/**
 * SNS への自動投稿。アカウントの認証情報（環境変数）が設定されているサービスにだけ投稿する。
 * - 朝（7〜10時）: 今日の重要ニュース（ジャンルごとのトップ）
 * - 昼（12〜14時）: AI ニュースのまとめ
 * - 夜（21時以降）: 今日の話題ニュースのまとめ（日別まとめ）
 * - 急上昇: 直近3時間に新しく報じるメディアが増えた話題（1日の上限あり）
 * - いま話題: 多くのメディアが報じた話題（1日の上限あり）
 * スパムにならないよう、深夜は投稿しない・投稿の間隔をあける・1日の投稿数に上限を設ける。
 * 投稿のリンクはこのサイトの話題のページ（各メディアの報道の比較）にする
 */
import { createHmac, randomBytes } from 'node:crypto';
import { jstDateKey } from '../../src/lib/dates.ts';
import type { DailySnapshot } from '../../src/lib/types.ts';

/** 投稿の上限と時間帯（日本時間） */
export const SOCIAL_LIMITS = {
  /** この時刻より前（0時〜）は投稿しない */
  quietUntilHour: 7,
  /** 24時間に投稿する数の上限（すべての種類の合計） */
  maxPerDay: 8,
  /** 急上昇・いま話題の投稿の間隔（分） */
  minGapMinutes: 90,
  maxRisingPerDay: 3,
  maxHotPerDay: 3,
  /** 急上昇として投稿する条件: 直近3時間に新しく報じたメディアの数・報じたメディアの数 */
  risingMinGained: 2,
  risingMinCoverage: 3,
  /** いま話題として投稿する条件 */
  hotMinCoverage: 4,
  hotMinScore: 50,
  /** まとめの投稿の時間帯（時） */
  morning: [7, 11],
  ai: [12, 15],
  digestHour: 21,
} as const;

export const DIGEST_HOUR = SOCIAL_LIMITS.digestHour;
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
  /** 重複投稿を防ぐためのキー（digest:YYYY-MM-DD / morning:YYYY-MM-DD / ai:YYYY-MM-DD / rising:話題ID / hot:話題ID） */
  key: string;
  /** 文字数の判定関数を受け取り、上限に収まる本文を返す */
  compose: (fits: (text: string) => boolean) => string;
  /** リンクカード用 */
  link: { url: string; title: string; description: string };
}

export interface SocialState {
  lastDigest?: string;
  /** 投稿の記録（platforms は投稿できたサービス。以前の記録にはない） */
  posted: { key: string; at: string; platforms?: string[] }[];
}

/** 投稿に使う話題（src/lib/topics.ts の数字から必要なものだけ） */
export interface SocialTopic {
  /** 話題の ID（話題のページ /topic/<ID>/） */
  id: string;
  title: string;
  /** 報じたメディアの数 */
  coverage: number;
  /** 話題度スコア（0〜100） */
  score: number;
  /** 直近3時間に新しく報じたメディアの数 */
  gained: number;
  /** 最後に報じられた日時（ISO 8601） */
  latestAt: string;
}

export interface PlanContext {
  now: Date;
  snapshots: DailySnapshot[];
  /** いま話題（話題度スコアの順） */
  hot: SocialTopic[];
  /** 急上昇（直近3時間に新しく報じたメディアの多い順） */
  rising: SocialTopic[];
  /** 今日の重要ニュース（ジャンルごとに1件） */
  important: SocialTopic[];
  /** AI の話題（話題度スコアの順） */
  ai: SocialTopic[];
  /** ページの絶対URLを作る */
  pageUrl: (path: string) => string;
  siteName: string;
}

export function jstHour(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' }).format(date));
}

function monthDay(date: string): { month: number; day: number } {
  const [, month, day] = date.split('-').map(Number);
  return { month, day };
}

/** 見出しを番号つきで並べたまとめの投稿（文字数に収まるまで件数と見出しの長さを減らす） */
function listPost(
  key: string,
  header: string,
  titles: string[],
  url: string,
  hashtags: string,
  link: SocialPost['link'],
): SocialPost {
  return {
    key,
    compose: (fits) => {
      for (let count = Math.min(5, titles.length); count >= Math.min(3, titles.length); count--) {
        for (const max of [40, 32, 26, 20, 16, 12]) {
          const lines = titles.slice(0, count).map((title, index) => `${index + 1}. ${truncate(title, max)}`);
          const text = [header, ...lines, '', `▶ ${url}`, ...(hashtags ? [hashtags] : [])].join('\n');
          if (fits(text)) return text;
        }
      }
      return `${header}\n▶ ${url}`;
    },
    link,
  };
}

