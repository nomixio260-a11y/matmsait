/**
 * アクセス解析の入口: 送り元を確かめて、集計の Durable Object へ渡す（CORS の応答もここで返す）。
 * 公開しているサイトでは Cloudflare Pages の Functions（functions/api/[[path]].ts）がサイトと同じドメインの /api で使い、
 * 手元で試すときは Worker（src/index.ts）がそのまま使う
 *
 * - POST /collect          サイトの閲覧・記事のクリックなどを受け取る（いま見ている人数を返す）
 * - GET  /popular          よく読まれている記事（24時間・1週間）。サイトのビルドで使う（公開）
 * - GET  /admin/live       いま見ている人・最近の動き（運営者だけ）
 * - GET  /admin/stats      期間の集計（運営者だけ）
 * - GET  /admin/articles   記事ごとの人数（管理画面の「よく読まれている順」用。運営者だけ）
 * - GET  /push/key         通知の購読に使う公開鍵（公開）
 * - POST /push/subscribe   通知の購読・設定の変更（フォローしているジャンル・掲載元・キーワードと受け取り方）
 * - POST /push/unsubscribe 通知をやめる
 * - POST /push/status      このブラウザの購読が登録されているか
 * - POST /push/test        テストの通知を送る
 * - POST /push/check       公開したサイトの updates.json を読み、新着を通知する（公開のワークフローが呼ぶ。
 *                          中身は送り主から受け取らず、公開しているサイトのファイルを読む）
 * - GET  /admin/push       通知の購読の数・送った記録（運営者だけ）
 * - POST /admin/push/send  運営からのお知らせを通知で送る（運営者だけ）
 */
import { parseOrigins } from './core.ts';

/** Durable Object の名前空間（使うところだけ。Cloudflare の型と同じ形） */
export interface AnalyticsNamespace {
  idFromName(name: string): unknown;
  get(id: never, options?: { locationHint?: string }): { fetch(request: Request): Promise<Response> };
}

export interface FrontEnv {
  ANALYTICS: AnalyticsNamespace;
  /** サイトのほかに受け付けるオリジン（カンマ区切り。手元で試すときの http://localhost:4321 など） */
  ALLOWED_ORIGINS?: string;
  /** Pages の Functions で、公開しているサイトのファイルを読む（updates.json） */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Worker を直接使うときに updates.json を読むサイトの URL */
  SITE_URL?: string;
}

interface Route {
  method: 'GET' | 'POST';
  /** サイト（と許可したオリジン）のページからだけ受け付ける */
  site: boolean;
  /** 受け付ける内容の大きさ（POST） */
  maxBody?: number;
}

const ROUTES: Record<string, Route> = {
  '/collect': { method: 'POST', site: true },
  '/popular': { method: 'GET', site: false },
  '/admin/live': { method: 'GET', site: true },
  '/admin/stats': { method: 'GET', site: true },
  '/admin/articles': { method: 'GET', site: true },
  '/push/key': { method: 'GET', site: false },
  // フォローの設定（ジャンル・掲載元・キーワード）を含むので少し大きめ
  '/push/subscribe': { method: 'POST', site: true, maxBody: 16_384 },
  '/push/unsubscribe': { method: 'POST', site: true },
  '/push/status': { method: 'POST', site: true },
  '/push/test': { method: 'POST', site: true },
  // 公開のワークフロー（GitHub Actions）から呼ぶ。送り主の内容は使わないので、どこからでも受け付ける
  '/push/check': { method: 'POST', site: false },
  '/admin/push': { method: 'GET', site: true },
  '/admin/push/send': { method: 'POST', site: true },
};
const MAX_BODY = 4096;

/**
 * 公開しているサイトの updates.json（新着の通知の材料）。Pages の Functions では同じデプロイのファイルを、
 * Worker を直接使うときは SITE_URL のサイトから読む。読めなければ undefined
 */
async function updatesFile(env: FrontEnv, url: URL): Promise<string | undefined> {
  try {
    const response = env.ASSETS
      ? await env.ASSETS.fetch(new Request(new URL('/updates.json', url.origin)))
      : env.SITE_URL
        ? await fetch(`${env.SITE_URL.replace(/\/+$/, '')}/updates.json`, { headers: { 'Cache-Control': 'no-cache' } })
        : undefined;
    if (!response?.ok) return undefined;
    return await response.text();
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

/**
 * 送り元のオリジン。同じドメインのページからの GET には Origin が付かないので、
 * ブラウザが付ける Sec-Fetch-Site（ページのスクリプトからは変えられない）で見分ける
 */
export function originOf(request: Request, url: URL): string {
  const origin = request.headers.get('Origin');
  if (origin) return origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin' ? url.origin : '';
}

/**
 * リクエストを処理する。prefix は入口のパス（Pages Functions では /api）。
 * 計測と管理画面の API は、サイトと同じドメインのページか、ALLOWED_ORIGINS のオリジンからだけ受け付ける
 */
export async function handle(request: Request, env: FrontEnv, prefix = ''): Promise<Response> {
  const url = new URL(request.url);
  const path = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname;
  if (path === '/') {
    return new Response('トピあつめのアクセス解析です。\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const route = ROUTES[path];
  if (!route) return new Response('Not found', { status: 404 });
  const origin = originOf(request, url);
  const allowed = origin !== '' && (origin === url.origin || parseOrigins(env.ALLOWED_ORIGINS).includes(origin));
  const cors: Record<string, string> = allowed
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : route.site
      ? { Vary: 'Origin' }
      : { 'Access-Control-Allow-Origin': '*' };

  if (request.method === 'OPTIONS') {
    if (!allowed) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': route.method,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== route.method) return new Response('Method not allowed', { status: 405, headers: cors });
  if (route.site && !allowed) return new Response('Forbidden', { status: 403, headers: cors });

  let body: string | undefined;
  if (path === '/push/check') {
    body = await updatesFile(env, url);
    if (body === undefined) {
      return new Response(JSON.stringify({ error: 'updates.json を読めませんでした' }), {
        status: 503,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  } else if (request.method === 'POST') {
    body = await request.text();
    if (body.length > (route.maxBody ?? MAX_BODY)) return new Response('Payload too large', { status: 413, headers: cors });
  }
  // Durable Object へは、必要な情報だけを決まった名前で渡す（IP は訪問者番号を作るのに使うだけで保存しない）
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const headers = new Headers({
    'x-ua': request.headers.get('User-Agent') ?? '',
    'x-ip': request.headers.get('CF-Connecting-IP') ?? '',
    'x-country': typeof cf?.country === 'string' ? cf.country : '',
  });
  const authorization = request.headers.get('Authorization');
  if (authorization) headers.set('authorization', authorization);
  try {
    // 日本の利用者が多いので、Durable Object はアジア太平洋に置く（最初に作られるときだけ効く）
    const stub = env.ANALYTICS.get(env.ANALYTICS.idFromName('main') as never, { locationHint: 'apac' });
    const response = await stub.fetch(new Request(`https://analytics.internal${path}${url.search}`, { method: request.method, headers, body }));
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(cors)) out.headers.set(name, value);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
