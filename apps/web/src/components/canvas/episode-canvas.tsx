'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '@/lib/api';
import { CharacterNode } from './nodes/character-node';
import { SceneNode } from './nodes/scene-node';
import { ShotNode } from './nodes/shot-node';
import type { ApiAdapter, ApiEpisode, ApiModelConfig, ApiProject, ApiShot } from '@/lib/types';

const nodeTypes = { character: CharacterNode, scene: SceneNode, shot: ShotNode };

type Pos = Record<string, { x: number; y: number }>;

/** 无持久化布局时的初始排布：角色最左列，场景各自成列，镜头按序纵排在所属场景列下 */
function autoLayout(project: ApiProject, episode: ApiEpisode): Pos {
  const pos: Pos = {};
  project.characters.forEach((c, i) => {
    pos[`char:${c.id}`] = { x: 20, y: 20 + i * 260 };
  });
  episode.scenes.forEach((scene, si) => {
    const x = 320 + si * 300;
    pos[`scene:${scene.id}`] = { x, y: 20 };
    scene.shots.forEach((shot, shi) => {
      pos[`shot:${shot.id}`] = { x, y: 280 + shi * 340 };
    });
  });
  return pos;
}

/** 该镜头当前生效的视频模型单段上限（与 StageRail 的 override→默认→首个 解析一致） */
function videoMaxSecFor(shot: ApiShot, adapters: ApiAdapter[], modelConfigs: ApiModelConfig[]): number | null {
  const options = adapters.filter((a) => a.capability === 'video.i2v');
  const override = shot.stages.find((s) => s.capability === 'video.i2v')?.adapterId;
  const projectDefault = modelConfigs.find((m) => m.capability === 'video.i2v')?.adapterId;
  const effective =
    options.find((a) => a.id === override) ?? options.find((a) => a.id === projectDefault) ?? options[0];
  return effective?.caps.maxDurationSec ?? null;
}

/**
 * 剧集画布（F4）：角色/场景/镜头 = 卡片节点，拖线 = 引用。
 * character→shot 实线可增删（写 Shot.characterIds）；scene→shot 虚线只读（sceneId 派生）。
 * 引用关系的真数据在 DB，画布只是视图层——画布坏了列表视图照常可用。
 */
export function EpisodeCanvas({
  projectId,
  project,
  episode,
  adapters,
  modelConfigs,
  selectedShotId,
  onSelectShot,
}: {
  projectId: string;
  project: ApiProject;
  episode: ApiEpisode;
  adapters: ApiAdapter[];
  modelConfigs: ApiModelConfig[];
  selectedShotId: string | null;
  onSelectShot: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [positions, setPositions] = useState<Pos>(() => ({
    ...autoLayout(project, episode),
    ...(episode.canvasLayout ?? {}),
  }));
  // 切集时重置布局（各集独立 canvasLayout）
  useEffect(() => {
    setPositions({ ...autoLayout(project, episode), ...(episode.canvasLayout ?? {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode.id]);
  // 新增节点（如新生成的分镜）没有坐标时补默认位置
  useEffect(() => {
    setPositions((prev) => {
      const auto = autoLayout(project, episode);
      const missing = Object.keys(auto).filter((k) => !prev[k]);
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const k of missing) next[k] = auto[k];
      return next;
    });
  }, [project, episode]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveLayout = useMutation({
    mutationFn: (layout: Pos) =>
      api(`/api/episodes/${episode.id}/canvas`, { method: 'PATCH', body: JSON.stringify({ layout }) }),
  });
  const scheduleSave = useCallback(
    (layout: Pos) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLayout.mutate(layout), 800);
    },
    [saveLayout],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  const patchCharacterIds = useMutation({
    mutationFn: (p: { shotId: string; characterIds: string[] }) =>
      api(`/api/shots/${p.shotId}`, { method: 'PATCH', body: JSON.stringify({ characterIds: p.characterIds }) }),
    onSuccess: invalidate,
  });

  const nodes = useMemo<Node[]>(() => {
    const list: Node[] = [];
    for (const c of project.characters) {
      const id = `char:${c.id}`;
      list.push({ id, type: 'character', position: positions[id] ?? { x: 0, y: 0 }, data: { character: c, projectId } });
    }
    for (const scene of episode.scenes) {
      const sid = `scene:${scene.id}`;
      list.push({ id: sid, type: 'scene', position: positions[sid] ?? { x: 0, y: 0 }, data: { scene, projectId } });
      for (const shot of scene.shots) {
        const id = `shot:${shot.id}`;
        list.push({
          id,
          type: 'shot',
          position: positions[id] ?? { x: 0, y: 0 },
          data: {
            shot,
            scene,
            characters: project.characters,
            projectId,
            videoMaxSec: videoMaxSecFor(shot, adapters, modelConfigs),
            highlighted: shot.id === selectedShotId,
          },
        });
      }
    }
    return list;
  }, [project, episode, positions, projectId, adapters, modelConfigs, selectedShotId]);

  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = [];
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        // 场景继承：虚线只读（从 shot.sceneId 派生，删不掉）
        list.push({
          id: `e-scene-${scene.id}-${shot.id}`,
          source: `scene:${scene.id}`,
          target: `shot:${shot.id}`,
          deletable: false,
          selectable: false,
          style: { strokeDasharray: '6 4', stroke: '#10b98188' },
        });
        for (const cid of shot.characterIds) {
          // 角色引用：实线，可连可删
          list.push({
            id: `e-char-${cid}-${shot.id}`,
            source: `char:${cid}`,
            target: `shot:${shot.id}`,
            style: { stroke: '#60a5fa' },
          });
        }
      }
    }
    return list;
  }, [episode]);

  const shotById = useMemo(() => {
    const m = new Map<string, ApiShot>();
    for (const scene of episode.scenes) for (const shot of scene.shots) m.set(shot.id, shot);
    return m;
  }, [episode]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setPositions((prev) => {
        const moved = applyNodeChanges(
          changes,
          Object.entries(prev).map(([id, position]) => ({ id, position, data: {} }) as Node),
        );
        const next: Pos = {};
        for (const n of moved) next[n.id] = n.position;
        return next;
      });
    },
    [],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source?.startsWith('char:') || !conn.target?.startsWith('shot:')) return;
      const characterId = conn.source.slice(5);
      const shotId = conn.target.slice(5);
      const shot = shotById.get(shotId);
      if (!shot || shot.characterIds.includes(characterId)) return;
      patchCharacterIds.mutate({ shotId, characterIds: [...shot.characterIds, characterId] });
    },
    [shotById, patchCharacterIds],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) {
        if (!e.id.startsWith('e-char-')) continue;
        const characterId = e.source.slice(5);
        const shotId = e.target.slice(5);
        const shot = shotById.get(shotId);
        if (!shot) continue;
        patchCharacterIds.mutate({ shotId, characterIds: shot.characterIds.filter((id) => id !== characterId) });
      }
    },
    [shotById, patchCharacterIds],
  );

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_e, node) => {
          if (node.id.startsWith('shot:')) onSelectShot(node.id.slice(5));
        }}
        onNodeDragStop={() => scheduleSave(positions)}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background gap={24} color="#1e293b" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
