// デプロイ後に実行する。検索エンジン（IndexNow）とフィード購読者（WebSub）に更新を知らせ、
// SNS の認証情報が設定されていれば自動投稿する。
// 管理画面の「今すぐ投稿」の依頼（data/social-request.json）があれば、時間帯や間隔を待たずに投稿し、
// 結果を data/social.json の manual に書く（管理画面がそれを読んで表示する）。
//
// 環境変数:
//   SITE_BASE_URL   公開サイトのベースURL（例: https://example.github.io/matmsait）
//   DATA_CHANGED    "false" なら記事が増えていないので、新しい要約ページだけを IndexNow に送る
//   NOTIFY_DRY_RUN  "1" なら送信せずに内容だけ表示する
//   NOTIFY_SKIP_PING "1" なら検索エンジン・フィードへの通知をせず、SNS の投稿だけ行う（手で投稿を確かめるとき）
//   NOTIFY_PREVIEW_DIR NOTIFY_DRY_RUN のとき、リンクカードの画像（見出しのカード）をこのフォルダーに書き出す
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { categories, site } from '../src/config/site.ts';
import { tags } from '../src/config/tags.ts';
import { dailyPath, getDailySnapshots } from '../src/lib/daily.ts';
import { jstDateKey } from '../src/lib/dates.ts';
import { cardOptions } from '../src/lib/og-cards.ts';
import { renderCardPng } from '../src/lib/og-image.ts';
import { getSummaries, summaryPath } from '../src/lib/summaries.ts';
import { socialSources } from '../src/lib/social-source.ts';
import { getTopicViews, tagPath, topicPath } from '../src/lib/topics.ts';
import { growthWithin } from '../src/lib/topic-core.ts';
import { indexNowPayload, publishWebSub, submitIndexNow } from './lib/ping.ts';
import {
  configuredPlatforms,
  pendingRequest,
  planPosts,
  platformAllows,
  platformLimit,
  previewPlatforms,
  reachedDailyLimit,
  recordManual,
  recordPost,
  type PostedEntry,
  type SocialRequest,
  type SocialState,
} from './lib/social.ts';

const SOCIAL_STATE_PATH = resolve(process.cwd(), 'data/social.json');
const SOCIAL_REQUEST_PATH = resolve(process.cwd(), 'data/social-request.json');
const DAY = 24 * 60 * 60 * 1000;

