import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIContext } from 'astro';
import {
  aiPost,
  digestPost,
  fitsBluesky,
  hotPost,
  morningPost,
  risingPost,
  summaryPost,
  weeklyPost,
  type PlanContext,
  type SocialState,
} from '../../../scripts/lib/social.ts';
import { getDailySnapshots } from '../../lib/daily.ts';
import { jstDateKey } from '../../lib/dates.ts';
import { socialSources } from '../../lib/social-source.ts';
import { categories, site } from '../../config/site.ts';
import { getBlocklist } from '../../lib/blocklist.ts';
import { blockReason } from '../../lib/blocklist-core.ts';
import { allowsSummary, builtAt, getAllItems, getItems, getSources, href, siteOf } from '../../lib/items.ts';
import { getAllSummaries, getSummaries, getSummary } from '../../lib/summaries.ts';
import { TEXT_KEYS_PATH, parseJsonList, pickKeys } from '../../lib/article-texts.ts';
import { coverageOf, getHotTopics, topicOf } from '../../lib/topics.ts';
import { getAllTopicNotes } from '../../lib/topic-notes.ts';
import { getTopicOverrides } from '../../lib/topic-overrides.ts';
import { matchTopicNote } from '../../lib/topic-notes-core.ts';
import { isHidden } from '../../lib/blocklist.ts';
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

/**
 * SNS（Bluesky）の自動投稿の候補。自動投稿と同じ作り方で、Bluesky の文字数（300）に収める。
 * 自動投稿は30分ごと（毎時の更新のあとと、その30分後）に時間帯と上限を見て行うので、ここは「次に投稿されうるもの」と、手で追加の投稿をしたいときの下書き
 */
function socialDrafts(siteUrl: URL | undefined) {
  const now = builtAt;
  const pageUrl = (path: string) => new URL(href(path), siteUrl ?? 'https://example.com').toString();
  const sources = socialSources(now);
  const context: PlanContext = { now, snapshots: getDailySnapshots(), ...sources, pageUrl, siteName: site.name };
  const today = jstDateKey(now);
  const snapshot = context.snapshots.find((entry) => entry.date === today);
  const drafts = [
    ...context.rising.filter((topic) => topic.gained >= 2).slice(0, 2).map((topic) => ({ kind: '急上昇', post: risingPost(topic, context) })),
    ...context.hot.slice(0, 2).map((topic) => ({ kind: 'いま話題', post: hotPost(topic, context) })),
    ...context.summaries.slice(0, 1).map((summary) => ({ kind: '10秒でわかるニュース', post: summaryPost(summary, context) })),
    { kind: '今日の注目ニュース', post: morningPost(context.important, today, context) },
    { kind: 'AIニュース', post: aiPost(context.ai, today, context) },
    { kind: '今週のランキング', post: weeklyPost(context.weekly, today, context) },
    { kind: '今日のまとめ', post: snapshot ? digestPost(snapshot, context) : undefined },
  ];
  return drafts.flatMap(({ kind, post }) => (post ? [{ kind, key: post.key, text: post.compose(fitsBluesky), url: post.link.url }] : []));
}

/** AI 整理の候補にするトピックの数（話題度の高い順） */
const NOTE_TOPICS = 80;

/**
 * AI 整理（トピック整理）の候補: 72時間に報じられた、2つ以上の媒体のトピック（話題度の順）。
 * プロンプトに入れるのは、要約を禁じていない掲載元の、非表示でない記事だけ（2件未満のトピックは整理できないので除く）
 */
function noteTopics() {
  const notes = getAllTopicNotes();
  return getHotTopics({ hours: 72, limit: NOTE_TOPICS * 2 })
    .map((view) => {
      const usable = view.reports.map((report) => report.item).filter((item) => allowsSummary(item) && !isHidden(item));
      const note = matchTopicNote(
        notes,
        view.items.map((item) => item.id),
      );
      return {
        id: view.id,
        title: view.lead.title,
        firstAt: view.firstAt,
        latestAt: view.latestAt,
        coverage: view.coverage,
        score: view.score,
        category: view.categories[0] ?? view.lead.category,
        // 媒体ごとの最初の記事（報じた順）
        articles: usable.map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          site: siteOf(item).label,
          excerpt: item.excerpt,
          publishedAt: item.publishedAt,
        })),
        // 要約を禁じている掲載元など、プロンプトに入れない媒体の数
        excluded: view.reports.length - usable.length,
        allItems: view.items.map((item) => item.id),
        // トピックのすべての記事（まとめ方の手直し用。報じた順）
        items: [...view.items]
          .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
          .map((item) => ({ id: item.id, title: item.title, url: item.url, site: siteOf(item).label, publishedAt: item.publishedAt })),
        ...(note ? { noted: { topic: note.topic, notedAt: note.notedAt, firstAt: note.firstAt, newer: view.items.filter((item) => !note.items.includes(item.id)).length } } : {}),
      };
    })
    .filter((topic) => topic.articles.length >= 2)
    .slice(0, NOTE_TOPICS);
}

/** 自動投稿の記録（data/social.json。新しい順に30件） */
function socialLog() {
  try {
    const state = JSON.parse(readData('data/social.json') ?? '{"posted":[]}') as SocialState;
    return (Array.isArray(state.posted) ? state.posted : []).slice(-30).reverse();
  } catch {
    return [];
  }
}

/** 管理画面用のデータ（要約待ちの記事、保存済みの要約、非表示の設定、収集元の状況、お知らせ・ピックアップ、SNS の下書き） */
export function GET({ site: siteUrl }: APIContext) {
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
    social: socialDrafts(siteUrl),
    // AI 整理（トピック整理）の候補と、トピックのまとめ方の手直し（統合・分割）
    topics: noteTopics(),
    topicOverrides: getTopicOverrides(),
    socialLog: socialLog(),
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
