import { describe, expect, it } from 'vitest';
import {
  highlightParts,
  interpretQuery,
  matchPlace,
  matchWords,
  normalizeText,
  parseQuery,
  rankEntries,
  rankTopics,
  suggestKeywords,
  type SearchEntry,
  type TopicEntry,
  type WordEntry,
} from '../src/lib/search-core.ts';

const now = Date.parse('2026-10-06T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now - hours * 3600e3).toISOString();

function entry(i: string, t: string, extra: Partial<SearchEntry> = {}): SearchEntry {
  return { i, t, u: `https://example.com/${i}`, s: '例のサイト', h: 'example.com', c: 'tech', d: hoursAgo(1), ...extra };
}

describe('normalizeText / parseQuery', () => {
  it('全角・半角、大文字・小文字、カタカナ・ひらがなの違いを吸収する', () => {
    expect(normalizeText('ＡＩ ニュース')).toBe(normalizeText('ai にゅーす'));
    expect(normalizeText('ｶﾒﾗ')).toBe(normalizeText('かめら'));
  });

  it('全角スペースも区切りにする', () => {
    expect(parseQuery('　大谷　ホームラン ').words).toEqual(['大谷', 'ホームラン']);
  });
});

describe('rankEntries', () => {
  const entries = [
    entry('title', 'AIで変わる仕事の未来'),
    entry('summary', '新しいサービスの発表', { m: '生成AIを使った新しい翻訳サービスを公開した。' }),
    entry('excerpt', '新製品の紹介', { e: 'AIカメラを搭載した…' }),
    entry('old', 'AIの歴史を振り返る', { d: hoursAgo(24 * 10) }),
    entry('sports', 'サッカー日本代表が勝利', { c: 'sports' }),
  ];

  it('すべての検索語を含む記事だけを、見出し > 要約・抜粋の順に並べる', () => {
    const ids = rankEntries(entries, parseQuery('ai').terms, { now }).map((e) => e.i);
    expect(ids[0]).toBe('title');
    expect(ids).toContain('summary');
    expect(ids).toContain('excerpt');
    expect(ids).not.toContain('sports');
    expect(rankEntries(entries, parseQuery('ai 翻訳').terms, { now }).map((e) => e.i)).toEqual(['summary']);
  });

  it('カテゴリ・期間・要約ありで絞り込み、新しい順にも並べられる', () => {
    expect(rankEntries(entries, [], { now, category: 'sports' }).map((e) => e.i)).toEqual(['sports']);
    expect(rankEntries(entries, parseQuery('ai').terms, { now, days: 3 }).map((e) => e.i)).not.toContain('old');
    expect(rankEntries(entries, parseQuery('ai').terms, { now, summaryOnly: true }).map((e) => e.i)).toEqual(['summary']);
    const newest = rankEntries(entries, parseQuery('ai').terms, { now, sort: 'new' });
    expect(newest.at(-1)?.i).toBe('old');
  });

  it('AI 要約のキーワードでも見つかり、要約の本文だけの一致より上に並ぶ', () => {
    const withKeywords = [
      entry('body', 'ゲームの新作', { m: 'Steamで配信する新作を発表した。' }),
      entry('keyword', 'ゲームの新作発表', { m: '新作のRPGを発表した。', k: 'Steam RPG' }),
    ];
    expect(rankEntries(withKeywords, parseQuery('steam').terms, { now }).map((e) => e.i)).toEqual(['keyword', 'body']);
  });
});

describe('highlightParts', () => {
  it('表記の違いを吸収して一致した部分を元の文字列のまま返す', () => {
    expect(highlightParts('新型ＡＩカメラ', ['ai'])).toEqual([
      { text: '新型', match: false },
      { text: 'ＡＩ', match: true },
      { text: 'カメラ', match: false },
    ]);
    expect(highlightParts('ニュースまとめ', [normalizeText('にゅーす')])[0]).toEqual({ text: 'ニュース', match: true });
    expect(highlightParts('一致しない', ['xyz'])).toEqual([{ text: '一致しない', match: false }]);
  });

  it('検索欄に入力したままの言葉（parseQuery の terms）で一致部分を探せる', () => {
    const { terms } = parseQuery('AI えーじぇんと');
    expect(highlightParts('AIエージェントが登場', terms).filter((part) => part.match).map((part) => part.text)).toEqual([
      'AIエージェント',
    ]);
  });
});

describe('suggestKeywords', () => {
  it('直近の見出しによく出てくる言葉を、ありふれた言葉を除いて返す', () => {
    const titles = [
      'ChatGPTに新機能、画像を編集',
      'ChatGPTの料金が改定',
      'ChatGPTで旅行の計画',
      '大谷翔平が2打席連続ホームラン',
      '大谷翔平、今季50号',
      '大谷翔平の活躍に米メディア称賛',
      '新製品を発表 発表会は来月',
      '新製品の発表を延期',
      '新製品の発表、価格は未定',
    ];
    const entries = titles.map((t, n) => entry(`k${n}`, t));
    const keywords = suggestKeywords(entries, now);
    expect(keywords).toContain('ChatGPT');
    expect(keywords).toContain('大谷翔平');
    expect(keywords).not.toContain('発表');
    expect(suggestKeywords([...entries.map((e) => ({ ...e, d: hoursAgo(100) }))], now)).toEqual([]);
  });

  it('1つの掲載元の見出しにしか出ない言葉（サイト名などの決まり文句）は、minSources で除ける', () => {
    const entries = [
      { t: '新しい施策を発表｜SITEPLUS', d: hoursAgo(1), s: 'X' },
      { t: '話題の映画の裏側｜SITEPLUS', d: hoursAgo(2), s: 'X' },
      { t: '人気の店に行列｜SITEPLUS', d: hoursAgo(3), s: 'X' },
      { t: 'ChatGPTに新機能', d: hoursAgo(1), s: 'A' },
      { t: 'ChatGPTの料金が改定', d: hoursAgo(1), s: 'B' },
      { t: 'ChatGPTで旅行の計画', d: hoursAgo(1), s: 'A' },
    ];
    expect(suggestKeywords(entries, now)).toContain('SITEPLUS');
    const keywords = suggestKeywords(entries, now, { minSources: 2 });
    expect(keywords).toContain('ChatGPT');
    expect(keywords).not.toContain('SITEPLUS');
  });
});

describe('言葉での検索', () => {
  const categories = [
    { slug: 'tech', name: 'テクノロジー' },
    { slug: 'game', name: 'ゲーム・アニメ' },
  ];

  it('期間・並べ方・ジャンル・AI 要約の言葉を条件として読み、残りを検索語にする', () => {
    const query = interpretQuery('今日 急上昇 AI テクノロジー', categories);
    expect(query).toMatchObject({ days: 1, kind: 'rising', category: 'tech', words: ['AI'], terms: ['ai'] });
    expect(query.conditions.map((condition) => condition.meaning)).toEqual(['24時間以内', '報じる媒体が増えているトピックを先に', 'ジャンル「テクノロジー」']);
    expect(interpretQuery('アニメ 新着', categories)).toMatchObject({ category: 'game', kind: 'new', words: [] });
    expect(interpretQuery('AI要約 Apple')).toMatchObject({ summaryOnly: true, words: ['Apple'] });
    // 条件の言葉がなければ、すべて検索語
    expect(interpretQuery('大谷翔平 本塁打')).toMatchObject({ words: ['大谷翔平', '本塁打'], conditions: [] });
  });

  const topics: TopicEntry[] = [
    { i: 't1', t: 'INZONE の新色', w: 'inzoneの新色 そにー inzone', v: 5, sc: 50, g: 0, d: '2026-10-07T10:00:00.000Z', c: 'tech' },
    { i: 't2', t: 'ドジャース勝利', w: 'どじゃーす勝利 山本由伸', v: 4, sc: 40, g: 3, d: '2026-10-07T11:00:00.000Z', c: 'sports' },
    { i: 't3', t: '古い話', w: 'inzone 古い', v: 2, sc: 10, g: 0, d: '2026-10-01T00:00:00.000Z', c: 'tech' },
  ];
  const at = Date.parse('2026-10-07T12:00:00.000Z');

  it('トピックを、検索語（どれかの記事の見出し）と条件で探し、並べ方を変える', () => {
    expect(rankTopics(topics, interpretQuery('INZONE'), at).map((topic) => topic.i)).toEqual(['t1', 't3']);
    expect(rankTopics(topics, interpretQuery('今日 INZONE'), at).map((topic) => topic.i)).toEqual(['t1']);
    expect(rankTopics(topics, interpretQuery('急上昇'), at).map((topic) => topic.i)).toEqual(['t2']);
    expect(rankTopics(topics, interpretQuery('新着'), at).map((topic) => topic.i)).toEqual(['t2', 't1', 't3']);
    expect(rankTopics(topics, interpretQuery('テクノロジー', [{ slug: 'tech', name: 'テクノロジー' }]), at).map((topic) => topic.i)).toEqual(['t1', 't3']);
  });

  it('キーワードのページと、記事のどこで一致したか', () => {
    const words: WordEntry[] = [
      { w: 'INZONE', s: 'INZONE', n: 8 },
      { w: 'INZONE H9 II', s: 'INZONE-H9-II', n: 4 },
      { w: 'ソニー', s: 'ソニー', n: 10 },
    ];
    expect(matchWords(words, ['inzone']).map((entry) => entry.w)).toEqual(['INZONE', 'INZONE H9 II']);
    expect(matchWords(words, ['そにーの新製品']).map((entry) => entry.w)).toEqual(['ソニー']);
    expect(matchWords(words, [])).toEqual([]);
    const article: SearchEntry = { i: 'a', t: 'ソニーの新製品', u: 'https://example.com', s: 'GAME Watch', h: 'game.watch.impress.co.jp', c: 'tech', d: '2026-10-07T00:00:00.000Z', m: 'INZONE の新色を発表した', k: 'INZONE ソニー' };
    expect(matchPlace(article, ['そにー'])).toBe('title');
    expect(matchPlace(article, ['inzone'])).toBe('keywords');
    expect(matchPlace(article, ['新色'])).toBe('summary');
    expect(matchPlace(article, ['game'])).toBe('site');
  });
});
