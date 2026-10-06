import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Item } from '../../src/lib/types.ts';

export interface PruneOptions {
  now: Date;
  maxAgeDays?: number;
  maxItems?: number;
}

/**
 * 記事をIDで重複排除しながらマージする。
 * 基本は先に取得した方を残すが、はてブ等の集約元経由の記事を配信元自身のフィードで取得できた場合は
 * 配信元の情報（カテゴリ・公開日時・抜粋）に置き換える。
 */
export function mergeItems(
  existing: Item[],
  incoming: Item[],
  isAggregator: (sourceId: string) => boolean = () => false,
): Item[] {
  const byId = new Map<string, Item>();
  for (const item of [...existing, ...incoming]) {
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      continue;
    }
    const preferNew = isAggregator(prev.sourceId) && !isAggregator(item.sourceId);
    const [kept, other] = preferNew ? [item, prev] : [prev, item];
    const merged: Item = { ...kept, excerpt: kept.excerpt || other.excerpt };
    const hatebu = Math.max(kept.hatebu ?? 0, other.hatebu ?? 0);
    if (hatebu > 0) merged.hatebu = hatebu;
    byId.set(item.id, merged);
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

/** 1記事1行のJSONにする（ファイルを小さく保ちつつ、git の差分も記事単位で見やすくする） */
export function serializeItems(items: Item[]): string {
  return items.length === 0 ? '[]\n' : `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
}

/** items.json を読む。無い・壊れている場合は空配列 */
export function readItemsFile(path: string): Item[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(data) ? (data as Item[]) : [];
  } catch (error) {
    console.warn(`${path} を読み込めないため空として扱います: ${error}`);
    return [];
  }
}

export function writeItemsFile(path: string, items: Item[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeItems(items));
}
