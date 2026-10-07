/**
 * トレンド（変化）の材料。ビルド中に1回だけ計算する。
 * - 日ごとの集計（data/trends/）: 日別・週間の分析に使う。記事が消えたあとも残る
 * - いまの変化: ビルドした時刻の24時間と、その前の24時間・それまでの7日間を記事から比べる（トレンドのページ）
 * 計算は trend-core.ts（テストできるよう分けている）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories } from '../config/site.ts';
import { getBlocklist } from './blocklist.ts';
import { blockReason } from './blocklist-core.ts';
import { jstDateKey } from './dates.ts';
import { builtAt, getItems, getSource } from './items.ts';
import { HOUR, WORD_BASELINE_DAYS, containsWord, isNewWord, normalizeWord, prepareVocabulary, rankHot, type TrendWord } from './topic-core.ts';
import { getGenreTemperature, getTopicView, getTopicViews, getTrendWords, topicViewOf, type TopicView } from './topics.ts';
import {
  appearedTopics,
  coolingTopics,
  emergingPairs,
  isDayTrend,
  summarizeWeek,
  wordShifts,
  type CoolingTopic,
  type DayTopic,
  type DayTrend,
  type WeekSummary,
  type WordPair,
  type WordShift,
  type WordedEntry,
} from './trend-core.ts';
import { getWordView, getWordViews, relatedWords, wordHref, type WordView } from './words.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const TRENDS_DIR = resolve(process.cwd(), 'data/trends');

let dayCache: DayTrend[] | undefined;

/** 管理画面で非表示にした記事・NG ワードは、過去の集計からも外して見せる */
function withoutHidden(day: DayTrend): DayTrend {
  const list = getBlocklist();
  const words = Object.fromEntries(Object.entries(day.words).filter(([word]) => !blockReason({ id: '', title: word, url: '' }, list)));
  const top = day.top.filter((topic) => !blockReason({ id: topic.id, title: topic.title, url: topic.url }, list));
  return { ...day, words, top };
}

/** 日ごとの集計（新しい日付順） */
export function getDayTrends(): DayTrend[] {
  if (!dayCache) {
    dayCache = existsSync(TRENDS_DIR)
      ? readdirSync(TRENDS_DIR)
          .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
          .flatMap((file) => {
            try {
              const data: unknown = JSON.parse(readFileSync(resolve(TRENDS_DIR, file), 'utf8'));
              return isDayTrend(data) ? [withoutHidden(data)] : [];
            } catch {
              return [];
            }
          })
          .sort((a, b) => b.date.localeCompare(a.date))
      : [];
  }
  return dayCache;
}

export function getDayTrend(date: string): DayTrend | undefined {
  return getDayTrends().find((day) => day.date === date);
}

/** その日より前の集計（新しい順に days 日分まで） */
export function trendsBefore(date: string, days = WORD_BASELINE_DAYS): DayTrend[] {
  return getDayTrends()
    .filter((day) => day.date < date)
    .slice(0, days);
}

/** 集計のトピックの、いまのトピックのページ（なくなっていれば undefined） */
export function liveTopicOf(topic: DayTopic): TopicView | undefined {
  return getTopicView(topic.id);
}

/** 集計のトピックの見せ方: トピックのページがあれば、その見出しとリンク。なくなっていれば初報の記事へ */
export interface DayTopicView {
  topic: DayTopic;
  title: string;
  coverage: number;
  /** リンク先（トピックのページは href() を通す前のパス、初報の記事は URL） */
  link: string;
  /** 初報の記事へのリンクか */
  external: boolean;
  /** 初報のメディア名 */
  source?: string;
}

export function dayTopicView(topic: DayTopic): DayTopicView {
  const live = liveTopicOf(topic);
  return {
    topic,
    title: live?.lead.title ?? topic.title,
    coverage: Math.max(live?.coverage ?? 0, topic.coverage),
    link: live ? `/topic/${live.id}/` : topic.url,
    external: !live,
    source: getSource(topic.sourceId)?.name,
  };
}

let weekCache: WeekSummary | undefined;

/** 今週のトピあつめ（直近7日間。今日を含む） */
export function getWeekSummary(): WeekSummary {
  weekCache ??= summarizeWeek(getDayTrends(), jstDateKey(builtAt));
  return weekCache;
}

// ===== いまの変化（トレンドのページ） =====

let entriesCache: WordedEntry[] | undefined;

