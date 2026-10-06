// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Actions では actions/configure-pages の値が SITE_URL / BASE_PATH に入る。
// 独自ドメインを使う場合も Pages の設定から自動で反映される。
const site = process.env.SITE_URL || 'https://example.com';
const base = process.env.BASE_PATH || '/';
const builtAt = new Date().toISOString();

/** 日別まとめの最終更新日時 */
function dailyUpdatedAt(/** @type {string} */ date) {
  try {
    return JSON.parse(readFileSync(`data/daily/${date}.json`, 'utf8')).updatedAt;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    sitemap({
      // 2ページ目以降の一覧と検索ページは noindex にしているので含めない
      filter: (page) => !/\/\d+\/$/.test(page) && !/\/search\/$/.test(page),
      // 更新されるページには最終更新日時を付け、検索エンジンに再クロールを促す
      serialize(item) {
        const path = new URL(item.url).pathname.slice(base.replace(/\/$/, '').length);
        const daily = path.match(/^\/daily\/(\d{4}-\d{2}-\d{2})\/$/);
        if (daily) {
          item.lastmod = dailyUpdatedAt(daily[1]);
        } else if (/^\/(?:|latest\/|ranking\/|daily\/|category\/[^/]+\/|source\/[^/]+\/)$/.test(path)) {
          item.lastmod = builtAt;
        }
        return item;
      },
    }),
  ],
});
