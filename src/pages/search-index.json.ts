import { getItems, siteOf } from '../lib/items.ts';

/** 検索ページ用のインデックス（キーを短くしてサイズを抑えている） */
export function GET() {
  const entries = getItems().map((item) => {
    const site = siteOf(item);
    return {
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
