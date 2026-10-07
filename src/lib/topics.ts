/**
 * 話題（同じ出来事を報じた記事のまとまり）。ビルド中に1回だけ計算する。
 * 話題度 = その出来事を報じた掲載元の数。話題度スコア・急上昇などの計算は topic-core.ts（テストできるよう分けている）
 */
import { tags as tagDefinitions, type TagDefinition } from '../config/tags.ts';
import { builtAt, getItems, getSource } from './items.ts';
import { getPopular } from './popular.ts';
import { buildRelatedIndex, clusterTopics, type RelatedIndex, type TopicCluster } from './related.ts';
import { getSummaries, getSummary } from './summaries.ts';
import { tagsOf } from './tag-core.ts';
import {
  HOUR,
  analyzeTopic,
  newTopics,
  rankHot,
  rankImportant,
  rankRising,
  trendingWords,
  type RisingResult,
  type TopicStats,
  type TrendWord,
} from './topic-core.ts';
import type { Item, SummaryRecord } from './types.ts';

/** 話題をまとめる対象（新しい記事から何日分か。1週間のランキングに足りる分） */
const TOPIC_DAYS = 8;
/** 話題のページを検索エンジンに出す条件（報じたメディアの数。AI 要約のある話題は数にかかわらず出す） */
const INDEX_MIN_COVERAGE = 3;

let index: RelatedIndex | undefined;
let topics: TopicCluster[] | undefined;
let topicById: Map<string, TopicCluster> | undefined;

/** 掲載中の記事と要約から作った「同じ話題」の索引（ビルド中は1回だけ作る） */
export function getRelatedIndex(): RelatedIndex {
  index ??= buildRelatedIndex([...getItems(), ...getSummaries()]);
  return index;
}

/** 直近の記事を話題ごとにまとめたもの */
export function getTopics(): TopicCluster[] {
  if (!topics) {
    const cutoff = builtAt.getTime() - TOPIC_DAYS * 24 * HOUR;
    topics = clusterTopics(getItems().filter((item) => Date.parse(item.publishedAt) >= cutoff));
    topicById = new Map(topics.flatMap((topic) => topic.items.map((item) => [item.id, topic] as const)));
  }
  return topics;
}

/** 記事の話題（同じ出来事を報じたほかの掲載元の記事を含む） */
export function topicOf(id: string): TopicCluster | undefined {
  getTopics();
  return topicById?.get(id);
}

/** 記事の話題度（その出来事を報じた掲載元の数。まとめられなかった記事は1） */
export function coverageOf(id: string): number {
  return topicOf(id)?.coverage ?? 1;
}

/** 記事に話題度を付ける（2以上のときだけ） */
export function withTopicCoverage<T extends Item>(item: T): T {
  const coverage = coverageOf(item.id);
  return coverage >= 2 ? { ...item, coverage } : item;
}

export interface HotTopic extends TopicCluster {
  /** 見出しとして見せる記事（AI 要約のある記事、なければ最初に報じた記事） */
  lead: Item;
  /** lead 以外の記事（掲載元ごとに1件） */
  others: Item[];
}

/** 見出しにする記事と、ほかの掲載元の記事に分ける */
export function toHotTopic(topic: TopicCluster): HotTopic {
  const summarized = topic.items.find((item) => getSummary(item.id));
  const lead = summarized ?? topic.items[topic.items.length - 1];
  const seen = new Set([lead.sourceId]);
  const others = topic.items.filter((item) => {
    if (seen.has(item.sourceId)) return false;
    seen.add(item.sourceId);
    return true;
  });
  return { ...topic, lead: withTopicCoverage(lead), others };
}

/** 2つ以上のメディアが報じた話題（話題度スコアなどの数字・AI 要約・タグつき） */
export interface TopicView extends HotTopic, TopicStats {
  /** 話題の記事の AI 要約（見出しにした記事の要約が先頭） */
  summaries: SummaryRecord[];
  /** 当てはまるタグ */
  tags: TagDefinition[];
  /** 話題のページを検索エンジンに出すか（報じたメディアが多いか、AI 要約がある話題だけ） */
  indexable: boolean;
}

export function topicPath(id: string): string {
  return `/topic/${id}/`;
}

/** 記事の AI 要約のキーワード（タグの当てはめに使う） */
function keywordsOf(item: Item): string[] {
  return getSummary(item.id)?.keywords ?? [];
}

