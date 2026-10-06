/**
 * 話題（同じ出来事を報じた記事のまとまり）。ビルド中に1回だけ計算する。
 * 話題度 = その出来事を報じた掲載元の数。はてなブックマーク数の代わりに、ランキング・注目の話題に使う
 */
import { builtAt, getItems } from './items.ts';
import { buildRelatedIndex, clusterTopics, type RelatedIndex, type TopicCluster } from './related.ts';
import { getSummaries, getSummary } from './summaries.ts';
import type { Item } from './types.ts';

const HOUR = 60 * 60 * 1000;
/** 話題をまとめる対象（新しい記事から何日分か。1週間のランキングに足りる分） */
const TOPIC_DAYS = 8;

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

export interface HotTopicOptions {
  /** この時間以内に報じられた話題 */
  hours?: number;
  /** カテゴリで絞る */
  category?: string;
  limit?: number;
  /** 報じた掲載元の数の下限 */
  minCoverage?: number;
}

/** 注目の話題（多くの掲載元が報じた順。同じなら新しく報じられた順） */
export function getHotTopics({ hours = 24, category, limit = 20, minCoverage = 2 }: HotTopicOptions = {}): HotTopic[] {
  const cutoff = builtAt.getTime() - hours * HOUR;
  return getTopics()
    .filter((topic) => topic.coverage >= minCoverage && Date.parse(topic.latestAt) >= cutoff)
    .map(toHotTopic)
    .filter((topic) => !category || topic.lead.category === category)
    .sort((a, b) => b.coverage - a.coverage || b.latestAt.localeCompare(a.latestAt))
    .slice(0, limit);
}
