import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { site } from '../../config/site.ts';
import { dailyPath, formatDay, getDailySnapshots } from '../../lib/daily.ts';
import { feedExtras } from '../../lib/feeds.ts';
import { href } from '../../lib/items.ts';

/** 日別まとめページの更新を届けるフィード（リンク先は当サイトのページ） */
export function GET(context: APIContext) {
  return rss({
    title: `${site.name}（日別まとめ）`,
    description: 'その日に話題になったニュースを1日ごとにまとめてお届けします。',
    site: new URL(href('/daily/'), context.site),
    items: getDailySnapshots()
      .slice(0, 30)
      .map((day) => {
        const top = day.items.slice(0, 5);
        return {
          title: `${formatDay(day.date)}の話題のニュース`,
          link: new URL(href(dailyPath(day.date)), context.site).toString(),
          pubDate: new Date(day.updatedAt),
          description: top.length
            ? `${top.map((item, index) => `${index + 1}. ${item.title}`).join(' / ')} ほか、全${day.total}件`
            : `全${day.total}件の記事をカテゴリごとにまとめています。`,
        };
      }),
    ...feedExtras(new URL(href('/daily/rss.xml'), context.site).toString()),
  });
}
