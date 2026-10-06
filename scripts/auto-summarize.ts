// 要約のない記事を選び、本文を取得して Claude API で要約する（GitHub Actions から実行）
//
//   npm run auto-summarize -- [--count 10] [--category tech] [--order balanced|popular|latest]
//                             [--length short|normal|long] [--no-points] [--out file] [--dry-run]
//
//   --out があればそのファイルに保存用 JSON を書き出す（あとで `npm run summaries -- import` で取り込む）。
//   なければ data/summaries/ に直接保存する。--dry-run は本文の取得までで API は呼ばない。
//
// 環境変数
//   ANTHROPIC_API_KEY  API キー（必須。未設定なら何もせず終了する）
//   SUMMARY_MODEL      使うモデル（既定 claude-opus-5-5）
//   SUMMARY_EFFORT     考える深さ low / medium / high（既定 low。要約には十分）
//   SUMMARY_LENGTH     要約の長さ short / normal / long（既定 normal）
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { site } from '../src/config/site.ts';
import { getItems, siteOf } from '../src/lib/items.ts';
import {
  groupByFile,
  mergeSummaryRecords,
  parseSummaryFile,
  serializeSummaryFile,
  SUMMARY_LENGTHS,
  toSummaryRecord,
  validateEntries,
  type SummaryLength,
} from '../src/lib/summary-core.ts';
import { getSummary } from '../src/lib/summaries.ts';
import type { Item, SummaryRecord } from '../src/lib/types.ts';
import { clipText, decodeHtml, extractArticle, isAboutTitle } from './lib/article.ts';
import {
  DEFAULT_MODEL,
  EFFORTS,
  estimateCost,
  pickCandidates,
  summarizeArticle,
  type Effort,
  type MessagesApi,
  type PickOrder,
  type SummarizerOptions,
} from './lib/auto-summary.ts';
import { closeConnections, httpGet } from './lib/http.ts';
import { jitter, sleep } from './lib/timing.ts';

/** AI に渡す本文の上限（字）。長い記事は前半だけで十分要約でき、費用も抑えられる */
const MAX_CHARS = 5000;
/** 同時に処理する記事数 */
const CONCURRENCY = 3;
const MAX_COUNT = 100;

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '10' },
    category: { type: 'string' },
    order: { type: 'string', default: 'balanced' },
    length: { type: 'string', default: process.env.SUMMARY_LENGTH || 'normal' },
    'no-points': { type: 'boolean', default: false },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const count = Math.min(MAX_COUNT, Math.max(0, Math.floor(Number(values.count) || 0)));
const dryRun = values['dry-run'];
const length = values.length as SummaryLength;
const order = values.order as PickOrder;
const model = process.env.SUMMARY_MODEL?.trim() || DEFAULT_MODEL;
const effortSetting = (process.env.SUMMARY_EFFORT?.trim() || 'low') as Effort;

const log = (message: string) => console.log(message);

interface Outcome {
  item: Item;
  status: 'saved' | 'skipped' | 'error';
  reason?: string;
  model?: string;
  tokens?: { input: number; output: number };
}

/** 同じサイトへは間隔を空けて1件ずつアクセスする */
const hostQueues = new Map<string, Promise<void>>();
async function politely<T>(host: string, task: () => Promise<T>): Promise<T> {
  const previous = hostQueues.get(host);
  let release!: () => void;
  hostQueues.set(host, new Promise<void>((done) => (release = done)));
  if (previous) {
    await previous;
    await sleep(jitter(1500, 4000));
  }
  try {
    return await task();
  } finally {
    release();
  }
}

/** 記事ページを取得して本文を取り出す。要約に向かないページは理由を返す */
async function loadArticleText(item: Item): Promise<{ text: string } | { reason: string }> {
  const host = new URL(item.url).hostname;
  const res = await politely(host, () => httpGet(item.url, { timeoutMs: 20_000 }));
  if (res.status !== 200) return { reason: `記事ページを取得できませんでした（HTTP ${res.status}）` };
  const type = String(res.headers['content-type'] ?? '');
  if (type && !/html/i.test(type)) return { reason: `記事ページではありません（${type.split(';')[0]}）` };
  const article = extractArticle(decodeHtml(res.body, type));
  if (!article) return { reason: '本文を取り出せませんでした' };
  if (!isAboutTitle(item.title, article.text)) return { reason: '取り出した本文が見出しと合いません' };
  return { text: clipText(article.text, MAX_CHARS) };
}

