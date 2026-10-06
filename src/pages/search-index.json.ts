import { getItems, siteOf } from '../lib/items.ts';
import { getSummary } from '../lib/summaries.ts';

/** 検索ページ用のインデックス（キーを短くしてサイズを抑えている） */
export function GET() {
  const entries = getItems().map((item) => {
    const site = siteOf(item);
    return {
      i: item.id,
      ...(getSummary(item.id) ? { m: 1 } : {}),
      t: item.title,
      u: item.url,
      s: site.label,
      h: site.host,
      c: item.category,
      d: item.publishedAt,
      ...(item.hatebu ? { b: item.hatebu } : {}),
    };
  });
  return new Response(JSON.stringify(entries), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
