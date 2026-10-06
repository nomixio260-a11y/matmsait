import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { categories } from '../config/site.ts';
import type { Source } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const SOURCES_PATH = resolve(process.cwd(), 'sources.yaml');

/** 1回の取得で取り込む記事数の上限の最大値（scripts/fetch-feeds.ts の既定値と同じ） */
export const MAX_LIMIT = 50;

/** sources.yaml を読み込み、id の重複・未定義カテゴリ・URL形式・正規表現・件数の上限を検証する */
export function loadSources(path = SOURCES_PATH): Source[] {
  const raw = parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: 配列形式で記述してください`);

  const categorySlugs = new Set(categories.map((c) => c.slug));
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `${path} の ${index + 1} 件目`;
    const source = entry as Partial<Source>;
    for (const key of ['id', 'name', 'feedUrl', 'siteUrl', 'category'] as const) {
      if (typeof source[key] !== 'string' || source[key] === '') {
        throw new Error(`${where}: ${key} がありません`);
      }
    }
    const { id, name, feedUrl, siteUrl, category, aggregator, stripTitle, limit, excerpt, summary } = source as Source;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${where}: id は英小文字・数字・ハイフンのみ使えます`);
    if (seen.has(id)) throw new Error(`${where}: id "${id}" が重複しています`);
    if (!categorySlugs.has(category)) throw new Error(`${where}: カテゴリ "${category}" は site.ts に未定義です`);
    for (const url of [feedUrl, siteUrl]) {
      if (!/^https?:\/\//.test(url)) throw new Error(`${where}: URL "${url}" が不正です`);
    }
    for (const [key, value] of Object.entries({ aggregator, excerpt, summary })) {
      if (value !== undefined && typeof value !== 'boolean') {
        throw new Error(`${where}: ${key} は true / false で指定してください`);
      }
    }
    if (stripTitle !== undefined) {
      try {
        new RegExp(stripTitle);
      } catch {
        throw new Error(`${where}: stripTitle の正規表現が不正です`);
      }
    }
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) {
      throw new Error(`${where}: limit は 1〜${MAX_LIMIT} の整数で指定してください`);
    }
    seen.add(id);
    return {
      id,
      name,
      feedUrl,
      siteUrl,
      category,
      ...(aggregator ? { aggregator } : {}),
      ...(stripTitle ? { stripTitle } : {}),
      ...(limit ? { limit } : {}),
      ...(excerpt === false ? { excerpt } : {}),
      ...(summary === false ? { summary } : {}),
    };
  });
}
