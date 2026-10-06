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

/** はてなブックマーク数をまとめて取得する（キーは渡したURLそのもの） */
export async function fetchHatenaCounts(urls: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const [index, batch] of chunkUrls([...new Set(urls)]).entries()) {
    if (index > 0) await sleep(jitter(600, 1500));
    const query = batch.map((url) => `url=${encodeURIComponent(url)}`).join('&');
    const res = await httpGet(`${ENDPOINT}?${query}`, { kind: 'fetch' });
    if (res.status !== 200) throw new Error(`はてなブックマーク件数API: HTTP ${res.status}`);
    const data = JSON.parse(decodeBody(res.body, res.headers['content-type'])) as Record<string, number>;
    for (const [url, count] of Object.entries(data)) {
      if (typeof count === 'number') counts.set(url, count);
    }
  }
  return counts;
}
