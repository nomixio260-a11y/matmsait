import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tags } from '../../src/config/tags.ts';
import { isHidden } from '../../src/lib/blocklist.ts';
import { jstDateKey } from '../../src/lib/dates.ts';
import { clusterTopics, type ClusterOptions } from '../../src/lib/related.ts';
import { getSummaries } from '../../src/lib/summaries.ts';
import { HOUR, TOPIC_DAYS, prepareVocabulary } from '../../src/lib/topic-core.ts';
import { buildDayTrend, isDayTrend, sameDayTrend, type DayTrend } from '../../src/lib/trend-core.ts';
import type { Item } from '../../src/lib/types.ts';

const DAY = 24 * HOUR;

/** 言葉の候補: AI 要約のキーワードとタグの言葉（サイトの注目ワードと同じ） */
export function trendVocabulary(): string[] {
  return [...getSummaries().flatMap((record) => record.keywords ?? []), ...tags.flatMap((tag) => tag.words)];
}

export function readDayTrend(path: string): DayTrend | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isDayTrend(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** トピックは1行ずつにする（差分を読みやすくするため） */
export function serializeDayTrend(trend: DayTrend): string {
  const { top, ...rest } = trend;
  const head = JSON.stringify(rest).slice(0, -1);
  return top.length === 0 ? `${head},"top":[]}\n` : `${head},"top":[\n${top.map((topic) => JSON.stringify(topic)).join(',\n')}\n]}\n`;
}

export interface TrendUpdateOptions {
  /** 何日分を作り直すか（日本時間の今日から。報じる媒体は後から増えるので数日分） */
  days?: number;
  /** 言葉の候補（省略時は AI 要約のキーワードとタグの言葉） */
  vocabulary?: readonly string[];
  /** 運営者によるトピックの統合・分割（サイトのトピックと同じまとめ方にする） */
  links?: Pick<ClusterOptions, 'mustLink' | 'cannotLink'>;
  /** サイトに載せない記事か（省略時は data/blocklist.json の設定） */
  hidden?: (item: Item) => boolean;
}

/**
 * 日ごとの集計（data/trends/YYYY-MM-DD.json）のうち、直近 days 日分を作り直す。内容が変わった日付を返す。
 * トピックはサイトと同じ期間（TOPIC_DAYS）の記事でまとめ、サイトに載せない記事は数えない
 */
export function updateTrendFiles(
  items: readonly Item[],
  dir: string,
  now: Date,
  { days = 3, vocabulary = trendVocabulary(), links, hidden = isHidden }: TrendUpdateOptions = {},
): string[] {
  const cutoff = now.getTime() - TOPIC_DAYS * DAY;
  const visible = items.filter((item) => Date.parse(item.publishedAt) >= cutoff && !hidden(item));
  const clusters = clusterTopics(visible, links);
  const words = prepareVocabulary(vocabulary);
  mkdirSync(dir, { recursive: true });
  const changed: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = jstDateKey(new Date(now.getTime() - offset * DAY));
    const next = buildDayTrend(date, visible, clusters, words, now);
    if (next.articles === 0) continue;
    const path = join(dir, `${date}.json`);
    const previous = readDayTrend(path);
    if (previous && sameDayTrend(previous, next)) continue;
    writeFileSync(path, serializeDayTrend(next));
    changed.push(date);
  }
  return changed;
}
