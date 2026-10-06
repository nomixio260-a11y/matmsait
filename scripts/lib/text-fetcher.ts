/**
 * 記事の本文の自動取得の中身（scripts/fetch-texts.ts から使う。通信は差し替えられるのでテストできる）。
 *
 * サイトの意向を守るため:
 * - TopiatsumeBot と名乗り、ブラウザのふりはしない（説明のページを User-Agent に入れる）
 * - robots.txt で自分（TopiatsumeBot）が断られている、または主な AI のクローラーが断られているページは取得しない
 * - ページに noai（AI での利用を断る指定）があれば使わない
 * - 拒否された（401・403・429・451・503）ときは再試行せず、そのまま記録する
 * - 1回の実行で取得するのは少しだけにし、同じサイトへは間隔を空けて1件ずつ
 * 取得した本文は公開しない。運営者の公開鍵で暗号化して返す
 */
import { pendingRequests, TEXT_STATUS_LABELS, type TextRequest, type TextResult } from '../../src/lib/article-texts.ts';
import { encryptText, type PublicTextKey } from '../../src/lib/text-crypto.ts';
import { MIN_TEXT_LENGTH, extractArticleText } from './article-text.ts';
import { BOT_NAME, botHeaders, decodeBody, type HttpGetOptions, type HttpResponse } from './http.ts';
import { aiOptOut, hasNoAiDirective, isAllowed, parseRobots, type RobotsGroup } from './robots.ts';
import { jitter, sleep } from './timing.ts';

/** 1回の実行で取得する記事の数の上限 */
export const MAX_PER_RUN = 15;
/** 同時にアクセスするサイトの数 */
const SITE_CONCURRENCY = 3;
/** 拒否とみなす応答 */
const BLOCKED_STATUSES = new Set([401, 403, 429, 451, 503]);

export interface FetchTextsOptions {
  requests: TextRequest[];
  results: TextResult[];
  keys: PublicTextKey[];
  now: Date;
  /** ボットの説明のページ（User-Agent に入れる） */
  infoUrl: string;
  get: (url: string, options: HttpGetOptions) => Promise<HttpResponse>;
  /** 同じサイトへのアクセスの間隔（テストでは 0） */
  wait?: () => Promise<void>;
  log?: (message: string) => void;
}

/** robots.txt を読む（4xx は「ルールなし」、読めないとき・5xx は取得しない） */
async function loadRobots(origin: string, options: FetchTextsOptions, headers: [string, string][]): Promise<RobotsGroup[] | 'error'> {
  try {
    const res = await options.get(`${origin}/robots.txt`, { baseHeaders: headers, timeoutMs: 15_000 });
    if (res.status >= 200 && res.status < 300) return parseRobots(decodeBody(res.body, res.headers['content-type']));
    if (res.status >= 400 && res.status < 500) return [];
    return 'error';
  } catch {
    return 'error';
  }
}

async function fetchOne(
  request: TextRequest,
  robots: RobotsGroup[],
  options: FetchTextsOptions,
  headers: [string, string][],
): Promise<TextResult> {
  const base = { id: request.id, url: request.url, fetchedAt: new Date().toISOString() };
  const target = new URL(request.url);
  const pathAndQuery = target.pathname + target.search;
  if (!isAllowed(robots, BOT_NAME, pathAndQuery)) return { ...base, status: 'robots' };
  const optOut = aiOptOut(robots, pathAndQuery);
  if (optOut) return { ...base, status: 'ai-optout', detail: `robots.txt で ${optOut} を拒否` };
  try {
    const res = await options.get(request.url, { baseHeaders: headers, timeoutMs: 20_000 });
    if (BLOCKED_STATUSES.has(res.status)) return { ...base, status: 'blocked', detail: `HTTP ${res.status}` };
    if (res.status === 404 || res.status === 410) return { ...base, status: 'not-found', detail: `HTTP ${res.status}` };
    if (res.status !== 200) return { ...base, status: 'error', detail: `HTTP ${res.status}` };
    const type = String(res.headers['content-type'] ?? '');
    if (type && !/html/i.test(type)) return { ...base, status: 'error', detail: `HTML ではありません（${type}）` };
    const tagValues = [res.headers['x-robots-tag']].flat().filter((value): value is string => typeof value === 'string');
    const article = extractArticleText(decodeBody(res.body, type));
    if (hasNoAiDirective([...tagValues, ...article.robots])) return { ...base, status: 'ai-optout', detail: 'ページに noai の指定' };
    const length = Array.from(article.text).length;
    if (length < MIN_TEXT_LENGTH) return { ...base, status: 'no-text', detail: `${length}字` };
    return { ...base, status: 'ok', length, enc: await encryptText(article.text, options.keys) };
  } catch (error) {
    return { ...base, status: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * まだ結果のない依頼の本文を取得して、結果を返す（取得したものだけ）。
 * 公開鍵がなければ何もしない（本文をそのまま公開リポジトリに置かないため）
 */
export async function fetchTexts(options: FetchTextsOptions): Promise<TextResult[]> {
  const { requests, results, keys, now, log = () => {} } = options;
  const wait = options.wait ?? (() => sleep(jitter(3000, 5000)));
  const pending = pendingRequests(requests, results, now.getTime()).slice(0, MAX_PER_RUN);
  if (pending.length === 0) {
    log('本文の取得の依頼はありません');
    return [];
  }
  if (keys.length === 0) {
    log('運営者の公開鍵が登録されていないため、本文を取得しません（管理画面にログインすると登録されます）');
    return [];
  }
  const headers = botHeaders(options.infoUrl);
  // サイト（オリジン）ごとにまとめ、同じサイトへは1件ずつ間隔を空ける
  const bySite = new Map<string, TextRequest[]>();
  for (const request of pending) {
    let origin: string;
    try {
      origin = new URL(request.url).origin;
    } catch {
      continue;
    }
    bySite.set(origin, [...(bySite.get(origin) ?? []), request]);
  }
  const queue = [...bySite.entries()];
  const fetched: TextResult[] = [];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const [origin, list] = entry;
      const robots = await loadRobots(origin, options, headers);
      for (const [i, request] of list.entries()) {
        if (i > 0) await wait();
        const result: TextResult =
          robots === 'error'
            ? { id: request.id, url: request.url, status: 'error', detail: 'robots.txt を読めませんでした', fetchedAt: new Date().toISOString() }
            : await fetchOne(request, robots, options, headers);
        fetched.push(result);
        log(`${result.status === 'ok' ? '取得' : '取得せず'}: ${request.url} — ${TEXT_STATUS_LABELS[result.status]}${result.detail ? `（${result.detail}）` : ''}`);
      }
    }
  };
  await Promise.all(Array.from({ length: SITE_CONCURRENCY }, worker));
  return fetched;
}
