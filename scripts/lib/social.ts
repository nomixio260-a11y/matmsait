/**
 * SNS への自動投稿。主に Bluesky（無料の API）。Mastodon・Misskey も認証情報があれば同じ内容を投稿する。
 * X は API が有料（2026年2月から無料枠がなく、URL つきの投稿は1件 0.2 ドル）なので使わない。
 *
 * 投稿の種類（日本時間）:
 * - 朝（7〜10時台）: 今日の重要ニュース
 * - 昼（12〜14時台）: AI ニュース
 * - 日曜の夕方（18〜20時台）: 今週の話題ランキング
 * - 夜（21時以降）: 今日の話題ニュース（日別まとめ）
 * - 急上昇・いま話題・10秒でわかるニュース（AI 要約）: 前の投稿から1時間あけて1件ずつ（種類ごとに1日の上限あり）
 * - 管理画面の「今すぐ投稿」: 時間帯・間隔を待たずに、いちばん新しい話題を1件（なければ「いま話題のニュース」のまとめ）
 *
 * スパムにならないよう、深夜は投稿しない・1日の投稿数に上限を設ける・同じ話題は二度投稿しない。
 * フォロー・いいね・返信の自動化はしない（相手の迷惑になり、アカウントの停止にもつながるため）。
 * リンクはこのサイトのページにし、どの投稿から来たかがアクセス解析で分かるよう utm_source などを付ける
 */
import { jstDateKey } from '../../src/lib/dates.ts';
import type { DailySnapshot } from '../../src/lib/types.ts';

/** 投稿の上限と時間帯（日本時間） */
export const SOCIAL_LIMITS = {
  /** この時刻より前（0時〜）は投稿しない */
  quietUntilHour: 7,
  /** 24時間に投稿する数の上限（すべての種類の合計） */
  maxPerDay: 12,
  /** 急上昇・いま話題・10秒でわかるニュースの投稿の間隔（分） */
  minGapMinutes: 60,
  maxRisingPerDay: 4,
  maxHotPerDay: 4,
  maxSummaryPerDay: 3,
  /** 急上昇として投稿する条件: 直近3時間に新しく報じたメディアの数・報じたメディアの数 */
  risingMinGained: 2,
  risingMinCoverage: 3,
  /** いま話題として投稿する条件 */
  hotMinCoverage: 4,
  hotMinScore: 50,
  /** まとめの投稿の時間帯（時。始まりを含み、終わりを含まない） */
  morning: [7, 11],
  ai: [12, 15],
  /** 日曜日の、今週のまとめ */
  weekly: [18, 21],
  digestHour: 21,
  /** 管理画面の「今すぐ投稿」も含めた24時間の上限（誤って何度も押したときの歯止め） */
  manualMaxPerDay: 24,
  /** 「今すぐ投稿」の依頼がこれより古ければ投稿しない（分。更新の失敗などで処理が遅れたときに、思わぬ時間に投稿しないように） */
  requestExpiresMinutes: 30,
} as const;

export const DIGEST_HOUR = SOCIAL_LIMITS.digestHour;
const HOUR = 60 * 60 * 1000;
const URL_PATTERN = /https?:\/\/[^\s]+/g;

// ===== 文字数の数え方（サービスごとに異なる） =====

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