/** 直近の記事と、見出しに入っているキーワード（キーワードのページの言葉のうち、注目ワードにしない言葉を除いたもの） */
function wordEntries(): WordedEntry[] {
  if (!entriesCache) {
    const trendKeys = new Set(prepareVocabulary(getWordViews().map((view) => view.word)).map((word) => word.key));
    const wordsByItem = new Map<string, { label: string; key: string }[]>();
    for (const view of getWordViews()) {
      if (!trendKeys.has(view.key)) continue;
      for (const item of view.items) wordsByItem.set(item.id, [...(wordsByItem.get(item.id) ?? []), { label: view.word, key: view.key }]);
    }
    entriesCache = getItems()
      .filter((item) => wordsByItem.has(item.id))
      .map((item) => ({ id: item.id, words: wordsByItem.get(item.id) ?? [], sourceId: item.sourceId, publishedAt: item.publishedAt }));
  }
  return entriesCache;
}

/** 注目ワードの表の1行 */
export interface TrendWordRow {
  word: TrendWord;
  /** キーワードのページ（あれば） */
  view?: WordView;
  /** 24時間に報道があった、その言葉のトピックのうち話題度のいちばん高いもの */
  topic?: TopicView;
  /** 一緒に出てくる言葉 */
  related: WordView[];
  /** 24時間ごとの見出しの数（古い順。最後が直近24時間。それまでの7日間と比べられるように8つ） */
  windows: number[];
}

/** その言葉が見出しに入った、24時間に報道があったトピック（話題度の順） */
function topicsWithWord(word: string, view: WordView | undefined): TopicView[] {
  const since = builtAt.getTime() - 24 * HOUR;
  const recent = (topic: TopicView) => Date.parse(topic.latestAt) >= since;
  if (view) return view.topics.filter(recent);
  const key = normalizeWord(word);
  return rankHot(getTopicViews().filter((topic) => recent(topic) && topic.items.some((item) => containsWord(normalizeWord(item.title), key))));
}

let rowCache: TrendWordRow[] | undefined;

/** 注目ワード（24時間の数・それまでの7日間の1日平均・増え方・関連トピック・一緒に出てくる言葉） */
export function getTrendWordRows(limit = 20): TrendWordRow[] {
  rowCache ??= getTrendWords(60).map((word) => {
    const view = getWordView(word.word);
    return {
      word,
      view,
      topic: topicsWithWord(word.word, view)[0],
      related: view ? relatedWords(view, 3).map((entry) => entry.view) : [],
      windows: wordWindows(word.word, view),
    };
  });
  return rowCache.slice(0, limit);
}

/** 24時間ごとの見出しの数（古い順に 1 + WORD_BASELINE_DAYS 個。最後が直近24時間） */
function wordWindows(word: string, view: WordView | undefined): number[] {
  const now = builtAt.getTime();
  const count = 1 + WORD_BASELINE_DAYS;
  const key = normalizeWord(word);
  const items = view?.items ?? getItems().filter((item) => containsWord(normalizeWord(item.title), key));
  const windows = Array.from({ length: count }, () => 0);
  for (const item of items) {
    const age = now - Date.parse(item.publishedAt);
    const index = Math.floor(Math.max(0, age) / (24 * HOUR));
    if (index < count) windows[count - 1 - index]++;
  }
  return windows;
}

/** 急に現れた言葉: それまでの7日間にほとんど（1件以下しか）出てこなかったのに、24時間で3件以上・2媒体以上の見出しに出てきた言葉 */
export function getEmergingWords(limit = 8): (TrendWordRow & { firstAt?: string })[] {
  const since = builtAt.getTime() - 24 * HOUR;
  return getTrendWordRows(60)
    .filter((row) => isNewWord(row.word.previous) && row.word.count >= 3)
    .slice(0, limit)
    .map((row) => {
      const key = normalizeWord(row.word.word);
      // 24時間のうち、その言葉が最初に見出しに出てきた時刻
      const first = getItems()
        .filter((item) => Date.parse(item.publishedAt) > since && containsWord(normalizeWord(item.title), key))
        .at(-1);
      return { ...row, firstAt: first?.publishedAt };
    });
}