const dryRun = process.env.NOTIFY_DRY_RUN === '1';
const warn = (message: string) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARN ${message}`);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function readState(): SocialState {
  if (!existsSync(SOCIAL_STATE_PATH)) return { posted: [] };
  try {
    return JSON.parse(readFileSync(SOCIAL_STATE_PATH, 'utf8')) as SocialState;
  } catch {
    return { posted: [] };
  }
}

/** 管理画面の「今すぐ投稿」の依頼（なければ undefined） */
function readRequest(): SocialRequest | undefined {
  if (!existsSync(SOCIAL_REQUEST_PATH)) return undefined;
  try {
    const data = JSON.parse(readFileSync(SOCIAL_REQUEST_PATH, 'utf8')) as Partial<SocialRequest>;
    return typeof data.id === 'string' && typeof data.at === 'string' ? { id: data.id, at: data.at } : undefined;
  } catch {
    return undefined;
  }
}

async function notifySearchEngines(baseUrl: string, now: Date, dataChanged: boolean) {
  const days = [jstDateKey(now), jstDateKey(new Date(now.getTime() - DAY))].filter((date) =>
    existsSync(resolve(process.cwd(), `data/daily/${date}.json`)),
  );
  // 直近（3時間以内）に要約を保存・手直しした記事のページ
  const recentSummaries = getSummaries()
    .filter((record) => now.getTime() - Date.parse(record.updatedAt ?? record.summarizedAt) < 3 * 60 * 60 * 1000)
    .slice(0, 100)
    .map((record) => summaryPath(record.id));
  // 新しく報じられた・報じるメディアが増えた話題のページ（検索エンジンに出すページだけ。3時間以内に報じられたもの）
  const recentTopics = getTopicViews()
    .filter((view) => view.indexable && growthWithin(view.reports, now.getTime(), 3) > 0)
    .slice(0, 100)
    .map((view) => topicPath(view.id));
  // 記事が増えていなくても、新しい要約ページは知らせる
  const paths = [
    ...(dataChanged
      ? [
          '/',
          '/latest/',
          '/ranking/',
          '/rising/',
          '/daily/',
          ...categories.map((category) => `/category/${category.slug}/`),
          ...tags.map((tag) => tagPath(tag.slug)),
          ...days.map(dailyPath),
          ...recentTopics,
        ]
      : []),
    ...(recentSummaries.length > 0 ? ['/summaries/', ...recentSummaries] : []),
  ];
  if (paths.length === 0) {
    console.log('記事・要約の更新がないため検索エンジンへの通知は省略します');
    return;
  }
  const payload = indexNowPayload(baseUrl, site.indexNowKey, paths);
  const feeds = dataChanged
    ? ['/rss.xml', '/daily/rss.xml', '/summaries/rss.xml', ...categories.map((category) => `/category/${category.slug}/rss.xml`)].map(
        (path) => `${baseUrl}${path}`,
      )
    : [];

  if (dryRun) {
    console.log('IndexNow に送る内容:', JSON.stringify(payload, null, 2));
    console.log('WebSub で通知するフィード:', feeds);
    return;
  }
  try {
    const status = await submitIndexNow(payload);
    console.log(`IndexNow に ${payload.urlList.length} 件のURLを送信しました（HTTP ${status}）`);
  } catch (error) {
    warn(`IndexNow の送信に失敗: ${errorMessage(error)}`);
  }
  if (feeds.length === 0) return;
  const results = await Promise.allSettled(feeds.map(publishWebSub));
  const failed = results.filter((result) => result.status === 'rejected');
  for (const result of failed) warn(`WebSub の通知に失敗: ${errorMessage((result as PromiseRejectedResult).reason)}`);
  console.log(`WebSub に ${feeds.length - failed.length}/${feeds.length} 件のフィード更新を通知しました`);
}

async function postToSocial(baseUrl: string, now: Date) {
  // リンクカードの画像: 投稿ごとの見出しのカード（作れなければサイトの共通の OGP 画像）
  const ogPath = resolve(process.cwd(), 'public/og.png');
  const options = cardOptions(baseUrl);
  const cardImage = async (card: Parameters<typeof renderCardPng>[0]) => new Uint8Array(await renderCardPng(card, options));
  const platforms = configuredPlatforms(process.env, { thumb: existsSync(ogPath) ? new Uint8Array(readFileSync(ogPath)) : undefined, cardImage });
  let state = readState();
  const save = () => {
    if (!dryRun) writeFileSync(SOCIAL_STATE_PATH, `${JSON.stringify(state, null, 1)}\n`);
  };

  // 管理画面の「今すぐ投稿」の依頼（まだ処理していないもの）
  const pending = pendingRequest(state, readRequest(), now);
  if (pending) console.log(`管理画面から「今すぐ投稿」の依頼があります（${pending.request.at}）`);
  if (pending?.expired) {
    console.log('依頼から時間がたっているため、今すぐの投稿は行いません');
    state = recordManual(state, pending.request, now, { result: 'expired' });
  }
  const manual = pending && !pending.expired ? pending.request : undefined;

  if (platforms.length === 0 && !dryRun) {
    console.log('SNS（Bluesky など）の認証情報が未設定のため、自動投稿は行いません');
    if (manual) state = recordManual(state, manual, now, { result: 'no-credentials' });
    if (pending) save();
    return;
  }
  // 話題はサイトのビルドと同じ計算（同じ記事データから作るので、話題のページの URL と一致する）
  const posts = planPosts(
    state,
    {
      now,
      snapshots: getDailySnapshots(),
      ...socialSources(now),
      pageUrl: (path) => `${baseUrl}${path}`,
      siteName: site.name,
    },
    { manual: manual !== undefined },
  );
  if (posts.length === 0) {
    console.log('今回 SNS に投稿する内容はありません');
    if (manual) state = recordManual(state, manual, now, { result: reachedDailyLimit(state, now, true) ? 'limit' : 'none' });
    if (pending) save();
    return;
  }

  const manualPosts: PostedEntry[] = [];
  const errors: string[] = [];
  for (const post of posts) {
    if (dryRun) {
      for (const platform of platforms.length > 0 ? platforms : previewPlatforms) {
        console.log(`--- ${platform.name} に投稿する内容（${post.key}）---\n${post.compose(platform.fits)}\n`);
      }
      const previewDir = process.env.NOTIFY_PREVIEW_DIR;
      if (previewDir && post.card) {
        mkdirSync(previewDir, { recursive: true });
        const file = join(previewDir, `${post.key.replace(/[^\w-]+/g, '_')}.png`);
        writeFileSync(file, await cardImage(post.card));
        console.log(`リンクカードの画像: ${file}`);
      }
      continue;
    }
    // サービスごとの上限（24時間・30日）
    const targets = platforms.filter((platform) => platformAllows(platform.name, state, now, platformLimit(manual !== undefined)));
    if (targets.length === 0) {
      console.log(`上限により、どのサービスにも投稿しません（${post.key}）`);
      continue;
    }
    const results = await Promise.allSettled(targets.map((platform) => platform.send(post.compose(platform.fits), post)));
    const succeeded: string[] = [];
    const urls: Record<string, string> = {};
    results.forEach((result, index) => {
      const name = targets[index].name;
      if (result.status === 'fulfilled') {
        succeeded.push(name);
        if (result.value) urls[name] = result.value;
        console.log(`${name} に投稿しました（${post.key}）${result.value ? ` ${result.value}` : ''}`);
      } else {
        const message = errorMessage(result.reason);
        // 通信のエラーは「Bluesky: HTTP 401 …」のようにサービス名から始まる
        errors.push(message.startsWith(`${name}:`) ? message : `${name}: ${message}`);
        warn(`${name} への投稿に失敗（${post.key}）: ${message}`);
      }
    });
    // 1つでも投稿できたら記録する（全滅なら次回もう一度試す）
    if (succeeded.length > 0) {
      state = recordPost(state, post, now, succeeded, urls);
      if (manual) manualPosts.push(state.posted[state.posted.length - 1]);
    }
  }
  if (manual && !dryRun) {
    state = recordManual(
      state,
      manual,
      now,
      manualPosts.length > 0
        ? { result: 'posted', posts: manualPosts }
        : errors.length > 0
          ? { result: 'failed', error: errors[0].slice(0, 300) }
          : { result: 'limit' },
    );
  }
  save();
}

async function main() {
  const baseUrl = process.env.SITE_BASE_URL?.replace(/\/+$/, '');
  if (!baseUrl) {
    console.log('SITE_BASE_URL が未設定のため通知を省略します');
    return;
  }
  const now = new Date();
  if (process.env.NOTIFY_SKIP_PING !== '1') await notifySearchEngines(baseUrl, now, process.env.DATA_CHANGED !== 'false');
  await postToSocial(baseUrl, now);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
