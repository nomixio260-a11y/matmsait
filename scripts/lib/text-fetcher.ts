/**
 * 記事の本文の自動取得の中身（scripts/fetch-texts.ts から使う。通信は差し替えられるのでテストできる）。
 *
 * 通信はフィードの取得と同じブラウザ相当のヘッダーで行う（ボットの名前は名乗らない。名乗ると断られやすくなるため）。
 * そのうえで、サイトの意向は次のように守る:
 * - robots.txt でクローラー全般（User-agent: *）に断っている、または主な AI のクローラーを断っているページは取得しない
 *   （記事の続きのページなど、たどるページも1つずつ確かめる）
 * - ページに noai（AI での利用を断る指定）があれば使わない
 * - 拒否された（401・403・429・451・503）ときは再試行せず、そのまま記録する（ボット対策のすり抜けはしない）
 * - 1回の実行で取得するのは少しだけにし、同じサイトへは間隔を空けて1件ずつ
 * 取得した本文は公開しない。運営者の公開鍵で暗号化して返す
 *
 * 本文の取り方（2026-10-09 に改善）:
 * - ページから本文の候補をいくつか作って選ぶ（article-text.ts）
 * - 記事が複数のページに分かれていれば、続きのページ（2ページ目以降）もたどってつなげる
 * - 「全文を読む」のリンクがあれば、その先（全文のページ）を使う
 * - 本文が短ければ、記事本体へのリンク（お知らせのページなど）・AMP 版・WordPress の記事の API を順に試す
 * - 通信の失敗やサイトの一時的なエラー（500・502・504）は、少し待って1回だけやり直す
 */
import {
  pendingRequests,
  TEXT_FETCH_VERSION,
  TEXT_STATUS_LABELS,
  type TextRequest,
  type TextResult,
  type TextStatus,
} from '../../src/lib/article-texts.ts';
import { encryptText, type PublicTextKey } from '../../src/lib/text-crypto.ts';
import { MIN_TEXT_LENGTH, extractArticleText, type ExtractedArticle } from './article-text.ts';
import { decodeBody, type CookieJar, type HttpGetOptions, type HttpResponse } from './http.ts';
import { aiOptOut, hasNoAiDirective, isAllowed, parseRobots, type RobotsGroup } from './robots.ts';
import { jitter, sleep } from './timing.ts';

/** 1回の実行で取得する記事の数の上限 */
export const MAX_PER_RUN = 15;
/** 1つの記事で開くページの数の上限（最初のページ・続きのページ・全文のページなど） */
export const MAX_PAGES_PER_ARTICLE = 6;
/** 同時にアクセスするサイトの数 */
const SITE_CONCURRENCY = 3;
/** 1回の実行で本文の取得に使う時間の上限（毎時の更新（収集・公開）を遅らせないため。残りは次の実行で取得する） */
export const RUN_BUDGET_MS = 5 * 60 * 1000;
/** 拒否とみなす応答 */
const BLOCKED_STATUSES = new Set([401, 403, 429, 451, 503]);
/** 一時的なエラーとみなす応答（少し待って1回だけやり直す） */
const TEMPORARY_STATUSES = new Set([500, 502, 504]);
/** robots.txt で当てはめるグループ（名乗らないので、クローラー全般向けのルールに従う） */
const GENERIC_AGENT = '*';

export interface FetchTextsOptions {
  requests: TextRequest[];
  results: TextResult[];
  keys: PublicTextKey[];
  now: Date;
  get: (url: string, options: HttpGetOptions) => Promise<HttpResponse>;
  /** 同じサイトへのアクセスの間隔（テストでは 0） */
  wait?: () => Promise<void>;
  /** 記事の見出し（取り出した本文が見出しの記事のものかを確かめる。分からなければページの見出しを使う） */
  titleOf?: (id: string) => string | undefined;
  /** 取得に使う時間の上限（ミリ秒。既定は RUN_BUDGET_MS） */
  budgetMs?: number;
  /**
   * もう本文が要らない記事か（要約を保存した記事。結果はファイルに書くときに外されるので、
   * これを渡さないと「結果のない依頼」として毎回取りに行ってしまう）
   */
  done?: (id: string) => boolean;
  log?: (message: string) => void;
}

type Get = (url: string, options: HttpGetOptions) => Promise<HttpResponse>;

const defaultWait = () => sleep(jitter(1500, 3000));

/** 通信の失敗・一時的なエラーなら、少し待って1回だけやり直す（拒否された応答はやり直さない） */
async function getWithRetry(get: Get, url: string, options: HttpGetOptions, wait: () => Promise<void>): Promise<HttpResponse> {
  try {
    const res = await get(url, options);
    if (!TEMPORARY_STATUSES.has(res.status)) return res;
  } catch {
    // 下でやり直す
  }
  await wait();
  return get(url, options);
}

