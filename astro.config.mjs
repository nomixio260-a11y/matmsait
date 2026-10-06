// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Actions では actions/configure-pages の値が SITE_URL / BASE_PATH に入る。
// 独自ドメインを使う場合は SITE_URL=https://example.jp, BASE_PATH=/ にする。
export default defineConfig({
  site: process.env.SITE_URL || 'https://example.com',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'always',
  integrations: [sitemap()],
});
