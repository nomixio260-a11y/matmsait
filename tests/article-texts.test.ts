import { describe, expect, it } from 'vitest';
import {
  TEXT_KEY_LIMIT,
  mergeTextKeys,
  mergeTextRequests,
  mergeTextResults,
  parseJsonList,
  pendingRequests,
  pickRequests,
  pickResults,
  serializeTextsFile,
  shouldRetry,
  TEXT_FETCH_VERSION,
  type TextRequest,
  type TextResult,
} from '../src/lib/article-texts.ts';

const now = Date.parse('2026-10-07T00:00:00.000Z');
const at = (hours: number) => new Date(now - hours * 3600e3).toISOString();
const request = (id: string, hours: number): TextRequest => ({ id, url: `https://e.jp/${id}`, sourceId: 's', requestedAt: at(hours) });
const result = (id: string, hours: number, status: TextResult['status'] = 'ok'): TextResult => ({
  id,
  url: `https://e.jp/${id}`,
  status,
  fetchedAt: at(hours),
});

describe('本文の自動取得の依頼と結果', () => {
  it('結果のない依頼と、結果より後に依頼し直したものだけを、古い順に取得する（古すぎる依頼は除く）', () => {
    const requests = [request('a', 1), request('b', 3), request('c', 2), request('old', 24 * 15)];
    const results = [result('b', 4), result('c', 1)];
    expect(pendingRequests(requests, results, now).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('取り方を改善する前に本文を取れなかった記事は1回だけ取り直し、一時的な失敗は30分あけて3回まで試す', () => {
    const minutes = (m: number) => new Date(now - m * 60e3).toISOString();
    const r = (status: TextResult['status'], extra: Partial<TextResult> = {}): TextResult => ({ ...result('a', 1, status), ...extra });
    // 前の版の「本文なし」「失敗」は取り直す（拒否・ページなし・取得済みは取り直さない）
    expect(shouldRetry(r('no-text'), now)).toBe(true);
    expect(shouldRetry(r('error'), now)).toBe(true);
    expect(shouldRetry(r('no-text', { v: TEXT_FETCH_VERSION }), now)).toBe(false);
    for (const status of ['ok', 'robots', 'ai-optout', 'blocked', 'not-found'] as const) expect(shouldRetry(r(status), now)).toBe(false);
    // 今の版の一時的な失敗は、30分たってから3回目まで
    expect(shouldRetry(r('error', { v: TEXT_FETCH_VERSION, fetchedAt: minutes(10) }), now)).toBe(false);
    expect(shouldRetry(r('error', { v: TEXT_FETCH_VERSION, fetchedAt: minutes(31) }), now)).toBe(true);
    expect(shouldRetry(r('error', { v: TEXT_FETCH_VERSION, fetchedAt: minutes(31), tries: 3 }), now)).toBe(false);
    // 取り直す記事は、依頼の一覧にも入る
    expect(pendingRequests([request('a', 3)], [r('no-text')], now).map((x) => x.id)).toEqual(['a']);
    expect(pendingRequests([request('a', 3)], [r('no-text', { v: TEXT_FETCH_VERSION })], now)).toEqual([]);
  });

  it('依頼を足すと同じ記事は新しい日時にし、古い依頼は外す', () => {
    const merged = mergeTextRequests([request('a', 5), request('old', 24 * 20)], [request('a', 1), request('b', 2)], now);
    expect(merged.map((r) => [r.id, r.requestedAt])).toEqual([
      ['a', at(1)],
      ['b', at(2)],
    ]);
  });

  it('結果をまとめると新しく取得した方を残し、古い結果・要らない記事の結果は外す', () => {
    const merged = mergeTextResults([[result('a', 5, 'error'), result('b', 1)], [result('a', 2), result('old', 24 * 15), result('done', 1)]], {
      now,
      keep: (id) => id !== 'done',
    });
    expect(merged.map((r) => [r.id, r.status])).toEqual([
      ['b', 'ok'],
      ['a', 'ok'],
    ]);
  });

  it('公開鍵は同じ鍵を1つにし、新しいものから上限まで', () => {
    const keys = Array.from({ length: TEXT_KEY_LIMIT + 2 }, (_, i) => ({ kid: `k${i}`, publicKey: 'p', createdAt: at(i + 1) }));
    const merged = mergeTextKeys(keys, { kid: 'new', publicKey: 'p', createdAt: at(0) });
    expect(merged).toHaveLength(TEXT_KEY_LIMIT);
    expect(merged[0].kid).toBe('new');
    expect(mergeTextKeys(merged, { kid: 'new', publicKey: 'p', createdAt: at(0) })).toHaveLength(TEXT_KEY_LIMIT);
  });

  it('ファイルの読み書き（壊れていれば空）', () => {
    const file = serializeTextsFile({ updatedAt: at(0), items: [result('a', 1)] });
    expect(parseJsonList(file, pickResults).map((r) => r.id)).toEqual(['a']);
    expect(parseJsonList('{壊れた', pickRequests)).toEqual([]);
    expect(parseJsonList(undefined, pickRequests)).toEqual([]);
  });
});
