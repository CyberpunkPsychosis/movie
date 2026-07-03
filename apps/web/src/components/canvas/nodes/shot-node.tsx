'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { api } from '@/lib/api';
import { planSegmentsCount } from '../segments-ui';
import type { ApiCharacter, ApiScene, ApiShot } from '@/lib/types';

export type ShotNodeData = {
  shot: ApiShot;
  scene: ApiScene;
  characters: ApiCharacter[];
  projectId: string;
  /** 该镜头当前生效的视频模型单段上限（拆段徽标用） */
  videoMaxSec: number | null;
  highlighted: boolean;
};
export type ShotNodeType = Node<ShotNodeData, 'shot'>;

/** 参考图预览条：与 buildStageInput 的注入逻辑一一对应（生成前可见"实际会发什么图"） */
function RefPreview({ shot, scene, characters }: { shot: ApiShot; scene: ApiScene; characters: ApiCharacter[] }) {
  const keyframe = shot.variants.find((v) => v.selected && v.capability === 'image.t2i');
  const refChars = shot.characterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is ApiCharacter => Boolean(c));
  const items: { key: string; label: string; assetId: string | null }[] = [
    ...(keyframe ? [{ key: 'kf', label: '首帧', assetId: keyframe.assetId }] : []),
    ...refChars.map((c) => ({ key: c.id, label: `@${c.name}`, assetId: c.refAssetId })),
    ...(scene.refAssetId ? [{ key: 'scene', label: '场景', assetId: scene.refAssetId }] : []),
  ];
  if (items.length === 0) {
    return <p className="text-[9px] text-slate-600">无参考图（连线角色 / 给场景生成参考图）</p>;
  }
  return (
    <div className="flex flex-wrap gap-1" title="本次生成将携带的参考图（mock 模型会在占位图上标注数量）">
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-0.5 rounded bg-ink-950 px-1 py-0.5">
          {it.assetId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/assets/${it.assetId}`} alt={it.label} className="h-5 w-5 rounded-sm object-cover" />
          ) : (
            <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-slate-800 text-[8px] text-slate-500">
              无
            </span>
          )}
          <span className={`text-[9px] ${it.assetId ? 'text-slate-400' : 'text-slate-600'}`}>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/** 画布镜头节点：变体缩略 + 时长 + 拆段徽标 + 生成 + 参考图预览条；左侧连接柄收角色引用线 */
export function ShotNode({ data }: NodeProps<ShotNodeType>) {
  const { shot, scene, characters, projectId, videoMaxSec, highlighted } = data;
  const queryClient = useQueryClient();
  const [durationSec, setDurationSec] = useState(shot.durationSec);
  useEffect(() => setDurationSec(shot.durationSec), [shot.id, shot.durationSec]);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['jobs', projectId] });
  };

  const saveDuration = useMutation({
    mutationFn: (v: number) =>
      api(`/api/shots/${shot.id}`, { method: 'PATCH', body: JSON.stringify({ durationSec: v }) }),
    onSuccess: invalidate,
  });
  const generate = useMutation({
    mutationFn: (capability: string) =>
      api(`/api/shots/${shot.id}/generate`, { method: 'POST', body: JSON.stringify({ capability }) }),
    onSuccess: invalidate,
  });

  const preview =
    shot.variants.find((v) => v.selected && v.capability.startsWith('video.')) ??
    shot.variants.find((v) => v.selected && v.capability === 'image.t2i') ??
    null;
  const segments = videoMaxSec && durationSec > videoMaxSec ? planSegmentsCount(durationSec, videoMaxSec) : 0;

  return (
    <div
      className={`w-52 rounded-xl border bg-ink-900/95 p-2 shadow-card ${
        highlighted ? 'border-blue-400' : 'border-slate-700'
      }`}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] text-slate-400">
        <span className="font-mono">SHOT {String(shot.index + 1).padStart(2, '0')}</span>
        <span className="nodrag flex items-center gap-0.5">
          <input
            type="number"
            min={1}
            max={60}
            className="input w-11 px-1 py-0 text-[10px]"
            value={durationSec}
            onChange={(e) => setDurationSec(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
            onBlur={() => durationSec !== shot.durationSec && saveDuration.mutate(durationSec)}
          />
          s
        </span>
      </div>
      <div className="flex h-36 items-center justify-center overflow-hidden rounded-lg bg-ink-950">
        {preview ? (
          preview.asset.contentType.startsWith('video/') ? (
            <video src={`/api/assets/${preview.assetId}`} className="h-full w-full object-cover" muted playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/assets/${preview.assetId}`} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <span className="px-2 text-center text-[10px] leading-4 text-slate-600">{shot.visualPrompt.slice(0, 40)}</span>
        )}
      </div>
      {segments > 0 && (
        <p className="mt-1 text-[9px] leading-3 text-amber-400">
          超单段上限 {videoMaxSec}s，将拆 {segments} 段续接（尾帧→首帧自动拼接）
        </p>
      )}
      <div className="mt-1.5">
        <RefPreview shot={shot} scene={scene} characters={characters} />
      </div>
      <div className="mt-1.5 flex gap-1">
        <button
          className="btn-ghost flex-1 px-1 py-0.5 text-[10px]"
          disabled={generate.isPending}
          onClick={() => generate.mutate('image.t2i')}
        >
          生成帧
        </button>
        <button
          className="btn-primary flex-1 px-1 py-0.5 text-[10px]"
          disabled={generate.isPending}
          onClick={() => generate.mutate('video.i2v')}
        >
          生成片
        </button>
      </div>
      {generate.isError && <p className="mt-1 text-[10px] text-red-400">{generate.error.message}</p>}
      <Handle type="target" position={Position.Left} className="!bg-blue-400" title="从角色节点拖线到这里 = 引用" />
    </div>
  );
}
