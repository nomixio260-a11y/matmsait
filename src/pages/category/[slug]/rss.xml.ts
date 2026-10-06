import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { categories, site, type Category } from '../../../config/site.ts';
import { feedExtras, itemToFeedItem } from '../../../lib/feeds.ts';
import { getItemsByCategory, href } from '../../../lib/items.ts';

export function getStaticPaths() {
  return categories.map((category) => ({ params: { slug: category.slug }, props: { category } }));
}

export function GET(context: APIContext) {
  const { category } = context.props as { category: Category };
  return rss({
    title: `${category.name}｜${site.name}`,
    description: category.description,
    site: new URL(href(`/category/${category.slug}/`), context.site),
    items: getItemsByCategory(category.slug)
      .slice(0, 50)
      .map((item) => itemToFeedItem(item, context.site)),
    ...feedExtras(new URL(href(`/category/${category.slug}/rss.xml`), context.site).toString()),
  });
}
