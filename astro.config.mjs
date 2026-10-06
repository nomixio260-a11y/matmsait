// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Actions では actions/configure-pages の値が SITE_URL / BASE_PATH に入る。
// 独自ドメインを使う場合も Pages の設定から自動で反映される。
export default defineConfig({
  site: process.env.SITE_URL || 'https://example.com',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'always',
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    sitemap({
      // 2ページ目以降の一覧と検索ページは noindex にしているので含めない
      filter: (page) => !/\/\d+\/$/.test(page) && !/\/search\/$/.test(page),
    }),
  ],
});
