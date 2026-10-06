import { describe, expect, it } from 'vitest';
import { chunkUrls } from '../scripts/lib/hatena.ts';

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
