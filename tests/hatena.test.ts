import { describe, expect, it } from 'vitest';
import { chunkUrls, fetchHatenaCounts } from '../scripts/lib/hatena.ts';
import type { HttpResponse } from '../scripts/lib/http.ts';

describe('chunkUrls', () => {
  it('50件ごとに分割する', () => {
    const urls = Array.from({ length: 120 }, (_, n) => `https://example.com/${n}`);
    expect(chunkUrls(urls).map((batch) => batch.length)).toEqual([50, 50, 20]);
  });

  it('クエリが長くなりすぎないよう、長いURLは少ない件数で分割する', () => {
    const urls = Array.from({ length: 30 }, (_, n) => `https://example.com/${'あ'.repeat(40)}/${n}`);
    const batches = chunkUrls(urls);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const length = batch.reduce((sum, url) => sum + encodeURIComponent(url).length + 5, 0);
      expect(length).toBeLessThanOrEqual(6000);
    }
    expect(batches.flat()).toEqual(urls);
  });

  it('空なら空', () => {
    expect(chunkUrls([])).toEqual([]);
  });
});

describe('fetchHatenaCounts', () => {
  const urls = Array.from({ length: 120 }, (_, n) => `https://example.com/${n}`);
  const respond = (status: number, body: unknown): HttpResponse => ({
    url: 'https://bookmark.hatenaapis.com/',
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  });
  /** URL の中の記事の番号をはてブ数として返す。fail に入れた回は失敗させる */
  function fakeGet(fail: Set<number>) {
    let calls = 0;
    const get = async (url: string) => {
      const call = calls++;
      if (fail.has(call)) return respond(503, {});
      const params = new URL(url).searchParams.getAll('url');
      return respond(200, Object.fromEntries(params.map((u) => [u, Number(u.split('/').pop())])));
    };
    return { get: get as never, calls: () => calls };
  }
  const noWait = async () => {};

  it('まとめて取得する', async () => {
    const { get } = fakeGet(new Set());
    const counts = await fetchHatenaCounts(urls, get, noWait);
    expect(counts.size).toBe(120);
    expect(counts.get('https://example.com/42')).toBe(42);
  });

  it('一部が失敗しても1回やり直し、それでも失敗した分だけを飛ばして続ける', async () => {
    // 1回目（1つ目のまとまり）は失敗→やり直しで成功。3回目・4回目（2つ目のまとまり）は2回とも失敗
    const { get, calls } = fakeGet(new Set([0, 2, 3]));
    const counts = await fetchHatenaCounts(urls, get, noWait);
    expect(calls()).toBe(5);
    expect(counts.has('https://example.com/0')).toBe(true);
    expect(counts.has('https://example.com/50')).toBe(false);
    expect(counts.has('https://example.com/119')).toBe(true);
  });

  it('すべて失敗したらエラーにする', async () => {
    const { get } = fakeGet(new Set([0, 1, 2, 3, 4, 5]));
    await expect(fetchHatenaCounts(urls, get, noWait)).rejects.toThrow('はてなブックマーク件数API');
  });
});
