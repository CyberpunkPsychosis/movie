import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@stageforge/db';
import { GENERATION_QUEUE, getQueue, getStorage } from '@stageforge/core';
import { getAdapter } from '@stageforge/adapters';
import { requireUser } from '@/lib/auth';
import { assertProjectAccess, badRequest, handleError, notFound } from '@/lib/server';
import { resolveAdapterId } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';

const schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('generate'), prompt: z.string().max(1000).optional(), adapterId: z.string().optional() }),
  z.object({ mode: z.literal('upload'), dataUrl: z.string().max(8_000_000) }),
]);

/**
 * 场景参考图（锁场景不跳景的锚图）：
 * - generate: 走 image.t2i 能力出空镜场景图（input 带 sceneId、不带 shotId，worker 据此回写而非落变体）
 * - upload:   用户上传场景图（dataURL）
 */
export async function POST(req: NextRequest, { params }: { params: { sceneId: string } }) {
  try {
    const user = await requireUser();
    const scene = await prisma.scene.findUnique({
      where: { id: params.sceneId },
      include: { episode: true },
    });
    if (!scene) notFound('场景不存在');
    await assertProjectAccess(scene.episode.projectId, user.id);
    const projectId = scene.episode.projectId;
    const body = schema.parse(await req.json());

    if (body.mode === 'upload') {
      const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/.exec(body.dataUrl);
      if (!match) badRequest('dataUrl 格式不合法（需 data:image/*;base64,…）');
      const [, contentType, b64] = match;
      const buf = Buffer.from(b64, 'base64');
      const ext = contentType.includes('png') ? 'png' : contentType.includes('svg') ? 'svg' : 'jpg';
      const asset = await prisma.asset.create({
        data: {
          projectId,
          kind: 'image',
          storageKey: '',
          contentType,
          meta: { role: 'scene-ref', sceneId: scene.id, uploaded: true },
        },
      });
      const key = `${projectId}/${asset.id}.${ext}`;
      await getStorage().put(key, buf, contentType);
      await prisma.asset.update({ where: { id: asset.id }, data: { storageKey: key } });
      await prisma.scene.update({ where: { id: scene.id }, data: { refAssetId: asset.id } });
      return NextResponse.json({ assetId: asset.id });
    }

    // generate 模式：异步任务，worker 成功后回写 Scene.refAssetId
    const adapterId = body.adapterId ?? (await resolveAdapterId(projectId, 'image.t2i'));
    const adapter = getAdapter(adapterId);
    const input = {
      prompt:
        body.prompt ??
        `${scene.title}，${scene.location}。空镜场景参考图：无人物，交代环境全貌与光线氛围，构图稳定，适合作为场景一致性参考`,
      aspectRatio: '9:16',
      sceneId: scene.id,
    };
    const estimated = adapter.estimateCost(input);
    const job = await prisma.generationJob.create({
      data: {
        projectId,
        capability: 'image.t2i',
        adapterId,
        input,
        estimatedCostCents: estimated.cents,
        currency: estimated.currency,
      },
    });
    await getQueue(GENERATION_QUEUE).add('scene-ref', { jobId: job.id });
    return NextResponse.json({ job }, { status: 202 });
  } catch (e) {
    return handleError(e);
  }
}
