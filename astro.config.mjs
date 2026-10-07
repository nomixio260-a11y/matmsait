// @ts-check
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** AI 要約を保存・手直しした日時（記事ID → 日時） */
function summaryDates() {
  const dates = new Map();
  if (!existsSync('data/summaries')) return dates;
  for (const file of readdirSync('data/summaries')) {
    if (!/^\d{4}-\d{2}\.json$/.test(file)) continue;
    for (const record of JSON.parse(readFileSync(`data/summaries/${file}`, 'utf8'))) {
      dates.set(record.id, record.updatedAt ?? record.summarizedAt);
    }
  }
  return dates;
}
const summarizedAt = summaryDates();

/** よく読まれている記事のデータがあるか（なければ /popular/ は検索エンジンに出さない） */
function hasPopular() {
  try {
    const data = JSON.parse(readFileSync('data/popular.json', 'utf8'));
    return (data.day?.length ?? 0) + (data.week?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
const popularReady = hasPopular();

/** ビルドしたページの HTML（話題・タグのページは中身しだいで noindex になるので、サイトマップに入れるかを HTML で決める） */
const distDir = fileURLToPath(new URL('./dist/', import.meta.url));
function builtHtml(/** @type {string} */ path) {
  try {
    // キーワードのページの URL は日本語を % で書いたもの。ファイルの場所は元の文字
    return readFileSync(`${distDir}${decodeURIComponent(path).replace(/^\//, '')}index.html`, 'utf8');
  } catch {
    return '';
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
      // noindex にしているページ（2ページ目以降の一覧、掲載元別・新着の一覧、検索、あとで読む、管理画面）は含めない。
      // 掲載元別・新着の一覧は外部サイトへのリンクが並ぶだけなので、検索エンジンにはトップ・カテゴリ・要約・話題・日別まとめを見てもらう
      filter: (page) =>
        !/\/\d+\/$/.test(page) &&
        !/\/(search|saved|latest|following|settings|offline)\/$/.test(page) &&
        !/\/(admin|source)\//.test(page) &&
        (summarizedAt.size > 0 || !/\/summaries\/$/.test(page)) &&
        (popularReady || !/\/popular\/$/.test(page)),
      // 更新されるページには最終更新日時を付け、検索エンジンに再クロールを促す
      serialize(item) {
        const path = new URL(item.url).pathname.slice(base.replace(/\/$/, '').length);
        const daily = path.match(/^\/daily\/(\d{4}-\d{2}-\d{2})\/$/);
        const summary = path.match(/^\/summary\/([0-9a-f]+)\/$/);
        if (/^\/(?:topic|tag|word)\/[^/]+\/$|^\/(?:rising|tags|words|trends|weekly|genres)\/$/.test(path)) {
          // 中身が少なくて noindex にしたページは入れない。話題のページは最後に報じられた日時を最終更新にする
          const html = builtHtml(path);
          if (/<meta name="robots" content="noindex/.test(html)) return undefined;
          item.lastmod = html.match(/<meta property="article:modified_time" content="([^"]+)"/)?.[1] ?? builtAt;
          return item;
        }
        if (daily) {
          item.lastmod = dailyUpdatedAt(daily[1]);
        } else if (summary) {
          item.lastmod = summarizedAt.get(summary[1]);
        } else if (/^\/(?:|latest\/|ranking\/|popular\/|daily\/|summaries\/|category\/[^/]+\/|source\/[^/]+\/)$/.test(path)) {
          item.lastmod = builtAt;
        }
        return item;
      },
    }),
    // よく使われる /sitemap.xml でも同じサイトマップを読めるようにする（Search Console に登録しやすいように）
    {
      name: 'sitemap-alias',
      hooks: {
        'astro:build:done': ({ dir }) => {
          const index = new URL('sitemap-index.xml', dir);
          if (existsSync(index)) copyFileSync(index, new URL('sitemap.xml', dir));
        },
      },
    },
  ],
});
