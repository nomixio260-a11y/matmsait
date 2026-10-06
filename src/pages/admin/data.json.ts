import { categories, site } from '../../config/site.ts';
import { getBlocklist } from '../../lib/blocklist.ts';
import { blockReason } from '../../lib/blocklist-core.ts';
import { builtAt, getAllItems, getItems, siteOf } from '../../lib/items.ts';
import { getAllSummaries, getSummaries, getSummary } from '../../lib/summaries.ts';
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

/** 非表示にしている記事（理由つき。新しい順に最大300件） */
function hiddenArticles() {
  const blocklist = getBlocklist();
  const byId = new Map([...getAllItems(), ...getAllSummaries()].map((item) => [item.id, item]));
  return [...byId.values()]
    .flatMap((item) => {
      const reason = blockReason(item, blocklist);
      return reason ? [{ ...article(item), reason }] : [];
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 300);
}

/** 管理画面用のデータ（要約待ちの記事、保存済みの要約、非表示の設定） */
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
    blocklist: getBlocklist(),
    hidden: hiddenArticles(),
  };
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
