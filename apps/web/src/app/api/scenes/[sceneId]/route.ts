import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@stageforge/db';
import { requireUser } from '@/lib/auth';
import { assertProjectAccess, handleError, notFound } from '@/lib/server';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  location: z.string().max(100).optional(),
  consistencyNote: z.string().max(500).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { sceneId: string } }) {
  try {
    const user = await requireUser();
    const scene = await prisma.scene.findUnique({
      where: { id: params.sceneId },
      include: { episode: true },
    });
    if (!scene) notFound('场景不存在');
    await assertProjectAccess(scene.episode.projectId, user.id);
    const body = patchSchema.parse(await req.json());
    const updated = await prisma.scene.update({ where: { id: params.sceneId }, data: body });
    return NextResponse.json({ scene: updated });
  } catch (e) {
    return handleError(e);
  }
}
