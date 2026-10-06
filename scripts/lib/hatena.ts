import { decodeBody, httpGet } from './http.ts';
import { jitter, sleep } from './timing.ts';

const ENDPOINT = 'https://bookmark.hatenaapis.com/count/entries';
const MAX_URLS = 50;
const MAX_QUERY_LENGTH = 6000;

/** URL を API の上限（50件・URL長）に収まるよう分割する */
export function chunkUrls(urls: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const url of urls) {
    const size = encodeURIComponent(url).length + 5;
    if (batch.length > 0 && (batch.length >= MAX_URLS || length + size > MAX_QUERY_LENGTH)) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(url);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

type Get = typeof httpGet;

async function fetchBatch(batch: string[], get: Get): Promise<Record<string, number>> {
  const query = batch.map((url) => `url=${encodeURIComponent(url)}`).join('&');
  const res = await get(`${ENDPOINT}?${query}`, { kind: 'fetch' });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(decodeBody(res.body, res.headers['content-type'])) as Record<string, number>;
}

/**
 * はてなブックマーク数をまとめて取得する（キーは渡したURLそのもの）。
 * 一部のまとまりが失敗しても、1回だけやり直したうえで残りは続ける（失敗した分は前回の値のまま）。
 * すべて失敗したときだけエラーにする
 */
export async function fetchHatenaCounts(urls: string[], get: Get = httpGet, wait = sleep): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const batches = chunkUrls([...new Set(urls)]);
  let failed = 0;
  let lastError: unknown;
  for (const [index, batch] of batches.entries()) {
    if (index > 0) await wait(jitter(600, 1500));
    let data: Record<string, number> | undefined;
    for (let attempt = 1; attempt <= 2 && !data; attempt++) {
      try {
        data = await fetchBatch(batch, get);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await wait(jitter(2000, 4000));
      }
    }
    if (!data) {
      failed++;
      continue;
    }
    for (const [url, count] of Object.entries(data)) {
      if (typeof count === 'number') counts.set(url, count);
    }
  }
  if (batches.length > 0 && failed === batches.length) {
    throw new Error(`はてなブックマーク件数API: ${lastError instanceof Error ? lastError.message : lastError}`);
  }
  if (failed > 0) console.warn(`はてなブックマーク数: ${batches.length}回中${failed}回の取得に失敗（その分は前回の値のまま）`);
  return counts;
}
