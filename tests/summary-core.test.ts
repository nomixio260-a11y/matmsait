import { describe, expect, it } from 'vitest';
import {
  buildSummaryPrompt,
  editSummaryRecord,
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

  it('要点なしの指定では points を常に空の配列にさせる', () => {
    const prompt = buildSummaryPrompt([{ id: 'a', title: 't', url: 'https://e.com', site: 's' }], {
      siteName: 'テスト',
      length: 'short',
      points: false,
    });
    expect(prompt).toContain('"points"（文字列の配列）: 常に空の配列 []');
    expect(prompt).not.toContain('要点を0〜3個');
    expect(prompt).toContain('60〜100字');
  });

  it('JSON の形式を詳しく指示し、記事一覧と出力例をコードブロックで示す', () => {
    const articles = ['a', 'b', 'c'].map((id) => ({ id: `${id.repeat(16)}`, title: id, url: `https://e.com/${id}`, site: 's' }));
    const prompt = buildSummaryPrompt(articles, { siteName: 'テスト', length: 'long', points: true });
    expect(prompt).toContain('ちょうど3件');
    expect(prompt).toContain('```json で始まり ``` で終わるコードブロック1つだけ');
    expect(prompt).toContain('"status"（文字列）: 要約できた記事は "ok"、本文を読めなかった記事は "unavailable"');
    expect(prompt).toContain('\\" と書く');
    // 出力例と記事一覧はそれぞれ JSON として読める
    const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveLength(2);
    expect(Array.from(blocks[0][0].summary as string).length).toBeGreaterThanOrEqual(200);
    expect(blocks[1].map((article: { id: string }) => article.id)).toEqual(articles.map((article) => article.id));
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

  it('コードブロックが複数あれば配列をつなげる（回答が2回に分かれた場合）', () => {
    expect(extractJson('```json\n[{"id":"a"}]\n```\n続きです\n```json\n[{"id":"b"}]\n```')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('配列の括弧がなくオブジェクトが並んでいるだけでも読む', () => {
    expect(extractJson('{"id":"a"}\n{"id":"b"}')).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(extractJson('{"id":"a"},\n{"id":"b"},')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('JSON がなければ分かりやすいエラー', () => {
    expect(() => extractJson('ごめんなさい、できません')).toThrow('JSON が見つかりません');
    expect(() => extractJson('[{"id": "a"')).toThrow();
  });
});

describe('normalizeEntries', () => {
  it('配列・{summaries: [...]}・{id: 要約} の形を同じ形にそろえる', () => {
    const expected = [{ id: 'a', status: 'ok', summary: 'x', points: [], background: '', keywords: [] }];
    expect(normalizeEntries([{ id: 'a', summary: 'x' }])).toEqual(expected);
    expect(normalizeEntries({ summaries: [{ id: 'a', summary: 'x' }] })).toEqual(expected);
    expect(normalizeEntries({ a: 'x' })).toEqual(expected);
    expect(normalizeEntries({ a: { summary: 'x' } })).toEqual(expected);
  });

  it('項目名のゆれ・1件だけの回答・知らない包み方を吸収する', () => {
    const expected = [{ id: 'a', status: 'ok', summary: 'x', points: ['p'], background: '', keywords: [] }];
    expect(normalizeEntries([{ 記事ID: 'a', 状態: 'OK', 要約: 'x', 要点: ['p'] }])).toEqual(expected);
    expect(normalizeEntries({ id: 'a', summary: 'x', points: ['p'] })).toEqual(expected);
    expect(normalizeEntries({ output: [{ id: 'a', summary: 'x', points: ['p'] }] })).toEqual(expected);
  });

  it('要点の記号・番号を外し、文字列で返ってきた要点は行ごとに分ける', () => {
    expect(normalizeEntries([{ id: 'a', summary: 'x', points: ['・一つ目', '2. 二つ目', '③三つ目', '- Switch2/PS5向け'] }])[0].points).toEqual([
      '一つ目',
      '二つ目',
      '三つ目',
      'Switch2/PS5向け',
    ]);
    expect(normalizeEntries([{ id: 'a', summary: 'x', points: '・一つ目\n・二つ目' }])[0].points).toEqual(['一つ目', '二つ目']);
  });

  it('背景・キーワードを読み取る（日本語の項目名、文字列のキーワード、# 付きも）', () => {
    const [entry] = normalizeEntries([{ id: 'a', summary: 'x', 背景: '用語の説明', キーワード: '#任天堂、Switch 2, 新作' }]);
    expect(entry.background).toBe('用語の説明');
    expect(entry.keywords).toEqual(['任天堂', 'Switch 2', '新作']);
  });
});

describe('validateEntries（背景・キーワード）', () => {
  const lookup = () => ({ summarized: false });

  it('背景とキーワードを整えて受け付け、重複・長すぎるキーワードは外す', () => {
    const { accepted } = validateEntries(
      [
        {
          id: 'a',
          status: 'ok',
          summary: longSummary,
          points: [],
          background: '<b>量子化</b>は、AI モデルの数値の精度を下げて軽くする技術。',
          keywords: ['Qwen', 'Qwen', 'ゲーミングPC', 'あ'.repeat(40), '1', '2', '3', '4', '5'],
        },
      ],
      lookup,
    );
    expect(accepted[0].background).toBe('量子化は、AI モデルの数値の精度を下げて軽くする技術。');
    expect(accepted[0].keywords?.slice(0, 2)).toEqual(['Qwen', 'ゲーミングPC']);
    expect(accepted[0].keywords?.length).toBeLessThanOrEqual(6);
  });

  it('背景・キーワードがなくても受け付け、項目ごと省く', () => {
    const { accepted } = validateEntries([{ id: 'a', status: 'ok', summary: longSummary, points: [], background: '', keywords: [] }], lookup);
    expect(accepted[0]).not.toHaveProperty('background');
    expect(accepted[0]).not.toHaveProperty('keywords');
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

describe('断り文の判定', () => {
  const lookup = () => ({ summarized: false });
  const check = (summary: string, options = {}) => validateEntries([{ id: 'a', status: 'ok', summary, points: [] }], lookup, options);
  const news = [
    '大規模な通信障害で、同社のサイトにアクセスできない状態が数時間続いた。復旧の見通しは立っていない。',
    '障害でサイトにアクセスできず、利用者からは問い合わせが相次いだ。同社は原因を調べている。',
    '新しいアプリでは、買い物をするとポイントを取得できる。対象店舗は全国に広がる予定だという。',
    '同社の担当者は「詳細はお答えできません」と述べ、事故の原因については明らかにしなかった。',
  ];
  const refusals = [
    '申し訳ありませんが、このページの内容は確認できませんでした。別の記事をお試しください。',
    '記事にアクセスできませんでしたので、内容を確認できませんでした。再度お試しください。',
    '指定された URL を開けませんでした。ページが削除されている可能性があります。',
    'この記事は有料会員限定のため、要約できません。ログイン後の本文が必要です。',
    'I cannot access the article at this URL, so I am unable to summarize it here.',
  ];

  it('ニュースとして普通の文ははじかない', () => {
    for (const summary of news) expect(check(summary).accepted, summary).toHaveLength(1);
  });

  it('AI が読めなかったことの報告ははじく', () => {
    for (const summary of refusals) expect(check(summary).skipped, summary).toHaveLength(1);
  });

  it('運営者が直した要約では確認しない', () => {
    expect(check(refusals[0], { checkRefusal: false }).accepted).toHaveLength(1);
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

  it('背景・キーワードも保存し、手直しでは省略した項目はそのまま・空にした項目は消す', () => {
    const saved = toSummaryRecord(
      item('a'),
      { id: 'a', summary: longSummary, points: [], background: '背景の説明', keywords: ['A社', '新製品'], replaces: false },
      now,
    );
    expect(saved).toMatchObject({ background: '背景の説明', keywords: ['A社', '新製品'] });
    const later = new Date('2026-10-07T00:00:00.000Z');
    const kept = editSummaryRecord(saved, { summary: '直した要約', points: ['p'] }, later);
    expect(kept).toMatchObject({ summary: '直した要約', background: '背景の説明', keywords: ['A社', '新製品'], updatedAt: later.toISOString() });
    const cleared = editSummaryRecord(saved, { summary: '直した要約', points: [], background: '', keywords: [] }, later);
    expect(cleared).not.toHaveProperty('background');
    expect(cleared).not.toHaveProperty('keywords');
    expect(cleared.summarizedAt).toBe(saved.summarizedAt);
  });

  it('記事情報は回答ではなくサイトのデータから作る', () => {
    const saved = toSummaryRecord(item('a'), { id: 'a', summary: longSummary, points: ['p'], replaces: false }, now);
    expect(saved).toMatchObject({ id: 'a', title: 'タイトルa', url: 'https://example.com/a', summarizedAt: now.toISOString() });
  });
});
