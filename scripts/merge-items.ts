// 別の実行で取得した items.json を、最新の data/items.json にマージする。
// ワークフローで push が競合したとき（再実行や同時実行）に、最新のデータを取り込み直すために使う。
import { resolve } from 'node:path';
import { loadSources } from '../src/lib/sources.ts';
import { getSummary } from '../src/lib/summaries.ts';
import { updateDailySnapshots } from './lib/daily.ts';
import { mergeItems, pruneItems, readItemsFile, writeItemsFile } from './lib/store.ts';

const ITEMS_PATH = resolve(process.cwd(), 'data/items.json');
const DAILY_DIR = resolve(process.cwd(), 'data/daily');

const otherPath = process.argv[2];
if (!otherPath) {
  console.error('使い方: npm run merge -- <取り込む items.json>');
  process.exit(1);
}

const now = new Date();
const sourceById = new Map(loadSources().map((source) => [source.id, source]));
const known = (sourceId: string) => sourceById.has(sourceId);
const isAggregator = (sourceId: string) => sourceById.get(sourceId)?.aggregator === true;

const current = readItemsFile(ITEMS_PATH).filter((item) => known(item.sourceId));
const other = readItemsFile(otherPath).filter((item) => known(item.sourceId));
// 見出しが同じ記事をまとめるときは、要約のある記事を残す
const hasSummary = (id: string) => Boolean(getSummary(id));
const merged = pruneItems(mergeItems(current, other, isAggregator, hasSummary), { now });
writeItemsFile(ITEMS_PATH, merged);
const days = updateDailySnapshots(merged, DAILY_DIR, now);
console.log(`マージ後 ${merged.length} 件（日別まとめを更新: ${days.join(', ') || 'なし'}）`);