export function digestPost(snapshot: DailySnapshot, { pageUrl, siteName }: PlanContext): SocialPost | undefined {
  const top = snapshot.items;
  if (top.length < 3) return undefined;
  const { month, day } = monthDay(snapshot.date);
  const url = pageUrl(`/daily/${snapshot.date}/`);
  return listPost(
    `digest:${snapshot.date}`,
    `【${month}/${day}の話題ニュース】`,
    top.map((item) => item.title),
    url,
    '#ニュースまとめ',
    {
      url,
      title: `${month}月${day}日の話題のニュースまとめ｜${siteName}`,
      description: `「${truncate(top[0].title, 60)}」ほか、その日に多くのメディアが報じた話題の記事を紹介します。`,
    },
  );
}

export function morningPost(topics: SocialTopic[], date: string, { pageUrl, siteName }: PlanContext): SocialPost | undefined {
  if (topics.length < 3) return undefined;
  const { month, day } = monthDay(date);
  const url = pageUrl('/ranking/#today');
  return listPost(
    `morning:${date}`,
    `【${month}/${day} 今日の重要ニュース】`,
    topics.map((topic) => `${topic.title}（${topic.coverage}社）`),
    url,
    '#ニュース',
    {
      url,
      title: `今日の重要ニュース｜${siteName}`,
      description: `「${truncate(topics[0].title, 60)}」ほか、多くのメディアが報じたニュースをジャンルごとに紹介します。`,
    },
  );
}

export function aiPost(topics: SocialTopic[], date: string, { pageUrl, siteName }: PlanContext): SocialPost | undefined {
  if (topics.length < 2) return undefined;
  const { month, day } = monthDay(date);
  const url = pageUrl('/tag/ai/');
  return listPost(
    `ai:${date}`,
    `【${month}/${day} AIニュース】`,
    topics.map((topic) => topic.title),
    url,
    '#AI #生成AI',
    {
      url,
      title: `AIニュースランキング｜${siteName}`,
      description: `「${truncate(topics[0].title, 60)}」ほか、多くのメディアが報じたAIのニュースを紹介します。`,
    },
  );
}

/** 1つの話題の投稿（急上昇・いま話題）。リンクは話題のページ（各メディアの報道の比較） */
function topicPost(kind: 'rising' | 'hot', topic: SocialTopic, { pageUrl, siteName }: PlanContext): SocialPost {
  const url = pageUrl(`/topic/${topic.id}/`);
  const header =
    kind === 'rising' ? `🚀 急上昇（3時間で+${topic.gained}社・計${topic.coverage}社が報道）` : `🔥 いま話題（${topic.coverage}社が報道・話題度${topic.score}）`;
  return {
    key: `${kind}:${topic.id}`,
    compose: (fits) => {
      for (const max of [100, 70, 50, 40, 30, 20]) {
        const text = [header, truncate(topic.title, max), `各メディアの報道を比べる ▶ ${url}`].join('\n');
        if (fits(text)) return text;
      }
      return `${header}\n▶ ${url}`;
    },
    link: {
      url,
      title: truncate(`${topic.title}｜${topic.coverage}社の報道まとめ`, 100),
      description: `${topic.coverage}のメディアが報じたニュースを、報じた順に比べられます（${siteName}）。`,
    },
  };
}

export function hotPost(topic: SocialTopic, context: PlanContext): SocialPost {
  return topicPost('hot', topic, context);
}

export function risingPost(topic: SocialTopic, context: PlanContext): SocialPost {
  return topicPost('rising', topic, context);
}

