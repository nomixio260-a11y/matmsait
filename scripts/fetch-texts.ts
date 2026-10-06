/**
 * AI が開けない記事の本文を自動で取得する（管理画面からの依頼 data/text-requests.json にもとづく）。
 * 取り方の決まり（TopiatsumeBot と名乗る・robots.txt と AI での利用の拒否を守る・拒否されたら再試行しない）は
 * scripts/lib/text-fetcher.ts を参照。取得した本文は運営者の公開鍵（data/text-keys.json）で暗号化して data/texts.json に置く。
 *
 * 使い方: npm run texts                    （依頼を取得する）
 *         npm run texts -- --merge <file>  （別に取得した結果を data/texts.json にまとめる。データのコミット用）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TEXT_KEYS_PATH,
  TEXT_REQUESTS_PATH,
  TEXTS_PATH,
  mergeTextResults,
  parseJsonList,
  pickKeys,
  pickRequests,
  pickResults,
  serializeTextsFile,
  type TextResult,
} from '../src/lib/article-texts.ts';
import { site } from '../src/config/site.ts';
import { getSummary } from '../src/lib/summaries.ts';
import { closeConnections, httpGet } from './lib/http.ts';
import { fetchTexts } from './lib/text-fetcher.ts';

const path = (file: string) => resolve(process.cwd(), file);
const readText = (file: string) => (existsSync(path(file)) ? readFileSync(path(file), 'utf8') : undefined);
const readResults = (file = TEXTS_PATH): TextResult[] => parseJsonList(readText(file), pickResults);

/** ボットの説明のページ（サイトの運営者情報）。公開先が分からなければリポジトリ */
function infoUrl(): string {
  const base = process.env.SITE_BASE_URL?.replace(/\/+$/, '');
  return base ? `${base}/about/#bot` : `https://github.com/${site.repository.owner}/${site.repository.repo}`;
}

/** 結果を書く（要約を保存した記事の結果は、もう要らないので外す）。中身が変わらなければ書かない（毎回コミットしないように） */
function writeResults(lists: TextResult[][], now: Date) {
  const items = mergeTextResults(lists, { now: now.getTime(), keep: (id) => !getSummary(id) });
  if (JSON.stringify(items) === JSON.stringify(readResults())) return;
  writeFileSync(path(TEXTS_PATH), serializeTextsFile({ updatedAt: now.toISOString(), items }));
}

const mergeIndex = process.argv.indexOf('--merge');
if (mergeIndex >= 0) {
  const file = process.argv[mergeIndex + 1];
  if (file && existsSync(file)) writeResults([readResults(), readResults(file)], new Date());
} else {
  const now = new Date();
  const results = readResults();
  const fetched = await fetchTexts({
    requests: parseJsonList(readText(TEXT_REQUESTS_PATH), pickRequests),
    results,
    keys: parseJsonList(readText(TEXT_KEYS_PATH), pickKeys),
    now,
    infoUrl: infoUrl(),
    get: httpGet,
    log: (message) => console.log(message),
  });
  closeConnections();
  if (fetched.length > 0) {
    writeResults([results, fetched], now);
    console.log(`本文の取得: ${fetched.length}件中 ${fetched.filter((result) => result.status === 'ok').length}件を取得しました`);
  }
}
