import type { RSSFeedItem } from '@astrojs/rss';
import { getCategory, getSource } from './items.ts';
import type { Item } from './types.ts';
import { WEBSUB_HUB } from './websub.ts';

/** RSS に WebSub と自分自身の場所を書き込むための追加要素 */
export function feedExtras(selfUrl: string) {
  return {
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    customData: [
      '<language>ja</language>',
      `<atom:link href="${selfUrl}" rel="self" type="application/rss+xml"/>`,
      `<atom:link href="${WEBSUB_HUB}" rel="hub"/>`,
    ].join(''),
  };
}

export function itemToFeedItem(item: Item): RSSFeedItem {
  const source = getSource(item.sourceId);
  const category = getCategory(item.category);
  return {
    title: item.title,
    link: item.url,
    description: item.excerpt,
    pubDate: new Date(item.publishedAt),
    ...(category ? { categories: [category.name] } : {}),
    // RSS 2.0 の <source>: 記事を取得した元のフィード
    ...(source ? { source: { title: source.name, url: source.feedUrl } } : {}),
  };
}
