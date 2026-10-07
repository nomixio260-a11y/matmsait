import { describe, expect, it } from 'vitest';
import {
  FOLLOW_LIMITS,
  cleanFollow,
  cleanMute,
  containsTerm,
  isEmptyPrefs,
  matchFollow,
  parseUpdates,
  withBase,
  type UpdateEntry,
} from '../src/lib/follow-core.ts';
import { normalizeText } from '../src/lib/search-core.ts';

const entry = (over: Partial<UpdateEntry> = {}): UpdateEntry => ({
  i: '0123456789abcdef',
  t: '新しいスマホが発表',
  c: 'tech',
  s: 'gigazine',
  n: 'GIGAZINE',
  u: 'https://gigazine.net/news/1/',
  d: '2026-10-07T01:00:00.000Z',
  ...over,
});

describe('フォロー・ミュートの設定', () => {
  it('形の正しくないもの・重複・多すぎるものを除く（キーワードは表記ゆれも重複とみなす）', () => {
    const follow = cleanFollow({
      cats: ['tech', 'tech', 'Bad Slug', 3, 'news'],
      srcs: ['gigazine', '../evil', ''],
      words: ['ＡＩ', 'ai', ' 東京  地震 ', 'x'.repeat(FOLLOW_LIMITS.wordLength + 1), 'カメラ', 'かめら', 'ok\u0000'],
    });
    expect(follow).toEqual({ cats: ['tech', 'news'], srcs: ['gigazine'], words: ['AI', '東京 地震', 'カメラ', 'ok'] });
    expect(cleanFollow('nonsense')).toEqual({ cats: [], srcs: [], words: [] });
    expect(cleanMute({ words: Array.from({ length: 100 }, (_, i) => `w${i}`) }).words).toHaveLength(FOLLOW_LIMITS.words);
    expect(isEmptyPrefs(cleanFollow({}))).toBe(true);
  });

  it('英数字だけのキーワードは、前後が英数字でないときだけ当てはまる', () => {
    const t = (title: string) => normalizeText(title);
    expect(containsTerm(t('生成AIの新機能'), 'ai')).toBe(true);
    expect(containsTerm(t('AIエージェント'), 'ai')).toBe(true);
    expect(containsTerm(t('Gmailの不具合'), 'ai')).toBe(false);
    expect(containsTerm(t('OpenAI と Google'), 'ai')).toBe(false);
    expect(containsTerm(t('ＧＰＵ不足'), 'gpu')).toBe(true);
    expect(containsTerm(t('カメラの新製品'), normalizeText('かめら'))).toBe(true);
  });
});

describe('フォローに当てはまる新着', () => {
  const entries = [
    entry({ i: '0000000000000001', t: '生成AIの新しいモデル', c: 'tech', s: 'itmedia' }),
    entry({ i: '0000000000000002', t: 'プロ野球 日本シリーズ', c: 'sports', s: 'full-count' }),
    entry({ i: '0000000000000003', t: 'ゲーム機の値上げ', c: 'game', s: '4gamer' }),
    entry({ i: '0000000000000004', t: 'セールでAIスピーカーが安い', c: 'tech', s: 'gigazine' }),
    entry({ i: '0000000000000005', t: '東京で震度3の地震', c: 'news', s: 'fnn' }),
  ];

  it('キーワード → 掲載元 → ジャンルの順に理由を付け、ミュートしたものは除く', () => {
    const matches = matchFollow(entries, { cats: ['sports', 'tech'], srcs: ['4gamer'], words: ['AI', '東京 地震'] }, { cats: [], srcs: [], words: ['セール'] });
    expect(matches.map((match) => [match.entry.i, match.reason])).toEqual([
      ['0000000000000001', { kind: 'word', value: 'AI' }],
      ['0000000000000002', { kind: 'cat', value: 'sports' }],
      ['0000000000000003', { kind: 'src', value: '4gamer' }],
      ['0000000000000005', { kind: 'word', value: '東京 地震' }],
    ]);
  });

  it('ジャンルのミュートは、そのジャンルをフォローしていないときだけ効く', () => {
    const mute = { cats: ['tech'], srcs: [], words: [] };
    expect(matchFollow(entries, { cats: [], srcs: [], words: ['AI'] }, mute)).toHaveLength(0);
    expect(matchFollow(entries, { cats: ['tech'], srcs: [], words: ['AI'] }, mute)).toHaveLength(2);
    // 掲載元のミュートはいつも効く
    expect(matchFollow(entries, { cats: ['tech'], srcs: [], words: [] }, { cats: [], srcs: ['itmedia'], words: [] }).map((m) => m.entry.i)).toEqual([
      '0000000000000004',
    ]);
  });
});

describe('updates.json', () => {
  it('形の正しい記事・話題だけを読み、ベースパスとジャンルの名前を確かめる', () => {
    const file = parseUpdates(
      JSON.stringify({
        builtAt: '2026-10-07T02:00:00.000Z',
        base: '/matmsait/',
        cats: { tech: 'テクノロジー', 'Bad Slug': 'x', news: 3 },
        items: [
          entry({ k: 3, m: 1, u: '/summary/0123456789abcdef/' }),
          { ...entry(), i: 'bad' },
          { ...entry(), u: 'javascript:alert(1)' },
          { ...entry(), u: '//evil.example/' },
          { ...entry(), d: 'not a date' },
        ],
        hot: [
          { i: ['0123456789abcdef', 'nope'], t: '話題', k: 5, u: '/summary/0123456789abcdef/' },
          { i: ['0123456789abcdef'], t: '外へのリンク', k: 5, u: 'https://evil.example/' },
          { i: [], t: '記事なし', k: 5, u: '/' },
        ],
      }),
    );
    expect(file?.base).toBe('/matmsait/');
    expect(file?.cats).toEqual({ tech: 'テクノロジー' });
    expect(file?.items).toEqual([entry({ k: 3, m: 1, u: '/summary/0123456789abcdef/' })]);
    expect(file?.hot).toEqual([{ i: ['0123456789abcdef'], t: '話題', k: 5, u: '/summary/0123456789abcdef/' }]);
    expect(parseUpdates(JSON.stringify({ base: '//evil', items: [] }))?.base).toBe('/');
    expect(parseUpdates('{broken')).toBeUndefined();
    expect(parseUpdates(JSON.stringify({ items: 'x' }))).toBeUndefined();
  });

  it('サイト内のパスにベースパスを付ける（元記事の URL はそのまま）', () => {
    expect(withBase('/summary/x/', '/matmsait/')).toBe('/matmsait/summary/x/');
    expect(withBase('/following/', '/')).toBe('/following/');
    expect(withBase('https://example.com/a', '/matmsait/')).toBe('https://example.com/a');
  });
});
