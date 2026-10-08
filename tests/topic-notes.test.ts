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

  it('要約と同じ基準（核心を先に・重複なし・単位・日付・主張と事実・宣伝の言葉・予想を書かない）を伝える', () => {
    const prompt = buildTopicNotePrompt(topic, { siteName: 'トピあつめ' });
    expect(prompt).toContain('重要な情報は残し、不要な情報は削り、記事にないことは書かない');
    expect(prompt).toContain('1つ目にはニュースの核心（誰が・何を・どうした）');
    expect(prompt).toContain('同じ事実を何度も書かない');
    expect(prompt).toContain('勝手に1つにまとめず、「A は10人、B は12人と書いている」');
    expect(prompt).toContain('将来の予想・評価・感想（「〜だろう」「大きな影響を与える」「今後の動向が注目される」）は書かない');
    expect(prompt).toContain('単位（円・%・人 など）');
    expect(prompt).toContain('publishedAt をもとに「10月7日」');
    expect(prompt).toContain('「〜と発表した」「〜としている」「〜によると」');
    expect(prompt).toContain('革新的・画期的・圧倒的');
    // 出力例の整理・解釈も、予想や「注目」を書かない
    expect(prompt).not.toContain('注目が集まっている可能性がある');
  });
});

describe('AI 整理の要確認', () => {
  it('宣伝の言葉・定型文・予想・あいまいな日付を要確認に出す（保存は止めない）', () => {
    const result = parseTopicNoteAnswer(
      answer({
        status: 'ok',
        common: [{ text: 'ソニーは本日、画期的な新色を発表した。', sources: [ids[0], ids[1]] }],
        emphasis: [],
        differences: [],
        background: '',
        interpretation: 'ゲーム市場に大きな影響を与えるだろう。',
      }),
      ids,
    );
    expect(result.note).toBeDefined();
    expect(result.warnings).toEqual([
      expect.stringMatching(/^共通して報じられていること: 宣伝・評価の言葉「画期的」/),
      expect.stringMatching(/^共通して報じられていること: 「本日」は/),
      expect.stringMatching(/^整理・解釈: 中身のない定型文・評価「大きな影響を与える」/),
      expect.stringMatching(/^整理・解釈: 推測の言い方「だろう」/),
    ]);
  });

  it('問題のない整理には要確認を付けない', () => {
    const result = parseTopicNoteAnswer(
      answer({
        status: 'ok',
        common: [{ text: 'ソニーは10月7日、INZONE E9 の新色を10月22日に発売すると発表した。', sources: [ids[0], ids[1]] }],
        emphasis: [],
        differences: [],
        background: '',
        interpretation: '3つの記事とも発売日を中心に伝えており、価格はどの記事も伝えていない。',
      }),
      ids,
    );
    expect(result.note).toBeDefined();
    expect(result).not.toHaveProperty('warnings');
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
