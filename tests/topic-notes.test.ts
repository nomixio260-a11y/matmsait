import { describe, expect, it } from 'vitest';
import {
  SENSATIONAL_WORDS,
  buildTopicNotePrompt,
  matchTopicNote,
  mergeTopicNotes,
  parseTopicNoteAnswer,
  parseTopicNoteFile,
  removeTopicNote,
  serializeTopicNoteFile,
  topicNoteFilePath,
  type TopicNote,
} from '../src/lib/topic-notes-core.ts';

const topic = {
  id: 'aaaa000000000001',
  title: 'ソニー、INZONE の新色を発売',
  firstAt: '2026-10-07T01:00:00.000Z',
  articles: [
    { id: 'aaaa000000000001', site: 'GAME Watch', title: 'ソニー、INZONE E9 の新色', url: 'https://example.com/a', excerpt: '抜粋A', publishedAt: '2026-10-07T01:00:00.000Z' },
    { id: 'bbbb000000000002', site: '4Gamer.net', title: 'INZONE E9 に新色', url: 'https://example.com/b', publishedAt: '2026-10-07T02:00:00.000Z' },
    { id: 'cccc000000000003', site: 'ASCII.jp', title: 'INZONE の新色が登場', url: 'https://example.com/c', publishedAt: '2026-10-07T03:00:00.000Z' },
  ],
};
const ids = topic.articles.map((article) => article.id);

const answer = (body: object) => `整理しました。\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;

describe('AI 整理のプロンプト', () => {
  it('記事の ID・URL と、事実と解釈を分けること・煽る言葉を使わないことを伝える', () => {
    const prompt = buildTopicNotePrompt(topic, { siteName: 'トピあつめ' });
    for (const article of topic.articles) {
      expect(prompt).toContain(article.id);
      expect(prompt).toContain(article.url);
    }
    expect(prompt).toContain('事実と解釈を分ける');
    expect(prompt).toContain('どちらが正しいかは判断せず');
    expect(prompt).toContain(SENSATIONAL_WORDS[0]);
    expect(prompt).toContain('記事一覧（3件）');
    // 抜粋のない記事には excerpt を入れない
    expect(prompt).not.toContain('"excerpt": ""');
  });
});

describe('AI 整理の回答の検証', () => {
  it('出典をトピックの記事に限り、形を整えて受け付ける', () => {
    const result = parseTopicNoteAnswer(
      answer({
        status: 'ok',
        common: [
          { text: 'ソニーは  INZONE E9 の<b>新色</b>を発表した。', sources: [ids[0], ids[1], 'zzzz999999999999'] },
          { text: '1つの記事にしかない話', sources: [ids[2]] },
        ],
        emphasis: [
          { source: ids[0], text: '価格を詳しく伝えている。' },
          { source: ids[0], text: '同じ記事の2つ目は入れない。' },
          { source: 'zzzz999999999999', text: '知らない記事' },
        ],
        differences: [{ text: '発売日を、A は10月22日、B は10月下旬と書いている。', sources: [ids[0], ids[1]] }],
        background: 'INZONE はソニーのゲーム向けブランド。',
        interpretation: '',
      }),
      ids,
    );
    expect(result.note).toEqual({
      common: [{ text: 'ソニーは INZONE E9 の新色を発表した。', sources: [ids[0], ids[1]] }],
      emphasis: [{ source: ids[0], text: '価格を詳しく伝えている。' }],
      differences: [{ text: '発売日を、A は10月22日、B は10月下旬と書いている。', sources: [ids[0], ids[1]] }],
      background: 'INZONE はソニーのゲーム向けブランド。',
    });
    expect(result.issues.join('\n')).toContain('出典の記事が2つ未満');
    expect(result.issues.join('\n')).toContain('zzzz999999999999');
  });

  it('煽る言葉・読めなかった回答・共通の事実がない回答は受け付けない', () => {
    const base = { status: 'ok', common: [{ text: '新色を発表した。', sources: [ids[0], ids[1]] }], emphasis: [], differences: [] };
    expect(parseTopicNoteAnswer(answer({ ...base, interpretation: '衝撃の新色だ。' }), ids).note).toBeUndefined();
    expect(parseTopicNoteAnswer(answer({ ...base, interpretation: '衝撃の新色だ。' }), ids).issues[0]).toContain('煽る言葉');
    expect(parseTopicNoteAnswer(answer({ status: 'unavailable' }), ids).note).toBeUndefined();
    expect(parseTopicNoteAnswer(answer({ status: 'ok', common: [] }), ids).issues.join('')).toContain('共通して報じられていること');
    expect(parseTopicNoteAnswer('これは JSON ではありません', ids).issues[0]).toContain('JSON');
    expect(parseTopicNoteAnswer(answer({ ...base, background: '詳しくは https://example.com/x へ' }), ids).note).toBeUndefined();
  });
});

describe('AI 整理の保存ファイル', () => {
  const note = (topicId: string, items: string[], notedAt: string): TopicNote => ({
    topic: topicId,
    items,
    title: '見出し',
    firstAt: '2026-10-07T01:00:00.000Z',
    common: [{ text: '共通の事実', sources: items.slice(0, 2) }],
    emphasis: [],
    differences: [],
    notedAt,
  });

  it('トピックの最初の報道の月（日本時間）ごとのファイル', () => {
    expect(topicNoteFilePath('2026-09-30T16:00:00.000Z')).toBe('data/topic-notes/2026-10.json');
    expect(topicNoteFilePath('2026-09-30T14:00:00.000Z')).toBe('data/topic-notes/2026-09.json');
  });

  it('記事が重なる整理は新しいものに置き換え、読み書きできる', () => {
    const old = note('t1', ['a', 'b'], '2026-10-07T00:00:00.000Z');
    const other = note('t2', ['x', 'y'], '2026-10-07T01:00:00.000Z');
    const renewed = note('t1b', ['b', 'c'], '2026-10-08T00:00:00.000Z');
    const merged = mergeTopicNotes([old, other], renewed);
    expect(merged.map((entry) => entry.topic)).toEqual(['t1b', 't2']);
    expect(parseTopicNoteFile(serializeTopicNoteFile(merged))).toEqual(merged);
    expect(removeTopicNote(merged, 't2').map((entry) => entry.topic)).toEqual(['t1b']);
    expect(parseTopicNoteFile('')).toEqual([]);
    expect(() => parseTopicNoteFile('{}')).toThrow();
  });

  it('いまのトピックの記事といちばん多く重なる整理を選ぶ（トピックの ID が変わっても）', () => {
    const notes = [note('t1', ['a', 'b'], '2026-10-07T00:00:00.000Z'), note('t2', ['b', 'c', 'd'], '2026-10-06T00:00:00.000Z')];
    expect(matchTopicNote(notes, ['z', 'b', 'c'])?.topic).toBe('t2');
    expect(matchTopicNote(notes, ['a'])?.topic).toBe('t1');
    expect(matchTopicNote(notes, ['q'])).toBeUndefined();
  });
});
