'use client';

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { api } from '@/lib/api';
import type { ApiCharacter } from '@/lib/types';

export type CharacterNodeData = { character: ApiCharacter; projectId: string };
export type CharacterNodeType = Node<CharacterNodeData, 'character'>;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 画布角色节点：定妆图 + 生成/上传，右侧连接柄拖线到镜头 = 引用 */
export function CharacterNode({ data }: NodeProps<CharacterNodeType>) {
  const { character, projectId } = data;
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['jobs', projectId] });
  };

  const generate = useMutation({
    mutationFn: () =>
      api(`/api/characters/${character.id}/ref-image`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'generate' }),
      }),
    onSuccess: invalidate,
  });
  const upload = useMutation({
    mutationFn: (dataUrl: string) =>
      api(`/api/characters/${character.id}/ref-image`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'upload', dataUrl }),
      }),
    onSuccess: invalidate,
  });

  return (
    <div className="w-40 rounded-xl border border-blue-900/60 bg-ink-900/95 p-2 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <span className="truncate text-xs font-medium text-blue-300">@{character.name}</span>
        {character.voiceId && <span title="已建专属音色">♪</span>}
      </div>
      <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-ink-950">
        {character.refAssetId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/assets/${character.refAssetId}`} alt={character.name} className="h-full w-full object-cover" />
        ) : (
          <span className="px-2 text-center text-[10px] leading-4 text-slate-600">
            无定妆图
            <br />
            生成或上传 →
          </span>
        )}
      </div>
      <div className="mt-1.5 flex gap-1">
        <button
          className="btn-ghost flex-1 px-1 py-0.5 text-[10px]"
          disabled={generate.isPending}
          onClick={() => generate.mutate()}
        >
          {character.refAssetId ? '重生成' : '生成'}
        </button>
        <button className="btn-ghost flex-1 px-1 py-0.5 text-[10px]" onClick={() => fileRef.current?.click()}>
          上传
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(await readAsDataUrl(file));
            e.target.value = '';
          }}
        />
      </div>
      {(generate.isError || upload.isError) && (
        <p className="mt-1 text-[10px] text-red-400">{(generate.error ?? upload.error)?.message}</p>
      )}
      <Handle type="source" position={Position.Right} className="!bg-blue-400" title="拖线到镜头 = 引用该角色" />
    </div>
  );
}
