import { categories, site } from '../../config/site.ts';
import { builtAt, getItems, siteOf } from '../../lib/items.ts';
import { getSummaries, getSummary } from '../../lib/summaries.ts';
import type { Item } from '../../lib/types.ts';

const article = (item: Item) => ({
  id: item.id,
  title: item.title,
  url: item.url,
  excerpt: item.excerpt,
  sourceId: item.sourceId,
  category: item.category,
  publishedAt: item.publishedAt,
  ...(item.hatebu ? { hatebu: item.hatebu } : {}),
  site: siteOf(item).label,
});

/** 管理画面用のデータ（要約待ちの記事と、保存済みの要約） */
export function GET() {
  const data = {
    generatedAt: builtAt.toISOString(),
    siteName: site.name,
    repository: site.repository,
    categories: categories.map(({ slug, name }) => ({ slug, name })),
    pending: getItems()
      .filter((item) => !getSummary(item.id))
      .map(article),
    summarized: getSummaries()
      .slice(0, 300)
      .map((record) => ({
        ...article(record),
        summary: record.summary,
        points: record.points,
        summarizedAt: record.summarizedAt,
      })),
  };
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
