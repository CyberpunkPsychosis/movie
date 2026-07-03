import {
  computeCostCents,
  type AssetOutput,
  type Credits,
  type ModelAdapter,
  type T2IInput,
  type Usage,
} from '@stageforge/core';
import { arkFetch, arkKey } from '../../ark';
import { produceMockImage } from '../../mock';

/**
 * 即梦图像（火山 Ark Seedream，与 Seedance 视频共用 ARK_API_KEY）。
 * 调研：与即梦视频同底模、中文理解强、上手门槛低 —— 国内短剧分镜图主流选择。
 * 参考单价：即梦 3.0 Pro 10 秒视频 100 积分≈10 元；图像积分价此处按占位估。
 *
 * 真实接入：Ark /images/generations 同步接口，支持多图参考（全能参考：
 * 角色定妆图 + 场景图随请求发送锁一致性）。
 * ⚠️ 请求字段形态（image 数组、size 档位）以 Ark 最新官方文档为准（uncertain，无 key 未实测）。
 * 无 ARK_API_KEY 时降级 mock 占位图（subtitle 标注"参考图×N"，链路可对账）。
 */
const META = {
  id: 'jimeng-t2i',
  displayName: '即梦图像（Seedream）',
  hue: 205,
};

const JIMENG_COST = { unit: 'per_image', price: 0.5, currency: 'CNY' } as const; // 占位估值，settings 校准

interface HandleData {
  result: { output: AssetOutput; usage: Usage };
}

/** 收集实际带图的参考（角色定妆图 + 场景图）为公网 URL 列表 */
async function collectRefUrls(
  input: T2IInput,
  ctx: Parameters<ModelAdapter<T2IInput, AssetOutput>['submit']>[1],
): Promise<string[]> {
  const urls: string[] = [];
  for (const r of input.characterRefs ?? []) {
    if (!r.refAssetId) continue;
    const url = await ctx.assetPublicUrl(r.refAssetId);
    if (url) urls.push(url);
    else ctx.log(`jimeng-t2i: 角色 ${r.name} 定妆图无公网 URL，未随请求发送（local 存储，生产切 S3/R2）`);
  }
  if (input.sceneRef?.refAssetId) {
    const url = await ctx.assetPublicUrl(input.sceneRef.refAssetId);
    if (url) urls.push(url);
    else ctx.log(`jimeng-t2i: 场景 ${input.sceneRef.title} 参考图无公网 URL，未随请求发送`);
  }
  return urls;
}

export const jimengT2I: ModelAdapter<T2IInput, AssetOutput> = {
  ...META,
  capability: 'image.t2i',
  provider: 'ByteDance',
  region: 'cn',
  caps: {
    resolutions: ['1024x1792', '2048x3584'],
    aspectRatios: ['9:16', '16:9', '1:1'],
    supportsReferenceImage: true,
    async: false,
  },
  cost: JIMENG_COST,
  mock: false, // 有 ARK_API_KEY 时真实调用；无 key 运行时降级 mock
  notes: '与即梦视频同底模 · 中文理解强 · 多图参考锁一致性 · ARK_API_KEY 启用真实调用',
  confidence: 'verified',
  estimateCost(): Credits {
    return computeCostCents(JIMENG_COST, { images: 1 });
  },
  async submit(input, ctx) {
    if (!arkKey()) {
      ctx.log('jimeng-t2i: 无 ARK_API_KEY，降级 mock 占位图');
      const result = await produceMockImage(META, input, ctx);
      const data: HandleData = { result };
      return { externalId: `mock:${ctx.jobId}`, data };
    }

    const imageUrls = await collectRefUrls(input, ctx);
    if (imageUrls.length) ctx.log(`jimeng-t2i: 携带参考图 ×${imageUrls.length}`);
    const json = await arkFetch('/images/generations', {
      method: 'POST',
      body: JSON.stringify({
        model: process.env.SEEDREAM_MODEL_ID ?? 'doubao-seedream-4-0',
        prompt: input.prompt,
        size: input.aspectRatio === '9:16' ? '1440x2560' : input.aspectRatio === '16:9' ? '2560x1440' : '2048x2048',
        response_format: 'url',
        ...(imageUrls.length ? { image: imageUrls } : {}),
      }),
    });
    const url = (json.data as { url?: string }[] | undefined)?.[0]?.url;
    if (!url) throw new Error(`Seedream 未返回图片 URL: ${JSON.stringify(json).slice(0, 200)}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载生成图片失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const asset = await ctx.saveAsset({
      kind: 'image',
      data: buf,
      contentType: 'image/jpeg',
      ext: 'jpg',
      meta: { source: 'ark-seedream', refCount: imageUrls.length },
    });
    const data: HandleData = { result: { output: { asset }, usage: { images: 1 } } };
    return { externalId: `seedream:${ctx.jobId}`, data };
  },
  async poll(handle) {
    const d = handle.data as HandleData;
    return { state: 'succeeded', output: d.result.output, usage: d.result.usage };
  },
};
