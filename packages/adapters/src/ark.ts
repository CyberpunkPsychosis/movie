/**
 * 火山引擎 Ark 共享工具（Seedance 视频 / Seedream 图像同一 key 同一网关）。
 * 与 mock.ts 性质相同的 provider 级共享层，不违背「一模型一文件」。
 */
export const ARK_BASE = process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3';

export function arkKey(): string | undefined {
  return process.env.ARK_API_KEY || undefined;
}

export async function arkFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${ARK_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${arkKey()}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Ark API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}
