/**
 * SNS への自動投稿。アカウントの認証情報（環境変数）が設定されているサービスにだけ投稿する。
 * - 毎日21時以降の最初の実行で「今日の話題ニュース」まとめを投稿
 * - はてブ数が一定以上の記事が出たら「いま話題」として投稿（1日の上限あり）
 */
import { createHmac, randomBytes } from 'node:crypto';
import { jstDateKey } from '../../src/lib/dates.ts';
import type { DailySnapshot, Item } from '../../src/lib/types.ts';

export const DIGEST_HOUR = 21;
export const HOT_THRESHOLD = 150;
export const HOT_WINDOW_HOURS = 12;
export const MAX_HOT_PER_DAY = 4;
const HOUR = 60 * 60 * 1000;
const URL_PATTERN = /https?:\/\/[^\s]+/g;

// ===== 文字数の数え方（サービスごとに異なる） =====

function weightedLength(text: string): number {
  let length = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const narrow =
      cp <= 0x10ff ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    length += narrow ? 1 : 2;
  }
  return length;
}

/** X の文字数（日本語などは2、URLは一律23として数える。上限280） */
export function xLength(text: string): number {
  let length = 0;
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    length += weightedLength(text.slice(last, match.index)) + 23;
    last = (match.index ?? 0) + match[0].length;
  }
  return length + weightedLength(text.slice(last));
}

const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** Bluesky の文字数（書記素単位。上限300） */
export function graphemeLength(text: string): number {
  return [...graphemes.segment(text)].length;
}

/** Mastodon の文字数（URLは一律23文字。上限500） */
export function mastodonLength(text: string): number {
  return Array.from(text.replace(URL_PATTERN, 'x'.repeat(23))).length;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

// ===== 投稿内容 =====

export interface SocialPost {
  /** 重複投稿を防ぐためのキー（digest:YYYY-MM-DD / hot:記事ID） */
  key: string;
  /** 文字数の判定関数を受け取り、上限に収まる本文を返す */
  compose: (fits: (text: string) => boolean) => string;
  /** リンクカード用 */
  link: { url: string; title: string; description: string };
}

export interface SocialState {
  lastDigest?: string;
  posted: { key: string; at: string }[];
}

export interface PlanContext {
  now: Date;
  items: Item[];
  snapshots: DailySnapshot[];
  /** ページの絶対URLを作る */
  pageUrl: (path: string) => string;
  siteName: string;
}

function jstHour(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' }).format(date));
}

export function digestPost(snapshot: DailySnapshot, { pageUrl, siteName }: PlanContext): SocialPost | undefined {
  const top = snapshot.items.filter((item) => (item.hatebu ?? 0) > 0);
  if (top.length < 3) return undefined;
  const [, month, day] = snapshot.date.split('-').map(Number);
  const header = `【${month}/${day}の話題ニュース】`;
  const url = pageUrl(`/daily/${snapshot.date}/`);
  return {
    key: `digest:${snapshot.date}`,
    compose: (fits) => {
      for (let count = Math.min(5, top.length); count >= 3; count--) {
        for (const max of [40, 32, 26, 20, 16, 12]) {
          const lines = top.slice(0, count).map((item, index) => `${index + 1}. ${truncate(item.title, max)}`);
          const text = [header, ...lines, '', `▶ ${url}`, '#ニュースまとめ'].join('\n');
          if (fits(text)) return text;
        }
      }
      return `${header}\n▶ ${url}`;
    },
    link: {
      url,
      title: `${month}月${day}日の話題のニュースまとめ｜${siteName}`,
      description: `1位「${truncate(top[0].title, 60)}」ほか、その日に話題になった記事をランキングで紹介します。`,
    },
  };
}

export function hotPost(item: Item, { pageUrl }: PlanContext): SocialPost {
  const rankingUrl = pageUrl('/ranking/');
  return {
    key: `hot:${item.id}`,
    compose: (fits) => {
      for (const max of [100, 70, 50, 40, 30, 20]) {
        const text = [`🔥 いま話題（${item.hatebu} users）`, truncate(item.title, max), item.url, '', `ほかの話題 ▶ ${rankingUrl}`].join(
          '\n',
        );
        if (fits(text)) return text;
      }
      return `🔥 ${truncate(item.title, 20)}\n${item.url}`;
    },
    link: { url: item.url, title: truncate(item.title, 100), description: truncate(item.excerpt, 150) },
  };
}

/** 今回の実行で投稿するものを決める */
export function planPosts(state: SocialState, context: PlanContext): SocialPost[] {
  const { now, items, snapshots } = context;
  const posts: SocialPost[] = [];
  const today = jstDateKey(now);

  if (jstHour(now) >= DIGEST_HOUR && state.lastDigest !== today) {
    const snapshot = snapshots.find((s) => s.date === today);
    const post = snapshot && digestPost(snapshot, context);
    if (post) posts.push(post);
  }

  const posted = new Set(state.posted.map((entry) => entry.key));
  const hotToday = state.posted.filter(
    (entry) => entry.key.startsWith('hot:') && now.getTime() - Date.parse(entry.at) < 24 * HOUR,
  ).length;
  if (hotToday < MAX_HOT_PER_DAY) {
    const cutoff = now.getTime() - HOT_WINDOW_HOURS * HOUR;
    const candidate = items
      .filter(
        (item) =>
          (item.hatebu ?? 0) >= HOT_THRESHOLD &&
          Date.parse(item.publishedAt) >= cutoff &&
          !posted.has(`hot:${item.id}`),
      )
      .sort((a, b) => (b.hatebu ?? 0) - (a.hatebu ?? 0))[0];
    if (candidate) posts.push(hotPost(candidate, context));
  }
  return posts;
}

/** 投稿済みとして記録する（古い記録は捨てる） */
export function recordPost(state: SocialState, post: SocialPost, now: Date): SocialState {
  return {
    lastDigest: post.key.startsWith('digest:') ? post.key.slice('digest:'.length) : state.lastDigest,
    posted: [...state.posted, { key: post.key, at: now.toISOString() }].slice(-300),
  };
}

// ===== 各サービスへの投稿 =====

export interface Platform {
  name: string;
  fits: (text: string) => boolean;
  send: (text: string, post: SocialPost) => Promise<void>;
}

async function request(url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : undefined;
}

// --- X（OAuth 1.0a） ---

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** OAuth 1.0a 用のパーセントエンコード（RFC 3986） */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const normalized = Object.entries(params)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const base = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(normalized)}`;
  return createHmac('sha1', `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`)
    .update(base)
    .digest('base64');
}

export function oauthHeader(
  method: string,
  url: string,
  credentials: XCredentials,
  { nonce = randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000)) } = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = oauthSignature(method, url, oauth, credentials.apiSecret, credentials.accessSecret);
  return `OAuth ${Object.entries(oauth)
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ')}`;
}

