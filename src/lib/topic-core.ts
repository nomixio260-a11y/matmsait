/**
 * 話題（同じ出来事を報じた記事のまとまり）の数字を計算する。Node 専用の機能は使わない（ビルドと SNS の自動投稿で使う）。
 * - 話題度スコア: 報じたメディアの数・報道の新しさ・ジャンルの広がり・このサイトで読まれた人数から 0〜100 で表す
 * - 急上昇: 直近の数時間に新しく報じたメディアの数
 * - 初報: いちばん早く報じたメディア
 * - 今日の重要ニュース: 報じたメディアの数とジャンルの広がり（時間では減らさない）の順。1つのジャンルに偏らないようにする
 * - 注目ワード: 直近の見出しに、それまでより急に多く出てきた言葉
 */
import type { TopicCluster } from './related.ts';
import type { Item } from './types.ts';

export const HOUR = 60 * 60 * 1000;

/** 話題度スコアで、1つの報道の重みが半分になるまでの時間 */
export const HALF_LIFE_HOURS = 12;
/** スコアの目盛り（熱さがこの値のとき約63点。報道4件が直後なら約63点、8件なら約86点） */
const SCORE_SCALE = 4;
/** 報じたメディアのジャンルが1つ増えるごとの上乗せ（いろいろな分野のメディアが報じた話題ほど大きな話題とみなす） */
const DIVERSITY_BONUS = 0.2;
/** このサイトで読まれた人数の重み（人数の対数に掛ける） */
const READS_WEIGHT = 0.5;

/** 1つのメディアの、その話題についての最初の記事 */
export interface TopicReport {
  item: Item;
  /** 報じた日時（ミリ秒） */
  time: number;
}

/** 新しく報じたメディアの数（直近1時間・3時間・24時間） */
export interface TopicGrowth {
  h1: number;
  h3: number;
  h24: number;
}

export interface TopicStats {
  /** 話題の ID（最初に報じた記事の ID。話題のページの URL に使う） */
  id: string;
  /** 報じたメディアの数 */
  coverage: number;
  /** 最初・最後に報じられた日時（ISO 8601） */
  firstAt: string;
  latestAt: string;
  /** メディアごとの最初の記事（報じた順。先頭が初報） */
  reports: TopicReport[];
  growth: TopicGrowth;
  /** 報じたメディアのジャンル（多い順） */
  categories: string[];
  /** 熱さ（話題度スコアのもとになる値） */
  heat: number;
  /** 話題度スコア（0〜100） */
  score: number;
  /** このサイトで24時間に読まれた人数（わからなければ0） */
  reads: number;
}

/** 話題の ID: 最初に報じた記事の ID（同じ時刻なら ID の小さいほう）。記事が増えても変わりにくい */
export function topicIdOf(items: readonly Item[]): string {
  let first = items[0];
  let firstTime = Date.parse(first.publishedAt);
  for (const item of items) {
    const time = Date.parse(item.publishedAt);
    if (time < firstTime || (time === firstTime && item.id < first.id)) {
      first = item;
      firstTime = time;
    }
  }
  return first.id;
}

/** メディアごとに最初の記事を選び、報じた順に並べる */
export function reportsOf(items: readonly Item[]): TopicReport[] {
  const first = new Map<string, TopicReport>();
  for (const item of items) {
    const time = Date.parse(item.publishedAt);
    const current = first.get(item.sourceId);
    if (!current || time < current.time || (time === current.time && item.id < current.item.id)) {
      first.set(item.sourceId, { item, time });
    }
  }
  return [...first.values()].sort((a, b) => a.time - b.time || a.item.id.localeCompare(b.item.id));
}

/** 直近 hours 時間に新しく報じたメディアの数 */
export function growthWithin(reports: readonly TopicReport[], now: number, hours: number): number {
  const cutoff = now - hours * HOUR;
  return reports.filter((report) => report.time > cutoff).length;
}

/** 報じたメディアのジャンル（多い順。同じ数なら先に報じたジャンルが先） */
export function categoriesOf(reports: readonly TopicReport[]): string[] {
  const counts = new Map<string, number>();
  for (const { item } of reports) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([category]) => category);
}

/**
 * 熱さ: 報道1件ごとに1を足す（報じてから HALF_LIFE_HOURS 時間ごとに半分に減る）。
 * 報じたメディアのジャンルが多いほど上乗せし、このサイトで読まれた人数（わかるとき）も少し足す
 */
export function heatOf(reports: readonly TopicReport[], now: number, { reads = 0 }: { reads?: number } = {}): number {
  let heat = 0;
  for (const { time } of reports) heat += 0.5 ** (Math.max(0, now - time) / (HALF_LIFE_HOURS * HOUR));
  const genres = new Set(reports.map((report) => report.item.category)).size;
  heat *= 1 + DIVERSITY_BONUS * Math.max(0, genres - 1);
  if (reads > 0) heat += READS_WEIGHT * Math.log2(1 + reads);
  return heat;
}

