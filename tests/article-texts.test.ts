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
