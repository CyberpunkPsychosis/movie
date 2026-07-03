/**
 * planSegments 的前端镜像（客户端组件不 import @stageforge/core：其中含 node:fs 依赖）。
 * 只需要段数，不需要每段秒数——与 core/segments.ts 的 N = ceil(total/max) 保持一致。
 */
export function planSegmentsCount(totalSec: number, maxPerSegment: number): number {
  const total = Math.max(1, Math.round(totalSec));
  const max = Math.max(1, Math.floor(maxPerSegment));
  return total <= max ? 1 : Math.ceil(total / max);
}