/** robots.txt を読む（4xx は「ルールなし」、読めないとき・5xx は取得しない。通信の失敗は1回だけやり直す） */
export async function loadRobots(origin: string, get: Get, wait: () => Promise<void> = () => sleep(2000)): Promise<RobotsGroup[] | 'error'> {
  try {
    const res = await getWithRetry(get, `${origin}/robots.txt`, { kind: 'document', timeoutMs: 15_000 }, wait);
    if (res.status >= 200 && res.status < 300) return parseRobots(decodeBody(res.body, res.headers['content-type']));
    if (res.status >= 400 && res.status < 500) return [];
    return 'error';
  } catch {
    return 'error';
  }
}

/** 記事の本文の取得の結果（取得できたときは本文。本文は公開しない） */
export type ArticleText =
  | { status: 'ok'; text: string; length: number; pages?: number }
  | { status: Exclude<TextStatus, 'ok'>; detail?: string };

export interface FetchArticleOptions {
  /** 記事の見出し（フィードの見出し） */
  title?: string;
  /** これだけの文字を取れたら、続きのページは取りに行かない */
  maxChars?: number;
  /** 同じサイトの次のページを開くまでの間隔（テストでは 0） */
  wait?: () => Promise<void>;
  /** この時刻（Date.now() の値）を過ぎたら、続きのページなどはたどらず、そこまでの本文を使う */
  deadline?: number;
}

/** 1ページを開いた結果 */
type PageResult =
  | { kind: 'page'; url: string; article: ExtractedArticle }
  | { kind: 'refused'; result: ArticleText }
  | { kind: 'failed'; result: ArticleText };

/**
 * 記事のページから本文を取る。robots.txt（クローラー全般・主な AI のクローラー）・ページの noai・アクセスの拒否を守る。
 * 本文の自動取得（暗号化して置く）と AI の自動要約（その場で要約して、本文は保存しない）で共通
 */
