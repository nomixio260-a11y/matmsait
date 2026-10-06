import { site as siteConfig } from '../config/site.ts';
import { getItems, siteOf } from '../lib/items.ts';
import { getSummaries, getSummary } from '../lib/summaries.ts';
import { coverageOf } from '../lib/topics.ts';
import type { Item } from '../lib/types.ts';

/** 抜粋は先頭だけを検索の対象にする（インデックスを小さく保つため） */
const EXCERPT_CHARS = 60;

const head = (text: string, max: number) => Array.from(text).slice(0, max).join('');

/**
 * 検索ページ用のインデックス（キーを短くし、件数も新しい順に上限までにしてサイズを抑えている）。
 * AI 要約のある記事は、記事が古くなって一覧から消えても要約で探せるように必ず含める
 */
export function GET() {
  const items = getItems().slice(0, siteConfig.searchLimit);
  const ids = new Set(items.map((item) => item.id));
  const all: Item[] = [...items, ...getSummaries().filter((record) => !ids.has(record.id))];
  const entries = all.map((item) => {
    const site = siteOf(item);
    const summary = getSummary(item.id);
    const coverage = coverageOf(item.id);
    return {
      i: item.id,
      t: item.title,
      u: item.url,
      s: site.label,
      h: site.host,
      c: item.category,
      d: item.publishedAt,
      ...(summary ? { m: summary.summary } : item.excerpt ? { e: head(item.excerpt, EXCERPT_CHARS) } : {}),
      ...(summary?.keywords?.length ? { k: summary.keywords.join(' ') } : {}),
      ...(coverage >= 2 ? { v: coverage } : {}),
    };
  });
  return new Response(JSON.stringify(entries), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