/** モデルが effort・structured outputs に対応しているかを Models API で確かめる */
async function detectOptions(client: Anthropic): Promise<SummarizerOptions> {
  const options: SummarizerOptions = {
    siteName: site.name,
    model,
    effort: EFFORTS.includes(effortSetting) ? effortSetting : undefined,
    length,
    points: !values['no-points'],
    structured: true,
    fallbacks: true,
  };
  try {
    const info = await client.models.retrieve(model);
    const capabilities = info.capabilities;
    if (capabilities) {
      options.structured = capabilities.structured_outputs.supported;
      if (options.effort && !(capabilities.effort.supported && capabilities.effort[options.effort]?.supported)) {
        options.effort = undefined;
      }
    }
  } catch (error) {
    if (error instanceof Anthropic.NotFoundError) throw new Error(`モデル「${model}」が見つかりません。SUMMARY_MODEL を確認してください`);
    if (error instanceof Anthropic.AuthenticationError) throw new Error('ANTHROPIC_API_KEY が無効です');
    // 確かめられなくても既定の設定で続ける
  }
  return options;
}

function writeRecords(records: SummaryRecord[]) {
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, serializeSummaryFile(records));
    log(`保存用 JSON を ${values.out} に書き出しました（${records.length}件）`);
    return;
  }
  for (const [path, group] of groupByFile(records)) {
    const absolute = resolve(process.cwd(), path);
    const merged = mergeSummaryRecords(parseSummaryFile(existsSync(absolute) ? readFileSync(absolute, 'utf8') : null), group);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, serializeSummaryFile(merged));
    log(`${path}: ${group.length}件を保存（合計 ${merged.length}件）`);
  }
}

/** GitHub Actions の実行結果ページに表を出す */
function writeJobSummary(outcomes: Outcome[], cost: number | undefined, tokens: { input: number; output: number }) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const escape = (text: string) => text.replace(/\|/g, '｜').replace(/\n/g, ' ');
  const tally = (status: Outcome['status']) => outcomes.filter((o) => o.status === status).length;
  const lines = [
    '### AI 要約',
    '',
    `モデル: \`${model}\` ・ 保存 ${tally('saved')}件 ・ 見送り ${tally('skipped')}件 ・ エラー ${tally('error')}件 ・ ` +
      `トークン 入力 ${tokens.input.toLocaleString()} / 出力 ${tokens.output.toLocaleString()}` +
      (cost === undefined ? '' : ` ・ 費用の目安 $${cost.toFixed(3)}`),
    '',
    '| 結果 | 記事 | 理由 |',
    '| --- | --- | --- |',
    ...outcomes.map(
      (o) =>
        `| ${o.status === 'saved' ? '保存' : o.status === 'skipped' ? '見送り' : 'エラー'} | [${escape(o.item.title)}](${o.item.url}) | ${escape(o.reason ?? '')} |`,
    ),
    '',
  ];
  appendFileSync(file, `${lines.join('\n')}\n`);
}

