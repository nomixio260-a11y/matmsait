/**
 * キーワード（人物・企業・製品・テーマ）のページ（/word/<言葉>/）の材料。ビルド中に1回だけ計算する。
 * 候補は AI 要約のキーワードと、タグの言葉（AI に「キーワード」として選ばせた、固有名詞の多い言葉）。
 * 見出しにその言葉が入った記事が、直近（トピックをまとめる期間）に MIN_ARTICLES 件・MIN_SOURCES 媒体以上ある言葉だけページを作る。
 * 記事が少ない言葉のページは検索エンジンに出さない（中身の薄いページを増やさないため）
 */
import { tags as tagDefinitions, type TagDefinition } from '../config/tags.ts';
import { jstDateKey } from './dates.ts';
import { builtAt, getItems } from './items.ts';
import { getSummaries } from './summaries.ts';
import { HOUR, containsWord, normalizeWord, rankHot } from './topic-core.ts';
import { tagsOfItem, topicViewOf, type TopicView } from './topics.ts';
import type { Item } from './types.ts';

/** キーワードのページを作る条件（見出しにその言葉が入った記事の数と媒体の数） */
const MIN_ARTICLES = 3;
const MIN_SOURCES = 2;
/** 検索エンジンに出す条件 */
const INDEX_ARTICLES = 8;
const INDEX_SOURCES = 3;
/** ページの数の上限（記事の多い順） */
const MAX_WORDS = 400;
/** 数える期間（日） */
const WINDOW_DAYS = 8;
/** キーワードにしない言葉（ニュースの見出しによく出る、何の話か分からない言葉） */
const STOP_WORDS = new Set(['発表', '発売', '開始', '公開', '開催', '決定', '新型', '登場', '対応', '最大', '最新', '日本', '世界', '速報', '注目', '話題', 'ニュース'].map(normalizeWord));

export interface WordDay {
  /** 日付（日本時間の YYYY-MM-DD） */
  date: string;
  count: number;
}

export interface WordView {
  /** 表示する言葉 */
  word: string;
  /** 比べるための形（normalizeWord） */
  key: string;
  /** URL の言葉の部分 */
  slug: string;
  /** 見出しにその言葉が入った記事（新しい順） */
  items: Item[];
  sources: number;
  /** その言葉の記事を含むトピック（2媒体以上。話題度の順） */
  topics: TopicView[];
  /** 直近24時間の記事の数と、それまでの6日間の1日あたりの平均 */
  today: number;
  baseline: number;
  /** 日ごとの記事の数（古い順に7日分。今日を含む） */
  daily: WordDay[];
  /** 当てはまるタグ */
  tags: TagDefinition[];
  indexable: boolean;
}

