/**
 * 話題（同じ出来事を報じた記事のまとまり）の数字を計算する。Node 専用の機能は使わない（ビルドと SNS の自動投稿で使う）。
 * - 話題度スコア: 報じたメディアの数・報道の新しさ・ジャンルの広がり・このサイトで読まれた人数から 0〜100 で表す
 * - 急上昇: 直近の数時間に新しく報じたメディアの数
 * - 初報: いちばん早く報じたメディア
 * - 今日の注目（今日の5トピック）: 報じた媒体の数とジャンルの広がり（時間では減らさない）の順。1つのジャンルに偏らないようにする（重要度の判断ではない）
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

/** 話題度の内訳（「なぜこの話題度？」の説明に使う） */
export interface ScoreBreakdown {
  /** 報じた媒体の数 */
  reports: number;
  /** 新しさで重みづけした報道の数（報じてから HALF_LIFE_HOURS 時間ごとに半分になる） */
  weighted: number;
  /** 報じた媒体のジャンルの数 */
  genres: number;
  /** ジャンルの広がりによる倍率 */
  spread: number;
  /** このサイトで読まれた人数による上乗せ */
  readsBonus: number;
  /** 熱さ（weighted × spread + readsBonus） */
  heat: number;
  /** 話題度（0〜100） */
  score: number;
}

/**
 * 熱さの内訳: 報道1件ごとに1を足す（報じてから HALF_LIFE_HOURS 時間ごとに半分に減る）。
 * 報じたメディアのジャンルが多いほど上乗せし、このサイトで読まれた人数（わかるとき）も少し足す
 */
export function scoreBreakdown(reports: readonly TopicReport[], now: number, { reads = 0 }: { reads?: number } = {}): ScoreBreakdown {
  let weighted = 0;
  for (const { time } of reports) weighted += 0.5 ** (Math.max(0, now - time) / (HALF_LIFE_HOURS * HOUR));
  const genres = new Set(reports.map((report) => report.item.category)).size;
  const spread = 1 + DIVERSITY_BONUS * Math.max(0, genres - 1);
  const readsBonus = reads > 0 ? READS_WEIGHT * Math.log2(1 + reads) : 0;
  const heat = weighted * spread + readsBonus;
  return { reports: reports.length, weighted, genres, spread, readsBonus, heat, score: scoreOf(heat) };
}

/** 熱さ（話題度スコアのもとになる値） */
export function heatOf(reports: readonly TopicReport[], now: number, options: { reads?: number } = {}): number {
  return scoreBreakdown(reports, now, options).heat;
}

