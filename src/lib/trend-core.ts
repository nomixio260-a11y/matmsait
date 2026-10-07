/**
 * トレンドの計算（日ごとの集計・昨日との違い・一緒に出始めた言葉・週間のまとめ）。Node 専用の機能は使わない。
 * 日ごとの集計は data/trends/YYYY-MM-DD.json に残し（毎時の収集で直近の数日分を作り直す）、記事が消えたあとも日別・週間の分析に使う。
 * どれも数字から機械的に出し、ニュースの良し悪し・重要さは判断しない
 */
import { dateFromKey, jstDateKey } from './dates.ts';
import type { TopicCluster } from './related.ts';
import {
  HOUR,
  WORD_BASELINE_DAYS,
  categoriesOf,
  containsWord,
  heatAt,
  heatOf,
  normalizeWord,
  reportsOf,
  scoreOf,
  topicIdOf,
  type TopicReport,
  type TopicStats,
  type VocabularyWord,
} from './topic-core.ts';
import type { Item } from './types.ts';

const DAY = 24 * HOUR;
/** 広がる速さを数える時間（急上昇と同じ3時間） */
const BURST_HOURS = 3;
/** 日ごとの集計に残すトピック: 話題度・その日に増えた媒体の数・広がる速さ、それぞれの上位 */
const KEEP_BY_PEAK = 15;
const KEEP_BY_ADDED = 10;
const KEEP_BY_BURST = 10;

// ===== 日ごとの集計 =====

/** 日ごとの集計に残すトピック */
export interface DayTopic {
  /** トピックの ID（最初に報じた記事の ID。トピックのページがあればリンクする） */
  id: string;
  /** 最初に報じた記事の見出し・URL・媒体（トピックのページがなくなった日も、初報へリンクできるように） */
  title: string;
  url: string;
  sourceId: string;
  /** いちばん多く報じたジャンル */
  category: string;
  /** 最初の報道の日時 */
  firstAt: string;
  /** その日の終わり（今日はいま）までに報じた媒体の数 */
  coverage: number;
  /** その日に新しく報じた媒体の数 */
  added: number;
  /** その日のうちで最も高かった話題度（0〜100。読まれた数は含めない） */
  peak: number;
  /** その日のうちに、3時間で新しく報じた媒体の数の最大（広がる速さ） */
  burst: number;
}

/** ジャンルごとの、その日の数字 */
export interface GenreDay {
  /** 記事の数 */
  articles: number;
  /** その日に記事があったトピック（2媒体以上）の数。トピックはいちばん多く報じたジャンルに数える */
  topics: number;
  /** ニュースの温度: それらのトピックの、その日の終わり（今日はいま）の熱さの合計 */
  heat: number;
}

/** 言葉ごとの、その日の見出しの数 */
export interface WordDay {
  /** その言葉が見出しに入った記事の数 */
  articles: number;
  /** その記事を出した媒体の数 */
  media: number;
}

/** 日ごとの集計（日本時間の1日） */
export interface DayTrend {
  /** YYYY-MM-DD（日本時間） */
  date: string;
  updatedAt: string;
  /** どの時点までを数えたか（過ぎた日はその日の終わり、今日は集計した時刻） */
  until: string;
  /** その日に公開された記事の数 */
  articles: number;
  /** 記事を出した媒体の数 */
  media: number;
  /** その日に記事があったトピック（2媒体以上）の数 */
  topics: number;
  genres: Record<string, GenreDay>;
  /** 言葉（AI 要約のキーワードとタグの言葉）ごとの見出しの数。2件以上の言葉だけ */
  words: Record<string, WordDay>;
  /** その日のトピックのうち、話題度・増えた媒体の数・広がる速さのどれかで上位のもの（話題度の順） */
  top: DayTopic[];
}

/** その日のうちで最も高かった話題度（その時点までの報道で計算。熱さは報道のたびに上がって、あとは下がるので、報道の時刻だけ見ればよい） */
export function peakWithin(reports: readonly TopicReport[], from: number, until: number): number {
  let peak = reports.some((report) => report.time < from) ? scoreOf(heatAt(reports, from)) : 0;
  for (const report of reports) {
    if (report.time < from || report.time >= until) continue;
    peak = Math.max(peak, scoreOf(heatAt(reports, report.time)));
  }
  return peak;
}

