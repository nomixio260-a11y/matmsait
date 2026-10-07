import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories, site } from '../../config/site.ts';
import { getBlocklist } from '../../lib/blocklist.ts';
import { blockReason } from '../../lib/blocklist-core.ts';
import { allowsSummary, builtAt, getAllItems, getItems, getSources, siteOf } from '../../lib/items.ts';
import { getAllSummaries, getSummaries, getSummary } from '../../lib/summaries.ts';
import { TEXT_KEYS_PATH, parseJsonList, pickKeys } from '../../lib/article-texts.ts';
import { coverageOf, topicOf } from '../../lib/topics.ts';
import type { Item } from '../../lib/types.ts';
import { NOTICE_PATH, PICKS_PATH, parseNotice, parsePicks } from '../../lib/editorial-core.ts';

/** 同じ話題（同じ出来事を報じた記事のまとまり）を見分けるキー。AI が開けない記事の代わりに、同じ話題の別の記事を選ぶのに使う */
function topicKey(id: string): string | undefined {
  const topic = topicOf(id);
  return topic && topic.coverage >= 2 ? topic.items.map((item) => item.id).sort()[0] : undefined;
}

const article = (item: Item) => {
  const topic = topicKey(item.id);
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    excerpt: item.excerpt,
    sourceId: item.sourceId,
    category: item.category,
    publishedAt: item.publishedAt,
    ...(coverageOf(item.id) >= 2 ? { coverage: coverageOf(item.id) } : {}),
    ...(topic ? { topic } : {}),
    site: siteOf(item).label,
  };
};

/** 管理画面に渡す要約待ちの記事の数（新着順）。収集元が多いと全件では管理画面の読み込みが重くなる */
const PENDING_LATEST = 3000;
/** 上の件数より古くても、多くの掲載元が報じた話題の記事はこの件数まで要約の候補に入れる */
const PENDING_POPULAR = 500;

/** 要約待ちの記事（新しい記事と、話題の記事。要約を載せられない掲載元の記事は除く） */
function pendingArticles(): Item[] {
  const unsummarized = getItems().filter((item) => !getSummary(item.id) && allowsSummary(item));
  const popular = unsummarized
    .slice(PENDING_LATEST)
    .filter((item) => coverageOf(item.id) >= 2)
    .sort((a, b) => coverageOf(b.id) - coverageOf(a.id))
    .slice(0, PENDING_POPULAR);
  return [...unsummarized.slice(0, PENDING_LATEST), ...popular];
}

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

function readData(path: string): string | undefined {
  const file = resolve(process.cwd(), path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 掲載中の記事・要約の数（全体と、きょう（日本時間）の分） */
function counts() {
  const today = dayKey.format(builtAt);
  const items = getItems();
  const summaries = getSummaries();
  return {
    items: items.length,
    itemsToday: items.filter((item) => dayKey.format(new Date(item.publishedAt)) === today).length,
    summaries: summaries.length,
    summariesToday: summaries.filter((record) => dayKey.format(new Date(record.summarizedAt)) === today).length,
    sources: getSources().length,
  };
}

/** 保存しているピックアップ（期限が過ぎたものも含む）と、その記事の情報（管理画面の一覧用） */
function picks() {
  const byId = new Map<string, Item>([...getAllSummaries(), ...getAllItems()].map((item) => [item.id, item]));
  return parsePicks(readData(PICKS_PATH)).map((pick) => {
    const item = byId.get(pick.id);
    return { ...pick, ...(item ? { article: article(item), summarized: Boolean(getSummary(pick.id)) } : {}) };
  });
}

/** 管理画面用のデータ（要約待ちの記事、保存済みの要約、非表示の設定、収集元の状況、お知らせ・ピックアップ） */
export function GET() {
  const data = {
    generatedAt: builtAt.toISOString(),
    siteName: site.name,
    repository: site.repository,
    categories: categories.map(({ slug, name }) => ({ slug, name })),
    pending: pendingArticles().map(article),
    summarized: getSummaries()
      .slice(0, 300)
      .map((record) => ({
        ...article(record),
        summary: record.summary,
        points: record.points,
        ...(record.background ? { background: record.background } : {}),
        ...(record.keywords?.length ? { keywords: record.keywords } : {}),
        summarizedAt: record.summarizedAt,
      })),
    counts: counts(),
    // お知らせ（掲載期間の前後も含めて、保存してある内容）とピックアップ
    notice: parseNotice(readData(NOTICE_PATH)) ?? null,
    picks: picks(),
    blocklist: getBlocklist(),
    hidden: hiddenArticles(),
    sources: sourceStats(),
    // 本文の自動取得に登録してある公開鍵の ID（自分の鍵が登録済みかを管理画面が確かめる）
    textKeys: parseJsonList(
      existsSync(resolve(process.cwd(), TEXT_KEYS_PATH)) ? readFileSync(resolve(process.cwd(), TEXT_KEYS_PATH), 'utf8') : undefined,
      pickKeys,
    ).map((key) => key.kid),
  };
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
