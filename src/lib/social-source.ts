/**
 * SNS の投稿の材料（いま話題・急上昇・今日の注目・AI・今週・新しい AI 要約）。
 * サイトのビルドと同じ計算なので、投稿のリンクは公開している話題のページと一致する。
 * 自動投稿（scripts/notify.ts）と管理画面の下書き（src/pages/admin/data.json.ts）で共通
 */
import type { SocialSummary, SocialTopic } from '../../scripts/lib/social.ts';
import { summaryPath, getSummaries } from './summaries.ts';
import { firstSentence } from './summary-view.ts';
import { growthWithin } from './topic-core.ts';
import { getHotTopics, getImportantTopics, getRisingTopics, getTagTopics, tagsOfItem, topicPath, topicViewOf, type TopicView } from './topics.ts';

const HOUR = 60 * 60 * 1000;

/** 話題を投稿の材料にする（ハッシュタグは話題のタグから） */
export function socialTopic(view: TopicView, now: Date, gained = growthWithin(view.reports, now.getTime(), 3)): SocialTopic {
  return {
    id: view.id,
    title: view.lead.title,
    coverage: view.coverage,
    score: view.score,
    gained,
    latestAt: view.latestAt,
    hashtags: view.tags.flatMap((tag) => tag.hashtags),
  };
}

/** 直近 hours 時間に保存した AI 要約（多くのメディアが報じた話題を先に。同じ話題は1件だけ） */
export function socialSummaries(now: Date, hours = 48): SocialSummary[] {
  const cutoff = now.getTime() - hours * HOUR;
  const seenTopics = new Set<string>();
  return getSummaries()
    .filter((record) => Date.parse(record.summarizedAt) >= cutoff)
    .map((record) => ({ record, view: topicViewOf(record.id) }))
    .sort((a, b) => (b.view?.coverage ?? 1) - (a.view?.coverage ?? 1) || b.record.summarizedAt.localeCompare(a.record.summarizedAt))
    .filter(({ view }) => {
      if (!view) return true;
      if (seenTopics.has(view.id)) return false;
      seenTopics.add(view.id);
      return true;
    })
    .map(({ record, view }) => ({
      id: record.id,
      title: record.title,
      lead: firstSentence(record.summary),
      path: view ? topicPath(view.id) : summaryPath(record.id),
      ...(view ? { topicId: view.id } : {}),
      hashtags: tagsOfItem(record).flatMap((tag) => tag.hashtags),
    }));
}

/** 投稿の材料をまとめて作る */
export function socialSources(now: Date) {
  const rising = getRisingTopics({ limit: 10, minTopics: 1 });
  return {
    hot: getHotTopics({ hours: 12, limit: 10 }).map((view) => socialTopic(view, now)),
    // 急上昇は3時間に新しく報じたメディアの数で決める（広げた時間では投稿しない）
    rising: rising.hours === 3 ? rising.topics.map((entry) => socialTopic(entry.topic, now, entry.gained)) : [],
    important: getImportantTopics({ hours: 24, limit: 5, perCategory: 1 }).map((view) => socialTopic(view, now)),
    ai: getTagTopics('ai', { hours: 24, limit: 5 }).map((view) => socialTopic(view, now)),
    weekly: getHotTopics({ hours: 24 * 7, limit: 5, sort: 'coverage' }).map((view) => socialTopic(view, now)),
    summaries: socialSummaries(now),
  };
}