/** 一緒に出始めた言葉（とその組の、いちばん新しい記事のトピック）。同じトピックから出た組は1つだけにする */
export function getEmergingPairs(limit = 8): (WordPair & { topic?: TopicView })[] {
  const seen = new Set<string>();
  return emergingPairs(wordEntries(), builtAt.getTime(), { limit: 50 })
    .map((pair) => ({ ...pair, topic: pair.ids.map((id) => topicViewOf(id)).find((view) => view !== undefined) }))
    .filter((pair) => {
      const key = pair.topic?.id ?? pair.ids.join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/** 昨日との違いの1行 */
export interface DiffEntry {
  kind: 'genre' | 'word' | 'topic';
  label: string;
  /** 「12→25件」「3→8媒体」など */
  change: string;
  href?: string;
  /** 補足（「最後の報道は15時間前」など） */
  note?: string;
}

export interface YesterdayDiff {
  surge: DiffEntry[];
  drop: DiffEntry[];
  appeared: DiffEntry[];
  cooled: DiffEntry[];
}

/** 言葉の増減（直近24時間とその前の24時間） */
export function getWordShifts(): WordShift[] {
  return wordShifts(wordEntries(), builtAt.getTime());
}

/** ジャンルごとの記事の数（直近24時間と、その前の24時間） */
export function getGenreArticleShifts(): Map<string, { recent: number; previous: number }> {
  const now = builtAt.getTime();
  const shifts = new Map(categories.map((category) => [category.slug, { recent: 0, previous: 0 }]));
  for (const item of getItems()) {
    const time = Date.parse(item.publishedAt);
    if (time > now || time <= now - 48 * HOUR) continue;
    const entry = shifts.get(item.category);
    if (!entry) continue;
    if (time > now - 24 * HOUR) entry.recent++;
    else entry.previous++;
  }
  return shifts;
}

let diffCache: YesterdayDiff | undefined;

/**
 * 昨日との違い: 急増（言葉・ジャンル）・急減（言葉・ジャンル）・新登場（トピック）・収束（トピック）。
 * 数字から機械的に選び、良い・悪いの判断はしない
 */
export function getYesterdayDiff({ limit = 4 }: { limit?: number } = {}): YesterdayDiff {
  if (diffCache) return diffCache;
  const now = builtAt.getTime();
  const shifts = getWordShifts();
  const genres = getGenreTemperature();
  const genreSurge = genres
    .filter((genre) => genre.topics >= genre.previousTopics + 3 && genre.topics >= genre.previousTopics * 1.5)
    .sort((a, b) => b.topics - b.previousTopics - (a.topics - a.previousTopics))
    .slice(0, 2)
    .map((genre): DiffEntry => ({ kind: 'genre', label: genre.name, change: `トピック ${genre.previousTopics}→${genre.topics}件`, href: `/category/${genre.category}/` }));
  const genreDrop = genres
    .filter((genre) => genre.previousTopics >= genre.topics + 3 && genre.topics <= genre.previousTopics * 0.6)
    .sort((a, b) => b.previousTopics - b.topics - (a.previousTopics - a.topics))
    .slice(0, 2)
    .map((genre): DiffEntry => ({ kind: 'genre', label: genre.name, change: `トピック ${genre.previousTopics}→${genre.topics}件`, href: `/category/${genre.category}/` }));
  const wordSurge = shifts
    .filter((shift) => shift.recent >= 4 && shift.sources >= 2 && shift.recent >= shift.previous * 2)
    .sort((a, b) => b.recent - b.previous - (a.recent - a.previous) || b.recent - a.recent)
    .slice(0, limit)
    .map((shift): DiffEntry => ({ kind: 'word', label: shift.word, change: `見出し ${shift.previous}→${shift.recent}件`, href: wordHref(shift.word) }));
  const wordDrop = shifts
    .filter((shift) => shift.previous >= 4 && shift.recent * 2 <= shift.previous)
    .sort((a, b) => b.previous - b.recent - (a.previous - a.recent) || b.previous - a.previous)
    .slice(0, limit)
    .map((shift): DiffEntry => ({ kind: 'word', label: shift.word, change: `見出し ${shift.previous}→${shift.recent}件`, href: wordHref(shift.word) }));
  const appeared = appearedTopics(getTopicViews(), now, { limit }).map(
    (view): DiffEntry => ({ kind: 'topic', label: view.lead.title, change: `0→${view.coverage}媒体`, href: `/topic/${view.id}/` }),
  );
  const cooled = coolingTopics(getTopicViews(), now, { limit }).map(
    (entry: CoolingTopic<TopicView>): DiffEntry => ({
      kind: 'topic',
      label: entry.topic.lead.title,
      change: `話題度 ${entry.before}→${entry.after}`,
      href: `/topic/${entry.topic.id}/`,
      note: `最後の報道は${Math.round((now - entry.lastAt) / HOUR)}時間前`,
    }),
  );
  diffCache = {
    surge: [...genreSurge, ...wordSurge].slice(0, limit),
    drop: [...genreDrop, ...wordDrop].slice(0, limit),
    appeared,
    cooled,
  };
  return diffCache;
}
