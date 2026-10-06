// @ts-check
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** AI 要約を保存した日時（記事ID → 日時） */
function summaryDates() {
  const dates = new Map();
  if (!existsSync('data/summaries')) return dates;
  for (const file of readdirSync('data/summaries')) {
    if (!/^\d{4}-\d{2}\.json$/.test(file)) continue;
    for (const record of JSON.parse(readFileSync(`data/summaries/${file}`, 'utf8'))) {
      dates.set(record.id, record.summarizedAt);
    }
  }
  return dates;
}
const summarizedAt = summaryDates();

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
      // 2ページ目以降の一覧・検索・管理画面は noindex にしているので含めない
      filter: (page) =>
        !/\/\d+\/$/.test(page) &&
        !/\/(search|admin)\/$/.test(page) &&
        (summarizedAt.size > 0 || !/\/summaries\/$/.test(page)),
      // 更新されるページには最終更新日時を付け、検索エンジンに再クロールを促す
      serialize(item) {
        const path = new URL(item.url).pathname.slice(base.replace(/\/$/, '').length);
        const daily = path.match(/^\/daily\/(\d{4}-\d{2}-\d{2})\/$/);
        const summary = path.match(/^\/summary\/([0-9a-f]+)\/$/);
        if (daily) {
          item.lastmod = dailyUpdatedAt(daily[1]);
        } else if (summary) {
          item.lastmod = summarizedAt.get(summary[1]);
        } else if (/^\/(?:|latest\/|ranking\/|daily\/|summaries\/|category\/[^/]+\/|source\/[^/]+\/)$/.test(path)) {
          item.lastmod = builtAt;
        }
        return item;
      },
    }),
  ],
});