async function main() {
  if (count === 0) {
    log('要約する件数が 0 のため何もしません');
    return;
  }
  if (!(length in SUMMARY_LENGTHS)) throw new Error('--length は short / normal / long のいずれかです');
  if (!['balanced', 'popular', 'latest'].includes(order)) throw new Error('--order は balanced / popular / latest のいずれかです');
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    log('::notice::ANTHROPIC_API_KEY が設定されていないため、AI 要約をスキップしました');
    return;
  }

  const candidates = pickCandidates(getItems(), (id) => Boolean(getSummary(id)), { order, category: values.category });
  log(`要約待ち ${candidates.length}件から最大 ${count}件を要約します（モデル ${model}）`);
  if (candidates.length === 0) return;

  const client = new Anthropic({ apiKey: apiKey || 'dry-run', maxRetries: 4, timeout: 180_000 });
  const options = dryRun
    ? { siteName: site.name, model, length, points: !values['no-points'], structured: true, fallbacks: true }
    : await detectOptions(client);
  const api: MessagesApi = { create: (params) => client.beta.messages.create(params) };

  const outcomes: Outcome[] = [];
  const records: SummaryRecord[] = [];
  const tokens = { input: 0, output: 0 };
  let cost: number | undefined = 0;
  /** 「読めなかった」と返される記事もあるので、API を呼ぶ回数は少し多めまで許す */
  const maxCalls = Math.ceil(count * 1.5) + 2;
  let calls = 0;
  let inFlight = 0;
  let stopReason = '';
  let consecutiveErrors = 0;
  const queue = [...candidates];
  const done = () => records.length + inFlight >= count || calls >= maxCalls || stopReason !== '';

  async function handle(item: Item) {
    const loaded = await loadArticleText(item).catch((error: unknown) => ({
      reason: `記事ページを取得できませんでした（${error instanceof Error ? error.message : error}）`,
    }));
    if ('reason' in loaded) {
      outcomes.push({ item, status: 'skipped', reason: loaded.reason });
      log(`  見送り ${item.title.slice(0, 40)}: ${loaded.reason}`);
      return;
    }
    if (done()) return;
    if (dryRun) {
      records.push(toSummaryRecord(item, { id: item.id, summary: '（確認のみ）', points: [], replaces: false }, new Date()));
      outcomes.push({ item, status: 'saved', reason: `本文 ${Array.from(loaded.text).length}字` });
      log(`  本文OK ${item.title.slice(0, 40)}（${Array.from(loaded.text).length}字）`);
      return;
    }

    calls++;
    inFlight++;
    try {
      const article = { id: item.id, title: item.title, url: item.url, site: siteOf(item).label };
      let result;
      try {
        result = await summarizeArticle(api, options, article, loaded.text);
      } catch (error) {
        // fallbacks に対応していないモデルでは 400 になるので、外して1回だけやり直す
        if (error instanceof Anthropic.BadRequestError && options.fallbacks) {
          options.fallbacks = false;
          log(`  （fallbacks を外して再試行します: ${error.message}）`);
          result = await summarizeArticle(api, options, article, loaded.text);
        } else {
          throw error;
        }
      }
      consecutiveErrors = 0;
      tokens.input += result.usage.input;
      tokens.output += result.usage.output;
      const price = estimateCost(result.model, result.usage);
      cost = cost === undefined || price === undefined ? undefined : cost + price;
      const usage = { model: result.model, tokens: result.usage };
      if (!result.entry) {
        // 断られた記事は見送り、応答の形の問題はエラーとして記録する
        const status = result.refused ? 'skipped' : 'error';
        outcomes.push({ item, status, reason: result.error, ...usage });
        log(`  ${status === 'skipped' ? '見送り' : 'エラー'} ${item.title.slice(0, 40)}: ${result.error}`);
        return;
      }
      const checked = validateEntries([result.entry], (id) => (id === item.id ? { summarized: Boolean(getSummary(id)) } : undefined));
      const accepted = checked.accepted[0];
      if (!accepted || records.length >= count) {
        const reason = [...checked.skipped, ...checked.errors][0]?.reason ?? '保存する件数に達しました';
        outcomes.push({ item, status: 'skipped', reason, ...usage });
        log(`  見送り ${item.title.slice(0, 40)}: ${reason}`);
        return;
      }
      records.push(toSummaryRecord(item, accepted, new Date()));
      outcomes.push({ item, status: 'saved', reason: `${Array.from(accepted.summary).length}字`, ...usage });
      log(`  保存 ${item.title.slice(0, 40)}（${result.model}, 入力 ${result.usage.input} / 出力 ${result.usage.output} トークン）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ item, status: 'error', reason: message });
      log(`  エラー ${item.title.slice(0, 40)}: ${message}`);
      // 認証・権限・利用上限のエラーは何度やっても同じなので打ち切る
      if (
        error instanceof Anthropic.AuthenticationError ||
        error instanceof Anthropic.PermissionDeniedError ||
        error instanceof Anthropic.NotFoundError ||
        error instanceof Anthropic.RateLimitError
      ) {
        stopReason = message;
      } else if (++consecutiveErrors >= 3) {
        stopReason = `エラーが続いたため中断しました（${message}）`;
      }
    } finally {
      inFlight--;
    }
  }

  async function worker() {
    while (!done()) {
      const item = queue.shift();
      if (!item) return;
      await handle(item);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  closeConnections();

  const tally = (status: Outcome['status']) => outcomes.filter((o) => o.status === status).length;
  log(
    `保存 ${records.length}件 ・ 見送り ${tally('skipped')}件 ・ エラー ${tally('error')}件 ・ API 呼び出し ${calls}回 ・ ` +
      `トークン 入力 ${tokens.input} / 出力 ${tokens.output}` +
      (cost === undefined || dryRun ? '' : ` ・ 費用の目安 $${cost.toFixed(3)}`),
  );
  if (dryRun) return;
  writeJobSummary(outcomes, cost, tokens);
  if (records.length > 0) writeRecords(records);
  if (stopReason) {
    // 保存できた分は書き出したうえで、失敗として知らせる（ワークフローはサイトの更新を続ける）
    console.error(`::error::AI 要約を途中で打ち切りました: ${stopReason}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`::error::${error instanceof Error ? error.message : error}`);
  closeConnections();
  process.exitCode = 1;
});
