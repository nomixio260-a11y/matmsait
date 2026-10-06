import { describe, expect, it } from 'vitest';
import { groupByDay } from '../src/lib/items.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, publishedAt: string): Item {
  return { id, title: id, url: `https://example.com/${id}`, excerpt: '', sourceId: 's', category: 'news', publishedAt };
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
