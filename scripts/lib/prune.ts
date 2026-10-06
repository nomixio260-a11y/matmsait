import type { Item } from '../../src/lib/types.ts';

export interface PruneOptions {
  now: Date;
  maxAgeDays?: number;
  maxItems?: number;
}

/** 既存の記事を優先して新しい記事をマージする（同じIDは先に取得したものを残す） */
export function mergeItems(existing: Item[], incoming: Item[]): Item[] {
  const byId = new Map<string, Item>();
  for (const item of [...existing, ...incoming]) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** 新着順に並べ、古すぎる記事と上限超過分を削除する */
export function pruneItems(
  items: Item[],
  { now, maxAgeDays = 30, maxItems = 3000 }: PruneOptions,
): Item[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => new Date(item.publishedAt).getTime() >= cutoff)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, maxItems);
}