/** 熱さを 0〜100 の話題度スコアにする（大きな話題ほど 100 に近づく） */
export function scoreOf(heat: number): number {
  return Math.round(100 * (1 - Math.exp(-Math.max(0, heat) / SCORE_SCALE)));
}

/** 話題の数字をまとめて計算する */
export function analyzeTopic(cluster: TopicCluster, now: number, { reads = 0 }: { reads?: number } = {}): TopicStats {
  const reports = reportsOf(cluster.items);
  const heat = heatOf(reports, now, { reads });
  return {
    id: topicIdOf(cluster.items),
    coverage: cluster.coverage,
    firstAt: cluster.firstAt,
    latestAt: cluster.latestAt,
    reports,
    growth: {
      h1: growthWithin(reports, now, 1),
      h3: growthWithin(reports, now, 3),
      h24: growthWithin(reports, now, 24),
    },
    categories: categoriesOf(reports),
    heat,
    score: scoreOf(heat),
    reads,
  };
}

/** いま話題: 話題度スコアの高い順（同じなら報じたメディアの多い順・新しく報じられた順） */
export function rankHot<T extends TopicStats>(topics: readonly T[]): T[] {
  return [...topics].sort(
    (a, b) => b.score - a.score || b.coverage - a.coverage || b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id),
  );
}

export interface RisingEntry<T> {
  topic: T;
  /** 集計した時間のうちに新しく報じたメディアの数 */
  gained: number;
}

export interface RisingResult<T> {
  /** 集計した時間（時間） */
  hours: number;
  topics: RisingEntry<T>[];
}

/**
 * 急上昇: 直近 hours 時間に新しく報じたメディアの多い順（同じなら最後に報じられたのが新しい順）。
 * 夜中など当てはまる話題が minTopics 件に足りないときは、集計する時間を広げる（3時間 → 6時間 → 12時間）
 */
export function rankRising<T extends TopicStats>(
  topics: readonly T[],
  now: number,
  { windows = [3, 6, 12], minTopics = 3, limit = 20 }: { windows?: number[]; minTopics?: number; limit?: number } = {},
): RisingResult<T> {
  let result: RisingResult<T> = { hours: windows[0] ?? 3, topics: [] };
  for (const hours of windows) {
    const rising = topics
      .filter((topic) => topic.coverage >= 2)
      .map((topic) => ({ topic, gained: growthWithin(topic.reports, now, hours) }))
      .filter((entry) => entry.gained >= 1)
      .sort(
        (a, b) =>
          b.gained - a.gained ||
          (b.topic.reports.at(-1)?.time ?? 0) - (a.topic.reports.at(-1)?.time ?? 0) ||
          b.topic.score - a.topic.score ||
          a.topic.id.localeCompare(b.topic.id),
      );
    result = { hours, topics: rising.slice(0, limit) };
    if (rising.length >= minTopics) break;
  }
  return result;
}

/** 報じられ始めた話題: 最初の報道が直近 hours 時間以内で、すでに minCoverage 以上のメディアが報じた話題（新しい順） */
export function newTopics<T extends TopicStats>(
  topics: readonly T[],
  now: number,
  { hours = 6, minCoverage = 2 }: { hours?: number; minCoverage?: number } = {},
): T[] {
  const cutoff = now - hours * HOUR;
  return topics
    .filter((topic) => topic.coverage >= minCoverage && Date.parse(topic.firstAt) > cutoff)
    .sort((a, b) => b.firstAt.localeCompare(a.firstAt) || a.id.localeCompare(b.id));
}

/** 重要度: 報じたメディアの数とジャンルの広がり（時間がたっても減らさない） */
export function importanceOf(topic: TopicStats): number {
  const spread = 1 + DIVERSITY_BONUS * Math.max(0, topic.categories.length - 1);
  return topic.coverage * spread + (topic.reads > 0 ? READS_WEIGHT * Math.log2(1 + topic.reads) : 0);
}

/**
 * 重要なニュース: since 以降にも報じられた話題を重要度の順に並べる。
 * 1つのジャンル（話題を報じたメディアで最も多いジャンル）は perCategory 件まで
 */
export function rankImportant<T extends TopicStats>(
  topics: readonly T[],
  since: number,
  { limit = 10, perCategory = 3, minCoverage = 2 }: { limit?: number; perCategory?: number; minCoverage?: number } = {},
): T[] {
  const candidates = topics
    .filter((topic) => topic.coverage >= minCoverage && Date.parse(topic.latestAt) >= since)
    .sort((a, b) => importanceOf(b) - importanceOf(a) || b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id));
  const counts = new Map<string, number>();
  const picked: T[] = [];
  for (const topic of candidates) {
    if (picked.length >= limit) break;
    const genre = topic.categories[0] ?? '';
    const count = counts.get(genre) ?? 0;
    if (count >= perCategory) continue;
    counts.set(genre, count + 1);
    picked.push(topic);
  }
  return picked;
}