/** 記事に当てはまるタグ */
export function tagsOfItem(item: Item): TagDefinition[] {
  return tagsOf(item, keywordsOf(item), tagDefinitions);
}

let views: TopicView[] | undefined;
let viewById: Map<string, TopicView> | undefined;
let viewByItem: Map<string, TopicView> | undefined;

/** 2つ以上のメディアが報じた話題（ビルド中は1回だけ作る） */
export function getTopicViews(): TopicView[] {
  if (!views) {
    const now = builtAt.getTime();
    // このサイトで24時間に読まれた人数（よく読まれている記事の上位だけわかる）
    const reads = new Map(getPopular('day', 50).map((entry) => [entry.item.id, entry.n]));
    views = getTopics()
      .filter((topic) => topic.coverage >= 2)
      .map((topic) => {
        const hot = toHotTopic(topic);
        const stats = analyzeTopic(topic, now, { reads: topic.items.reduce((sum, item) => sum + (reads.get(item.id) ?? 0), 0) });
        const summaries = topic.items.map((item) => getSummary(item.id)).filter((record): record is SummaryRecord => record !== undefined);
        summaries.sort((a, b) => Number(b.id === hot.lead.id) - Number(a.id === hot.lead.id));
        const tagMap = new Map<string, TagDefinition>();
        for (const item of topic.items) for (const tag of tagsOfItem(item)) tagMap.set(tag.slug, tag);
        return {
          ...hot,
          ...stats,
          summaries,
          tags: tagDefinitions.filter((tag) => tagMap.has(tag.slug)),
          indexable: stats.coverage >= INDEX_MIN_COVERAGE || summaries.length > 0,
        };
      });
    viewById = new Map(views.map((view) => [view.id, view]));
    viewByItem = new Map(views.flatMap((view) => view.items.map((item) => [item.id, view] as const)));
  }
  return views;
}

export function getTopicView(id: string): TopicView | undefined {
  getTopicViews();
  return viewById?.get(id);
}

/** 記事の話題（2つ以上のメディアが報じた話題だけ） */
export function topicViewOf(itemId: string): TopicView | undefined {
  getTopicViews();
  return viewByItem?.get(itemId);
}

export interface HotTopicOptions {
  /** この時間以内に報じられた話題 */
  hours?: number;
  /** カテゴリで絞る（見出しにした記事のカテゴリ） */
  category?: string;
  limit?: number;
  /** 報じた掲載元の数の下限 */
  minCoverage?: number;
  /** 並べ方（score: 話題度スコアの順。coverage: 報じた掲載元の数の順） */
  sort?: 'score' | 'coverage';
}

/** 注目の話題（既定は話題度スコアの高い順） */
export function getHotTopics({ hours = 24, category, limit = 20, minCoverage = 2, sort = 'score' }: HotTopicOptions = {}): TopicView[] {
  const cutoff = builtAt.getTime() - hours * HOUR;
  const filtered = getTopicViews().filter(
    (topic) => topic.coverage >= minCoverage && Date.parse(topic.latestAt) >= cutoff && (!category || topic.lead.category === category),
  );
  const sorted =
    sort === 'score'
      ? rankHot(filtered)
      : [...filtered].sort((a, b) => b.coverage - a.coverage || b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id));
  return sorted.slice(0, limit);
}

/** 急上昇（直近3時間に新しく報じたメディアの多い話題。少なければ時間を広げる） */
export function getRisingTopics({ limit = 20, minTopics = 3 }: { limit?: number; minTopics?: number } = {}): RisingResult<TopicView> {
  return rankRising(getTopicViews(), builtAt.getTime(), { limit, minTopics });
}

/** 報じられ始めた話題（最初の報道が直近 hours 時間以内） */
export function getNewTopics({ hours = 6, limit = 10 }: { hours?: number; limit?: number } = {}): TopicView[] {
  return newTopics(getTopicViews(), builtAt.getTime(), { hours }).slice(0, limit);
}

/** 重要なニュース（直近 hours 時間に報じられた話題を、報じたメディアの数とジャンルの広がりの順に。ジャンルの偏りを抑える） */
export function getImportantTopics({ hours = 24, limit = 10, perCategory = 3 }: { hours?: number; limit?: number; perCategory?: number } = {}): TopicView[] {
  return rankImportant(getTopicViews(), builtAt.getTime() - hours * HOUR, { limit, perCategory });
}