/** 今回の実行で投稿するものを決める（上限と時間帯を守る） */
export function planPosts(state: SocialState, context: PlanContext): SocialPost[] {
  const { now, snapshots } = context;
  const hour = jstHour(now);
  if (hour < SOCIAL_LIMITS.quietUntilHour) return [];
  const today = jstDateKey(now);
  const recent = state.posted.filter((entry) => now.getTime() - Date.parse(entry.at) < 24 * HOUR);
  const room = SOCIAL_LIMITS.maxPerDay - recent.length;
  if (room <= 0) return [];
  const posted = new Set(state.posted.map((entry) => entry.key));
  const posts: SocialPost[] = [];

  // 1日1回のまとめ（時間帯ごと）
  if (hour >= SOCIAL_LIMITS.digestHour && state.lastDigest !== today) {
    const snapshot = snapshots.find((s) => s.date === today);
    const post = snapshot && digestPost(snapshot, context);
    if (post) posts.push(post);
  }
  if (hour >= SOCIAL_LIMITS.morning[0] && hour < SOCIAL_LIMITS.morning[1] && !posted.has(`morning:${today}`)) {
    const post = morningPost(context.important.slice(0, 5), today, context);
    if (post) posts.push(post);
  }
  if (hour >= SOCIAL_LIMITS.ai[0] && hour < SOCIAL_LIMITS.ai[1] && !posted.has(`ai:${today}`)) {
    const post = aiPost(context.ai.slice(0, 5), today, context);
    if (post) posts.push(post);
  }

  // 急上昇・いま話題（前の投稿から間をあけ、1回の実行で1件まで。同じ話題は二度投稿しない）
  const eventPosts = recent.filter((entry) => /^(rising|hot):/.test(entry.key));
  const lastEvent = Math.max(0, ...eventPosts.map((entry) => Date.parse(entry.at)));
  const seenTopic = (id: string) => posted.has(`rising:${id}`) || posted.has(`hot:${id}`);
  if (now.getTime() - lastEvent >= SOCIAL_LIMITS.minGapMinutes * 60 * 1000) {
    const risingToday = eventPosts.filter((entry) => entry.key.startsWith('rising:')).length;
    const hotToday = eventPosts.filter((entry) => entry.key.startsWith('hot:')).length;
    const rising = context.rising.find(
      (topic) => topic.gained >= SOCIAL_LIMITS.risingMinGained && topic.coverage >= SOCIAL_LIMITS.risingMinCoverage && !seenTopic(topic.id),
    );
    const hotCutoff = now.getTime() - 12 * HOUR;
    const hot = context.hot.find(
      (topic) =>
        topic.coverage >= SOCIAL_LIMITS.hotMinCoverage &&
        topic.score >= SOCIAL_LIMITS.hotMinScore &&
        Date.parse(topic.latestAt) >= hotCutoff &&
        !seenTopic(topic.id),
    );
    if (rising && risingToday < SOCIAL_LIMITS.maxRisingPerDay) posts.push(risingPost(rising, context));
    else if (hot && hotToday < SOCIAL_LIMITS.maxHotPerDay) posts.push(hotPost(hot, context));
  }
  return posts.slice(0, room);
}

/** 投稿済みとして記録する（古い記録は捨てる） */
export function recordPost(state: SocialState, post: SocialPost, now: Date, platforms: string[] = []): SocialState {
  return {
    lastDigest: post.key.startsWith('digest:') ? post.key.slice('digest:'.length) : state.lastDigest,
    posted: [...state.posted, { key: post.key, at: now.toISOString(), ...(platforms.length > 0 ? { platforms } : {}) }].slice(-500),
  };
}

// ===== サービスごとの上限 =====

export interface PlatformLimit {
  /** 24時間の上限 */
  daily: number;
  /** 30日の上限 */
  monthly: number;
  /** 投稿する種類（digest・morning・ai・rising・hot）。undefined はすべて */
  types?: string[];
}

/**
 * サービスごとの投稿の上限。X の API は投稿ごとに料金がかかる（2026年時点で URL つきの投稿は1件 0.2 ドル）ため、
 * 既定では夜のまとめだけを1日1件にする。変えるときはリポジトリの Variables（X_DAILY_LIMIT・X_MONTHLY_LIMIT・X_POST_TYPES）で
 */
export function platformLimit(name: string, env: Record<string, string | undefined>): PlatformLimit {
  if (name === 'X') {
    const number = (value: string | undefined, fallback: number) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const types = (env.X_POST_TYPES ?? 'digest')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean);
    return { daily: number(env.X_DAILY_LIMIT, 1), monthly: number(env.X_MONTHLY_LIMIT, 31), types: types.includes('all') ? undefined : types };
  }
  return { daily: SOCIAL_LIMITS.maxPerDay, monthly: 300 };
}

/** このサービスにこの投稿をしてよいか（種類と、24時間・30日の上限） */
export function platformAllows(name: string, post: SocialPost, state: SocialState, now: Date, limit: PlatformLimit): boolean {
  const type = post.key.split(':')[0];
  if (limit.types && !limit.types.includes(type)) return false;
  const mine = state.posted.filter((entry) => entry.platforms?.includes(name));
  const within = (ms: number) => mine.filter((entry) => now.getTime() - Date.parse(entry.at) < ms).length;
  return within(24 * HOUR) < limit.daily && within(30 * 24 * HOUR) < limit.monthly;
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
