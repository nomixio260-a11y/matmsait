import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories } from '../config/site.ts';
import { loadSources } from './sources.ts';
import type { Item, Source } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const ITEMS_PATH = resolve(process.cwd(), 'data/items.json');

let cache: Item[] | undefined;

/** 収集済み記事を新着順で返す（ビルド時に1回だけ読み込む） */
export function getItems(): Item[] {
  if (!cache) {
    const items: Item[] = existsSync(ITEMS_PATH) ? JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) : [];
    cache = items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  return cache;
}

export function getItemsByCategory(slug: string): Item[] {
  return getItems().filter((item) => item.category === slug);
}

export function getItemsBySource(id: string): Item[] {
  return getItems().filter((item) => item.sourceId === id);
}

let sourceMap: Map<string, Source> | undefined;

export function getSources(): Source[] {
  return [...getSourceMap().values()];
}

export function getSource(id: string): Source | undefined {
  return getSourceMap().get(id);
}

function getSourceMap(): Map<string, Source> {
  sourceMap ??= new Map(loadSources().map((s) => [s.id, s]));
  return sourceMap;
}

export function getCategory(slug: string) {
  return categories.find((c) => c.slug === slug);
}

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** 日本時間で「10/6 11:30」形式にする */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** base パスを考慮したサイト内リンクを作る（path は "/" 始まり） */
export function href(path: string): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + path;
}
