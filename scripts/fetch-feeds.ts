import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Parser from 'rss-parser';
import { loadSources } from '../src/lib/sources.ts';
import { getSummary } from '../src/lib/summaries.ts';
import type { Item, Source } from '../src/lib/types.ts';
import { updateDailySnapshots } from './lib/daily.ts';
import {
  conditionalHeaders,
  readFeedStates,
  recordFailure,
  recordSuccess,
  writeFeedStates,
  type FeedStates,
  type FetchOutcome,
} from './lib/feed-state.ts';
import { fetchHatenaCounts } from './lib/hatena.ts';
import { closeConnections, decodeBody, httpGet, type HttpResponse } from './lib/http.ts';
import { buildExcerpt, cleanTitle, itemId, normalizePublishedAt, normalizeUrl } from './lib/normalize.ts';
import { mergeItems, pruneItems, readItemsFile, writeItemsFile } from './lib/store.ts';
import { jitter, retryDelay, shuffle, sleep } from './lib/timing.ts';

const ITEMS_PATH = resolve(process.cwd(), 'data/items.json');
const FEEDS_PATH = resolve(process.cwd(), 'data/feeds.json');
const DAILY_DIR = resolve(process.cwd(), 'data/daily');
/** 同時にアクセスするホスト数（同じホストへは常に1件ずつ） */
const HOST_CONCURRENCY = 4;
const MAX_ITEMS_PER_FEED = 50;
/** はてブ数を更新する対象（公開からこの時間以内の記事） */
const HATEBU_WINDOW_HOURS = 36;

const parser = new Parser();

/** 一時的なエラー（通信失敗・429・5xx）のときだけ1回だけ再試行する */
async function getWithRetry(url: string, headers: [string, string][]): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt++) {
    let res: HttpResponse | undefined;
    try {
      res = await httpGet(url, { headers });
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(jitter(3000, 6000));
      continue;
    }
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await sleep(retryDelay(res.headers['retry-after']));
      continue;
    }
    return res;
  }
}

