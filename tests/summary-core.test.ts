import { describe, expect, it } from 'vitest';
import {
  buildSummaryPrompt,
  extractJson,
  groupByFile,
  mergeSummaryRecords,
  normalizeEntries,
  parseSummaryFile,
  serializeSummaryFile,
  summaryFilePath,
  toSummaryRecord,
  validateEntries,
} from '../src/lib/summary-core.ts';
import type { Item, SummaryRecord } from '../src/lib/types.ts';

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: `タイトル${id}`,
    url: `https://example.com/${id}`,
    excerpt: '抜粋',
    sourceId: 's',
    category: 'news',
    publishedAt: '2026-10-06T03:00:00.000Z',
    ...extra,
  };
}

const longSummary = '新製品が発表され、価格と発売日が明らかになった。従来モデルより性能が向上している。';

describe('buildSummaryPrompt', () => {
  it('ルール・出力形式・記事一覧（id と URL）を含む', () => {
    const prompt = buildSummaryPrompt(
      [{ id: 'abc', title: '記事', url: 'https://example.com/a', site: '例', excerpt: '抜粋' }],
      { siteName: 'テスト', length: 'normal', points: true },
    );
    expect(prompt).toContain('「テスト」');
    expect(prompt).toContain('120〜200字');
    expect(prompt).toContain('"unavailable"');
    expect(prompt).toContain('"points"');
    expect(prompt).toContain('"id": "abc"');
    expect(prompt).toContain('"url": "https://example.com/a"');
  });

  it('要点なしの指定ではpointsを求めない', () => {
    const prompt = buildSummaryPrompt([{ id: 'a', title: 't', url: 'https://e.com', site: 's' }], {
      siteName: 'テスト',
      length: 'short',
      points: false,
    });
    expect(prompt).not.toContain('"points"');
    expect(prompt).toContain('60〜100字');
  });
});

describe('extractJson', () => {
  it('コードブロックや前後の説明文があっても JSON を取り出す', () => {
    expect(extractJson('はい、要約です。\n```json\n[{"id":"a"}]\n```\n以上です')).toEqual([{ id: 'a' }]);
    expect(extractJson('結果: [{"id":"a"}] です')).toEqual([{ id: 'a' }]);
  });

  it('末尾の余分なカンマは許す', () => {
    expect(extractJson('[{"id":"a",},]')).toEqual([{ id: 'a' }]);
  });

  it('JSON がなければ分かりやすいエラー', () => {
    expect(() => extractJson('ごめんなさい、できません')).toThrow('JSON が見つかりません');
    expect(() => extractJson('[{"id": "a"')).toThrow();
  });
});

describe('normalizeEntries', () => {
  it('配列・{summaries: [...]}・{id: 要約} の形を同じ形にそろえる', () => {
    const expected = [{ id: 'a', status: 'ok', summary: 'x', points: [] }];
    expect(normalizeEntries([{ id: 'a', summary: 'x' }])).toEqual(expected);
    expect(normalizeEntries({ summaries: [{ id: 'a', summary: 'x' }] })).toEqual(expected);
    expect(normalizeEntries({ a: 'x' })).toEqual(expected);
    expect(normalizeEntries({ a: { summary: 'x' } })).toEqual(expected);
  });
});

describe('validateEntries', () => {
  const known = new Map([
    ['a', { summarized: false }],
    ['b', { summarized: false }],
    ['c', { summarized: true }],
    ['d', { summarized: false }],
    ['e', { summarized: false }],
  ]);
  const lookup = (id: string) => known.get(id);

  it('正しい要約を受け付け、読めなかった記事・不明な id・短すぎる要約を分ける', () => {
    const result = validateEntries(
      normalizeEntries([
        { id: 'a', status: 'ok', summary: `<b>${longSummary}</b>`, points: ['要点1', '', '要点2'] },
        { id: 'b', status: 'unavailable', summary: '' },
        { id: 'c', summary: longSummary },
        { id: 'd', summary: '記事にアクセスできませんでしたので、内容を確認できませんでした。' },
        { id: 'e', summary: '短い' },
        { id: 'zzz', summary: longSummary },
        { id: 'a', summary: longSummary },
      ]),
      lookup,
    );
    expect(result.accepted).toEqual([
      { id: 'a', summary: longSummary, points: ['要点1', '要点2'], replaces: false },
      { id: 'c', summary: longSummary, points: [], replaces: true },
    ]);
    expect(result.skipped.map((issue) => issue.id)).toEqual(['b', 'd', 'a']);
    expect(result.errors.map((issue) => issue.id)).toEqual(['e', 'zzz']);
  });
});

describe('要約ファイル', () => {
  const now = new Date('2026-10-06T05:00:00.000Z');
  const record = (id: string, publishedAt: string): SummaryRecord =>
    toSummaryRecord(item(id, { publishedAt }), { id, summary: longSummary, points: [], replaces: false }, now);

  it('記事の公開月（日本時間）ごとのファイルに分ける', () => {
    expect(summaryFilePath('2026-09-30T15:30:00.000Z')).toBe('data/summaries/2026-10.json');
    expect(summaryFilePath('2026-09-30T14:30:00.000Z')).toBe('data/summaries/2026-09.json');
    const groups = groupByFile([record('a', '2026-10-01T00:00:00.000Z'), record('b', '2026-09-01T00:00:00.000Z')]);
    expect([...groups.keys()]).toEqual(['data/summaries/2026-10.json', 'data/summaries/2026-09.json']);
  });

  it('追加・上書き・削除をマージして新しい順に並べ、そのまま読み戻せる', () => {
    const existing = [record('old', '2026-10-01T00:00:00.000Z'), record('gone', '2026-10-02T00:00:00.000Z')];
    const updated = { ...record('old', '2026-10-01T00:00:00.000Z'), summary: '上書きした要約です。内容を新しくしました。' };
    const merged = mergeSummaryRecords(existing, [updated, record('new', '2026-10-05T00:00:00.000Z')], ['gone']);
    expect(merged.map((r) => r.id)).toEqual(['new', 'old']);
    expect(merged[1].summary).toContain('上書き');
    expect(parseSummaryFile(serializeSummaryFile(merged))).toEqual(merged);
    expect(parseSummaryFile(null)).toEqual([]);
    expect(() => parseSummaryFile('{"broken": true}')).toThrow();
  });

  it('記事情報は回答ではなくサイトのデータから作る', () => {
    const saved = toSummaryRecord(item('a', { hatebu: 12 }), { id: 'a', summary: longSummary, points: ['p'], replaces: false }, now);
    expect(saved).toMatchObject({ id: 'a', title: 'タイトルa', url: 'https://example.com/a', hatebu: 12, summarizedAt: now.toISOString() });
  });
});
