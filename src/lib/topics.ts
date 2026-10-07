/**
 * 話題（同じ出来事を報じた記事のまとまり）。ビルド中に1回だけ計算する。
 * 話題度 = その出来事を報じた掲載元の数。話題度スコア・急上昇などの計算は topic-core.ts（テストできるよう分けている）
 */
import { categories } from '../config/site.ts';
import { tags as tagDefinitions, type TagDefinition } from '../config/tags.ts';
import { builtAt, formatDateTime, getItems, getSource, siteOf } from './items.ts';
import { getPopular } from './popular.ts';
import { buildRelatedIndex, clusterTopics, type RelatedIndex, type TopicCluster } from './related.ts';
import { getSummaries, getSummary } from './summaries.ts';
import { tagsOf } from './tag-core.ts';
import { getTopicOverrides } from './topic-overrides.ts';
import { overrideLinks } from './topic-overrides-core.ts';
import {
  HOUR,
  LIFECYCLE_LABELS,
  TOPIC_DAYS,
  analyzeTopic,
  durationText,
  genreSpread,
  genreTemperature,
  heatSeries,
  isNewWord,
  lifecycleOf,
  momentumOf,
  newTopics,
  rankHot,
  rankImportant,
  rankRising,
  scoreBreakdown,
  spreadSteps,
  trendingWords,
  whyTrending,
  type GenreHeat,
  type HeatPoint,
  type Lifecycle,
  type Momentum,
  type SpreadStep,
  type RisingResult,
  type ScoreBreakdown,
  type TopicStats,
  type TrendWord,
} from './topic-core.ts';
import type { Item, SummaryRecord } from './types.ts';

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
    // 運営者の統合・分割（管理画面の「トピック整理」）を反映する
    topics = clusterTopics(
      getItems().filter((item) => Date.parse(item.publishedAt) >= cutoff),
      overrideLinks(getTopicOverrides()),
    );
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

/** 関連するトピック（見出しの似たトピック・同じテーマ（タグ）のトピック・同じジャンルのトピックの順。similar・sameGenre で選べる） */
export function relatedTopics(
  view: TopicView,
  limit = 6,
  { similar = true, sameGenre = true }: { similar?: boolean; sameGenre?: boolean } = {},
): TopicView[] {
  const picked = new Map<string, TopicView>();
  const add = (candidate: TopicView | undefined) => {
    if (candidate && candidate.id !== view.id && !picked.has(candidate.id) && picked.size < limit) picked.set(candidate.id, candidate);
  };
  const ranked = rankHot(getTopicViews());
  const slugs = new Set(view.tags.map((tag) => tag.slug));
  // 見出しの似ているトピック（同じ出来事の前後の動き）→ 同じテーマ → 同じジャンルの順
  if (similar) {
    for (const item of getRelatedIndex().related(view.lead, 10)) add(topicViewOf(item.id));
    for (const candidate of ranked) if (candidate.tags.some((tag) => slugs.has(tag.slug))) add(candidate);
  }
  if (sameGenre) for (const candidate of ranked) if (candidate.categories[0] === view.categories[0]) add(candidate);
  return [...picked.values()];
}

// ===== トピックのページ（推移・段階・広がり・概要・前後のニュース） =====

/** 話題度の推移（最初の報道から今まで。読まれた数は含めない） */
export function topicHeatSeries(view: TopicView): HeatPoint[] {
  return heatSeries(view.reports, builtAt.getTime());
}

/** いまの段階（発生・拡大・ピーク・減少） */
export function topicLifecycle(view: TopicView): Lifecycle {
  return lifecycleOf(view.reports, builtAt.getTime());
}

/** 報道の広がりの節目（1媒体 → 2媒体 → 3媒体 → 5媒体 …） */
export function topicSpreadSteps(view: TopicView): SpreadStep[] {
  return spreadSteps(view.reports);
}

/** ジャンルが加わった順（表示名と色つき） */
export function topicGenreSpread(view: TopicView): { category: string; name: string; color: string; time: number }[] {
  return genreSpread(view.reports).map(({ category, time }) => {
    const definition = categories.find((entry) => entry.slug === category);
    return { category, name: definition?.name ?? category, color: definition?.color ?? 'var(--muted)', time };
  });
}

