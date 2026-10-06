import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories } from '../config/site.ts';
import { loadSources } from './sources.ts';
import type { Item, Source } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const ITEMS_PATH = resolve(process.cwd(), 'data/items.json');
const HOUR = 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Tokyo';

/** ビルド時刻（ランキングの集計基準・最終更新の表示に使う） */
export const builtAt = new Date();

let itemsCache: Item[] | undefined;

/** 収集済み記事を新着順で返す（ビルド時に1回だけ読み込む） */
export function getItems(): Item[] {
  if (!itemsCache) {
    const items: Item[] = existsSync(ITEMS_PATH) ? JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) : [];
    itemsCache = items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  return itemsCache;
}

export function getItemsByCategory(slug: string): Item[] {
  return getItems().filter((item) => item.category === slug);
}

export function getItemsBySource(id: string): Item[] {
  return getItems().filter((item) => item.sourceId === id);
}

export function countByCategory(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of getItems()) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return counts;
}

export interface RankingOptions {
  /** 公開からこの時間以内の記事を対象にする */
  hours?: number;
  category?: string;
  limit?: number;
}

/** はてなブックマーク数の多い順に並べた人気記事 */
export function getRanking({ hours = 24, category, limit = 10 }: RankingOptions = {}): Item[] {
  const cutoff = builtAt.getTime() - hours * HOUR;
  return getItems()
    .filter(
      (item) =>
        (item.hatebu ?? 0) > 0 &&
        Date.parse(item.publishedAt) >= cutoff &&
        (!category || item.category === category),
    )
    .sort((a, b) => (b.hatebu ?? 0) - (a.hatebu ?? 0) || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}

let sourceMap: Map<string, Source> | undefined;
let hostMap: Map<string, Source> | undefined;

function getSourceMap(): Map<string, Source> {
  sourceMap ??= new Map(loadSources().map((source) => [source.id, source]));
  return sourceMap;
}

export function getSources(): Source[] {
  return [...getSourceMap().values()];
}

export function getSource(id: string): Source | undefined {
  return getSourceMap().get(id);
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

/** 記事のホストと同じサイトの配信元（集約元を除く） */
function getSourceByHost(host: string): Source | undefined {
  hostMap ??= new Map(
    getSources()
      .filter((source) => !source.aggregator)
      .map((source) => [hostOf(source.siteUrl), source]),
  );
  return hostMap.get(host);
}

export interface SiteInfo {
  /** 表示名（配信元の名前、不明ならホスト名） */
  label: string;
  host: string;
  /** 掲載元ページへリンクできる配信元 */
  source?: Source;
}

/** 記事の出典。はてブ経由の記事でも、元サイトが掲載元にあればその名前で表示する */
export function siteOf(item: Item): SiteInfo {
  const host = hostOf(item.url);
  const source = getSource(item.sourceId);
  if (source && !source.aggregator) return { label: source.name, host, source };
  const direct = getSourceByHost(host);
  return direct ? { label: direct.name, host, source: direct } : { label: host, host };
}

export function getCategory(slug: string) {
  return categories.find((c) => c.slug === slug);
}

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dayLabelFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE,
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE,
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export interface DayGroup {
  key: string;
  label: string;
  items: Item[];
}

/** 新着順の記事を日本時間の日付ごとにまとめる */
export function groupByDay(items: Item[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const date = new Date(item.publishedAt);
    const key = dayKeyFormat.format(date);
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabelFormat.format(date), items: [item] });
  }
  return groups;
}

/** 「11:30」 */
export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** 「10/6 11:30」 */
export function formatDateTime(iso: string | Date): string {
  return dateTimeFormat.format(new Date(iso));
}

/** base パスを考慮したサイト内リンクを作る（path は "/" 始まり） */
export function href(path: string): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + path;
}

/** ファビコン画像のURL（Google のファビコン取得サービス） */
export function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}
