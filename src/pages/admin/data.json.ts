import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories, site } from '../../config/site.ts';
import { getBlocklist } from '../../lib/blocklist.ts';
import { blockReason } from '../../lib/blocklist-core.ts';
import { builtAt, getAllItems, getItems, getSources, siteOf } from '../../lib/items.ts';
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

interface FeedState {
  okAt?: string;
  failures?: number;
  failedAt?: string;
  error?: string;
}

/** 収集元ごとの取得の状態（data/feeds.json。収集のたびに更新される） */
function feedStates(): Record<string, FeedState> {
  const path = resolve(process.cwd(), 'data/feeds.json');
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, FeedState>) : {};
  } catch {
    return {};
  }
}

/** 収集元ごとの記事数・最新の記事の日時・取得の状態（フィードが止まっていないかの確認用） */
function sourceStats() {
  const states = feedStates();
  const latest = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const item of getAllItems()) {
    counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
    if ((latest.get(item.sourceId) ?? '') < item.publishedAt) latest.set(item.sourceId, item.publishedAt);
  }
  return getSources().map((source) => ({
    id: source.id,
    name: source.name,
    category: source.category,
    siteUrl: source.siteUrl,
    count: counts.get(source.id) ?? 0,
    latest: latest.get(source.id) ?? null,
    okAt: states[source.id]?.okAt ?? null,
    failures: states[source.id]?.failures ?? 0,
    error: states[source.id]?.failures ? (states[source.id]?.error ?? null) : null,
  }));
}

/** 管理画面用のデータ（要約待ちの記事、保存済みの要約、非表示の設定、収集元の状況） */
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
    sources: sourceStats(),
  };
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