/** 媒体の名前を並べる（多いときは「ほかN媒体」） */
function siteNames(items: readonly Item[], max = 4): string {
  const names = items.map((item) => siteOf(item).label);
  return names.length > max ? `${names.slice(0, max).join('・')}ほか${names.length - max}媒体` : names.join('・');
}

/**
 * トピックの概要（数字から機械的に作る2〜3文）。検索エンジンにも読まれる、トピあつめ独自の説明。
 * 「いつ・どこが最初に報じ、どれくらいの時間でどこまで広がったか・いまどの段階か」を書き、ニュースの中身の評価はしない
 */
export function topicOverview(view: TopicView): string[] {
  const first = view.reports[0];
  const last = view.reports[view.reports.length - 1];
  const sentences: string[] = [];
  if (!first || !last) return sentences;
  const firstSite = siteOf(first.item).label;
  const followers = view.reports.slice(1).map((report) => report.item);
  const spread = last.time - first.time;
  sentences.push(
    followers.length > 0
      ? `${formatDateTime(new Date(first.time))}に${firstSite}が最初に報じ（最初に確認できた報道）、その後${spread < HOUR ? '1時間以内' : `${durationText(spread)}のうち`}に${siteNames(followers)}が報じて、計${view.coverage}媒体になりました。`
      : `${formatDateTime(new Date(first.time))}に${firstSite}が報じました。`,
  );
  const genres = topicGenreSpread(view);
  if (genres.length >= 2) sentences.push(`報道は${genres.map((genre) => `「${genre.name}」`).join('')}の${genres.length}ジャンルの媒体に広がっています。`);
  const life = topicLifecycle(view);
  const now = builtAt.getTime();
  const sinceLast = now - last.time;
  const stage = LIFECYCLE_LABELS[life.stage];
  sentences.push(
    life.stage === 'growing'
      ? `いまは「${stage}」の段階です（直近3時間に新しく報じた媒体があります）。`
      : life.stage === 'emerging'
        ? `いまは「${stage}」の段階です（報じられ始めたばかりです）。`
        : `いまは「${stage}」の段階です（最後の報道から${durationText(sinceLast)}、新しい報道はありません）。`,
  );
  return sentences;
}

