import { describe, expect, it } from 'vitest';
import { mergeItems, pruneItems, serializeItems } from '../scripts/lib/store.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, publishedAt: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    excerpt: '',
    sourceId: 's',
    category: 'news',
    publishedAt,
    ...extra,
  };
}

describe('mergeItems', () => {
  it('同じIDは既存側を残して重複させない', () => {
    const merged = mergeItems(
      [item('a', '2026-01-01T00:00:00.000Z', { title: '既存' })],
      [item('a', '2026-01-02T00:00:00.000Z', { title: '新規' }), item('b', '2026-01-02T00:00:00.000Z')],
    );
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
    expect(merged[0].title).toBe('既存');
  });

  it('同じ記事を2回マージしても件数は増えない', () => {
    const items = [item('a', '2026-01-01T00:00:00.000Z')];
    expect(mergeItems(mergeItems([], items), items)).toHaveLength(1);
  });

  it('集約元経由の記事は配信元のフィードの情報で置き換え、はてブ数は引き継ぐ', () => {
    const isAggregator = (id: string) => id === 'hatena';
    const viaHatena = item('a', '2026-01-02T00:00:00.000Z', { sourceId: 'hatena', category: 'life', hatebu: 120 });
    const direct = item('a', '2026-01-01T09:00:00.000Z', { sourceId: 'publisher', category: 'tech', excerpt: '本文' });
    const [merged] = mergeItems([viaHatena], [direct], isAggregator);
    expect(merged).toMatchObject({ sourceId: 'publisher', category: 'tech', excerpt: '本文', hatebu: 120 });
    expect(merged.publishedAt).toBe('2026-01-01T09:00:00.000Z');
  });

  it('配信元の記事を集約元の記事で上書きしない', () => {
    const isAggregator = (id: string) => id === 'hatena';
    const direct = item('a', '2026-01-01T00:00:00.000Z', { sourceId: 'publisher' });
    const viaHatena = item('a', '2026-01-02T00:00:00.000Z', { sourceId: 'hatena', excerpt: '抜粋' });
    const [merged] = mergeItems([direct], [viaHatena], isAggregator);
    expect(merged.sourceId).toBe('publisher');
    expect(merged.excerpt).toBe('抜粋');
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

describe('serializeItems', () => {
  it('1記事1行で書き出し、そのまま読み戻せる', () => {
    const items = [item('a', '2026-01-01T00:00:00.000Z'), item('b', '2026-01-02T00:00:00.000Z', { hatebu: 3 })];
    const text = serializeItems(items);
    expect(text.split('\n')).toHaveLength(5);
    expect(JSON.parse(text)).toEqual(items);
    expect(JSON.parse(serializeItems([]))).toEqual([]);
  });
});