export async function fetchArticleText(url: string, robots: RobotsGroup[], get: Get, options: FetchArticleOptions = {}): Promise<ArticleText> {
  const wait = options.wait ?? defaultWait;
  const maxChars = options.maxChars ?? 20_000;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { status: 'error', detail: '記事の URL が正しくありません' };
  }
  const refusal = robotsRefusal(robots, target);
  if (refusal) return refusal;
  const cookies: CookieJar = new Map();
  let opened = 0;
  // 転送（リダイレクト）の先も robots.txt で確かめる（別のサイトへ転送されたら、そのサイトの robots.txt を読む）
  const robotsByOrigin = new Map<string, RobotsGroup[] | 'error'>([[target.origin, robots]]);
  const rulesFor = async (url: URL) => {
    if (!robotsByOrigin.has(url.origin)) robotsByOrigin.set(url.origin, await loadRobots(url.origin, get, wait));
    return robotsByOrigin.get(url.origin)!;
  };
  let redirectRefusal: ArticleText | undefined;
  const followRedirect = async (to: URL) => {
    if (to.protocol !== 'https:' && to.protocol !== 'http:') return false;
    const rules = await rulesFor(to);
    redirectRefusal = rules === 'error' ? { status: 'error', detail: `転送先（${to.hostname}）の robots.txt を読めませんでした` } : robotsRefusal(rules, to);
    return !redirectRefusal;
  };

  /** 1ページを開いて本文を取り出す（referer: どのページのリンクから移ったか） */
  const open = async (pageUrl: string, referer?: string, articleUrl?: string): Promise<PageResult> => {
    opened++;
    try {
      redirectRefusal = undefined;
      const res = await getWithRetry(get, pageUrl, { kind: 'document', timeoutMs: 20_000, cookies, followRedirect, ...(referer ? { referer } : {}) }, wait);
      if (redirectRefusal) return { kind: 'refused', result: redirectRefusal };
      if (BLOCKED_STATUSES.has(res.status)) return { kind: 'refused', result: { status: 'blocked', detail: `HTTP ${res.status}` } };
      if (res.status === 404 || res.status === 410) return { kind: 'failed', result: { status: 'not-found', detail: `HTTP ${res.status}` } };
      if (res.status !== 200) return { kind: 'failed', result: { status: 'error', detail: `HTTP ${res.status}` } };
      const type = String(res.headers['content-type'] ?? '');
      if (type && !/html/i.test(type)) return { kind: 'failed', result: { status: 'error', detail: `HTML ではありません（${type}）` } };
      const article = extractArticleText(decodeBody(res.body, type), { url: res.url, articleUrl, title: options.title });
      const tagValues = [res.headers['x-robots-tag']].flat().filter((value): value is string => typeof value === 'string');
      if (hasNoAiDirective([...tagValues, ...article.robots])) return { kind: 'refused', result: { status: 'ai-optout', detail: 'ページに noai の指定' } };
      return { kind: 'page', url: res.url, article };
    } catch (error) {
      return { kind: 'failed', result: { status: 'error', detail: error instanceof Error ? error.message : String(error) } };
    }
  };
  /** 記事のサイト（最初のページの転送先。たどるのはこのサイトの中だけ）と、その robots.txt */
  let site = target;
  let siteRules = robots;
  /** たどってよいページか（同じサイトで、robots.txt と AI の拒否に当てはまらない。開ける数・時間の上限まで） */
  const followable = (link: string | undefined): link is string => {
    if (!link || opened >= MAX_PAGES_PER_ARTICLE || (options.deadline !== undefined && Date.now() >= options.deadline)) return false;
    try {
      const next = new URL(link);
      return next.hostname === site.hostname && !robotsRefusal(siteRules, next);
    } catch {
      return false;
    }
  };

  const first = await open(url);
  if (first.kind !== 'page') return first.result;
  const landed = new URL(first.url);
  if (landed.origin !== target.origin) {
    const rules = await rulesFor(landed);
    if (rules !== 'error') {
      site = landed;
      siteRules = rules;
    }
  }
  let { article } = first;
  /** 本文を取ったページと、続きのページを数える基準のページ（全文のページ・記事本体のページに移ったらそのページ） */
  let pageUrl = first.url;
  let articleUrl = first.url;
  let text = article.text;
  const length = (value: string) => Array.from(value).length;
  const use = (page: Extract<PageResult, { kind: 'page' }>) => {
    article = page.article;
    pageUrl = page.url;
    articleUrl = page.url;
    text = page.article.text;
  };

  // 「全文を読む」の先（本文が途中までのページ）
  if (followable(article.links.more)) {
    await wait();
    const full = await open(article.links.more, pageUrl);
    if (full.kind === 'refused') return full.result;
    if (full.kind === 'page' && length(full.article.text) > length(text)) use(full);
  }
  // 本文が短ければ: 記事本体へのリンク → AMP 版の順に試す
  for (const link of [article.links.stub, article.links.amp]) {
    if (length(text) >= MIN_TEXT_LENGTH || !followable(link)) continue;
    await wait();
    const other = await open(link, pageUrl);
    if (other.kind === 'refused') return other.result;
    if (other.kind === 'page' && length(other.article.text) > length(text)) use(other);
  }
  // それでも短ければ、WordPress の記事の API（ページには途中までしかなくても、全文があることが多い）
  if (length(text) < MIN_TEXT_LENGTH && followable(article.links.wpJson)) {
    await wait();
    const body = await wordpressText(get, article.links.wpJson, pageUrl, options.title, cookies, followRedirect);
    opened++;
    if (body && length(body) > length(text)) text = body;
  }

  // 続きのページ（2ページ目以降）をつなげる（同じ記事のページだけ。前のページと同じ行は除く）
  let pages = 1;
  const queue = [...article.links.pages];
  const seen = new Set([url, first.url, pageUrl]);
  while (queue.length > 0 && length(text) < maxChars) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (!followable(next)) break;
    await wait();
    const page = await open(next, pageUrl, articleUrl);
    if (page.kind === 'refused') {
      // 続きのページで AI での利用を断っていれば、その記事は使わない。アクセスを断られたら、そこまでにする
      if (page.result.status === 'ai-optout') return page.result;
      break;
    }
    if (page.kind !== 'page') break;
    const known = new Set(text.split('\n'));
    const added = page.article.text.split('\n').filter((line) => !known.has(line));
    // 新しい文字がほとんどなければ（動画へのリンクだけのページなど）、つなげずにそこまでにする
    if (added.join('').length < 50) break;
    text = `${text}\n${added.join('\n')}`;
    pages++;
    pageUrl = page.url;
    for (const link of page.article.links.pages) if (!seen.has(link) && !queue.includes(link)) queue.push(link);
  }

  const total = length(text);
  if (total < MIN_TEXT_LENGTH) {
    const what = article.media === 'video' ? '動画が中心のページ' : article.media === 'images' ? '画像が中心のページ' : '本文が短いページ';
    return { status: 'no-text', detail: `${what}（${total}字）` };
  }
  return { status: 'ok', text, length: total, ...(pages > 1 ? { pages } : {}) };
}

/** robots.txt でクローラー全般か主な AI のクローラーに断られているページなら、その結果 */
function robotsRefusal(robots: RobotsGroup[], url: URL): ArticleText | undefined {
  const pathAndQuery = url.pathname + url.search;
  if (!isAllowed(robots, GENERIC_AGENT, pathAndQuery)) return { status: 'robots' };
  const optOut = aiOptOut(robots, pathAndQuery);
  if (optOut) return { status: 'ai-optout', detail: `robots.txt で ${optOut} を拒否` };
  return undefined;
}

