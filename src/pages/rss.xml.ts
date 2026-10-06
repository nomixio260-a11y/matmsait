import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { site } from '../config/site.ts';
import { getItems, href, siteOf } from '../lib/items.ts';

export function GET(context: APIContext) {
  return rss({
    title: site.name,
    description: site.description,
    site: new URL(href('/'), context.site),
    items: getItems()
      .slice(0, 50)
      .map((item) => ({
        title: item.title,
        link: item.url,
        description: item.excerpt,
        pubDate: new Date(item.publishedAt),
        author: siteOf(item).label,
      })),
    customData: '<language>ja</language>',
  });
}
