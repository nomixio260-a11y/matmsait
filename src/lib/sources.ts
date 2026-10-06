import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { categories } from '../config/site.ts';
import type { Source } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const SOURCES_PATH = resolve(process.cwd(), 'sources.yaml');

/** sources.yaml を読み込み、id の重複・未定義カテゴリ・URL形式・正規表現を検証する */
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
    const { id, name, feedUrl, siteUrl, category, aggregator, stripTitle } = source as Source;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${where}: id は英小文字・数字・ハイフンのみ使えます`);
    if (seen.has(id)) throw new Error(`${where}: id "${id}" が重複しています`);
    if (!categorySlugs.has(category)) throw new Error(`${where}: カテゴリ "${category}" は site.ts に未定義です`);
    for (const url of [feedUrl, siteUrl]) {
      if (!/^https?:\/\//.test(url)) throw new Error(`${where}: URL "${url}" が不正です`);
    }
    if (aggregator !== undefined && typeof aggregator !== 'boolean') {
      throw new Error(`${where}: aggregator は true / false で指定してください`);
    }
    if (stripTitle !== undefined) {
      try {
        new RegExp(stripTitle);
      } catch {
        throw new Error(`${where}: stripTitle の正規表現が不正です`);
      }
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
    };
  });
}
