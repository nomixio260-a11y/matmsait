import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';
import { loadSources } from '../src/lib/sources.ts';
import type { Item, Source } from '../src/lib/types.ts';
import { itemId, makeExcerpt, normalizePublishedAt, normalizeUrl, stripHtml } from './lib/normalize.ts';
import { mergeItems, pruneItems } from './lib/prune.ts';

const ITEMS_PATH = fileURLToPath(new URL('../data/items.json', import.meta.url));
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
const MAX_ITEMS_PER_FEED = 50;
// HTTPヘッダーは ASCII のみ使用可能
const USER_AGENT = `MatomeAntennaBot/1.0 (+${process.env.SITE_URL ?? 'https://github.com/'})`;

const parser = new Parser();

async function fetchSource(source: Source, now: Date): Promise<Item[]> {
  const res = await fetch(source.feedUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const feed = await parser.parseString(await res.text());

  const items: Item[] = [];
  for (const entry of feed.items.slice(0, MAX_ITEMS_PER_FEED)) {
    const url = normalizeUrl(entry.link);
    const title = stripHtml(entry.title ?? '');
    if (!url || !title) continue;
    items.push({
      id: itemId(url),
      title,
      url,
      excerpt: makeExcerpt(entry.contentSnippet || entry.summary || entry.content || ''),
      sourceId: source.id,
      category: source.category,
      publishedAt: normalizePublishedAt(entry.isoDate ?? entry.pubDate, now),
    });
  }
  return items;
}

/** 同時実行数を制限しながら全ソースを取得する。失敗したソースはログに残してスキップ */
async function fetchAll(sources: Source[], now: Date): Promise<{ items: Item[]; failed: string[] }> {
  const results: Item[][] = new Array(sources.length);
  const failed: string[] = [];
  let next = 0;

  async function worker() {
    while (next < sources.length) {
      const index = next++;
      const source = sources[index];
      try {
        results[index] = await fetchSource(source, now);
        console.log(`  ok   ${source.id}: ${results[index].length} 件`);
      } catch (error) {
        results[index] = [];
        failed.push(source.id);
        console.warn(`  FAIL ${source.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
  return { items: results.flat(), failed };
}

function readExisting(): Item[] {
  if (!existsSync(ITEMS_PATH)) return [];
  return JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) as Item[];
}

async function main() {
  const now = new Date();
  const sources = loadSources();
  const sourceIds = new Set(sources.map((s) => s.id));
  console.log(`${sources.length} 件のフィードを取得します`);

  const { items: fetched, failed } = await fetchAll(sources, now);
  // sources.yaml から削除されたソースの記事は落とす
  const existing = readExisting().filter((item) => sourceIds.has(item.sourceId));
  const merged = pruneItems(mergeItems(existing, fetched), { now });
  const existingIds = new Set(existing.map((item) => item.id));
  const added = merged.filter((item) => !existingIds.has(item.id)).length;

  mkdirSync(dirname(ITEMS_PATH), { recursive: true });
  writeFileSync(ITEMS_PATH, JSON.stringify(merged, null, 1) + '\n');
  console.log(`新規 ${added} 件 / 合計 ${merged.length} 件を保存しました`);

  if (failed.length === sources.length) {
    console.error('すべてのフィードの取得に失敗しました');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
