import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { site } from '../../config/site.ts';
import { feedExtras, itemToFeedItem } from '../../lib/feeds.ts';
import { href } from '../../lib/items.ts';
import { getSummaries } from '../../lib/summaries.ts';

/** AI 要約つき記事の RSS（要約した日時の新しい順。リンク先は当サイトの要約ページ） */
export function GET(context: APIContext) {
  return rss({
    title: `${site.name}（AI要約）`,
    description: '話題のニュースのポイントをAIが要約した記事を、新しい順にお届けします。',
    site: new URL(href('/summaries/'), context.site),
    items: getSummaries()
      .slice(0, 50)
      .map((record) => ({ ...itemToFeedItem(record, context.site), pubDate: new Date(record.summarizedAt) })),
    ...feedExtras(new URL(href('/summaries/rss.xml'), context.site).toString()),
  });
}
