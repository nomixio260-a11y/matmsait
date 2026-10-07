import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories, site } from '../config/site.ts';
import { isHidden } from './blocklist.ts';
import { loadSources } from './sources.ts';
import type { Item, Source } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const ITEMS_PATH = resolve(process.cwd(), 'data/items.json');
const TIME_ZONE = 'Asia/Tokyo';

/** ビルド時刻（ランキングの集計基準・最終更新の表示に使う） */
export const builtAt = new Date();

let allItemsCache: Item[] | undefined;
let itemsCache: Item[] | undefined;

/**
 * 収集済みのすべての記事を新着順で返す（非表示の記事を含む。ビルド時に1回だけ読み込む）。
 * sources.yaml から外した掲載元の記事は、次の収集で消えるまでの間も載せない
 */
export function getAllItems(): Item[] {
  if (!allItemsCache) {
    const items: (Item & { hatebu?: number })[] = existsSync(ITEMS_PATH)
      ? JSON.parse(readFileSync(ITEMS_PATH, 'utf8'))
      : [];
    allItemsCache = items
      .filter((item) => getSourceMap().has(item.sourceId))
      .map(({ hatebu: _, ...item }) => item)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  return allItemsCache;
}

/** サイトに載せる記事を新着順で返す（管理画面で非表示にした記事を除く） */
export function getItems(): Item[] {
  itemsCache ??= getAllItems().filter((item) => !isHidden(item));
  return itemsCache;
}

export function getItemsByCategory(slug: string): Item[] {
  return getItems().filter((item) => item.category === slug);
}

export function getItemsBySource(id: string): Item[] {
  return getItems().filter((item) => item.sourceId === id);
}

/** 一覧ページ（新着・カテゴリ別・掲載元別）に載せる記事。ページを作りすぎないよう新しい順に上限まで */
export function listItems(items: Item[]): Item[] {
  return items.slice(0, site.pageSize * site.maxListPages);
}

/**
 * 新着順のまま、同じ掲載元が続きすぎないように選ぶ（トップページの「新着」など、件数の少ない一覧用）。
 * 1つの掲載元からは perSource 件までにし、それでも足りなければ外した記事で埋める
 */
export function pickVaried(items: Item[], limit: number, perSource = 3): Item[] {
  const picked = new Set<Item>();
  const counts = new Map<string, number>();
  for (const item of items) {
    if (picked.size >= limit) break;
    const count = counts.get(item.sourceId) ?? 0;
    if (count >= perSource) continue;
    picked.add(item);
    counts.set(item.sourceId, count + 1);
  }
  for (const item of items) {
    if (picked.size >= limit) break;
    picked.add(item);
  }
  return items.filter((item) => picked.has(item));
}

export function countByCategory(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of getItems()) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return counts;
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

/** 記事の出典。集約元（他サイトの記事を紹介するフィード）経由の記事でも、元サイトが掲載元にあればその名前で表示する */
export function siteOf(item: Item): SiteInfo {
  const host = hostOf(item.url);
  const source = getSource(item.sourceId);
  if (source && !source.aggregator) return { label: source.name, host, source };
  const direct = getSourceByHost(host);
  return direct ? { label: direct.name, host, source: direct } : { label: host, host };
}

/**
 * AI 要約を作って載せてよい記事か。利用条件を確認して登録している掲載元（sources.yaml）の記事で、
 * 規約で要約の掲載を禁じていない（summary: false でない）ものだけ。
 * 掲載元を外したら、その掲載元の記事の要約もサイトに載せない
 */
export function allowsSummary(item: Item): boolean {
  const source = siteOf(item).source;
  return source !== undefined && source.summary !== false;
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

/**
 * 「◯分前」「◯時間前」（24時間より前は fallback の表示）。ビルドした時点での表示で、閲覧時にスクリプトが今の時刻で書き直す。
 * 最初から相対時刻にしておくと、書き直しで文字の幅が変わってレイアウトがずれる（CLS）のを抑えられる
 */
export function formatRelative(iso: string, fallback: string = formatDateTime(iso), now: number = builtAt.getTime()): string {
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff) || diff >= 24 * 60 * 60 * 1000) return fallback;
  if (diff < 60 * 1000) return 'たった今';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}分前`;
  return `${Math.floor(diff / (60 * 60 * 1000))}時間前`;
}

/** ビルドした時点で1時間以内の記事か（NEW の印。閲覧時にスクリプトが今の時刻で付け直す） */
export function isFresh(iso: string, now: number = builtAt.getTime()): boolean {
  const diff = now - Date.parse(iso);
  return diff >= 0 && diff < 60 * 60 * 1000;
}

/** base パスを考慮したサイト内リンクを作る（path は "/" 始まり） */
export function href(path: string): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + path;
}

/** ファビコン画像のURL（Google のファビコン取得サービス） */
export function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}