/** 見出しの似ている前後のニュース（このトピックの記事は除き、新しい順） */
export function topicNeighbors(view: TopicView, limit = 6): Item[] {
  const own = new Set(view.items.map((item) => item.id));
  const seenTopics = new Set<string>([view.id]);
  const result: Item[] = [];
  for (const item of getRelatedIndex().related(view.lead, 30)) {
    if (own.has(item.id)) continue;
    // 同じトピックの記事は1件だけ（ほかの記事は「N媒体が報道」からトピックのページで見られる）
    const other = topicViewOf(item.id);
    if (other) {
      if (seenTopics.has(other.id)) continue;
      seenTopics.add(other.id);
    }
    result.push(item);
    if (result.length >= limit) break;
  }
  return result.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
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
    trendCache = trendingWords(getItems(), vocabulary, builtAt.getTime(), { limit: 60 });
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

// ===== トピックの説明（なぜ話題？・話題度の内訳・急上昇の勢い） =====

const categoryName = (slug: string) => categories.find((category) => category.slug === slug)?.name;

/** なぜ話題？（報道の状況から作る短い説明） */
export function topicWhy(view: TopicStats): string {
  return whyTrending(view, builtAt.getTime(), categoryName);
}

/** 話題度の内訳（「なぜこの話題度？」） */
export function topicScoreBreakdown(view: TopicStats): ScoreBreakdown {
  return scoreBreakdown(view.reports, builtAt.getTime(), { reads: view.reads });
}

/** 急上昇の勢い（何媒体から何媒体に増えたか・その前と比べたペース） */
export function topicMomentum(view: TopicStats, hours = 3): Momentum {
  return momentumOf(view.reports, builtAt.getTime(), hours);
}

/** 勢いの説明（「3時間で2→7媒体」「直前6時間の3.0倍のペース」） */
export function momentumText(momentum: Momentum): { spread: string; pace?: string } {
  const spread = momentum.before > 0 ? `${momentum.hours}時間で${momentum.before}→${momentum.after}媒体` : `${momentum.hours}時間で0→${momentum.after}媒体`;
  if (momentum.ratio !== undefined && momentum.ratio >= 1.2) {
    return { spread, pace: `直前${momentum.baselineHours}時間の${paceText(momentum.ratio)}のペース` };
  }
  if (momentum.before > 0 && momentum.baseline === 0 && momentum.gained > 0) {
    return { spread, pace: `直前${momentum.baselineHours}時間は新しい報道がなく、再び広がり始めています` };
  }
  if (momentum.before === 0) return { spread, pace: 'この時間に報じられ始めました' };
  return { spread };
}

// ===== 今日のトピあつめ（ダッシュボード） =====

/** 「今話題」に数えるトピックの話題度の下限 */
export const HOT_SCORE_MIN = 30;

export interface GenreTemperatureView extends GenreHeat {
  name: string;
  color: string;
  /** 昨日の同じ時刻と比べた増え方（up: 2割以上増えた / down: 2割以上減った / flat） */
  trend: 'up' | 'down' | 'flat';
}

let temperatureCache: GenreTemperatureView[] | undefined;

/** 今日のニュースの温度（ジャンルごとのトピックの熱さ。昨日の同じ時刻との比較つき）。すべてのジャンルを熱い順に */
export function getGenreTemperature(): GenreTemperatureView[] {
  if (!temperatureCache) {
    const heats = new Map(genreTemperature(getTopicViews(), builtAt.getTime()).map((genre) => [genre.category, genre]));
    temperatureCache = categories
      .map((category) => {
        const genre = heats.get(category.slug) ?? { category: category.slug, heat: 0, previous: 0, topics: 0, previousTopics: 0, outlets: 0, rising: 0 };
        const trend: GenreTemperatureView['trend'] =
          genre.heat >= genre.previous * 1.2 && genre.heat - genre.previous >= 0.5
            ? 'up'
            : genre.heat <= genre.previous * 0.8 && genre.previous - genre.heat >= 0.5
              ? 'down'
              : 'flat';
        return { ...genre, name: category.name, color: category.color, trend };
      })
      .sort((a, b) => b.heat - a.heat || b.topics - a.topics);
  }
  return temperatureCache;
}

export interface TodayCounts {
  /** 24時間の記事の数 */
  articles: number;
  /** 24時間に報道があったトピック（2媒体以上）の数 */
  topics: number;
  /** 24時間に記事のあった媒体の数 */
  media: number;
  /** 今話題（話題度 HOT_SCORE_MIN 以上）の数 */
  hot: number;
  /** 急上昇の数と、集計した時間 */
  rising: number;
  risingHours: number;
  /** 今日の注目の数 */
  focus: number;
  /** 注目ワードの数 */
  words: number;
}

/** 今日のトピあつめの数字 */
export function getTodayCounts(): TodayCounts {
  const since = builtAt.getTime() - 24 * HOUR;
  const recent = getItems().filter((item) => Date.parse(item.publishedAt) >= since);
  const topics = getTopicViews().filter((view) => Date.parse(view.latestAt) >= since);
  const rising = getRisingTopics({ limit: 50 });
  return {
    articles: recent.length,
    topics: topics.length,
    media: new Set(recent.map((item) => item.sourceId)).size,
    hot: topics.filter((view) => view.score >= HOT_SCORE_MIN).length,
    rising: rising.topics.length,
    risingHours: rising.hours,
    focus: getImportantTopics({ hours: 24, limit: 10, perCategory: 3 }).length,
    words: getTrendWords(30).length,
  };
}

export interface TodayChange {
  kind: 'genre-up' | 'genre-down' | 'word' | 'spread' | 'new' | 'total';
  text: string;
  href?: string;
}

const shortTitle = (title: string, max = 32) => (Array.from(title).length > max ? `${Array.from(title).slice(0, max - 1).join('')}…` : title);

/** 見出しを「」で囲む（見出しがかぎかっこで始まっていれば、そのまま） */
export function quoteTitle(title: string, max = 32): string {
  const short = shortTitle(title, max);
  return /^[「『【“"]/.test(short) ? short : `「${short}」`;
}

/** 「ふだんの◯倍」の表記（10倍以上は「10倍以上」にする。大げさに見せないため） */
export function paceText(ratio: number): string {
  return ratio >= 10 ? '10倍以上' : `${ratio.toFixed(1)}倍`;
}

/**
 * 今日、変化したこと: 昨日の同じ時刻との比較や、直近の報道の増え方から、変化を短い文で並べる。
 * 数字から機械的に作り、良い・悪い・重要といった判断はしない
 */
export function getTodayChanges(limit = 5): TodayChange[] {
  const now = builtAt.getTime();
  const changes: TodayChange[] = [];
  const genres = getGenreTemperature();
  // ジャンルのトピックの数が大きく増えた・減った
  const up = genres
    .filter((genre) => genre.topics >= genre.previousTopics + 3 && genre.topics >= genre.previousTopics * 1.3)
    .sort((a, b) => b.topics - b.previousTopics - (a.topics - a.previousTopics))[0];
  if (up) {
    changes.push({
      kind: 'genre-up',
      text: `「${up.name}」のトピックが、昨日の同じ時刻の${up.previousTopics}件から${up.topics}件に増えています。`,
      href: `/category/${up.category}/`,
    });
  }
  // 話題が大きく広がっているトピック（直近6時間に新しく報じた媒体が多い）
  const spread = getTopicViews()
    .map((view) => ({ view, momentum: momentumOf(view.reports, now, 6) }))
    .filter((entry) => entry.momentum.gained >= 2 && entry.momentum.before >= 1)
    .sort((a, b) => b.momentum.gained - a.momentum.gained || b.view.score - a.view.score)[0];
  if (spread) {
    changes.push({
      kind: 'spread',
      text: `${quoteTitle(spread.view.lead.title)}の報道が、6時間で${spread.momentum.before}→${spread.momentum.after}媒体に増えました。`,
      href: topicPath(spread.view.id),
    });
  }
  // 急に増えた言葉
  const word = getTrendWords(1)[0];
  if (word) {
    const pace = isNewWord(word.previous) ? 'それまでの7日間はほとんど出てこなかった言葉です' : `ふだん（それまでの7日間の平均）の${paceText(word.count / word.baseline)}です`;
    changes.push({
      kind: 'word',
      text: `「${word.word}」を含む見出しが、24時間で${word.count}件（${word.sources}媒体）。${pace}。`,
      href: `/search/?q=${encodeURIComponent(word.word)}`,
    });
  }
  // 報じられ始めたトピック
  const fresh = newTopics(getTopicViews(), now, { hours: 6 });
  if (fresh.length > 0) {
    changes.push({ kind: 'new', text: `この6時間に、${fresh.length}件のトピックが新しく報じられ始めました。`, href: '/rising/' });
  }
  const down = genres
    .filter((genre) => genre.previousTopics >= 4 && genre.topics <= genre.previousTopics * 0.6)
    .sort((a, b) => b.previousTopics - b.topics - (a.previousTopics - a.topics))[0];
  if (down) {
    changes.push({
      kind: 'genre-down',
      text: `「${down.name}」のトピックは、昨日の同じ時刻の${down.previousTopics}件から${down.topics}件に減っています。`,
      href: `/category/${down.category}/`,
    });
  }
  // 全体のトピックの数（昨日の同じ時刻と比べて）
  const today = genres.reduce((sum, genre) => sum + genre.topics, 0);
  const yesterday = genres.reduce((sum, genre) => sum + genre.previousTopics, 0);
  if (yesterday > 0) {
    changes.push({ kind: 'total', text: `24時間のトピックは${today}件（昨日の同じ時刻は${yesterday}件）です。` });
  }
  return changes.slice(0, limit);
}
