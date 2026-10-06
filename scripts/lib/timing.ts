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