/** WordPress の記事の API の本文（content.rendered）を文にする。取れなければ undefined */
async function wordpressText(
  get: Get,
  apiUrl: string,
  referer: string,
  title: string | undefined,
  cookies: CookieJar,
  followRedirect: HttpGetOptions['followRedirect'],
): Promise<string | undefined> {
  try {
    const res = await get(apiUrl, { kind: 'fetch', timeoutMs: 20_000, referer, cookies, followRedirect });
    if (res.status !== 200) return undefined;
    const data = JSON.parse(decodeBody(res.body, String(res.headers['content-type'] ?? ''))) as { content?: { rendered?: unknown; protected?: unknown } };
    const rendered = data.content?.rendered;
    if (typeof rendered !== 'string' || data.content?.protected === true) return undefined;
    return extractArticleText(`<html><body><article>${rendered}</article></body></html>`, { title }).text;
  } catch {
    return undefined;
  }
}

/** 結果に共通の項目（同じ依頼の一時的な失敗の取り直しなら、試した回数を数える） */
function resultBase(request: TextRequest, previous: TextResult | undefined) {
  const tries = previous && previous.status === 'error' && previous.fetchedAt >= request.requestedAt ? (previous.tries ?? 1) + 1 : 1;
  return { id: request.id, url: request.url, fetchedAt: new Date().toISOString(), v: TEXT_FETCH_VERSION, ...(tries > 1 ? { tries } : {}) };
}

async function fetchOne(
  request: TextRequest,
  robots: RobotsGroup[],
  options: FetchTextsOptions,
  previous: TextResult | undefined,
  deadline: number,
): Promise<TextResult> {
  const base = resultBase(request, previous);
  const title = options.titleOf?.(request.id);
  const article = await fetchArticleText(request.url, robots, options.get, { ...(title ? { title } : {}), wait: options.wait, deadline });
  if (article.status !== 'ok') return { ...base, status: article.status, ...(article.detail ? { detail: article.detail } : {}) };
  try {
    return {
      ...base,
      status: 'ok',
      length: article.length,
      ...(article.pages ? { detail: `${article.pages}ページ分` } : {}),
      enc: await encryptText(article.text, options.keys),
    };
  } catch (error) {
    return { ...base, status: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * まだ結果のない依頼（と、取り直す依頼）の本文を取得して、結果を返す（取得したものだけ）。
 * 公開鍵がなければ何もしない（本文をそのまま公開リポジトリに置かないため）
 */
export async function fetchTexts(options: FetchTextsOptions): Promise<TextResult[]> {
  const { requests, results, keys, now, log = () => {} } = options;
  const wait = options.wait ?? (() => sleep(jitter(3000, 5000)));
  const pending = pendingRequests(
    requests.filter((request) => !options.done?.(request.id)),
    results,
    now.getTime(),
  ).slice(0, MAX_PER_RUN);
  if (pending.length === 0) {
    log('本文の取得の依頼はありません');
    return [];
  }
  if (keys.length === 0) {
    log('運営者の公開鍵が登録されていないため、本文を取得しません（管理画面にログインすると登録されます）');
    return [];
  }
  const previous = new Map(results.map((result) => [result.id, result]));
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
  // 時間の上限を過ぎたら、新しい記事は取りに行かない（結果のない依頼は、次の実行で取得する）
  const deadline = Date.now() + (options.budgetMs ?? RUN_BUDGET_MS);
  let skipped = 0;
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const [origin, list] = entry;
      if (Date.now() >= deadline) {
        skipped += list.length;
        continue;
      }
      const robots = await loadRobots(origin, options.get, wait);
      for (const [i, request] of list.entries()) {
        if (Date.now() >= deadline) {
          skipped += list.length - i;
          break;
        }
        if (i > 0) await wait();
        // 記事のページどうしの間隔は、テストでは同じく 0、本番では短め（fetchArticleText の既定）
        const result: TextResult =
          robots === 'error'
            ? { ...resultBase(request, previous.get(request.id)), status: 'error', detail: 'robots.txt を読めませんでした' }
            : await fetchOne(request, robots, options, previous.get(request.id), deadline);
        fetched.push(result);
        log(`${result.status === 'ok' ? '取得' : '取得せず'}: ${request.url} — ${TEXT_STATUS_LABELS[result.status]}${result.detail ? `（${result.detail}）` : ''}`);
      }
    }
  };
  await Promise.all(Array.from({ length: SITE_CONCURRENCY }, worker));
  if (skipped > 0) log(`時間の上限に達したので、残りの${skipped}件は次の実行で取得します`);
  return fetched;
}
