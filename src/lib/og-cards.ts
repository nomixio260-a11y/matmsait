/**
 * 共有画像のカードの中身（どのページにどんなカードを出すか）。描画は og-image.ts（Node 専用）。
 * 話題のページ・AI 要約のページ・日別まとめのページに、それぞれの見出しのカードを出す（ほかのページはサイトの共通の画像 og.png）
 */
import { site } from '../config/site.ts';
import { getCategory, siteOf } from './items.ts';
import type { CardOptions, HeadlineCard, ListCard } from './og-image.ts';
import { mainTitle } from './related.ts';
import { firstSentence } from './summary-view.ts';
import type { TopicView } from './topics.ts';
import type { DailySnapshot, SummaryRecord } from './types.ts';

export function topicImagePath(id: string): string {
  return `/og/topic/${id}.png`;
}

export function summaryImagePath(id: string): string {
  return `/og/summary/${id}.png`;
}

export function dailyImagePath(date: string): string {
  return `/og/daily/${date}.png`;
}

/** カードの右下に出すドメイン・左下のキャッチコピー */
export function cardOptions(siteUrl: URL | string | undefined): CardOptions {
  let host = '';
  try {
    host = siteUrl ? new URL(siteUrl).host : '';
  } catch {
    // URL が分からなければドメインは出さない
  }
  return { host, tagline: site.tagline, siteName: site.name };
}

const genreName = (slug: string | undefined) => (slug ? getCategory(slug)?.name : undefined);

/** 話題のページのカード: 「N媒体が報道」・見出し・AI 要約の1文目（あれば）・ジャンル */
export function topicCard(view: TopicView): HeadlineCard {
  const genres = view.categories.map(genreName).filter((name): name is string => Boolean(name)).slice(0, 2);
  const summary = view.summaries[0];
  return {
    kind: 'headline',
    label: { text: `${view.coverage}媒体が報道`, tone: 'heat' },
    title: mainTitle(view.lead.title),
    ...(summary ? { sub: firstSentence(summary.summary, 80) } : {}),
    chips: [...genres, '各社の報道を比較'],
  };
}

/** AI 要約のページのカード: 「AI要約」・見出し・要約の1文目・ジャンルと掲載元 */
export function summaryCard(record: SummaryRecord): HeadlineCard {
  const genre = genreName(record.category);
  return {
    kind: 'headline',
    label: { text: 'AI要約', tone: 'accent' },
    title: mainTitle(record.title),
    sub: firstSentence(record.summary, 80),
    chips: [...(genre ? [genre] : []), siteOf(record).label],
  };
}

/** 日付（YYYY-MM-DD）を「10/9」に */
export function monthDay(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${month}/${day}`;
}

/** 日別まとめのページのカード: その日の話題ニュースの上位5件 */
export function dailyCard(snapshot: DailySnapshot): ListCard {
  const [, month, day] = snapshot.date.split('-').map(Number);
  return {
    kind: 'list',
    label: { text: monthDay(snapshot.date), tone: 'accent' },
    heading: `${month}月${day}日の話題ニュース TOP5`,
    items: snapshot.items.slice(0, 5).map((item) => mainTitle(item.title)),
  };
}
