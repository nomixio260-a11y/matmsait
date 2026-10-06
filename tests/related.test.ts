import { describe, expect, it } from 'vitest';
import { buildRelatedIndex, mainTitle, titleGrams } from '../src/lib/related.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, title: string, publishedAt = '2026-10-06T00:00:00.000Z'): Item {
  return { id, title, url: `https://example.com/${id}`, excerpt: '', sourceId: 's', category: 'news', publishedAt };
}

describe('mainTitle / titleGrams', () => {
  it('配信元の付け足しを除く', () => {
    expect(mainTitle('簗農相が発言を撤回 | 毎日新聞')).toBe('簗農相が発言を撤回');
    expect(mainTitle('簗農相が発言を撤回（NHK） - Yahoo!ニュース')).toBe('簗農相が発言を撤回');
    expect(mainTitle('簗農相が発言を撤回：朝日新聞')).toBe('簗農相が発言を撤回');
    expect([...titleGrams('Ab「C」')]).toEqual(['ab', 'bc']);
  });
});

describe('buildRelatedIndex', () => {
  const items = [
    item('a', '簗和生農相「道路予算カット」発言を撤回して謝罪 辞任は否定 | 毎日新聞'),
    item('b', '簗農相 地元の道路“予算カット”発言撤回 「深く反省」陳謝 | NHKニュース'),
    item('c', 'ファーウェイ「WATCH FIT 4」に高耐久なサファイアガラスモデル'),
    item('d', '岐阜vs山口 試合記録'),
    item('e', '愛媛vs群馬 試合記録'),
    item('f', '長野vs奈良 試合記録'),
    item('g', '松本vs鳥取 試合記録'),
    item('g2', '滋賀vs熊本 試合記録'),
    item('g3', '仙台vs磐田 試合記録'),
    item('h', '簗農相の予算カット発言を撤回、過去の記事', '2026-09-01T00:00:00.000Z'),
    ...Array.from({ length: 30 }, (_, i) => item(`x${i}`, `まったく関係のないニュース${i}番目の見出しです`)),
  ];
  const index = buildRelatedIndex(items);

  it('同じ話題の記事を見つける', () => {
    expect(index.related(items[0]).map((i) => i.id)).toEqual(['b']);
    expect(index.related(items[1]).map((i) => i.id)).toEqual(['a']);
  });

  it('決まり文句だけが共通の見出しは関連づけない', () => {
    expect(index.related(items[3])).toEqual([]);
  });

  it('関係のない記事・日付の離れた記事は含めない', () => {
    expect(index.related(items[2])).toEqual([]);
    expect(index.related(items[0]).some((i) => i.id === 'h')).toBe(false);
  });

  it('索引にない記事でも探せる', () => {
    expect(index.related(item('new', '簗農相が道路予算カット発言を撤回、謝罪')).map((i) => i.id)).toContain('a');
  });
});