/** ハッシュタグの文字列（記号や空白は除く） */
function hashtagLine(tags: readonly string[]): string {
  const clean = [...new Set(tags.map((tag) => tag.normalize('NFKC').replace(/[\s#・.,、。!?！？()（）「」/]/g, '')).filter(Boolean))];
  return clean.map((tag) => `#${tag}`).join(' ');
}

// ===== 投稿内容 =====

export type PostKind = 'digest' | 'morning' | 'ai' | 'weekly' | 'rising' | 'hot' | 'summary' | 'now';

export interface SocialPost {
  /** 重複投稿を防ぐためのキー（digest:YYYY-MM-DD / morning:… / ai:… / weekly:… / rising:話題ID / hot:話題ID / summary:記事ID / now:YYYY-MM-DDTHH） */
  key: string;
  kind: PostKind;
  /** 文字数の判定関数を受け取り、上限に収まる本文を返す（本文にはリンクの URL がそのまま入る） */
  compose: (fits: (text: string) => boolean) => string;
  /** リンクカード用 */
  link: { url: string; title: string; description: string };
}

/** 投稿の記録 */
export interface PostedEntry {
  key: string;
  at: string;
  /** 投稿できたサービス（以前の記録にはない） */
  platforms?: string[];
  /** サービスごとの投稿の URL（例: { Bluesky: 'https://bsky.app/profile/…/post/…' }） */
  urls?: Record<string, string>;
}

/** 管理画面の「今すぐ投稿」の依頼（data/social-request.json。管理画面が書く） */
export interface SocialRequest {
  /** 依頼ごとに違う ID（結果の記録と照らし合わせる） */
  id: string;
  /** 依頼した日時（ISO 8601） */
  at: string;
}

/**
 * 「今すぐ投稿」の結果。posted: 投稿した / none: 投稿できる新しい話題がなかった / no-credentials: 認証情報がない /
 * failed: 投稿に失敗した / limit: 24時間の上限 / expired: 依頼から時間がたっていた
 */
export type ManualOutcome = 'posted' | 'none' | 'no-credentials' | 'failed' | 'limit' | 'expired';

export interface ManualResult {
  /** 依頼の ID */
  id: string;
  requestedAt: string;
  /** 処理した日時 */
  at: string;
  result: ManualOutcome;
  /** 投稿したもの */
  posts?: PostedEntry[];
  /** 失敗したときの説明 */
  error?: string;
}

export interface SocialState {
  lastDigest?: string;
  posted: PostedEntry[];
  /** 管理画面の「今すぐ投稿」の最後の結果（管理画面が読んで表示する） */
  manual?: ManualResult;
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
  /** ハッシュタグ（# なし。話題のタグから） */
  hashtags?: string[];
}

/** 10秒でわかるニュース（AI 要約）に使う要約 */
export interface SocialSummary {
  /** 記事の ID */
  id: string;
  title: string;
  /** 要約の1文目（10秒で読む） */
  lead: string;
  /** 開くページ（2社以上が報じた話題なら話題のページ、ほかは要約のページ） */
  path: string;
  /** 2社以上が報じた話題の ID（同じ話題を急上昇などで投稿していたら投稿しない） */
  topicId?: string;
  hashtags?: string[];
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
  /** 今週の話題（報じたメディアの多い順） */
  weekly: SocialTopic[];
  /** 新しい AI 要約（投稿したい順） */
  summaries: SocialSummary[];
  /** ページの絶対URLを作る */
  pageUrl: (path: string) => string;
  siteName: string;
}

const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' });
const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' });

export function jstHour(date: Date): number {
  return Number(hourFormat.format(date));
}

function monthDay(date: string): { month: number; day: number } {
  const [, month, day] = date.split('-').map(Number);
  return { month, day };
}

/** 見出しを番号つきで並べたまとめの投稿（文字数に収まるまで件数と見出しの長さを減らす） */
function listPost(
  key: string,
  kind: PostKind,
  header: string,
  titles: string[],
  url: string,
  hashtags: string,
  link: SocialPost['link'],
): SocialPost {
  return {
    key,
    kind,
    compose: (fits) => {
      for (let count = Math.min(5, titles.length); count >= Math.min(3, titles.length); count--) {
        for (const max of [44, 36, 30, 24, 18, 14]) {
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
    'digest',
    `【${month}/${day}の話題ニュース】`,
    top.map((item) => item.title),
    url,
    hashtagLine(['ニュースまとめ']),
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
    'morning',
    `【${month}/${day} 今日の重要ニュース】`,
    topics.map((topic) => `${topic.title}（${topic.coverage}社）`),
    url,
    hashtagLine(['ニュース']),
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
    'ai',
    `【${month}/${day} AIニュース】`,
    topics.map((topic) => topic.title),
    url,
    hashtagLine(['AI', '生成AI']),
    {
      url,
      title: `AIニュースランキング｜${siteName}`,
      description: `「${truncate(topics[0].title, 60)}」ほか、多くのメディアが報じたAIのニュースを紹介します。`,
    },
  );
}

export function weeklyPost(topics: SocialTopic[], date: string, { pageUrl, siteName }: PlanContext): SocialPost | undefined {
  if (topics.length < 3) return undefined;
  const url = pageUrl('/ranking/#week');
  return listPost(
    `weekly:${date}`,
    'weekly',
    '【今週の話題ニュース TOP5】',
    topics.map((topic) => `${topic.title}（${topic.coverage}社）`),
    url,
    hashtagLine(['ニュースまとめ', '週間ランキング']),
    {
      url,
      title: `今週の話題のニュースランキング｜${siteName}`,
      description: `「${truncate(topics[0].title, 60)}」ほか、この1週間に多くのメディアが報じたニュースのランキングです。`,
    },
  );
}

/** 1つの話題の投稿（急上昇・いま話題）。リンクは話題のページ（各メディアの報道の比較） */
function topicPost(kind: 'rising' | 'hot', topic: SocialTopic, { pageUrl, siteName }: PlanContext): SocialPost {
  const url = pageUrl(`/topic/${topic.id}/`);
  const header =
    kind === 'rising' ? `🚀 急上昇（3時間で+${topic.gained}社・計${topic.coverage}社が報道）` : `🔥 いま話題（${topic.coverage}社が報道・話題度${topic.score}）`;
  const tags = hashtagLine(['ニュース', ...(topic.hashtags ?? []).slice(0, 2)]);
  return {
    key: `${kind}:${topic.id}`,
    kind,
    compose: (fits) => {
      for (const max of [100, 70, 50, 40, 30, 20]) {
        const text = [header, truncate(topic.title, max), `各メディアの報道を比べる ▶ ${url}`, tags].join('\n');
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

/** いま話題のニュースのまとめ（管理画面の「今すぐ投稿」で、急上昇などの新しい話題がないとき。同じ時間帯には1回まで） */
export function nowPost(topics: SocialTopic[], now: Date, { pageUrl, siteName }: PlanContext): SocialPost | undefined {
  if (topics.length < 3) return undefined;
  const date = jstDateKey(now);
  const hour = jstHour(now);
  const { month, day } = monthDay(date);
  const url = pageUrl('/');
  return listPost(
    `now:${date}T${String(hour).padStart(2, '0')}`,
    'now',
    `【いま話題のニュース】${month}/${day} ${hour}時`,
    topics.map((topic) => `${topic.title}（${topic.coverage}社）`),
    url,
    hashtagLine(['ニュース']),
    {
      url,
      title: `いま話題のニュース｜${siteName}`,
      description: `「${truncate(topics[0].title, 60)}」ほか、いま多くのメディアが報じているニュースを話題度の順に紹介します。`,
    },
  );
}

export function hotPost(topic: SocialTopic, context: PlanContext): SocialPost {
  return topicPost('hot', topic, context);
}

export function risingPost(topic: SocialTopic, context: PlanContext): SocialPost {
  return topicPost('rising', topic, context);
}

/** 10秒でわかるニュース（AI 要約の1文目） */
export function summaryPost(summary: SocialSummary, { pageUrl, siteName }: PlanContext): SocialPost {
  const url = pageUrl(summary.path);
  const tags = hashtagLine(['ニュース', ...(summary.hashtags ?? []).slice(0, 2)]);
  return {
    key: `summary:${summary.id}`,
    kind: 'summary',
    compose: (fits) => {
      for (const [titleMax, leadMax] of [
        [80, 160],
        [60, 120],
        [44, 90],
        [30, 70],
        [24, 50],
      ]) {
        const text = ['⏱ 10秒でわかるニュース', truncate(summary.title, titleMax), '', truncate(summary.lead, leadMax), `▶ ${url}`, tags].join('\n');
        if (fits(text)) return text;
      }
      return `⏱ 10秒でわかるニュース\n${truncate(summary.title, 20)}\n▶ ${url}`;
    },
    link: {
      url,
      title: truncate(`${summary.title}【AI要約】`, 100),
      description: truncate(`${summary.lead}（${siteName}）`, 150),
    },
  };
}

/** 直近24時間の投稿 */
function recentPosts(state: SocialState, now: Date): PostedEntry[] {
  return state.posted.filter((entry) => now.getTime() - Date.parse(entry.at) < 24 * HOUR);
}

/** 24時間の上限に達しているか（manual: 管理画面の「今すぐ投稿」の上限で数える） */
export function reachedDailyLimit(state: SocialState, now: Date, manual = false): boolean {
  return recentPosts(state, now).length >= (manual ? SOCIAL_LIMITS.manualMaxPerDay : SOCIAL_LIMITS.maxPerDay);
}

export interface PlanOptions {
  /**
   * 管理画面の「今すぐ投稿」: 深夜・間隔・種類ごとの上限を待たずに、急上昇 → いま話題 → 10秒でわかるニュースの順で
   * まだ投稿していない話題を1件投稿する（なければ「いま話題のニュース」のまとめ）。同じ話題は二度投稿しない
   */
  manual?: boolean;
}

/** 今回の実行で投稿するものを決める（上限と時間帯を守る） */
export function planPosts(state: SocialState, context: PlanContext, { manual = false }: PlanOptions = {}): SocialPost[] {
  const { now, snapshots } = context;
  const hour = jstHour(now);
  if (!manual && hour < SOCIAL_LIMITS.quietUntilHour) return [];
  const today = jstDateKey(now);
  const recent = recentPosts(state, now);
  const room = (manual ? SOCIAL_LIMITS.manualMaxPerDay : SOCIAL_LIMITS.maxPerDay) - recent.length;
  if (room <= 0) return [];
  const posted = new Set(state.posted.map((entry) => entry.key));
  const posts: SocialPost[] = [];
  const within = ([from, to]: readonly [number, number]) => hour >= from && hour < to;

  // 1日1回のまとめ（時間帯ごと）
  if (hour >= SOCIAL_LIMITS.digestHour && state.lastDigest !== today) {
    const snapshot = snapshots.find((s) => s.date === today);
    const post = snapshot && digestPost(snapshot, context);
    if (post) posts.push(post);
  }
  if (within(SOCIAL_LIMITS.morning) && !posted.has(`morning:${today}`)) {
    const post = morningPost(context.important.slice(0, 5), today, context);
    if (post) posts.push(post);
  }
  if (within(SOCIAL_LIMITS.ai) && !posted.has(`ai:${today}`)) {
    const post = aiPost(context.ai.slice(0, 5), today, context);
    if (post) posts.push(post);
  }
  if (weekdayFormat.format(now) === 'Sun' && within(SOCIAL_LIMITS.weekly) && !posted.has(`weekly:${today}`)) {
    const post = weeklyPost(context.weekly.slice(0, 5), today, context);
    if (post) posts.push(post);
  }

  // 急上昇・いま話題・10秒でわかるニュース（前の投稿から間をあけ、1回の実行で1件まで。同じ話題は二度投稿しない）
  const eventPosts = recent.filter((entry) => /^(rising|hot|summary|now):/.test(entry.key));
  const lastEvent = Math.max(0, ...eventPosts.map((entry) => Date.parse(entry.at)));
  // 10秒でわかるニュースで投稿した話題（記録は要約の記事 ID なので、要約から話題をたどる）
  const summaryTopics = new Set(context.summaries.filter((entry) => posted.has(`summary:${entry.id}`)).map((entry) => entry.topicId));
  const seenTopic = (id: string | undefined) =>
    id !== undefined && (posted.has(`rising:${id}`) || posted.has(`hot:${id}`) || summaryTopics.has(id));
  if (manual || now.getTime() - lastEvent >= SOCIAL_LIMITS.minGapMinutes * 60 * 1000) {
    // 種類ごとの1日の上限（「今すぐ投稿」では数えない）
    const allows = (kind: PostKind, max: number) => manual || eventPosts.filter((entry) => entry.key.startsWith(`${kind}:`)).length < max;
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
    const summary = context.summaries.find((entry) => !posted.has(`summary:${entry.id}`) && !seenTopic(entry.topicId));
    if (rising && allows('rising', SOCIAL_LIMITS.maxRisingPerDay)) posts.push(risingPost(rising, context));
    else if (hot && allows('hot', SOCIAL_LIMITS.maxHotPerDay)) posts.push(hotPost(hot, context));
    else if (summary && allows('summary', SOCIAL_LIMITS.maxSummaryPerDay)) posts.push(summaryPost(summary, context));
    else if (manual) {
      // 新しい話題がなければ、いま話題のニュースのまとめ（同じ時間帯に投稿済みなら何もしない）
      const post = nowPost(context.hot.slice(0, 5), now, context);
      if (post && !posted.has(post.key)) posts.push(post);
    }
  }
  return posts.slice(0, room);
}

/** まだ処理していない「今すぐ投稿」の依頼（処理済み・依頼がなければ undefined）。古すぎる依頼は expired */
export function pendingRequest(
  state: SocialState,
  request: SocialRequest | undefined,
  now: Date,
): { request: SocialRequest; expired: boolean } | undefined {
  if (!request || typeof request.id !== 'string' || request.id === '' || request.id === state.manual?.id) return undefined;
  const age = now.getTime() - Date.parse(request.at);
  // 日時が読めない依頼も古いものとして扱う
  return { request, expired: !(age < SOCIAL_LIMITS.requestExpiresMinutes * 60 * 1000) };
}

/** 「今すぐ投稿」の結果を記録する（管理画面がこれを読んで表示する） */
export function recordManual(
  state: SocialState,
  request: SocialRequest,
  now: Date,
  result: Pick<ManualResult, 'result' | 'posts' | 'error'>,
): SocialState {
  return { ...state, manual: { id: request.id, requestedAt: request.at, at: now.toISOString(), ...result } };
}

/** 投稿済みとして記録する（古い記録は捨てる） */
export function recordPost(
  state: SocialState,
  post: SocialPost,
  now: Date,
  platforms: string[] = [],
  urls: Record<string, string> = {},
): SocialState {
  const entry: PostedEntry = {
    key: post.key,
    at: now.toISOString(),
    ...(platforms.length > 0 ? { platforms } : {}),
    ...(Object.keys(urls).length > 0 ? { urls } : {}),
  };
  return {
    ...state,
    lastDigest: post.key.startsWith('digest:') ? post.key.slice('digest:'.length) : state.lastDigest,
    posted: [...state.posted, entry].slice(-500),
  };
}

// ===== サービスごとの上限 =====

export interface PlatformLimit {
  /** 24時間の上限 */
  daily: number;
  /** 30日の上限 */
  monthly: number;
}

/** サービスごとの投稿の上限（どのサービスも無料の API なので、全体の上限と同じ。manual: 「今すぐ投稿」のとき） */
export function platformLimit(manual = false): PlatformLimit {
  const daily = manual ? SOCIAL_LIMITS.manualMaxPerDay : SOCIAL_LIMITS.maxPerDay;
  return { daily, monthly: daily * 30 };
}

/** このサービスにこの投稿をしてよいか（24時間・30日の上限） */
export function platformAllows(name: string, state: SocialState, now: Date, limit: PlatformLimit = platformLimit()): boolean {
  const mine = state.posted.filter((entry) => entry.platforms?.includes(name));
  const within = (ms: number) => mine.filter((entry) => now.getTime() - Date.parse(entry.at) < ms).length;
  return within(24 * HOUR) < limit.daily && within(30 * 24 * HOUR) < limit.monthly;
}

// ===== リンク（流入元つき） =====

/** どの投稿から来たかが分かるよう、サイトのリンクに utm_source などを付ける */
export function withUtm(url: string, source: string, campaign: string): string {
  try {
    const target = new URL(url);
    target.searchParams.set('utm_source', source);
    target.searchParams.set('utm_medium', 'social');
    target.searchParams.set('utm_campaign', campaign);
    return target.toString();
  } catch {
    return url;
  }
}

/** 本文に出す短いリンク（ドメインとパスの先頭。Bluesky のアプリが自分で投稿したときと同じ見え方） */
export function displayUrl(url: string, max = 32): string {
  try {
    const target = new URL(url);
    const text = `${target.host}${target.pathname}`.replace(/\/$/, '');
    return truncate(text, max);
  } catch {
    return truncate(url, max);
  }
}

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Record<string, string>[];
}

/**
 * Bluesky の本文: URL を短い表示に置き換え、そこに流入元つきのリンクを付ける。ハッシュタグもタグにする（位置は UTF-8 のバイト単位）
 */
export function blueskyRichText(text: string, campaign: string): { text: string; facets: Facet[] } {
  let out = '';
  let last = 0;
  const links: { start: number; end: number; uri: string }[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    out += text.slice(last, match.index);
    const label = displayUrl(match[0]);
    links.push({ start: out.length, end: out.length + label.length, uri: withUtm(match[0], 'bluesky', campaign) });
    out += label;
    last = (match.index ?? 0) + match[0].length;
  }
  out += text.slice(last);
  const encoder = new TextEncoder();
  const byteAt = (index: number) => encoder.encode(out.slice(0, index)).length;
  const facets: Facet[] = links.map((link) => ({
    index: { byteStart: byteAt(link.start), byteEnd: byteAt(link.end) },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: link.uri }],
  }));
  for (const match of out.matchAll(/(^|\s)#([^\s#]+)/g)) {
    const start = byteAt((match.index ?? 0) + match[1].length);
    facets.push({
      index: { byteStart: start, byteEnd: start + encoder.encode(`#${match[2]}`).length },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: match[2] }],
    });
  }
  return { text: out, facets: facets.sort((a, b) => a.index.byteStart - b.index.byteStart) };
}

// ===== 各サービスへの投稿 =====

export interface Platform {
  name: string;
  fits: (text: string) => boolean;
  /** 投稿して、投稿のページの URL を返す（分からなければ undefined） */
  send: (text: string, post: SocialPost) => Promise<string | undefined>;
}

async function request(url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : undefined;
}

/** Bluesky の上限（書記素で300） */
export const fitsBluesky = (text: string) => graphemeLength(blueskyRichText(text, 'x').text) <= 300;

interface BlueskySession {
  accessJwt: string;
  did: string;
  handle?: string;
}

/**
 * Bluesky（AT Protocol）。ログインは1回の実行で1回だけ（ログインには回数の制限があるため）。
 * リンクカードの画像（サイトの OGP 画像）も1回だけアップロードして使い回す
 */
function blueskyPlatform(identifier: string, password: string, service: string, thumb?: Uint8Array<ArrayBuffer>): Platform {
  const base = service.replace(/\/+$/, '');
  let session: Promise<BlueskySession> | undefined;
  let thumbBlob: Promise<unknown> | undefined;
  const login = () =>
    (session ??= request(
      `${base}/xrpc/com.atproto.server.createSession`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) },
      'Bluesky',
    ) as Promise<BlueskySession>);
  const uploadThumb = (token: string) =>
    (thumbBlob ??= thumb
      ? (
          request(
            `${base}/xrpc/com.atproto.repo.uploadBlob`,
            { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` }, body: thumb },
            'Bluesky',
          ) as Promise<{ blob?: unknown }>
        )
          .then((result) => result.blob)
          // 画像を送れなくても、画像なしのリンクカードで投稿する
          .catch(() => undefined)
      : Promise.resolve(undefined));
  return {
    name: 'Bluesky',
    fits: fitsBluesky,
    send: async (text, post) => {
      const { accessJwt, did, handle } = await login();
      const rich = blueskyRichText(text, post.kind);
      const blob = await uploadThumb(accessJwt);
      const record = {
        $type: 'app.bsky.feed.post',
        text: rich.text,
        createdAt: new Date().toISOString(),
        langs: ['ja'],
        facets: rich.facets,
        embed: {
          $type: 'app.bsky.embed.external',
          external: {
            uri: withUtm(post.link.url, 'bluesky', post.kind),
            title: post.link.title,
            description: post.link.description,
            ...(blob ? { thumb: blob } : {}),
          },
        },
      };
      const created = (await request(
        `${base}/xrpc/com.atproto.repo.createRecord`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessJwt}` },
          body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
        },
        'Bluesky',
      )) as { uri?: string } | undefined;
      return blueskyPostUrl(created?.uri, handle || did);
    },
  };
}

/** 投稿の at:// の URI から、Bluesky のアプリで開ける URL を作る */
export function blueskyPostUrl(uri: string | undefined, actor: string): string | undefined {
  const rkey = uri?.match(/\/app\.bsky\.feed\.post\/([^/]+)$/)?.[1];
  return rkey ? `https://bsky.app/profile/${actor}/post/${rkey}` : undefined;
}

/** 本文の URL に流入元を付ける（Mastodon・Misskey は本文の URL をそのまま表示するので） */
const tagLinks = (text: string, source: string, campaign: string) => text.replace(URL_PATTERN, (url) => withUtm(url, source, campaign));

function mastodonPlatform(instance: string, token: string): Platform {
  const base = instance.replace(/\/+$/, '');
  return {
    name: 'Mastodon',
    fits: (text) => mastodonLength(text) <= 500,
    send: async (text, post) => {
      const status = (await request(
        `${base}/api/v1/statuses`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': post.key,
          },
          body: JSON.stringify({ status: tagLinks(text, 'mastodon', post.kind), visibility: 'public', language: 'ja' }),
        },
        'Mastodon',
      )) as { url?: string } | undefined;
      return status?.url;
    },
  };
}

function misskeyPlatform(instance: string, token: string): Platform {
  const base = instance.replace(/\/+$/, '');
  return {
    name: 'Misskey',
    fits: (text) => Array.from(text).length <= 3000,
    send: async (text, post) => {
      const created = (await request(
        `${base}/api/notes/create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ i: token, text: tagLinks(text, 'misskey', post.kind), visibility: 'public' }),
        },
        'Misskey',
      )) as { createdNote?: { id?: string } } | undefined;
      return created?.createdNote?.id ? `${base}/notes/${created.createdNote.id}` : undefined;
    },
  };
}

/** 認証情報がそろっているサービスだけを返す（thumb は Bluesky のリンクカードの画像） */
export function configuredPlatforms(env: Record<string, string | undefined>, { thumb }: { thumb?: Uint8Array<ArrayBuffer> } = {}): Platform[] {
  const platforms: Platform[] = [];
  if (env.BLUESKY_IDENTIFIER && env.BLUESKY_APP_PASSWORD) {
    platforms.push(
      blueskyPlatform(env.BLUESKY_IDENTIFIER.replace(/^@/, ''), env.BLUESKY_APP_PASSWORD, env.BLUESKY_SERVICE || 'https://bsky.social', thumb),
    );
  }
  if (env.MASTODON_URL && env.MASTODON_TOKEN) platforms.push(mastodonPlatform(env.MASTODON_URL, env.MASTODON_TOKEN));
  if (env.MISSKEY_URL && env.MISSKEY_TOKEN) platforms.push(misskeyPlatform(env.MISSKEY_URL, env.MISSKEY_TOKEN));
  return platforms;
}

/** 投稿せずに本文だけ確認するための、各サービスの文字数ルール */
export const previewPlatforms: Pick<Platform, 'name' | 'fits'>[] = [
  { name: 'Bluesky', fits: fitsBluesky },
  { name: 'Mastodon', fits: (text) => mastodonLength(text) <= 500 },
];