/** その日のうちに、hours 時間で新しく報じた媒体の数の最大（reports は報じた順） */
export function burstWithin(reports: readonly TopicReport[], from: number, until: number, hours = BURST_HOURS): number {
  let best = 0;
  let start = 0;
  reports.forEach((report, index) => {
    while (reports[start].time <= report.time - hours * HOUR) start++;
    if (report.time >= from && report.time < until) best = Math.max(best, index - start + 1);
  });
  return best;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * ある日の集計を作る。clusters はその日の前後を含む記事をまとめたもの（サイトのトピックと同じまとめ方）。
 * 今日の分は now までを数える
 */
export function buildDayTrend(
  date: string,
  items: readonly Item[],
  clusters: readonly TopicCluster[],
  vocabulary: readonly VocabularyWord[],
  now: Date,
): DayTrend {
  const from = dateFromKey(date).getTime();
  const until = Math.min(from + DAY, now.getTime());
  const inDay = (time: number) => time >= from && time < until;
  const dayItems = items.filter((item) => inDay(Date.parse(item.publishedAt)));

  const genres: Record<string, GenreDay> = {};
  const genreOf = (slug: string) => (genres[slug] ??= { articles: 0, topics: 0, heat: 0 });
  for (const item of dayItems) genreOf(item.category).articles++;

  const topics: DayTopic[] = [];
  for (const cluster of clusters) {
    if (!cluster.items.some((item) => inDay(Date.parse(item.publishedAt)))) continue;
    const reports = reportsOf(cluster.items).filter((report) => report.time < until);
    if (reports.length < 2) continue;
    const category = categoriesOf(reports)[0] ?? reports[0].item.category;
    const genre = genreOf(category);
    genre.topics++;
    genre.heat += heatOf(reports, until);
    topics.push({
      id: topicIdOf(cluster.items),
      title: reports[0].item.title,
      url: reports[0].item.url,
      sourceId: reports[0].item.sourceId,
      category,
      firstAt: new Date(reports[0].time).toISOString(),
      coverage: reports.length,
      added: reports.filter((report) => report.time >= from).length,
      peak: peakWithin(reports, from, until),
      burst: burstWithin(reports, from, until),
    });
  }
  for (const genre of Object.values(genres)) genre.heat = round2(genre.heat);

  const titles = dayItems.map((item) => ({ title: normalizeWord(item.title), sourceId: item.sourceId }));
  const words: Record<string, WordDay> = {};
  for (const word of vocabulary) {
    const matched = titles.filter((entry) => containsWord(entry.title, word.key));
    if (matched.length >= 2) words[word.label] = { articles: matched.length, media: new Set(matched.map((entry) => entry.sourceId)).size };
  }

  const byPeak = (a: DayTopic, b: DayTopic) => b.peak - a.peak || b.coverage - a.coverage || a.id.localeCompare(b.id);
  const keep = new Set([
    ...[...topics].sort(byPeak).slice(0, KEEP_BY_PEAK),
    ...topics
      .filter((topic) => topic.added >= 1)
      .sort((a, b) => b.added - a.added || byPeak(a, b))
      .slice(0, KEEP_BY_ADDED),
    ...topics
      .filter((topic) => topic.burst >= 2)
      .sort((a, b) => b.burst - a.burst || byPeak(a, b))
      .slice(0, KEEP_BY_BURST),
  ]);

  return {
    date,
    updatedAt: now.toISOString(),
    until: new Date(until).toISOString(),
    articles: dayItems.length,
    media: new Set(dayItems.map((item) => item.sourceId)).size,
    topics: topics.length,
    genres: Object.fromEntries(Object.entries(genres).sort(([a], [b]) => a.localeCompare(b))),
    words: Object.fromEntries(Object.entries(words).sort(([a, x], [b, y]) => y.articles - x.articles || a.localeCompare(b))),
    top: [...keep].sort(byPeak),
  };
}

/** 集計の中身が同じか（更新日時は比べない。変わっていない日のファイルを書き直さないため） */
export function sameDayTrend(a: DayTrend, b: DayTrend): boolean {
  const strip = ({ updatedAt: _, ...rest }: DayTrend) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

/** ファイルの形が正しいか（壊れたファイル・古い形のファイルは読まない） */
export function isDayTrend(value: unknown): value is DayTrend {
  const data = value as Partial<DayTrend> | null;
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof data.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(data.date) &&
    typeof data.until === 'string' &&
    typeof data.articles === 'number' &&
    typeof data.topics === 'number' &&
    typeof data.genres === 'object' &&
    typeof data.words === 'object' &&
    Array.isArray(data.top)
  );
}

/** 1日がすべて数え終わっているか（今日の分は途中） */
export function isCompleteDay(day: Pick<DayTrend, 'date' | 'until'>): boolean {
  return Date.parse(day.until) >= dateFromKey(day.date).getTime() + DAY;
}

// ===== 日ごとの集計を比べる（日別・週間のページ） =====

/** 前の日と比べたジャンルの数字 */
export interface GenreChange {
  category: string;
  today: GenreDay;
  /** 前の日（集計がなければ undefined） */
  previous?: GenreDay;
}

const emptyGenre = (): GenreDay => ({ articles: 0, topics: 0, heat: 0 });

/** ジャンルの変化: その日と前の日のジャンルごとの数字（その日のトピックの多い順） */
export function genreChanges(day: DayTrend, previous: DayTrend | undefined): GenreChange[] {
  const slugs = new Set([...Object.keys(day.genres), ...Object.keys(previous?.genres ?? {})]);
  return [...slugs]
    .map((category) => ({
      category,
      today: day.genres[category] ?? emptyGenre(),
      previous: previous ? (previous.genres[category] ?? emptyGenre()) : undefined,
    }))
    .sort((a, b) => b.today.topics - a.today.topics || b.today.articles - a.today.articles || a.category.localeCompare(b.category));
}

/** その日の注目ワード（その前の日々の集計と比べる） */
export interface DayWordTrend {
  word: string;
  articles: number;
  media: number;
  /** 前の日々の1日あたりの見出しの数（比べる日の集計がなければ undefined） */
  baseline?: number;
  /** 比べた日の数 */
  baselineDays: number;
}

/** 片方がもう片方を含む言葉（「INZONE」と「INZONE H9 II」など）は、先に並んだほうだけ残す */
function withoutNested<T extends { word: string }>(list: readonly T[], limit: number): T[] {
  const picked: T[] = [];
  for (const entry of list) {
    if (picked.length >= limit) break;
    const key = normalizeWord(entry.word);
    if (picked.some((other) => normalizeWord(other.word).includes(key) || key.includes(normalizeWord(other.word)))) continue;
    picked.push(entry);
  }
  return picked;
}

/**
 * その日の注目ワード: その日の見出しに minArticles 件・minMedia 媒体以上出てきた言葉を、前の日々（最大 WORD_BASELINE_DAYS 日）の
 * 1日あたりの数と比べて、増え方の大きい順に並べる。前の日の集計がなければ、その日の数の順
 */
export function dayWordTrends(
  day: DayTrend,
  previousDays: readonly DayTrend[],
  { limit = 12, minArticles = 3, minMedia = 2 }: { limit?: number; minArticles?: number; minMedia?: number } = {},
): DayWordTrend[] {
  const before = previousDays.filter((other) => other.date < day.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, WORD_BASELINE_DAYS);
  const totals = new Map<string, number>();
  for (const other of before) {
    for (const [word, count] of Object.entries(other.words)) totals.set(normalizeWord(word), (totals.get(normalizeWord(word)) ?? 0) + count.articles);
  }
  const candidates = Object.entries(day.words)
    .filter(([, count]) => count.articles >= minArticles && count.media >= minMedia)
    .map(([word, count]) => ({
      word,
      articles: count.articles,
      media: count.media,
      baseline: before.length > 0 ? (totals.get(normalizeWord(word)) ?? 0) / before.length : undefined,
      baselineDays: before.length,
    }));
  const score = (entry: DayWordTrend) => entry.articles / ((entry.baseline ?? 0) + 1);
  candidates.sort(
    (a, b) => score(b) - score(a) || b.articles - a.articles || Array.from(b.word).length - Array.from(a.word).length || a.word.localeCompare(b.word),
  );
  return withoutNested(candidates, limit);
}

/** 週間のまとめ */
export interface WeekSummary {
  /** 7日分の日付（古い順。最後が end） */
  dates: string[];
  /** 集計のある日（古い順） */
  days: DayTrend[];
  /** その前の7日分のうち、集計のある日 */
  previousDays: DayTrend[];
  /** 記事の数の合計と、1日あたりのトピックの数（数え終わった日の平均。今日の途中の分は平均に入れない） */
  articles: number;
  topicsPerDay: number;
  previous?: { articles: number; topicsPerDay: number; days: number };
  /** その週のトピック（話題度の高い順。同じトピックは1つにまとめ、いちばん大きい数字を使う） */
  topics: DayTopic[];
  /** その週の言葉（見出しの数の合計の多い順。前の週の数つき） */
  words: { word: string; articles: number; previous?: number }[];
  /** ジャンルごとの記事・トピックの合計（前の週の合計つき） */
  genres: { category: string; articles: number; topics: number; previous?: { articles: number; topics: number } }[];
}

/** 直近7日間（end を含む）のまとめ。前の7日間の集計があれば比べる */
export function summarizeWeek(trends: readonly DayTrend[], end: string): WeekSummary {
  const endTime = dateFromKey(end).getTime();
  const dates = Array.from({ length: 7 }, (_, index) => jstDateKey(new Date(endTime - (6 - index) * DAY)));
  const previousDates = Array.from({ length: 7 }, (_, index) => jstDateKey(new Date(endTime - (13 - index) * DAY)));
  const byDate = new Map(trends.map((day) => [day.date, day]));
  const days = dates.map((date) => byDate.get(date)).filter((day): day is DayTrend => day !== undefined);
  const previousDays = previousDates.map((date) => byDate.get(date)).filter((day): day is DayTrend => day !== undefined);
  const sum = (list: readonly DayTrend[], pick: (day: DayTrend) => number) => list.reduce((total, day) => total + pick(day), 0);
  const average = (list: readonly DayTrend[], pick: (day: DayTrend) => number) => {
    const complete = list.filter(isCompleteDay);
    const used = complete.length > 0 ? complete : list;
    return used.length > 0 ? sum(used, pick) / used.length : 0;
  };

  const topicMap = new Map<string, DayTopic>();
  for (const day of days) {
    for (const topic of day.top) {
      const current = topicMap.get(topic.id);
      topicMap.set(
        topic.id,
        current
          ? {
              ...current,
              coverage: Math.max(current.coverage, topic.coverage),
              added: current.added + topic.added,
              peak: Math.max(current.peak, topic.peak),
              burst: Math.max(current.burst, topic.burst),
            }
          : topic,
      );
    }
  }

  const wordTotals = (list: readonly DayTrend[]) => {
    const totals = new Map<string, { word: string; articles: number }>();
    for (const day of list) {
      for (const [word, count] of Object.entries(day.words)) {
        const key = normalizeWord(word);
        const entry = totals.get(key) ?? { word, articles: 0 };
        entry.articles += count.articles;
        totals.set(key, entry);
      }
    }
    return totals;
  };
  const thisWeek = wordTotals(days);
  const lastWeek = wordTotals(previousDays);
  const words = [...thisWeek]
    .map(([key, entry]) => ({ word: entry.word, articles: entry.articles, previous: previousDays.length > 0 ? (lastWeek.get(key)?.articles ?? 0) : undefined }))
    .sort((a, b) => b.articles - a.articles || Array.from(b.word).length - Array.from(a.word).length || a.word.localeCompare(b.word));

  const genreTotals = (list: readonly DayTrend[]) => {
    const totals = new Map<string, { articles: number; topics: number }>();
    for (const day of list) {
      for (const [category, genre] of Object.entries(day.genres)) {
        const entry = totals.get(category) ?? { articles: 0, topics: 0 };
        entry.articles += genre.articles;
        entry.topics += genre.topics;
        totals.set(category, entry);
      }
    }
    return totals;
  };
  const genreThis = genreTotals(days);
  const genreLast = genreTotals(previousDays);
  const genres = [...new Set([...genreThis.keys(), ...genreLast.keys()])]
    .map((category) => ({
      category,
      ...(genreThis.get(category) ?? { articles: 0, topics: 0 }),
      previous: previousDays.length > 0 ? (genreLast.get(category) ?? { articles: 0, topics: 0 }) : undefined,
    }))
    .sort((a, b) => b.topics - a.topics || b.articles - a.articles || a.category.localeCompare(b.category));

  return {
    dates,
    days,
    previousDays,
    articles: sum(days, (day) => day.articles),
    topicsPerDay: average(days, (day) => day.topics),
    previous:
      previousDays.length > 0
        ? { articles: sum(previousDays, (day) => day.articles), topicsPerDay: average(previousDays, (day) => day.topics), days: previousDays.length }
        : undefined,
    topics: [...topicMap.values()].sort((a, b) => b.peak - a.peak || b.coverage - a.coverage || a.id.localeCompare(b.id)),
    words: withoutNested(words, words.length),
    genres,
  };
}

// ===== いまの変化（トレンドのページ。ビルドした時刻の24時間と、その前の24時間を比べる） =====

/** 見出しに入っている言葉がわかっている記事 */
export interface WordedEntry {
  id: string;
  words: readonly VocabularyWord[];
  sourceId: string;
  publishedAt: string;
}

/** 言葉の増減（直近 hours 時間と、その前の hours 時間） */
export interface WordShift {
  word: string;
  recent: number;
  previous: number;
  /** 直近に見出しに使った媒体の数 */
  sources: number;
}

/** 言葉ごとの見出しの数を、直近 hours 時間とその前の hours 時間で比べる */
export function wordShifts(entries: readonly WordedEntry[], now: number, { hours = 24 }: { hours?: number } = {}): WordShift[] {
  const recentFrom = now - hours * HOUR;
  const previousFrom = recentFrom - hours * HOUR;
  const stats = new Map<string, { word: string; recent: number; previous: number; sources: Set<string> }>();
  for (const entry of entries) {
    const time = Date.parse(entry.publishedAt);
    if (time > now || time <= previousFrom) continue;
    for (const word of entry.words) {
      const stat = stats.get(word.key) ?? { word: word.label, recent: 0, previous: 0, sources: new Set<string>() };
      if (time > recentFrom) {
        stat.recent++;
        stat.sources.add(entry.sourceId);
      } else {
        stat.previous++;
      }
      stats.set(word.key, stat);
    }
  }
  return [...stats.values()].map(({ sources, ...stat }) => ({ ...stat, sources: sources.size }));
}

/** 一緒に出始めた言葉の組 */
export interface WordPair {
  a: string;
  b: string;
  /** 直近 hours 時間に、両方が入った見出しの数 */
  count: number;
  sources: number;
  /** 両方が入った記事（新しい順） */
  ids: string[];
}

/**
 * 一緒に出始めた言葉: 直近 hours 時間に minSources 媒体以上の見出しで一緒に使われた言葉の組のうち、
 * それまでの baselineDays 日間は一緒に出てこなかったもの。どちらの言葉も、それまでに単独では出てきていたものに限る
 * （新しい出来事の名前どうしの組ではなく、前からある言葉どうしの新しい結びつきを見つけるため）。
 * 片方がもう片方を含む組（「INZONE」と「INZONE H9 II」）は除く
 */
export function emergingPairs(
  entries: readonly WordedEntry[],
  now: number,
  {
    hours = 24,
    baselineDays = WORD_BASELINE_DAYS,
    minCount = 2,
    minSources = 2,
    limit = 10,
  }: { hours?: number; baselineDays?: number; minCount?: number; minSources?: number; limit?: number } = {},
): WordPair[] {
  const recentFrom = now - hours * HOUR;
  const baselineFrom = recentFrom - baselineDays * DAY;
  const recent = new Map<string, { a: VocabularyWord; b: VocabularyWord; ids: { id: string; time: number }[]; sources: Set<string> }>();
  const together = new Set<string>();
  const known = new Set<string>();
  for (const entry of entries) {
    const time = Date.parse(entry.publishedAt);
    if (time > now || time <= baselineFrom) continue;
    const isRecent = time > recentFrom;
    if (!isRecent) for (const word of entry.words) known.add(word.key);
    const words = [...new Map(entry.words.map((word) => [word.key, word])).values()].sort((x, y) => x.key.localeCompare(y.key));
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j < words.length; j++) {
        const [x, y] = [words[i], words[j]];
        if (x.key.includes(y.key) || y.key.includes(x.key)) continue;
        const pairKey = `${x.key}\u0000${y.key}`;
        if (!isRecent) {
          together.add(pairKey);
          continue;
        }
        const stat = recent.get(pairKey) ?? { a: x, b: y, ids: [], sources: new Set<string>() };
        stat.ids.push({ id: entry.id, time });
        stat.sources.add(entry.sourceId);
        recent.set(pairKey, stat);
      }
    }
  }
  return [...recent]
    .filter(
      ([pairKey, stat]) =>
        !together.has(pairKey) && known.has(stat.a.key) && known.has(stat.b.key) && stat.ids.length >= minCount && stat.sources.size >= minSources,
    )
    .map(([, stat]) => ({
      a: stat.a.label,
      b: stat.b.label,
      count: stat.ids.length,
      sources: stat.sources.size,
      ids: stat.ids.sort((x, y) => y.time - x.time).map((entry) => entry.id),
    }))
    .sort((p, q) => q.sources - p.sources || q.count - p.count || p.a.localeCompare(q.a) || p.b.localeCompare(q.b))
    .slice(0, limit);
}

