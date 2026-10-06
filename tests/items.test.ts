import { describe, expect, it } from 'vitest';
import { allowsSummary, groupByDay, listItems, pickVaried } from '../src/lib/items.ts';
import { site } from '../src/config/site.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, publishedAt: string, sourceId = 's'): Item {
  return { id, title: id, url: `https://example.com/${id}`, excerpt: '', sourceId, category: 'news', publishedAt };
}

describe('groupByDay', () => {
  it('日本時間の日付ごとにまとめる', () => {
    const groups = groupByDay([
      item('a', '2026-10-06T03:00:00.000Z'), // 10/6 12:00 JST
      item('b', '2026-10-05T15:30:00.000Z'), // 10/6 00:30 JST
      item('c', '2026-10-05T14:30:00.000Z'), // 10/5 23:30 JST
    ]);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['2026-10-06', ['a', 'b']],
      ['2026-10-05', ['c']],
    ]);
    expect(groups[0].label).toBe('10月6日(火)');
  });
});

describe('pickVaried', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 3, 59 - minute)).toISOString();

  it('同じ掲載元は perSource 件までにして、新着順のまま選ぶ', () => {
    const items = [
      item('a1', at(0), 'a'),
      item('a2', at(1), 'a'),
      item('a3', at(2), 'a'),
      item('b1', at(3), 'b'),
      item('a4', at(4), 'a'),
      item('c1', at(5), 'c'),
    ];
    expect(pickVaried(items, 4, 2).map((i) => i.id)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });

  it('足りなければ外した記事で埋める（新着順）', () => {
    const items = [item('a1', at(0), 'a'), item('a2', at(1), 'a'), item('a3', at(2), 'a'), item('b1', at(3), 'b')];
    expect(pickVaried(items, 4, 1).map((i) => i.id)).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(pickVaried(items, 3, 1).map((i) => i.id)).toEqual(['a1', 'a2', 'b1']);
  });
});

describe('listItems', () => {
  it('一覧に載せるのは「1ページの件数 × 最大ページ数」まで', () => {
    const limit = site.pageSize * site.maxListPages;
    const items = Array.from({ length: limit + 5 }, (_, n) => item(`i${n}`, '2026-10-06T00:00:00.000Z'));
    expect(listItems(items)).toHaveLength(limit);
    expect(listItems(items.slice(0, 3))).toHaveLength(3);
  });
});

describe('allowsSummary', () => {
  const at = '2026-10-06T00:00:00.000Z';

  it('要約の掲載を禁じている掲載元（summary: false）の記事は、要約を作らない・載せない', () => {
    expect(allowsSummary({ ...item('a', at, 'aera-digital'), url: 'https://dot.asahi.com/articles/-/1' })).toBe(false);
  });

  it('登録していない（利用条件を確認していない・外した）サイトの記事は、要約を作らない・載せない', () => {
    expect(allowsSummary({ ...item('b', at, 'itmedia'), url: 'https://www.itmedia.co.jp/news/articles/1.html' })).toBe(false);
    expect(allowsSummary({ ...item('c', at, 'hatena-social'), url: 'https://example.com/news/3' })).toBe(false);
  });

  it('登録している掲載元の記事は、集約元経由で見つけたものも含めて要約できる', () => {
    expect(allowsSummary({ ...item('d', at, 'zenn'), url: 'https://zenn.dev/someone/articles/4' })).toBe(true);
    expect(allowsSummary({ ...item('e', at, 'hatena-it'), url: 'https://www.4gamer.net/games/1/' })).toBe(true);
  });
});