/** フィードを取得する。前回から変わっていなければ（304）記事は空で返す */
async function fetchSource(
  source: Source,
  now: Date,
  states: FeedStates,
): Promise<{ items: Item[]; outcome: FetchOutcome }> {
  const res = await getWithRetry(source.feedUrl, conditionalHeaders(states[source.id], now));
  if (res.status === 304) return { items: [], outcome: { notModified: true } };
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const feed = await parser.parseString(decodeBody(res.body, res.headers['content-type']));
  const stripPattern = source.stripTitle ? new RegExp(source.stripTitle) : undefined;

  const items: Item[] = [];
  for (const entry of feed.items.slice(0, MAX_ITEMS_PER_FEED)) {
    const url = normalizeUrl(entry.link, res.url);
    const title = cleanTitle(entry.title ?? '', stripPattern);
    if (!url || !title) continue;
    items.push({
      id: itemId(url),
      title,
      url,
      excerpt: buildExcerpt(title, entry.contentSnippet || entry.summary || entry.content || ''),
      sourceId: source.id,
      category: source.category,
      publishedAt: normalizePublishedAt(entry.isoDate ?? entry.pubDate, now),
    });
  }
  const header = (name: string) => {
    const value = res.headers[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  return {
    items,
    outcome: { notModified: false, etag: header('etag'), lastModified: header('last-modified'), count: items.length },
  };
}

/**
 * 全ソースを取得する。人が順番に見て回るのに近づけるため、
 * 同じホストへは間隔をランダムに空けて1件ずつ、ホストの順番も毎回入れ替える。
 */
interface SourceResult {
  source: Source;
  /** 取得できた記事数（失敗したときは undefined） */
  count?: number;
  /** 前回から変わっていなかった（304） */
  notModified?: boolean;
  error?: string;
}

async function fetchAll(
  sources: Source[],
  now: Date,
  states: FeedStates,
): Promise<{ items: Item[]; failed: string[]; results: SourceResult[] }> {
  const byHost = new Map<string, Source[]>();
  for (const source of sources) {
    const host = new URL(source.feedUrl).hostname;
    byHost.set(host, [...(byHost.get(host) ?? []), source]);
  }
  const queue = shuffle([...byHost.values()].map((list) => shuffle(list)));
  const items: Item[] = [];
  const failed: string[] = [];
  const results: SourceResult[] = [];

  async function worker() {
    for (let list = queue.shift(); list; list = queue.shift()) {
      for (const [index, source] of list.entries()) {
        if (index > 0) await sleep(jitter(1500, 4000));
        try {
          const { items: fetched, outcome } = await fetchSource(source, now, states);
          items.push(...fetched);
          states[source.id] = recordSuccess(states[source.id], outcome, now);
          results.push({ source, count: fetched.length, notModified: outcome.notModified });
          console.log(`  ok   ${source.id}: ${outcome.notModified ? '変更なし（304）' : `${fetched.length} 件`}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push(source.id);
          states[source.id] = recordFailure(states[source.id], message, now);
          results.push({ source, error: message });
          console.warn(`  FAIL ${source.id}: ${message}（${states[source.id].failures}回連続）`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, byHost.size) }, worker));
  return { items, failed, results };
}

/** GitHub Actions の実行結果ページに、収集元ごとの取得結果を表で出す */
function writeJobSummary(results: SourceResult[], added: Map<string, number>, total: number, states: FeedStates) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const failed = results.filter((result) => result.error);
  const rows = [...results].sort(
    (a, b) => Number(Boolean(b.error)) - Number(Boolean(a.error)) || a.source.id.localeCompare(b.source.id),
  );
  const newTotal = [...added.values()].reduce((sum, count) => sum + count, 0);
  const lines = [
    '### フィードの取得',
    '',
    `成功 ${results.length - failed.length} / 失敗 ${failed.length} ・ 新規 ${newTotal}件 ・ 合計 ${total}件`,
    '',
    '| 状態 | 収集元 | 取得 | 新規 | エラー |',
    '| --- | --- | ---: | ---: | --- |',
    ...rows.map(
      ({ source, count, notModified, error }) =>
        `| ${error ? `❌ 失敗（${states[source.id]?.failures ?? 1}回連続）` : '✅'} | ${source.name}（${source.id}） | ${notModified ? '変更なし' : (count ?? '-')} | ${added.get(source.id) ?? 0} | ${error ?? ''} |`,
    ),
    '',
  ];
  appendFileSync(file, `${lines.join('\n')}\n`);
}

/** 直近の記事のはてなブックマーク数を更新する。失敗しても前回の値を残して続行 */
async function updateHatebu(items: Item[], now: Date): Promise<void> {
  const cutoff = now.getTime() - HATEBU_WINDOW_HOURS * 60 * 60 * 1000;
  const targets = items.filter((item) => Date.parse(item.publishedAt) >= cutoff);
  try {
    const counts = await fetchHatenaCounts(targets.map((item) => item.url));
    for (const item of targets) {
      const count = counts.get(item.url);
      if (count === undefined) continue;
      if (count > 0) item.hatebu = count;
      else delete item.hatebu;
    }
    console.log(`はてなブックマーク数を ${targets.length} 件更新しました`);
  } catch (error) {
    console.warn(`はてなブックマーク数の取得に失敗: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  const now = new Date();
  const sources = loadSources();
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const isAggregator = (id: string) => sourceById.get(id)?.aggregator === true;
  console.log(`${sources.length} 件のフィードを取得します`);

  // sources.yaml から削除された収集元の状態は残さない
  const states = Object.fromEntries(
    Object.entries(readFeedStates(FEEDS_PATH)).filter(([id]) => sourceById.has(id)),
  ) as FeedStates;
  const { items: fetched, failed, results } = await fetchAll(sources, now, states);
  // sources.yaml から削除されたソースの記事は落とす
  const existing = readItemsFile(ITEMS_PATH).filter((item) => sourceById.has(item.sourceId));
  // 見出しが同じ記事をまとめるときは、要約のある記事を残す
  const hasSummary = (id: string) => Boolean(getSummary(id));
  const merged = pruneItems(mergeItems(existing, fetched, isAggregator, hasSummary), { now });
  await updateHatebu(merged, now);
  closeConnections();

  const existingIds = new Set(existing.map((item) => item.id));
  const addedItems = merged.filter((item) => !existingIds.has(item.id));
  const added = addedItems.length;
  const addedBySource = new Map<string, number>();
  for (const item of addedItems) addedBySource.set(item.sourceId, (addedBySource.get(item.sourceId) ?? 0) + 1);
  writeJobSummary(results, addedBySource, merged.length, states);
  writeFeedStates(FEEDS_PATH, states);
  writeItemsFile(ITEMS_PATH, merged);
  const days = updateDailySnapshots(merged, DAILY_DIR, now);
  console.log(
    `新規 ${added} 件 / 合計 ${merged.length} 件を保存しました（成功 ${sources.length - failed.length} / 失敗 ${failed.length}）`,
  );
  console.log(`日別まとめを更新: ${days.join(', ') || 'なし'}`);

  if (failed.length === sources.length) {
    console.error('すべてのフィードの取得に失敗しました');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
