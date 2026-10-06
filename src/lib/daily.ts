import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isHidden } from './blocklist.ts';
import { dateFromKey } from './dates.ts';
import { getSource } from './items.ts';
import type { DailySnapshot, Item } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const DAILY_DIR = resolve(process.cwd(), 'data/daily');

let cache: DailySnapshot[] | undefined;

/** 日別まとめを新しい日付順で返す */
export function getDailySnapshots(): DailySnapshot[] {
  if (!cache) {
    cache = existsSync(DAILY_DIR)
      ? readdirSync(DAILY_DIR)
          .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
          .map((file) => JSON.parse(readFileSync(resolve(DAILY_DIR, file), 'utf8')) as DailySnapshot)
          // 管理画面で非表示にした記事と、sources.yaml から外した掲載元の記事は、過去の日別まとめからも外す
          .map((snapshot) => ({
            ...snapshot,
            items: snapshot.items
              .filter((item) => !isHidden(item) && getSource(item.sourceId) !== undefined)
              .map(({ hatebu: _, ...item }: Item & { hatebu?: number }) => item),
          }))
          .sort((a, b) => b.date.localeCompare(a.date))
      : [];
  }
  return cache;
}

const withYear = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});
const withoutYear = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});
const monthFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long' });

/** 「2026年10月6日(火)」/「10月6日(火)」 */
export function formatDay(date: string, year = false): string {
  return (year ? withYear : withoutYear).format(dateFromKey(date));
}

/** 「2026年10月」 */
export function formatMonth(date: string): string {
  return monthFormat.format(dateFromKey(date));
}

export function dailyPath(date: string): string {
  return `/daily/${date}/`;
}