// ===== 注目ワード =====

/** 注目ワードにしない言葉（AI 要約のキーワードに入りやすい、どの話題にも出てくる言葉） */
const TREND_STOP_WORDS = new Set(
  [
    '発表',
    '発売',
    '開始',
    '公開',
    '開催',
    '決定',
    '新型',
    '新作',
    '新色',
    '新機能',
    '新製品',
    '新商品',
    '最新',
    '速報',
    '判明',
    '逮捕',
    '退団',
    '引退',
    '移籍',
    '結婚',
    '死去',
    '受賞',
    '優勝',
    '開幕',
    '連携',
    '提携',
    '予約',
    '値上げ',
    '値下げ',
    '日本',
    '東京',
    '大阪',
    '米国',
    'アメリカ',
    '政府',
    '警察',
    '会社',
    '企業',
    '記事',
    '動画',
    '写真',
    '映像',
    '特集',
    'インタビュー',
    'セール',
    'キャンペーン',
    'アップデート',
    'ニュース',
  ].map((word) => normalizeWord(word)),
);

/** 言葉を比べるための正規化（全角・半角、大文字・小文字、カタカナ・ひらがなの違いをそろえる） */
export function normalizeWord(text: string): string {
  return Array.from(text.normalize('NFKC').toLowerCase(), (char) =>
    /[ァ-ヶ]/.test(char) ? String.fromCharCode(char.charCodeAt(0) - 0x60) : char,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TrendWord {
  /** 表示する言葉 */
  word: string;
  /** 直近に出てきた見出しの数 */
  count: number;
  /** 直近にその言葉を見出しに使ったメディアの数 */
  sources: number;
  /** それまでの期間に、同じ長さあたりで出てきた見出しの数 */
  baseline: number;
  /** 増え方（大きいほど急に増えた） */
  score: number;
}

export interface TrendEntry {
  title: string;
  sourceId: string;
  publishedAt: string;
}

/**
 * 注目ワード: 直近 hours 時間の見出しによく出てくる言葉のうち、それまでの baselineDays 日より急に増えたもの。
 * 言葉の候補（vocabulary）は AI 要約のキーワード（記事の中心になる固有名詞）とタグの言葉に限る
 * （見出しを機械的に区切ると「発表」「判明」のような、どの話題にも出てくる言葉ばかりになるため）
 */
export function trendingWords(
  entries: readonly TrendEntry[],
  vocabulary: readonly string[],
  now: number,
  {
    hours = 24,
    baselineDays = 6,
    limit = 12,
    minCount = 2,
    minSources = 2,
  }: { hours?: number; baselineDays?: number; limit?: number; minCount?: number; minSources?: number } = {},
): TrendWord[] {
  const recentFrom = now - hours * HOUR;
  const baselineFrom = recentFrom - baselineDays * 24 * HOUR;
  const recent: { title: string; sourceId: string }[] = [];
  const older: string[] = [];
  for (const entry of entries) {
    const time = Date.parse(entry.publishedAt);
    if (time > now) continue;
    if (time > recentFrom) recent.push({ title: normalizeWord(entry.title), sourceId: entry.sourceId });
    else if (time > baselineFrom) older.push(normalizeWord(entry.title));
  }
  const windows = (baselineDays * 24) / hours;
  const labels = new Map<string, string>();
  for (const word of vocabulary) {
    const key = normalizeWord(word);
    if (Array.from(key).length < 2 || TREND_STOP_WORDS.has(key) || /^[\d\s年月日時分.,:/-]+$/.test(key)) continue;
    if (/^\d+月\d+日$/.test(key)) continue;
    if (!labels.has(key)) labels.set(key, word.normalize('NFKC').trim());
  }
  const scored: TrendWord[] = [];
  for (const [key, word] of labels) {
    let count = 0;
    const sources = new Set<string>();
    for (const entry of recent) {
      if (!entry.title.includes(key)) continue;
      count++;
      sources.add(entry.sourceId);
    }
    if (count < minCount || sources.size < minSources) continue;
    const baseline = older.filter((title) => title.includes(key)).length / windows;
    scored.push({ word, count, sources: sources.size, baseline, score: count / (baseline + 1) });
  }
  // 同じ数なら長い言葉（「山本」より「山本由伸」）を先にする
  scored.sort(
    (a, b) =>
      b.score - a.score || b.count - a.count || Array.from(b.word).length - Array.from(a.word).length || a.word.localeCompare(b.word),
  );
  // 片方がもう片方を含む言葉（「INZONE」と「INZONE H9 II」など）は、先に選んだほうだけにする
  const picked: TrendWord[] = [];
  for (const candidate of scored) {
    if (picked.length >= limit) break;
    const key = normalizeWord(candidate.word);
    if (picked.some((word) => normalizeWord(word.word).includes(key) || key.includes(normalizeWord(word.word)))) continue;
    picked.push(candidate);
  }
  return picked;
}
