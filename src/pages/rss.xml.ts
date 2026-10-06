import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { site } from '../config/site.ts';
import { feedExtras, itemToFeedItem } from '../lib/feeds.ts';
import { getItems, href } from '../lib/items.ts';

export function GET(context: APIContext) {
  return rss({
    title: site.name,
    description: site.description,
    site: new URL(href('/'), context.site),
    items: getItems()
      .slice(0, 50)
      .map((item) => itemToFeedItem(item, context.site)),
    ...feedExtras(new URL(href('/rss.xml'), context.site).toString()),
  });
}
