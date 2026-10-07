// デプロイ後に実行する。検索エンジン（IndexNow）とフィード購読者（WebSub）に更新を知らせ、
// SNS の認証情報が設定されていれば自動投稿する。
//
// 環境変数:
//   SITE_BASE_URL   公開サイトのベースURL（例: https://example.github.io/matmsait）
//   DATA_CHANGED    "false" なら記事が増えていないので、新しい要約ページだけを IndexNow に送る
//   NOTIFY_DRY_RUN  "1" なら送信せずに内容だけ表示する
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories, site } from '../src/config/site.ts';
import { tags } from '../src/config/tags.ts';
import { dailyPath, getDailySnapshots } from '../src/lib/daily.ts';
import { jstDateKey } from '../src/lib/dates.ts';
import { getSummaries, summaryPath } from '../src/lib/summaries.ts';
import {
  getHotTopics,
  getImportantTopics,
  getRisingTopics,
  getTagTopics,
  getTopicViews,
  tagPath,
  topicPath,
  type TopicView,
} from '../src/lib/topics.ts';
import { growthWithin } from '../src/lib/topic-core.ts';
import { indexNowPayload, publishWebSub, submitIndexNow } from './lib/ping.ts';
import {
  configuredPlatforms,
  planPosts,
  platformAllows,
  platformLimit,
  previewPlatforms,
  recordPost,
  type SocialState,
  type SocialTopic,
} from './lib/social.ts';

const SOCIAL_STATE_PATH = resolve(process.cwd(), 'data/social.json');
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
  const platforms = configuredPlatforms(process.env);
  if (platforms.length === 0 && !dryRun) {
    console.log('SNS の認証情報が未設定のため、自動投稿は行いません');
    return;
  }
  let state = readState();
  // 話題はサイトのビルドと同じ計算（同じ記事データから作るので、話題のページの URL と一致する）
  const toSocial = (view: TopicView, gained = growthWithin(view.reports, now.getTime(), 3)): SocialTopic => ({
    id: view.id,
    title: view.lead.title,
    coverage: view.coverage,
    score: view.score,
    gained,
    latestAt: view.latestAt,
  });
  const rising = getRisingTopics({ limit: 10, minTopics: 1 });
  const posts = planPosts(state, {
    now,
    snapshots: getDailySnapshots(),
    hot: getHotTopics({ hours: 12, limit: 10 }).map((view) => toSocial(view)),
    // 急上昇は3時間に新しく報じたメディアの数で決める（広げた時間では投稿しない）
    rising: rising.hours === 3 ? rising.topics.map((entry) => toSocial(entry.topic, entry.gained)) : [],
    important: getImportantTopics({ hours: 24, limit: 5, perCategory: 1 }).map((view) => toSocial(view)),
    ai: getTagTopics('ai', { hours: 24, limit: 5 }).map((view) => toSocial(view)),
    pageUrl: (path) => `${baseUrl}${path}`,
    siteName: site.name,
  });
  if (posts.length === 0) {
    console.log('今回 SNS に投稿する内容はありません');
    return;
  }

  for (const post of posts) {
    if (dryRun) {
      for (const platform of platforms.length > 0 ? platforms : previewPlatforms) {
        const allowed = platformAllows(platform.name, post, state, now, platformLimit(platform.name, process.env));
        console.log(`--- ${platform.name} に投稿する内容（${post.key}${allowed ? '' : '・上限か種類の設定で投稿しない'}）---\n${post.compose(platform.fits)}\n`);
      }
      continue;
    }
    // サービスごとの上限（X は投稿に料金がかかるので既定では夜のまとめだけ）
    const targets = platforms.filter((platform) => platformAllows(platform.name, post, state, now, platformLimit(platform.name, process.env)));
    if (targets.length === 0) {
      console.log(`上限か種類の設定により、どのサービスにも投稿しません（${post.key}）`);
      continue;
    }
    const results = await Promise.allSettled(targets.map((platform) => platform.send(post.compose(platform.fits), post)));
    const succeeded: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        succeeded.push(targets[index].name);
        console.log(`${targets[index].name} に投稿しました（${post.key}）`);
      } else warn(`${targets[index].name} への投稿に失敗（${post.key}）: ${errorMessage(result.reason)}`);
    });
    // 1つでも投稿できたら記録する（全滅なら次回もう一度試す）
    if (succeeded.length > 0) state = recordPost(state, post, now, succeeded);
  }
  if (!dryRun) writeFileSync(SOCIAL_STATE_PATH, `${JSON.stringify(state, null, 1)}\n`);
}

async function main() {
  const baseUrl = process.env.SITE_BASE_URL?.replace(/\/+$/, '');
  if (!baseUrl) {
    console.log('SITE_BASE_URL が未設定のため通知を省略します');
    return;
  }
  const now = new Date();
  await notifySearchEngines(baseUrl, now, process.env.DATA_CHANGED !== 'false');
  await postToSocial(baseUrl, now);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
