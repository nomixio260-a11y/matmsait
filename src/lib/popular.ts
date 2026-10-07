/**
 * よく読まれている記事（data/popular.json。自動更新のたびに scripts/popular.ts がアクセス解析のサーバーから取ってくる）。
 * 人数は「要約ページを読んだ・記事を開いた・あとで読むに保存した人」の数（同じ人は1回だけ数える）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POPULAR_PATH } from './analytics-config.ts';
import { getItems } from './items.ts';
import { getSummary } from './summaries.ts';
import type { Item } from './types.ts';

export type PopularPeriod = 'day' | 'week';

export interface PopularFile {
  updatedAt: string;
  /** 24時間 */
  day: { id: string; n: number }[];
  /** 1週間 */
  week: { id: string; n: number }[];
}

export interface PopularEntry {
  item: Item;
  /** 人数（サイトには出さない） */
  n: number;
}

const pickList = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        /^[0-9a-f]{16}$/.test((entry as { id: string }).id) &&
        typeof (entry as { n?: unknown }).n === 'number' &&
        (entry as { n: number }).n > 0
          ? [{ id: (entry as { id: string }).id, n: Math.floor((entry as { n: number }).n) }]
          : [],
      )
    : [];

/** data/popular.json の中身を確かめて読む（形がおかしければ undefined） */
export function parsePopularFile(text: string | undefined): PopularFile | undefined {
  if (!text) return undefined;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null) return undefined;
    const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : '';
    return { updatedAt, day: pickList(data.day), week: pickList(data.week) };
  } catch {
    return undefined;
  }
}

let cache: PopularFile | null | undefined;

function load(): PopularFile | undefined {
  if (cache === undefined) {
    const path = resolve(process.cwd(), POPULAR_PATH);
    cache = (existsSync(path) && parsePopularFile(readFileSync(path, 'utf8'))) || null;
  }
  return cache ?? undefined;
}

const lists = new Map<PopularPeriod, PopularEntry[]>();

/** よく読まれている記事（サイトに載せている記事だけ。人数の多い順。ビルド中は1回だけ作る） */
export function getPopular(period: PopularPeriod, limit = 30): PopularEntry[] {
  let list = lists.get(period);
  if (!list) {
    list = [];
    const data = load();
    if (data) {
      const visible = new Map(getItems().map((item) => [item.id, item]));
      for (const { id, n } of data[period]) {
        // 収集した記事の一覧から消えた古い記事も、要約があれば載せる（要約は非表示の記事を除いて返る）
        const item = visible.get(id) ?? getSummary(id);
        if (item) list.push({ item, n });
      }
    }
    lists.set(period, list);
  }
  return list.slice(0, limit);
}

/** よく読まれている記事の集計の日時 */
export function popularUpdatedAt(): string | undefined {
  return load()?.updatedAt || undefined;
}

let ranks: Map<string, number> | undefined;

/** 24時間でよく読まれている記事の順位（上位10件だけ。記事の一覧に「人気」の印を付けるのに使う） */
export function popularRank(id: string): number | undefined {
  ranks ??= new Map(getPopular('day', 10).map((entry, index) => [entry.item.id, index + 1]));
  return ranks.get(id);
}
