'use client';

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { api } from '@/lib/api';
import type { ApiScene } from '@/lib/types';

export type SceneNodeData = { scene: ApiScene; projectId: string };
export type SceneNodeType = Node<SceneNodeData, 'scene'>;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 画布场景节点：场景参考图 + 生成/上传 + 一致性话术；同场景镜头自动继承（虚线） */
export function SceneNode({ data }: NodeProps<SceneNodeType>) {
  const { scene, projectId } = data;
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState(scene.consistencyNote);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['jobs', projectId] });
  };

  const generate = useMutation({
    mutationFn: () =>
      api(`/api/scenes/${scene.id}/ref-image`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'generate' }),
      }),
    onSuccess: invalidate,
  });
  const upload = useMutation({
    mutationFn: (dataUrl: string) =>
      api(`/api/scenes/${scene.id}/ref-image`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'upload', dataUrl }),
      }),
    onSuccess: invalidate,
  });
  const saveNote = useMutation({
    mutationFn: () =>
      api(`/api/scenes/${scene.id}`, { method: 'PATCH', body: JSON.stringify({ consistencyNote: note }) }),
    onSuccess: invalidate,
  });

  return (
    <div className="w-44 rounded-xl border border-emerald-900/60 bg-ink-900/95 p-2 shadow-card">
      <div className="mb-1 truncate text-xs font-medium text-emerald-300">
        {scene.title}
        {scene.location ? ` · ${scene.location}` : ''}
      </div>
      <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg bg-ink-950">
        {scene.refAssetId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/assets/${scene.refAssetId}`} alt={scene.title} className="h-full w-full object-cover" />
        ) : (
          <span className="px-2 text-center text-[10px] leading-4 text-slate-600">
            无场景图
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
          {scene.refAssetId ? '重生成' : '生成'}
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
      <textarea
        className="input nodrag mt-1.5 h-12 w-full resize-none px-1.5 py-1 text-[10px] leading-4"
        title="场景一致性话术（随参考图注入支持参考图的模型）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== scene.consistencyNote && saveNote.mutate()}
      />
      {(generate.isError || upload.isError) && (
        <p className="mt-1 text-[10px] text-red-400">{(generate.error ?? upload.error)?.message}</p>
      )}
      <Handle type="source" position={Position.Right} className="!bg-emerald-400" title="同场景镜头自动引用（虚线）" />
    </div>
  );
}
