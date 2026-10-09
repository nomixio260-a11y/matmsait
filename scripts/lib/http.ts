import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';

const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Chrome 132 安定版のリリース日。以降ほぼ4週間ごとにメジャーバージョンが上がる */
const CHROME_132_RELEASE = Date.UTC(2025, 0, 14);

/**
 * 現時点の Chrome 安定版から1つ前のメジャーバージョン。
 * 日付から算出するので放置しても古い UA にならず、まだ出ていない版を名乗ることもない。
 */
export function chromeMajorVersion(now: Date = new Date()): number {
  const elapsed = Math.max(0, now.getTime() - CHROME_132_RELEASE);
  return 132 + Math.floor(elapsed / (28 * DAY)) - 1;
}

const zstdDecompressSync = (zlib as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync;

export const ACCEPT_ENCODING = zstdDecompressSync ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';

/**
 * - document: アドレスバーから RSS を開いたときのリクエスト
 * - fetch: ページ内のスクリプトから API を呼んだときのリクエスト
 */
export type RequestKind = 'document' | 'fetch';

/** Windows 版 Chrome が送るのと同じヘッダーを同じ順序で返す（Host は送信時に先頭へ付ける） */
export function browserHeaders(kind: RequestKind, now: Date = new Date(), referer?: string): [string, string][] {
  const version = chromeMajorVersion(now);
  const brands = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not/A)Brand";v="24"`;
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
  const language = 'ja,en-US;q=0.9,en;q=0.8';

  if (kind === 'document') {
    return [
      ['Connection', 'keep-alive'],
      ['sec-ch-ua', brands],
      ['sec-ch-ua-mobile', '?0'],
      ['sec-ch-ua-platform', '"Windows"'],
      ['Upgrade-Insecure-Requests', '1'],
      ['User-Agent', userAgent],
      [
        'Accept',
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      ],
      // ページの中のリンクから移るとき（記事の続きのページなど）は、ブラウザと同じく移る前のページを Referer で送る
      ['Sec-Fetch-Site', referer ? 'same-origin' : 'none'],
      ['Sec-Fetch-Mode', 'navigate'],
      ['Sec-Fetch-User', '?1'],
      ['Sec-Fetch-Dest', 'document'],
      ...(referer ? ([['Referer', referer]] as [string, string][]) : []),
      ['Accept-Encoding', ACCEPT_ENCODING],
      ['Accept-Language', language],
    ];
  }
  return [
    ['Connection', 'keep-alive'],
    ['sec-ch-ua-platform', '"Windows"'],
    ['User-Agent', userAgent],
    ['sec-ch-ua', brands],
    ['sec-ch-ua-mobile', '?0'],
    ['Accept', '*/*'],
    ['Sec-Fetch-Site', 'cross-site'],
    ['Sec-Fetch-Mode', 'cors'],
    ['Sec-Fetch-Dest', 'empty'],
    ['Accept-Encoding', ACCEPT_ENCODING],
    ['Accept-Language', language],
  ];
}

export interface HttpResponse {
  /** リダイレクト後の最終URL */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  /** 展開済みの本文 */
  body: Buffer;
}

export interface HttpGetOptions {
  kind?: RequestKind;
  timeoutMs?: number;
  maxRedirects?: number;
  /** ブラウザの既定のヘッダーの後ろに足すヘッダー（条件付きリクエストの If-None-Match など） */
  headers?: [string, string][];
  /** ページの中のリンクから移るときの、移る前のページ（Referer） */
  referer?: string;
  /**
   * Cookie を覚えて送り返す（ブラウザと同じく。初めて開くと Cookie を付けて同じページへ転送するサイトや、
   * 記事の続きのページで同じ Cookie が要るサイトのため）。同じ記事の取得の間だけ使い、保存はしない
   */
  cookies?: CookieJar;
  /**
   * 転送（リダイレクト）の先へ進むか。進まなければ、転送の応答をそのまま返す
   * （記事の本文の取得で、転送先のページが robots.txt で断られていないかを確かめてから進むため）
   */
  followRedirect?: (to: URL) => boolean | Promise<boolean>;
}

/** Cookie の入れ物（ホスト名 → 名前 → 値） */
export type CookieJar = Map<string, Map<string, string>>;

/** そのホストに送る Cookie（Domain で指定されたものは、そのドメインの下のホストにも送る） */
export function cookieHeader(jar: CookieJar, hostname: string): string {
  const pairs = new Map<string, string>();
  for (const [domain, cookies] of jar) {
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) continue;
    for (const [name, value] of cookies) pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** 応答の Set-Cookie を覚える（期限切れ・Max-Age=0 は消す。属性は Domain だけを見る） */
export function storeCookies(jar: CookieJar, hostname: string, setCookie: string[] | string | undefined): void {
  for (const line of [setCookie ?? []].flat()) {
    const [pair, ...attributes] = line.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    let domain = hostname;
    let expired = false;
    let foreign = false;
    for (const attribute of attributes) {
      const [key, raw = ''] = attribute.split('=');
      const attr = key.trim().toLowerCase();
      const val = raw.trim();
      if (attr === 'domain' && val) {
        const candidate = val.replace(/^\./, '').toLowerCase();
        // ほかのサイトのドメインの Cookie は受け取らない（ブラウザと同じ）
        if (hostname === candidate || hostname.endsWith(`.${candidate}`)) domain = candidate;
        else foreign = true;
      } else if (attr === 'max-age' && Number(val) <= 0) {
        expired = true;
      } else if (attr === 'expires' && Date.parse(val) < Date.now()) {
        expired = true;
      }
    }
    if (foreign) continue;
    const cookies = jar.get(domain) ?? new Map<string, string>();
    if (expired) cookies.delete(name);
    else cookies.set(name, value);
    jar.set(domain, cookies);
  }
}

// Node の fetch は Sec-Fetch-Mode を cors に固定し独自の既定ヘッダーも足すため、
// ブラウザと同じヘッダーを送れるよう node:http(s) で直接リクエストする。
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 4 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 4 }),
};

