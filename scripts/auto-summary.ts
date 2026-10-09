// AI による自動要約（.github/workflows/update.yml の「AI で自動要約」から実行。仕組みは scripts/lib/auto-summary.ts）
//
//   npm run auto-summary -- --out <file>   要約して、保存する要約を <file> に書く（取り込みは npm run summaries -- import <file> --skip-existing）
//   npm run auto-summary -- --dry-run      AI には頼まず、選んだ記事と本文が取れるかだけを表示する（記録も書かない）
//   --min-interval <分>                    前回の自動要約からこの時間がたっていなければ何もしない（push のときの更新で使う）
//
// 環境変数:
//   CLOUDFLARE_ACCOUNT_ID   Cloudflare のアカウント ID
//   CLOUDFLARE_AI_TOKEN     Workers AI の権限のある API トークン（なければ CLOUDFLARE_API_TOKEN を試す）
//   AUTO_SUMMARY_PER_RUN    1回に要約する数（既定4。0 で止める）
//   AUTO_SUMMARY_PER_DAY    1日（UTC）に要約する数（既定60）
//   AUTO_SUMMARY_MODEL      Workers AI のモデル（既定 @cf/qwen/qwen3.8-27b）
//   AUTO_SUMMARY_REASONING  考える量（off・low・medium・xhigh。既定 xhigh。多いほど要約はよくなるが、使う量が増えて1日の件数が減る）
// 試した記録と、その日に使った量の見積もりは data/auto-summary.json に置く
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SOCIAL_LIMITS } from './lib/social.ts';
import { site } from '../src/config/site.ts';
import { isHidden } from '../src/lib/blocklist.ts';
import { allowsSummary, getItems, siteOf } from '../src/lib/items.ts';
import { getSummary } from '../src/lib/summaries.ts';
import { getTopicViews } from '../src/lib/topics.ts';
import {
  ATTEMPT_LABELS,
  AUTO_SUMMARY_STATE_PATH,
  articleTextOf,
  parseAutoSummaryOptions,
  parseAutoSummaryState,
  pickCandidates,
  runAutoSummary,
  serializeAutoSummaryState,
  workersAiClient,
} from './lib/auto-summary.ts';
import { closeConnections, httpGet } from './lib/http.ts';
import { jitter, sleep } from './lib/timing.ts';

const STATE_PATH = resolve(process.cwd(), AUTO_SUMMARY_STATE_PATH);
/** この時間を過ぎたら新しい記事に取りかからない（ワークフローの手順の制限時間より短く） */
const TIME_LIMIT = 4 * 60 * 1000;

const { values } = parseArgs({
  options: { out: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, 'min-interval': { type: 'string', default: '0' } },
});
const dryRun = values['dry-run'];
const now = new Date();
const options = parseAutoSummaryOptions(process.env);
const before = existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8') : undefined;
const state = parseAutoSummaryState(before, now);
const log = (message: string) => console.log(message);

function saveState(next: typeof state) {
  if (dryRun) return;
  const text = serializeAutoSummaryState(next);
  if (text !== before) writeFileSync(STATE_PATH, text);
}

async function main() {
  if (options.perRun === 0) {
    log('自動要約は止めています（変数 AUTO_SUMMARY_PER_RUN が 0）');
    return;
  }
  // 管理画面の保存などの push のたびに待たせないよう、前回から間もなければ何もしない（定期の更新では 0）
  const minInterval = Number(values['min-interval']) * 60_000;
  const last = state.lastRun ? Date.parse(state.lastRun.at) : NaN;
  if (minInterval > 0 && now.getTime() - last < minInterval) {
    log(`前回の自動要約（${state.lastRun?.at}）から${values['min-interval']}分たっていないため、今回は行いません`);
    return;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = (process.env.CLOUDFLARE_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN)?.trim();
  if (!dryRun && (!accountId || !token)) {
    log('Cloudflare のアカウント ID と Workers AI のトークンがないため、自動要約は行いません');
    return;
  }
  const remaining = Math.max(0, options.perDay - state.saved);
  const candidates = pickCandidates({
    topics: getTopicViews().map((view) => ({
      coverage: view.coverage,
      score: view.score,
      latestAt: view.latestAt,
      items: [view.lead, ...view.items.filter((item) => item.id !== view.lead.id)],
      summarized: view.summaries.length > 0,
    })),
    items: getItems(),
    isSummarized: (id) => Boolean(getSummary(id)),
    canSummarize: (item) => allowsSummary(item) && !isHidden(item),
    attempts: state.attempts,
    now,
    // 本文が取れない記事もあるので多めに選び、AI に頼む数（perRun）で止める
    limit: Math.min(options.perRun * 3, remaining),
    preferredCategories: SOCIAL_LIMITS.preferredCategories,
  });
  log(
    `自動要約（${options.model}・考える量 ${options.reasoning}）: 候補 ${candidates.length}件・今日（UTC）の保存 ${state.saved}/${options.perDay}件・使用量の見積もり ${state.neurons}ニューロン`,
  );
  if (candidates.length === 0) {
    saveState({ ...state, lastRun: { at: now.toISOString(), saved: 0, tried: 0, message: remaining === 0 ? '今日の上限に達しています' : '要約する記事がありません' } });
    return;
  }
  if (dryRun) {
    // 実際の実行と同じように本文を取得してみる（AI には頼まない）
    const robotsCache = new Map();
    for (const item of candidates) {
      const article = await articleTextOf(item, httpGet, robotsCache);
      const result = article.status === 'ok' ? `本文 ${Array.from(article.text).length}字` : `${ATTEMPT_LABELS[article.result]}${article.detail ? `・${article.detail}` : ''}`;
      log(`- ${item.title}（${siteOf(item).label}）: ${result}`);
    }
    return;
  }
  const result = await runAutoSummary({
    candidates,
    state,
    options,
    now,
    siteName: site.name,
    siteOf: (item) => siteOf(item).label,
    ai: workersAiClient({ accountId: accountId!, token: token!, model: options.model, reasoning: options.reasoning }),
    get: httpGet,
    wait: () => sleep(jitter(3000, 5000)),
    log,
    deadline: Date.now() + TIME_LIMIT,
  });
  // 取り込み（npm run summaries -- import）で AI が自動で作った要約として保存されるよう、作ったモデルを付ける
  if (values.out && result.entries.length > 0) {
    writeFileSync(values.out, `${JSON.stringify(result.entries.map((entry) => ({ ...entry, generator: options.model })), null, 1)}\n`);
  }
  saveState(result.state);
  const counts = new Map<string, number>();
  for (const attempt of result.state.attempts.slice(state.attempts.length)) counts.set(attempt.result, (counts.get(attempt.result) ?? 0) + 1);
  log(
    `自動要約の結果: ${[...counts].map(([key, count]) => `${ATTEMPT_LABELS[key as keyof typeof ATTEMPT_LABELS]} ${count}件`).join('・') || 'なし'}（今日の使用量の見積もり ${result.state.neurons}ニューロン）`,
  );
  if (result.state.problem && result.entries.length === 0) log(`::warning::${result.state.problem.message}`);
}

try {
  await main();
} catch (error) {
  console.log(`::warning::自動要約に失敗しました: ${error instanceof Error ? error.message : error}`);
} finally {
  closeConnections();
}