function xPlatform(credentials: XCredentials): Platform {
  const url = 'https://api.x.com/2/tweets';
  return {
    name: 'X',
    fits: (text) => xLength(text) <= 280,
    send: async (text) => {
      await request(
        url,
        {
          method: 'POST',
          headers: { Authorization: oauthHeader('POST', url, credentials), 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
        'X',
      );
    },
  };
}

// --- Bluesky ---

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Record<string, string>[];
}

/** URL とハッシュタグを Bluesky のリンク・タグにする（位置は UTF-8 のバイト単位） */
export function richTextFacets(text: string): Facet[] {
  const encoder = new TextEncoder();
  const byteAt = (index: number) => encoder.encode(text.slice(0, index)).length;
  const facets: Facet[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = byteAt(match.index ?? 0);
    facets.push({
      index: { byteStart: start, byteEnd: start + encoder.encode(match[0]).length },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }],
    });
  }
  for (const match of text.matchAll(/(^|\s)#([^\s#]+)/g)) {
    const start = byteAt((match.index ?? 0) + match[1].length);
    facets.push({
      index: { byteStart: start, byteEnd: start + encoder.encode(`#${match[2]}`).length },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: match[2] }],
    });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

function blueskyPlatform(identifier: string, password: string, service: string): Platform {
  const base = service.replace(/\/+$/, '');
  return {
    name: 'Bluesky',
    fits: (text) => graphemeLength(text) <= 300,
    send: async (text, post) => {
      const session = (await request(
        `${base}/xrpc/com.atproto.server.createSession`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) },
        'Bluesky',
      )) as { accessJwt: string; did: string };
      const record = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        langs: ['ja'],
        facets: richTextFacets(text),
        embed: {
          $type: 'app.bsky.embed.external',
          external: { uri: post.link.url, title: post.link.title, description: post.link.description },
        },
      };
      await request(
        `${base}/xrpc/com.atproto.repo.createRecord`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessJwt}` },
          body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
        },
        'Bluesky',
      );
    },
  };
}

// --- Mastodon / Misskey ---

function mastodonPlatform(instance: string, token: string): Platform {
  const base = instance.replace(/\/+$/, '');
  return {
    name: 'Mastodon',
    fits: (text) => mastodonLength(text) <= 500,
    send: async (text, post) => {
      await request(
        `${base}/api/v1/statuses`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': post.key,
          },
          body: JSON.stringify({ status: text, visibility: 'public', language: 'ja' }),
        },
        'Mastodon',
      );
    },
  };
}

function misskeyPlatform(instance: string, token: string): Platform {
  const base = instance.replace(/\/+$/, '');
  return {
    name: 'Misskey',
    fits: (text) => Array.from(text).length <= 3000,
    send: async (text) => {
      await request(
        `${base}/api/notes/create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ i: token, text, visibility: 'public' }),
        },
        'Misskey',
      );
    },
  };
}

/** 認証情報がそろっているサービスだけを返す */
export function configuredPlatforms(env: Record<string, string | undefined>): Platform[] {
  const platforms: Platform[] = [];
  if (env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_TOKEN_SECRET) {
    platforms.push(
      xPlatform({
        apiKey: env.X_API_KEY,
        apiSecret: env.X_API_SECRET,
        accessToken: env.X_ACCESS_TOKEN,
        accessSecret: env.X_ACCESS_TOKEN_SECRET,
      }),
    );
  }
  if (env.BLUESKY_IDENTIFIER && env.BLUESKY_APP_PASSWORD) {
    platforms.push(
      blueskyPlatform(env.BLUESKY_IDENTIFIER, env.BLUESKY_APP_PASSWORD, env.BLUESKY_SERVICE || 'https://bsky.social'),
    );
  }
  if (env.MASTODON_URL && env.MASTODON_TOKEN) platforms.push(mastodonPlatform(env.MASTODON_URL, env.MASTODON_TOKEN));
  if (env.MISSKEY_URL && env.MISSKEY_TOKEN) platforms.push(misskeyPlatform(env.MISSKEY_URL, env.MISSKEY_TOKEN));
  return platforms;
}

/** 投稿せずに本文だけ確認するための、各サービスの文字数ルール */
export const previewPlatforms: Pick<Platform, 'name' | 'fits'>[] = [
  { name: 'X', fits: (text) => xLength(text) <= 280 },
  { name: 'Bluesky', fits: (text) => graphemeLength(text) <= 300 },
  { name: 'Mastodon', fits: (text) => mastodonLength(text) <= 500 },
  { name: 'Misskey', fits: (text) => Array.from(text).length <= 3000 },
];