/** リダイレクトを辿って GET し、圧縮を展開した本文を返す */
export async function httpGet(url: string, options: HttpGetOptions = {}): Promise<HttpResponse> {
  const { kind = 'document', timeoutMs = 15_000, maxRedirects = 5, headers = [], referer, cookies, followRedirect } = options;
  let current = new URL(url);
  for (let redirects = 0; ; redirects++) {
    const cookie = cookies ? cookieHeader(cookies, current.hostname) : '';
    const res = await requestOnce(
      current,
      [...browserHeaders(kind, new Date(), referer), ...headers, ...(cookie ? ([['Cookie', cookie]] as [string, string][]) : [])],
      timeoutMs,
    );
    if (cookies) storeCookies(cookies, current.hostname, res.headers['set-cookie']);
    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(res.status) || !location) {
      return { url: current.toString(), ...res };
    }
    if (redirects >= maxRedirects) throw new Error('リダイレクトが多すぎます');
    const next = new URL(location, current);
    if (followRedirect && !(await followRedirect(next))) return { url: current.toString(), ...res };
    current = next;
  }
}

/** keep-alive で保持している接続を閉じる */
export function closeConnections(): void {
  agents['http:'].destroy();
  agents['https:'].destroy();
}

async function requestOnce(
  url: URL,
  headers: [string, string][],
  timeoutMs: number,
): Promise<Omit<HttpResponse, 'url'>> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`未対応のプロトコル: ${url.protocol}`);
  }
  const isHttps = url.protocol === 'https:';
  const port = Number(url.port) || (isHttps ? 443 : 80);
  const proxy = isHttps ? proxyFor(url) : null;
  const socket = proxy ? await openTunnel(proxy, url.hostname, port, timeoutMs) : undefined;

  return new Promise((resolve, reject) => {
    const request = (isHttps ? https : http).request(
      {
        hostname: url.hostname,
        port,
        path: url.pathname + url.search,
        method: 'GET',
        // 配列で渡すと Node は Host などを自動で足さないので、ブラウザと同じく先頭に置く
        headers: [['Host', url.host], ...headers].flat(),
        ...(socket ? { createConnection: () => socket } : { agent: agents[url.protocol as 'http:' | 'https:'] }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) request.destroy(new Error('レスポンスが大きすぎます'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          clearTimeout(timer);
          // プロキシ経由の接続はプールしないので、使い終わったら閉じる
          socket?.destroy();
          try {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: decompress(Buffer.concat(chunks), response.headers['content-encoding']),
            });
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      },
    );
    const timer = setTimeout(() => request.destroy(new Error(`タイムアウト（${timeoutMs / 1000}秒）`)), timeoutMs);
    request.on('error', (error) => {
      clearTimeout(timer);
      socket?.destroy();
      reject(error);
    });
    request.end();
  });
}

export function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return body;
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(body);
    case 'deflate':
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    case 'br':
      return zlib.brotliDecompressSync(body);
    case 'zstd':
      if (zstdDecompressSync) return zstdDecompressSync(body);
    // falls through
    default:
      throw new Error(`未対応の圧縮形式: ${encoding}`);
  }
}

/** HTTPS_PROXY が設定されていれば（NO_PROXY 対象外のとき）そのURLを返す。CI では通常使われない */
function proxyFor(url: URL): URL | null {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim().replace(/^\*?\./, ''))
    .filter(Boolean);
  const host = url.hostname;
  if (noProxy.some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`))) return null;
  return new URL(raw);
}

function openTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const target = `${host}:${port}`;
    const headers: Record<string, string> = { Host: target };
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    const request = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: target,
      headers,
    });
    const timer = setTimeout(() => request.destroy(new Error('プロキシ接続がタイムアウトしました')), timeoutMs);
    request.once('connect', (response, socket) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`プロキシ接続に失敗しました（HTTP ${response.statusCode}）`));
        return;
      }
      resolve(tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] }));
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

const CHARSET_ALIASES: Record<string, string> = {
  sjis: 'shift_jis',
  'x-sjis': 'shift_jis',
  'shift-jis': 'shift_jis',
  'windows-31j': 'shift_jis',
  cp932: 'shift_jis',
  ms932: 'shift_jis',
  eucjp: 'euc-jp',
  'x-euc-jp': 'euc-jp',
};

/**
 * Content-Type の charset → XML 宣言の encoding → HTML の meta（charset・http-equiv）→ UTF-8 の順で文字コードを決めて文字列にする
 * （Shift_JIS・EUC-JP のページで、HTTP のヘッダーに charset がなく meta にだけ書いてあるサイトがある）
 */
export function decodeBody(body: Buffer, contentType: string | undefined): string {
  const fromHeader = contentType?.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  const head = body.subarray(0, 512).toString('latin1');
  const fromXml = head.match(/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i)?.[1];
  const fromMeta = fromHeader || fromXml ? undefined : body.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  const label = (fromHeader || fromXml || fromMeta || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(CHARSET_ALIASES[label] ?? label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
