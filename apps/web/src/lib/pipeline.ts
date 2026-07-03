import {
  clampDuration,
  listAdapters,
  tryGetAdapter,
} from '@stageforge/adapters';
import { planSegments } from '@stageforge/core';
import type {
  Capability,
  CharacterRef,
  Credits,
  I2VInput,
  LipsyncInput,
  ModelAdapter,
  SceneRef,
  T2IInput,
  TTSInput,
} from '@stageforge/core';
import { prisma, type Prisma, type Shot, type ShotStage, type Variant, type Asset } from '@stageforge/db';
import { badRequest } from './server';

type ShotWithRelations = Shot & {
  stages: ShotStage[];
  variants: (Variant & { asset: Asset })[];
};

/**
 * 解析某个镜头某个环节实际使用的 adapterId。
 * 优先级：单镜覆盖（ShotStage.adapterId）→ 项目默认（ModelConfig）→ 注册表首个。
 * 「任意环节任意模型」的读路径就这三行查表，没有任何模型硬编码。
 */
export async function resolveAdapterId(
  projectId: string,
  capability: Capability,
  stages?: ShotStage[],
): Promise<string> {
  const override = stages?.find((s) => s.capability === capability)?.adapterId;
  if (override && tryGetAdapter(override)) return override;
  const config = await prisma.modelConfig.findUnique({
    where: { projectId_capability: { projectId, capability } },
  });
  if (config && tryGetAdapter(config.adapterId)) return config.adapterId;
  const first = listAdapters(capability)[0];
  if (!first) badRequest(`没有任何适配器支持能力 ${capability}`);
  return first.id;
}

async function characterRefsFor(shot: Shot): Promise<CharacterRef[]> {
  if (shot.characterIds.length === 0) return [];
  const characters = await prisma.character.findMany({ where: { id: { in: shot.characterIds } } });
  return characters.map((c) => ({
    characterId: c.id,
    name: c.name,
    refAssetId: c.refAssetId,
    consistencyNote: c.consistencyNote,
    voiceId: c.voiceId,
  }));
}

function selectedVariant(shot: ShotWithRelations, capabilities: Capability[]) {
  return shot.variants.find((v) => v.selected && capabilities.includes(v.capability as Capability));
}

/** 场景参考：按 sceneId 标量查询（调用方 include 无需变化），锁场景不跳景 */
async function sceneRefFor(shot: Shot): Promise<SceneRef | undefined> {
  const scene = await prisma.scene.findUnique({ where: { id: shot.sceneId } });
  if (!scene) return undefined;
  return {
    sceneId: scene.id,
    title: scene.title,
    refAssetId: scene.refAssetId,
    consistencyNote: scene.consistencyNote,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdapter = ModelAdapter<any, any>;

/**
 * 估价：视频时长超单段上限时按拆段求和（与 worker 实际拆段共用 planSegments，估价=实际账）。
 * 其余能力直通 adapter.estimateCost。
 */
export function estimateStageCost(adapter: AnyAdapter, capability: Capability, input: unknown): Credits {
  if (capability === 'video.i2v' || capability === 'video.t2v') {
    const i = input as I2VInput;
    const max = adapter.caps.maxDurationSec;
    if (max && i.durationSec > max) {
      return planSegments(i.durationSec, max)
        .map((s) => adapter.estimateCost({ ...i, durationSec: s }))
        .reduce((a, c) => ({ cents: a.cents + c.cents, currency: c.currency }));
    }
  }
  return adapter.estimateCost(input);
}

/**
 * 按能力从镜头数据组装 adapter 输入。
 * 角色参考图/一致性话术在这里统一注入 —— 模型无关（只有声明
 * supportsReferenceImage 的适配器会消费 characterRefs，其余自动忽略）。
 */
export async function buildStageInput(
  capability: Capability,
  shot: ShotWithRelations,
): Promise<Prisma.InputJsonValue> {
  const refs = await characterRefsFor(shot);
  const sceneRef = await sceneRefFor(shot);
  const consistency = refs.length > 0 ? `。${refs.map((r) => `@${r.name} ${r.consistencyNote}`).join('；')}` : '';
  // 场景话术只在有参考图时注入（无图时纯文字场景描述已在 visualPrompt 里）
  const sceneNote = sceneRef?.refAssetId ? `。场景「${sceneRef.title}」：${sceneRef.consistencyNote}` : '';

  switch (capability) {
    case 'image.t2i':
    case 'image.character': {
      const input: T2IInput = {
        prompt: `${shot.visualPrompt}${consistency}${sceneNote}`,
        aspectRatio: '9:16',
        characterRefs: refs,
        sceneRef,
      };
      return input as unknown as Prisma.InputJsonValue;
    }
    case 'video.i2v':
    case 'video.t2v': {
      const keyframe = selectedVariant(shot, ['image.t2i']);
      const input: I2VInput = {
        prompt: `${shot.visualPrompt}，${shot.cameraMove}镜头，${shot.emotion}情绪${consistency}${sceneNote}`,
        // 上限 60s：超过模型单段上限的部分由 worker 拆段续接（F3），不在这里截断
        durationSec: clampDuration(shot.durationSec, 60),
        resolution: '1080p',
        aspectRatio: '9:16',
        keyframeAssetId: capability === 'video.i2v' ? keyframe?.assetId ?? null : null,
        dialogue: shot.dialogue,
        characterRefs: refs,
        sceneRef,
      };
      return input as unknown as Prisma.InputJsonValue;
    }
    case 'audio.tts': {
      if (!shot.dialogue.trim()) badRequest('该镜头没有台词，无法配音');
      // 声音克隆建库（M3）：镜头首个绑定了克隆音色的角色 → 用其专属 voiceId
      const voiceId = refs.find((r) => r.voiceId)?.voiceId ?? undefined;
      const input: TTSInput = { text: shot.dialogue, voiceId };
      return input as unknown as Prisma.InputJsonValue;
    }
    case 'audio.lipsync': {
      const video = selectedVariant(shot, ['video.i2v', 'video.t2v']);
      const audio = selectedVariant(shot, ['audio.tts', 'audio.voiceclone']);
      if (!video) badRequest('请先生成并选定该镜头的视频变体');
      if (!audio) badRequest('请先生成并选定该镜头的配音变体');
      const input: LipsyncInput = { videoAssetId: video.assetId, audioAssetId: audio.assetId };
      return input as unknown as Prisma.InputJsonValue;
    }
    default:
      badRequest(`能力 ${capability} 不支持镜头级生成`);
  }
}
