import { describe, expect, it } from 'vitest';
import { mergeItems, pruneItems } from '../scripts/lib/prune.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, publishedAt: string, title = id): Item {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    excerpt: '',
    sourceId: 's',
    category: 'news',
    publishedAt,
  };
}

describe('mergeItems', () => {
  it('同じIDは既存側を残して重複させない', () => {
    const merged = mergeItems(
      [item('a', '2026-01-01T00:00:00.000Z', '既存')],
      [item('a', '2026-01-02T00:00:00.000Z', '新規'), item('b', '2026-01-02T00:00:00.000Z')],
    );
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
    expect(merged[0].title).toBe('既存');
  });

  it('同じ記事を2回マージしても件数は増えない', () => {
    const items = [item('a', '2026-01-01T00:00:00.000Z')];
    expect(mergeItems(mergeItems([], items), items)).toHaveLength(1);
  });
});

describe('pruneItems', () => {
  const now = new Date('2026-02-01T00:00:00Z');

  it('新着順に並べ、期限切れを削除する', () => {
    const result = pruneItems(
      [
        item('old', '2025-12-01T00:00:00.000Z'),
        item('mid', '2026-01-20T00:00:00.000Z'),
        item('new', '2026-01-31T00:00:00.000Z'),
      ],
      { now, maxAgeDays: 30 },
    );
    expect(result.map((i) => i.id)).toEqual(['new', 'mid']);
  });

  it('上限件数で切り詰める', () => {
    const items = Array.from({ length: 5 }, (_, n) => item(`i${n}`, `2026-01-2${n}T00:00:00.000Z`));
    expect(pruneItems(items, { now, maxItems: 2 }).map((i) => i.id)).toEqual(['i4', 'i3']);
  });
});
