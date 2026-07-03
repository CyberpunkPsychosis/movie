import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getStorage,
  planSegments,
  type AdapterCaps,
  type AssetOutput,
  type I2VInput,
  type ModelAdapter,
  type RunContext,
  type Usage,
} from '@stageforge/core';
import { concatVideosToBuffer, extractLastFrameBuffer, hasFfmpeg } from './media';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdapter = ModelAdapter<any, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 统一执行一次 submit→poll 生命周期（所有能力/所有模型的唯一路径），failed 时 throw */
export async function runAdapterOnce<TOutput = unknown>(
  adapter: AnyAdapter,
  input: unknown,
  ctx: RunContext,
): Promise<{ output: TOutput; usage: Usage }> {
  const handle = await adapter.submit(input, ctx);
  let status = await adapter.poll(handle, ctx);
  while (status.state === 'running') {
    await sleep(2000);
    status = await adapter.poll(handle, ctx);
  }
  if (status.state === 'failed') throw new Error(status.error);
  return { output: status.output as TOutput, usage: status.usage ?? {} };
}

/** 是否需要拆段续接：视频请求时长超过该 adapter 的单段上限（能力无关，只读 caps） */
export function needsSegmentation(caps: AdapterCaps, input: unknown): boolean {
  const d = (input as I2VInput | undefined)?.durationSec;
  return typeof d === 'number' && caps.maxDurationSec != null && d > caps.maxDurationSec;
}

/**
 * 长镜头拆段续接编排（F3）：拆 N 段逐段生成，第 i+1 段用第 i 段尾帧作首帧，
 * 全部段 ffmpeg 拼成单条 mp4 落为一个变体。对 adapter 完全无感——
 * 每段仍是标准的 submit→poll，「加模型零改动」原则不破。
 */
export async function runSegmentedVideo(
  adapter: AnyAdapter,
  input: I2VInput,
  ctx: RunContext,
): Promise<{ output: AssetOutput; usage: Usage }> {
  const max = adapter.caps.maxDurationSec as number;
  if (!hasFfmpeg()) {
    ctx.log(`长镜头 ${input.durationSec}s 超单段上限 ${max}s，但环境无 ffmpeg 无法续接，退化为单段（${max}s）`);
    return runAdapterOnce<AssetOutput>(adapter, { ...input, durationSec: max }, ctx);
  }

  const plan = planSegments(input.durationSec, max);
  ctx.log(`长镜头拆段续接：${input.durationSec}s → ${plan.length} 段 [${plan.join(', ')}]s`);
  const storage = getStorage();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-longshot-'));
  const files: string[] = [];
  let seconds = 0;
  let keyframeAssetId = input.keyframeAssetId ?? null;
  let partial: { failedAtSegment: number; error: string } | null = null;

  try {
    for (let i = 0; i < plan.length; i++) {
      const segInput: I2VInput = {
        ...input,
        durationSec: plan[i],
        keyframeAssetId,
        prompt:
          i === 0
            ? input.prompt
            : `${input.prompt}。紧接上一段结尾画面继续拍摄：延续同一镜头的动作与运镜，人物、服装、场景保持完全一致`,
      };
      let seg: { output: AssetOutput; usage: Usage };
      try {
        ctx.log(`第 ${i + 1}/${plan.length} 段生成中（${plan[i]}s）…`);
        seg = await runAdapterOnce<AssetOutput>(adapter, segInput, ctx);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (i === 0) throw e; // 第 0 段失败 = 整个镜头失败
        // 止损：保留已成功段，拼接返回部分结果，用户可自行重roll
        partial = { failedAtSegment: i, error: message.slice(0, 300) };
        ctx.log(`第 ${i + 1}/${plan.length} 段失败，止损：用已成功的 ${i} 段拼接（${message.slice(0, 120)}）`);
        break;
      }

      const asset = seg.output.asset;
      if (!asset.contentType.startsWith('video/')) {
        // 段产物不是视频（如 SVG 占位）→ 无法抽帧/拼接，直接作为整镜结果返回
        ctx.log(`段产物不是视频（${asset.contentType}），无法续接，直接作为整镜变体返回`);
        return seg;
      }
      const buf = await storage.get(asset.storageKey);
      const file = path.join(tmp, `${i}.mp4`);
      await fs.writeFile(file, buf);
      files.push(file);
      seconds += seg.usage.seconds ?? plan[i];

      if (i < plan.length - 1) {
        const frame = await extractLastFrameBuffer(file);
        if (frame) {
          const frameAsset = await ctx.saveAsset({
            kind: 'image',
            data: frame,
            contentType: 'image/jpeg',
            ext: 'jpg',
            meta: { role: 'continuation-frame', segment: i },
          });
          keyframeAssetId = frameAsset.assetId;
          ctx.log(`第 ${i + 1} 段尾帧已抽取，作为第 ${i + 2} 段首帧`);
        } else {
          keyframeAssetId = null;
          ctx.log(`第 ${i + 1} 段尾帧抽取失败，下一段无首帧，仅靠续接话术衔接`);
        }
      }
    }

    const merged = await concatVideosToBuffer(files);
    const finalAsset = await ctx.saveAsset({
      kind: 'video',
      data: merged,
      contentType: 'video/mp4',
      ext: 'mp4',
      meta: {
        source: 'segmented',
        requestedSec: input.durationSec,
        segments: plan.length,
        succeeded: files.length,
        ...(partial ? { partial: true, failedAtSegment: partial.failedAtSegment, error: partial.error } : {}),
      },
    });
    ctx.log(
      `拆段续接完成：${files.length}/${plan.length} 段拼为单条视频（${seconds}s）${partial ? '（部分成功）' : ''}`,
    );
    return { output: { asset: finalAsset }, usage: { seconds } };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
