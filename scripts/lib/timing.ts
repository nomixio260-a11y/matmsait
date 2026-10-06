export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** min〜max ミリ秒のランダムな待ち時間（毎回同じ間隔で機械的にアクセスしないため） */
export function jitter(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Retry-After（秒）の指定があれば、その時間（最大60秒）。なければ数秒のランダムな時間 */
export function retryDelay(retryAfter: string | string[] | undefined): number {
  const seconds = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : jitter(3000, 6000);
}