/** 話題が落ち着いたトピック（24時間前には話題度が高かったが、新しい報道が止まり、話題度が下がったもの） */
export interface CoolingTopic<T> {
  topic: T;
  /** 24時間前の話題度 */
  before: number;
  /** いまの話題度（読まれた数は含めない） */
  after: number;
  /** 最後の報道の時刻 */
  lastAt: number;
}

export function coolingTopics<T extends TopicStats>(
  topics: readonly T[],
  now: number,
  { minBefore = 40, ratio = 0.5, quietHours = 12, limit = 5 }: { minBefore?: number; ratio?: number; quietHours?: number; limit?: number } = {},
): CoolingTopic<T>[] {
  return topics
    .map((topic) => ({
      topic,
      before: scoreOf(heatAt(topic.reports, now - DAY)),
      after: scoreOf(heatAt(topic.reports, now)),
      lastAt: topic.reports.at(-1)?.time ?? 0,
    }))
    .filter((entry) => entry.before >= minBefore && entry.after <= entry.before * ratio && entry.lastAt <= now - quietHours * HOUR)
    .sort((a, b) => b.before - a.before || b.topic.coverage - a.topic.coverage || a.topic.id.localeCompare(b.topic.id))
    .slice(0, limit);
}

/** 新しく登場したトピック: 最初の報道が直近 hours 時間以内で、minCoverage 媒体以上が報じたもの（媒体の多い順） */
export function appearedTopics<T extends TopicStats>(
  topics: readonly T[],
  now: number,
  { hours = 24, minCoverage = 3, limit = 5 }: { hours?: number; minCoverage?: number; limit?: number } = {},
): T[] {
  const from = now - hours * HOUR;
  return topics
    .filter((topic) => topic.coverage >= minCoverage && (topic.reports[0]?.time ?? 0) > from)
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
