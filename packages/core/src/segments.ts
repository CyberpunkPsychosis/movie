/**
 * 长镜头拆段计划（F3 片段续接）：镜头时长超过模型单段上限时，拆成 N 段逐段生成、
 * 尾帧续接、最后拼成单条视频。web 估价与 worker 实际拆段共用本函数，保证估价=实际账。
 */

/**
 * 均分为 N 段（N = ceil(total/max)），整数秒，余数摊给前几段。
 * 均分而非"先切满"：避免出现 1-2 秒的碎尾段（31s/15 → [11,10,10] 而非 [15,15,1]）。
 * totalSec ≤ max 时返回 [totalSec]。
 */
export function planSegments(totalSec: number, maxPerSegment: number): number[] {
  const total = Math.max(1, Math.round(totalSec));
  const max = Math.max(1, Math.floor(maxPerSegment));
  if (total <= max) return [total];
  const n = Math.ceil(total / max);
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}
