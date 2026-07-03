import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@stageforge/db';
import { requireUser } from '@/lib/auth';
import { assertProjectAccess, handleError, notFound } from '@/lib/server';

export const dynamic = 'force-dynamic';

const schema = z.object({
  layout: z.record(z.object({ x: z.number(), y: z.number() })),
});

/** 画布节点坐标持久化（前端拖拽结束后防抖保存） */
export async function PATCH(req: NextRequest, { params }: { params: { episodeId: string } }) {
  try {
    const user = await requireUser();
    const episode = await prisma.episode.findUnique({ where: { id: params.episodeId } });
    if (!episode) notFound('剧集不存在');
    await assertProjectAccess(episode.projectId, user.id);
    const body = schema.parse(await req.json());
    await prisma.episode.update({
      where: { id: params.episodeId },
      data: { canvasLayout: body.layout },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
