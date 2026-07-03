import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@stageforge/db';
import { requireUser } from '@/lib/auth';
import { getShotWithAccess, handleError } from '@/lib/server';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  dialogue: z.string().max(2000).optional(),
  visualPrompt: z.string().max(4000).optional(),
  shotType: z.string().max(20).optional(),
  emotion: z.string().max(20).optional(),
  cameraMove: z.string().max(20).optional(),
  durationSec: z.number().min(1).max(60).optional(),
  /** 引用的角色 id（整组替换语义，画布连线/删线用） */
  characterIds: z.array(z.string().min(1)).max(20).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { shotId: string } }) {
  try {
    const user = await requireUser();
    await getShotWithAccess(params.shotId, user.id);
    const body = patchSchema.parse(await req.json());
    const shot = await prisma.shot.update({ where: { id: params.shotId }, data: body });
    return NextResponse.json({ shot });
  } catch (e) {
    return handleError(e);
  }
}
