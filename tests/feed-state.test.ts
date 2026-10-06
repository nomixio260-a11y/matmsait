import { describe, expect, it } from 'vitest';
import { conditionalHeaders, recordFailure, recordSuccess, FULL_FETCH_AFTER_MS } from '../scripts/lib/feed-state.ts';
import { retryDelay } from '../scripts/lib/timing.ts';

const now = new Date('2026-10-06T09:00:00.000Z');
const earlier = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

describe('conditionalHeaders', () => {
  it('前回の ETag・Last-Modified を送る（ブラウザの再読み込みと同じ）', () => {
    const state = { etag: '"abc"', lastModified: 'Tue, 06 Oct 2026 08:00:00 GMT', fetchedAt: earlier, failures: 0 };
    expect(conditionalHeaders(state, now)).toEqual([
      ['If-None-Match', '"abc"'],
      ['If-Modified-Since', 'Tue, 06 Oct 2026 08:00:00 GMT'],
    ]);
  });

  it('初回や、しばらく本文を受け取っていないときは送らない（全部取り直す）', () => {
    expect(conditionalHeaders(undefined, now)).toEqual([]);
    const old = new Date(now.getTime() - FULL_FETCH_AFTER_MS - 1000).toISOString();
    expect(conditionalHeaders({ etag: '"abc"', fetchedAt: old, failures: 0 }, now)).toEqual([]);
  });
});

describe('recordSuccess / recordFailure', () => {
  it('本文を受け取ったら ETag などを入れ替え、失敗の回数を 0 に戻す', () => {
    const previous = { etag: '"old"', lastModified: 'old', fetchedAt: earlier, okAt: earlier, failures: 2, error: 'HTTP 503', count: 10 };
    expect(recordSuccess(previous, { notModified: false, etag: '"new"', count: 30 }, now)).toEqual({
      etag: '"new"',
      fetchedAt: now.toISOString(),
      okAt: now.toISOString(),
      failures: 0,
      error: 'HTTP 503',
      count: 30,
    });
  });

  it('変更なし（304）なら前回の ETag と記事数のまま', () => {
    const previous = { etag: '"same"', fetchedAt: earlier, okAt: earlier, failures: 1, count: 20 };
    expect(recordSuccess(previous, { notModified: true }, now)).toEqual({ ...previous, okAt: now.toISOString(), failures: 0 });
  });

  it('失敗は連続の回数と最後のエラーを残す', () => {
    const first = recordFailure(undefined, 'HTTP 403', now);
    expect(first).toEqual({ failures: 1, failedAt: now.toISOString(), error: 'HTTP 403' });
    expect(recordFailure(first, 'タイムアウト', now)).toMatchObject({ failures: 2, error: 'タイムアウト' });
  });
});

describe('retryDelay', () => {
  it('Retry-After の秒数（最大60秒）に従う', () => {
    expect(retryDelay('10')).toBe(10_000);
    expect(retryDelay(['5'])).toBe(5_000);
    expect(retryDelay('3600')).toBe(60_000);
  });

  it('指定がなければ数秒', () => {
    const delay = retryDelay(undefined);
    expect(delay).toBeGreaterThanOrEqual(3000);
    expect(delay).toBeLessThanOrEqual(6000);
    expect(retryDelay('Wed, 21 Oct 2026 07:28:00 GMT')).toBeLessThanOrEqual(6000);
  });
});
