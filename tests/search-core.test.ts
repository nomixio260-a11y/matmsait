import { describe, expect, it } from 'vitest';
import { highlightParts, normalizeText, parseQuery, rankEntries, suggestKeywords, type SearchEntry } from '../src/lib/search-core.ts';

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