/** ある時点の熱さ（その時点までの報道だけで計算する。読まれた人数は含めない） */
export function heatAt(reports: readonly TopicReport[], time: number): number {
  return heatOf(
    reports.filter((report) => report.time <= time),
    time,
  );
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

/** 急上昇の勢い（何媒体から何媒体に増えたか、その前の時間と比べた増え方） */
export interface Momentum {
  /** 集計した時間（時間） */
  hours: number;
  /** 集計を始めた時点の媒体の数 */
  before: number;
  /** いまの媒体の数 */
  after: number;
  /** 集計した時間に新しく報じた媒体の数 */
  gained: number;
  /** その前の baselineHours 時間に新しく報じた媒体の数 */
  baseline: number;
  baselineHours: number;
  /** 1時間あたりの増え方が、その前の時間の何倍か（その前に増えていなければ undefined） */
  ratio?: number;
}

/** 直近 hours 時間の勢い（その前の baselineHours 時間の増え方と比べる） */
export function momentumOf(reports: readonly TopicReport[], now: number, hours = 3, baselineHours = 6): Momentum {
  const start = now - hours * HOUR;
  const baselineStart = start - baselineHours * HOUR;
  let before = 0;
  let gained = 0;
  let baseline = 0;
  for (const { time } of reports) {
    if (time > now) continue;
    if (time > start) gained++;
    else {
      before++;
      if (time > baselineStart) baseline++;
    }
  }
  const ratio = baseline > 0 ? gained / hours / (baseline / baselineHours) : undefined;
  return { hours, before, after: before + gained, gained, baseline, baselineHours, ratio };
}

/** 経過時間の短い表記（「45分」「3時間」「2日」） */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}時間` : `${Math.round(hours / 24)}日`;
}

/**
 * なぜ話題？: 数字から機械的に作る短い説明（1〜3文）。ニュースの価値は判断せず、報道の状況だけを書く。
 * categoryName はジャンルの slug から表示名を返す
 */
export function whyTrending(stats: TopicStats, now: number, categoryName: (slug: string) => string | undefined): string {
  const sentences: string[] = [];
  const momentum = momentumOf(stats.reports, now, 3);
  const first = stats.reports[0];
  const last = stats.reports[stats.reports.length - 1];
  if (momentum.before === 0 && momentum.gained >= 2 && first) {
    sentences.push(`最初の報道から${durationText(now - first.time)}で${momentum.gained}媒体が報じました`);
  } else if (momentum.gained >= 2) {
    sentences.push(`直近3時間で新たに${momentum.gained}媒体が報じ、計${stats.coverage}媒体になりました`);
  } else if (stats.growth.h24 >= 2 && first && last && stats.growth.h24 === stats.coverage) {
    // 24時間のうちに報じられ始めたトピック: どれくらいの時間で広がったか（同時に報じられたときは「1時間以内」）
    const spread = last.time - first.time;
    sentences.push(
      spread < HOUR
        ? `最初の報道から1時間以内に${stats.coverage}媒体が報じました`
        : `最初の報道から${durationText(spread)}で${stats.coverage}媒体に広がりました`,
    );
  } else if (stats.growth.h24 >= 2) {
    sentences.push(`この24時間で新たに${stats.growth.h24}媒体が報じ、計${stats.coverage}媒体になりました`);
  } else {
    sentences.push(`${stats.coverage}媒体が報じています`);
  }
  if (stats.categories.length >= 2) {
    const names = stats.categories
      .slice(0, 3)
      .map((slug) => categoryName(slug) ?? slug)
      .map((name) => `「${name}」`)
      .join('');
    sentences.push(`${names}の${stats.categories.length}ジャンルの媒体に広がっています`);
  }
  if (stats.reads >= 5) sentences.push('トピあつめでもよく読まれています');
  return `${sentences.join('。')}。`;
}

/** ジャンルごとのニュースの温度（そのジャンルのトピックの熱さの合計） */
export interface GenreHeat {
  category: string;
  /** いまの熱さの合計 */
  heat: number;
  /** 24時間前の同じ時刻の熱さの合計 */
  previous: number;
  /** 直近 hours 時間に報道があったトピックの数 */
  topics: number;
  /** 24時間前の同じ時刻に数えたときのトピックの数 */
  previousTopics: number;
  /** それらのトピックを報じた媒体の数の合計 */
  outlets: number;
  /** 直近3時間に新しい報道があったトピックの数 */
  rising: number;
}

/**
 * ニュースの温度: トピックを最も多く報じたジャンル（categories[0]）に振り分け、熱さを足す。
 * 昨日の同じ時刻の熱さ（その時点までの報道だけで計算）も出して、増え方を比べられるようにする
 */
export function genreTemperature<T extends TopicStats>(topics: readonly T[], now: number, { hours = 24 }: { hours?: number } = {}): GenreHeat[] {
  const since = now - hours * HOUR;
  const yesterday = now - 24 * HOUR;
  const yesterdaySince = yesterday - hours * HOUR;
  const genres = new Map<string, GenreHeat>();
  const genreOf = (slug: string) => {
    let genre = genres.get(slug);
    if (!genre) {
      genre = { category: slug, heat: 0, previous: 0, topics: 0, previousTopics: 0, outlets: 0, rising: 0 };
      genres.set(slug, genre);
    }
    return genre;
  };
  for (const topic of topics) {
    const slug = topic.categories[0];
    if (!slug) continue;
    const latest = topic.reports.at(-1)?.time ?? 0;
    if (latest > since) {
      const genre = genreOf(slug);
      genre.heat += heatOf(topic.reports, now);
      genre.topics++;
      genre.outlets += topic.coverage;
      if (growthWithin(topic.reports, now, 3) > 0) genre.rising++;
    }
    if (topic.reports.some((report) => report.time > yesterdaySince && report.time <= yesterday)) {
      const genre = genreOf(slug);
      genre.previous += heatAt(topic.reports, yesterday);
      genre.previousTopics++;
    }
  }
  return [...genres.values()].sort((a, b) => b.heat - a.heat || b.topics - a.topics || a.category.localeCompare(b.category));
}

// ===== トピックのページ: 話題度の推移・いまの段階・報道の広がり =====

/** 話題度の推移の1点 */
export interface HeatPoint {
  time: number;
  /** その時点の話題度（0〜100。その時点までの報道だけで計算し、読まれた数は含めない） */
  score: number;
}

/** 推移の点の間隔の候補（時間）。トピックが長く続くほど間隔を広げる */
const SERIES_STEPS = [1, 2, 3, 6, 12, 24];

/**
 * 話題度の推移: 最初の報道から now まで、一定の間隔ごとの話題度。
 * 点が maxPoints を超えないように間隔を 1・2・3・6・12・24 時間から選ぶ（最後の点はいつも now）
 */
export function heatSeries(reports: readonly TopicReport[], now: number, { maxPoints = 48 }: { maxPoints?: number } = {}): HeatPoint[] {
  const first = reports[0];
  if (!first || now < first.time) return [];
  const span = now - first.time;
  const step = (SERIES_STEPS.find((hours) => span / (hours * HOUR) <= maxPoints - 1) ?? SERIES_STEPS.at(-1)!) * HOUR;
  const points: HeatPoint[] = [];
  for (let time = first.time; time < now; time += step) points.push({ time, score: scoreOf(heatAt(reports, time)) });
  points.push({ time: now, score: scoreOf(heatAt(reports, now)) });
  return points;
}

/** トピックの段階: 発生（報じられ始めた）・拡大（報じる媒体が増えている）・ピーク・減少 */
export type LifecycleStage = 'emerging' | 'growing' | 'peak' | 'declining';

export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  emerging: '発生',
  growing: '拡大',
  peak: 'ピーク',
  declining: '減少',
};

export interface Lifecycle {
  stage: LifecycleStage;
  /** いままでで最も高かった話題度と、その時刻（推移の点から） */
  peakScore: number;
  peakAt: number;
  /** いまの話題度（読まれた数は含めない） */
  current: number;
}

/** 報じられ始めてからこの時間までで、増え方がまだ小さいトピックは「発生」 */
const EMERGING_HOURS = 3;
/** いまの話題度がピークのこの割合以上なら「ピーク」（それより下がっていれば「減少」） */
const PEAK_RATIO = 0.75;

/**
 * いまの段階を、報道の増え方と話題度の推移から機械的に決める。
 * - 発生: 最初の報道から3時間以内で、新しく報じた媒体がまだ2つ以下
 * - 拡大: 直近3時間に新しく報じた媒体があり、話題度が3時間前より下がっていない
 * - ピーク: 新しい報道は止まったが、話題度がピークの75%以上
 * - 減少: 話題度がピークの75%より下がった
 */
export function lifecycleOf(reports: readonly TopicReport[], now: number): Lifecycle {
  const series = heatSeries(reports, now, { maxPoints: 96 });
  let peak = series[0] ?? { time: now, score: 0 };
  for (const point of series) if (point.score >= peak.score) peak = point;
  const current = series.at(-1)?.score ?? 0;
  const first = reports[0]?.time ?? now;
  const gained = growthWithin(reports, now, 3);
  const before = scoreOf(heatAt(reports, now - 3 * HOUR));
  let stage: LifecycleStage;
  if (now - first <= EMERGING_HOURS * HOUR && gained <= 2) stage = 'emerging';
  else if (gained >= 1 && current >= before) stage = 'growing';
  else if (current >= peak.score * PEAK_RATIO) stage = 'peak';
  else stage = 'declining';
  return { stage, peakScore: peak.score, peakAt: peak.time, current };
}

/** 報道の広がりの節目（1媒体 → 2媒体 → 3媒体 → 5媒体 → 10媒体 …と、いまの数） */
export interface SpreadStep {
  /** その時点の媒体の数 */
  count: number;
  /** その数になった時刻 */
  time: number;
  /** 前の節目のあとに報じた媒体（この節目まで） */
  added: TopicReport[];
}

const SPREAD_MILESTONES = [1, 2, 3, 5, 10, 20, 30, 50];

/** 報じた媒体の数が節目の数になった時刻を、報じた順に並べる（最後はいまの数） */
export function spreadSteps(reports: readonly TopicReport[], milestones: readonly number[] = SPREAD_MILESTONES): SpreadStep[] {
  const steps: SpreadStep[] = [];
  let from = 0;
  reports.forEach((report, index) => {
    const count = index + 1;
    if (!milestones.includes(count) && count !== reports.length) return;
    steps.push({ count, time: report.time, added: reports.slice(from, count) });
    from = count;
  });
  return steps;
}

/** ジャンルの広がり: 報じた媒体のジャンルが、どの順に加わったか（ジャンルごとに最初の報道の時刻） */
export function genreSpread(reports: readonly TopicReport[]): { category: string; time: number }[] {
  const seen = new Map<string, number>();
  for (const { item, time } of reports) if (!seen.has(item.category)) seen.set(item.category, time);
  return [...seen].map(([category, time]) => ({ category, time }));
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

const ALNUM = /[a-z0-9]/;

/**
 * 正規化した見出し（normalizeWord）に、正規化した言葉が含まれるか。
 * 英数字で始まる・終わる言葉は、英数字の続きの一部には当てはめない（「mail」の中の「ai」・「AM5」の中の「M5」など）
 */
export function containsWord(normalizedTitle: string, key: string): boolean {
  if (!key) return false;
  const startsAlnum = ALNUM.test(key[0]);
  const endsAlnum = ALNUM.test(key[key.length - 1]);
  for (let index = normalizedTitle.indexOf(key); index >= 0; index = normalizedTitle.indexOf(key, index + 1)) {
    const before = normalizedTitle[index - 1] ?? '';
    const after = normalizedTitle[index + key.length] ?? '';
    if ((!startsAlnum || !ALNUM.test(before)) && (!endsAlnum || !ALNUM.test(after))) return true;
  }
  return false;
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
      if (!containsWord(entry.title, key)) continue;
      count++;
      sources.add(entry.sourceId);
    }
    if (count < minCount || sources.size < minSources) continue;
    const baseline = older.filter((title) => containsWord(title, key)).length / windows;
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