/** 関連する話題（同じタグの話題・見出しの似た話題・同じジャンルの話題の順） */
export function relatedTopics(view: TopicView, limit = 6): TopicView[] {
  const picked = new Map<string, TopicView>();
  const add = (candidate: TopicView | undefined) => {
    if (candidate && candidate.id !== view.id && !picked.has(candidate.id) && picked.size < limit) picked.set(candidate.id, candidate);
  };
  const ranked = rankHot(getTopicViews());
  const slugs = new Set(view.tags.map((tag) => tag.slug));
  for (const candidate of ranked) if (candidate.tags.some((tag) => slugs.has(tag.slug))) add(candidate);
  for (const item of getRelatedIndex().related(view.lead, 10)) add(topicViewOf(item.id));
  for (const candidate of ranked) if (candidate.categories[0] === view.categories[0]) add(candidate);
  return [...picked.values()];
}

// ===== タグ =====

export function tagPath(slug: string): string {
  return `/tag/${slug}/`;
}

let tagItems: Map<string, Item[]> | undefined;

/** タグに当てはまる記事（新しい順。話題をまとめる期間の記事） */
export function getTagItems(slug: string): Item[] {
  if (!tagItems) {
    tagItems = new Map(tagDefinitions.map((tag) => [tag.slug, [] as Item[]]));
    const cutoff = builtAt.getTime() - TOPIC_DAYS * 24 * HOUR;
    for (const item of getItems()) {
      if (Date.parse(item.publishedAt) < cutoff) break;
      for (const tag of tagsOfItem(item)) tagItems.get(tag.slug)?.push(item);
    }
  }
  return tagItems.get(slug) ?? [];
}

/** タグの話題（話題度スコアの順） */
export function getTagTopics(slug: string, { hours = 24 * 7, limit = 20 }: { hours?: number; limit?: number } = {}): TopicView[] {
  const cutoff = builtAt.getTime() - hours * HOUR;
  return rankHot(getTopicViews().filter((view) => Date.parse(view.latestAt) >= cutoff && view.tags.some((tag) => tag.slug === slug))).slice(
    0,
    limit,
  );
}

/** タグのページを検索エンジンに出す記事数の下限（少ないページは中身が薄いので出さない） */
export const TAG_INDEX_MIN_ITEMS = 8;

// ===== 注目ワード =====

let trendCache: TrendWord[] | undefined;

/** 注目ワード（直近24時間の見出しに急に増えた言葉。候補は AI 要約のキーワードとタグの言葉） */
export function getTrendWords(limit = 12): TrendWord[] {
  if (!trendCache) {
    const vocabulary = [...getSummaries().flatMap((record) => record.keywords ?? []), ...tagDefinitions.flatMap((tag) => tag.words)];
    trendCache = trendingWords(getItems(), vocabulary, builtAt.getTime(), { limit: 30 });
  }
  return trendCache.slice(0, limit);
}

// ===== メディア別 =====

export interface MediaStat {
  sourceId: string;
  name: string;
  category: string;
  /** 直近 hours 時間の記事数 */
  articles: number;
  /** 2つ以上のメディアが報じた話題のうち、このメディアも報じた数 */
  topics: number;
  /** そのうち、このメディアが最初に報じた（初報）数 */
  firsts: number;
}

/** メディアごとの記事数・話題になったニュースの数・初報の数（直近 hours 時間） */
export function getMediaStats(hours = 24): MediaStat[] {
  const cutoff = builtAt.getTime() - hours * HOUR;
  const stats = new Map<string, MediaStat>();
  const statOf = (sourceId: string) => {
    let stat = stats.get(sourceId);
    if (!stat) {
      const source = getSource(sourceId);
      stat = { sourceId, name: source?.name ?? sourceId, category: source?.category ?? '', articles: 0, topics: 0, firsts: 0 };
      stats.set(sourceId, stat);
    }
    return stat;
  };
  for (const item of getItems()) {
    if (Date.parse(item.publishedAt) < cutoff) break;
    statOf(item.sourceId).articles++;
  }
  for (const view of getTopicViews()) {
    if (Date.parse(view.latestAt) < cutoff) continue;
    for (const report of view.reports) statOf(report.item.sourceId).topics++;
    const first = view.reports[0];
    if (first && first.time >= cutoff) statOf(first.item.sourceId).firsts++;
  }
  return [...stats.values()].sort(
    (a, b) => b.firsts - a.firsts || b.topics - a.topics || b.articles - a.articles || a.name.localeCompare(b.name, 'ja'),
  );
}