/** URL に使う形（空白は「-」、URL で意味を持つ記号は除く） */
export function wordSlug(word: string): string {
  return word
    .normalize('NFKC')
    .trim()
    .replace(/[\s/?#%\\]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function wordPath(slug: string): string {
  return `/word/${encodeURIComponent(slug)}/`;
}

let views: WordView[] | undefined;
let byKey: Map<string, WordView> | undefined;

/** キーワードのページ（記事の多い順） */
export function getWordViews(): WordView[] {
  if (!views) {
    const now = builtAt.getTime();
    const cutoff = now - WINDOW_DAYS * 24 * HOUR;
    const items = getItems().filter((item) => Date.parse(item.publishedAt) >= cutoff);
    const titles = items.map((item) => normalizeWord(item.title));
    // 候補: AI 要約のキーワードとタグの言葉（同じ形の言葉は1つに）
    const labels = new Map<string, string>();
    for (const word of [...getSummaries().flatMap((record) => record.keywords ?? []), ...tagDefinitions.flatMap((tag) => tag.words)]) {
      const key = normalizeWord(word);
      const length = Array.from(key).length;
      if (length < 2 || length > 30 || STOP_WORDS.has(key) || /^[\d\s年月日時分.,:/-]+$/.test(key) || /^\d+月\d+日$/.test(key)) continue;
      if (!labels.has(key)) labels.set(key, word.normalize('NFKC').trim());
    }
    const days = Array.from({ length: 7 }, (_, index) => jstDateKey(new Date(now - (6 - index) * 24 * HOUR)));
    const slugs = new Set<string>();
    const result: WordView[] = [];
    for (const [key, word] of labels) {
      const matched = items.filter((_, index) => containsWord(titles[index], key));
      const sources = new Set(matched.map((item) => item.sourceId)).size;
      if (matched.length < MIN_ARTICLES || sources < MIN_SOURCES) continue;
      let slug = wordSlug(word);
      if (!slug || slugs.has(slug)) slug = `${slug || 'word'}-${result.length}`;
      slugs.add(slug);
      const topicMap = new Map<string, TopicView>();
      for (const item of matched) {
        const view = topicViewOf(item.id);
        if (view) topicMap.set(view.id, view);
      }
      const dayCounts = new Map(days.map((day) => [day, 0]));
      let recent = 0;
      let older = 0;
      for (const item of matched) {
        const time = Date.parse(item.publishedAt);
        const day = jstDateKey(item.publishedAt);
        if (dayCounts.has(day)) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
        if (time > now - 24 * HOUR) recent++;
        else if (time > now - 7 * 24 * HOUR) older++;
      }
      const tagSlugs = new Set(matched.flatMap((item) => tagsOfItem(item).map((tag) => tag.slug)));
      const topics = rankHot([...topicMap.values()]);
      result.push({
        word,
        key,
        slug,
        items: matched,
        sources,
        topics,
        today: recent,
        baseline: older / 6,
        daily: days.map((date) => ({ date, count: dayCounts.get(date) ?? 0 })),
        tags: tagDefinitions.filter((tag) => tagSlugs.has(tag.slug)),
        indexable: matched.length >= INDEX_ARTICLES && sources >= INDEX_SOURCES && topics.length > 0,
      });
    }
    // 同じ記事の組しか持たない言葉（「INZONE H9 II」と「Fnatic」など）は、記事の多いほう・長いほうを残す
    result.sort((a, b) => b.items.length - a.items.length || Array.from(b.word).length - Array.from(a.word).length || a.key.localeCompare(b.key));
    const seenSets = new Set<string>();
    views = result
      .filter((view) => {
        const signature = view.items
          .map((item) => item.id)
          .sort()
          .join(',');
        if (seenSets.has(signature)) return false;
        seenSets.add(signature);
        return true;
      })
      .slice(0, MAX_WORDS);
    byKey = new Map(views.map((view) => [view.key, view]));
  }
  return views;
}

/** 言葉のページ（なければ undefined） */
export function getWordView(word: string): WordView | undefined {
  getWordViews();
  return byKey?.get(normalizeWord(word));
}

/** 言葉のページへのリンク先（ページがなければサイト内検索） */
export function wordHref(word: string): string {
  const view = getWordView(word);
  return view ? wordPath(view.slug) : `/search/?q=${encodeURIComponent(word)}`;
}

/** 一緒に出てくる言葉（同じ記事の見出しに入っている、ほかのキーワード。多い順） */
export function relatedWords(view: WordView, limit = 12): { view: WordView; count: number }[] {
  const ids = new Set(view.items.map((item) => item.id));
  return getWordViews()
    .filter((other) => other.key !== view.key && !other.key.includes(view.key) && !view.key.includes(other.key))
    .map((other) => ({ view: other, count: other.items.filter((item) => ids.has(item.id)).length }))
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count || b.view.items.length - a.view.items.length)
    .slice(0, limit);
}

/** 記事の組に出てくるキーワード（トピックのページの「このトピックの言葉」） */
export function wordsOfItems(items: readonly Item[], limit = 8): WordView[] {
  const titles = items.map((item) => normalizeWord(item.title));
  return getWordViews()
    .filter((view) => titles.some((title) => containsWord(title, view.key)))
    .sort((a, b) => Array.from(b.key).length - Array.from(a.key).length)
    .filter((view, index, list) => !list.slice(0, index).some((other) => other.key.includes(view.key)))
    .slice(0, limit);
}
