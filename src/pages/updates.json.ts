import { categories } from '../config/site.ts';
import type { UpdatesFile, UpdateEntry, UpdateTopic } from '../lib/follow-core.ts';
import { builtAt, getItems, siteOf } from '../lib/items.ts';
import { getSummary, summaryPath } from '../lib/summaries.ts';
import { coverageOf, getHotTopics } from '../lib/topics.ts';

/** 新着として載せる期間と件数（フォロー中のページ・ヘッダーの件数・通知の材料。大きくしすぎない） */
const HOURS = 36;
const LIMIT = 1200;
/** 通知の材料にする話題 */
const HOT_LIMIT = 10;
const HOT_MIN = 3;

/**
 * 直近の新着記事と話題（キーを短くしてサイズを抑えている）。
 * 「フォロー中」のページとヘッダーの新着件数はブラウザで、通知はサーバー（/api/push/check）がこれを読む
 */
export function GET() {
  const cutoff = builtAt.getTime() - HOURS * 60 * 60 * 1000;
  const items: UpdateEntry[] = getItems()
    .filter((item) => Date.parse(item.publishedAt) >= cutoff)
    .slice(0, LIMIT)
    .map((item) => {
      const summary = getSummary(item.id);
      const coverage = coverageOf(item.id);
      return {
        i: item.id,
        t: item.title,
        c: item.category,
        s: item.sourceId,
        n: siteOf(item).label,
        u: summary ? summaryPath(item.id) : item.url,
        d: item.publishedAt,
        ...(coverage >= 2 ? { k: coverage } : {}),
        ...(summary ? { m: 1 as const } : {}),
      };
    });
  const hot: UpdateTopic[] = getHotTopics({ hours: 24, limit: HOT_LIMIT, minCoverage: HOT_MIN }).map((topic) => ({
    i: topic.items.map((item) => item.id).slice(0, 50),
    t: topic.lead.title,
    k: topic.coverage,
    u: getSummary(topic.lead.id) ? summaryPath(topic.lead.id) : '/ranking/',
  }));
  const file: UpdatesFile = {
    builtAt: builtAt.toISOString(),
    base: import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`,
    cats: Object.fromEntries(categories.map((category) => [category.slug, category.name])),
    items,
    hot,
  };
  return new Response(JSON.stringify(file), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
