import { resolve } from 'node:path';
import Parser from 'rss-parser';
import { loadSources } from '../src/lib/sources.ts';
import { getSummary } from '../src/lib/summaries.ts';
import type { Item, Source } from '../src/lib/types.ts';
import { updateDailySnapshots } from './lib/daily.ts';
import { fetchHatenaCounts } from './lib/hatena.ts';
import { closeConnections, decodeBody, httpGet, type HttpResponse } from './lib/http.ts';
import { buildExcerpt, cleanTitle, itemId, normalizePublishedAt, normalizeUrl } from './lib/normalize.ts';
import { mergeItems, pruneItems, readItemsFile, writeItemsFile } from './lib/store.ts';
import { jitter, shuffle, sleep } from './lib/timing.ts';

const ITEMS_PATH = resolve(process.cwd(), 'data/items.json');
const DAILY_DIR = resolve(process.cwd(), 'data/daily');
/** 同時にアクセスするホスト数（同じホストへは常に1件ずつ） */
const HOST_CONCURRENCY = 4;
const MAX_ITEMS_PER_FEED = 50;
/** はてブ数を更新する対象（公開からこの時間以内の記事） */
const HATEBU_WINDOW_HOURS = 36;

const parser = new Parser();

/** 一時的なエラー（通信失敗・429・5xx）のときだけ1回だけ再試行する */
async function getWithRetry(url: string): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await httpGet(url);
      if (attempt < 2 && (res.status === 429 || res.status >= 500)) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(jitter(3000, 6000));
    }
  }
}

async function fetchSource(source: Source, now: Date): Promise<Item[]> {
  const res = await getWithRetry(source.feedUrl);
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
  return items;
}

/**
 * 全ソースを取得する。人が順番に見て回るのに近づけるため、
 * 同じホストへは間隔をランダムに空けて1件ずつ、ホストの順番も毎回入れ替える。
 */
async function fetchAll(sources: Source[], now: Date): Promise<{ items: Item[]; failed: string[] }> {
  const byHost = new Map<string, Source[]>();
  for (const source of sources) {
    const host = new URL(source.feedUrl).hostname;
    byHost.set(host, [...(byHost.get(host) ?? []), source]);
  }
  const queue = shuffle([...byHost.values()].map((list) => shuffle(list)));
  const items: Item[] = [];
  const failed: string[] = [];

  async function worker() {
    for (let list = queue.shift(); list; list = queue.shift()) {
      for (const [index, source] of list.entries()) {
        if (index > 0) await sleep(jitter(1500, 4000));
        try {
          const fetched = await fetchSource(source, now);
          items.push(...fetched);
          console.log(`  ok   ${source.id}: ${fetched.length} 件`);
        } catch (error) {
          failed.push(source.id);
          console.warn(`  FAIL ${source.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, byHost.size) }, worker));
  return { items, failed };
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

  const { items: fetched, failed } = await fetchAll(sources, now);
  // sources.yaml から削除されたソースの記事は落とす
  const existing = readItemsFile(ITEMS_PATH).filter((item) => sourceById.has(item.sourceId));
  // 見出しが同じ記事をまとめるときは、要約のある記事を残す
  const hasSummary = (id: string) => Boolean(getSummary(id));
  const merged = pruneItems(mergeItems(existing, fetched, isAggregator, hasSummary), { now });
  await updateHatebu(merged, now);
  closeConnections();

  const existingIds = new Set(existing.map((item) => item.id));
  const added = merged.filter((item) => !existingIds.has(item.id)).length;
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
