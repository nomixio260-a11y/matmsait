/**
 * アクセス解析の中身のうち、Cloudflare に依存しない処理（サイトのテスト（vitest）からも読み込む）。
 * - ブラウザから届いたイベントの検証（おかしな値は捨てる）
 * - ボットの判定・端末や流入元の分類
 * - 集計（日ごとの集計と、今日の分をその場で数える処理の両方に使う）
 *
 * 個人を特定しないため、Cookie は使わず、IP アドレスは保存しない。訪問者は「日ごとに変わる塩」と IP・ブラウザの種類から作る
 * 匿名の番号（vid）で数える（塩は翌日に捨てるので、日をまたいで同じ人を追うことはできない）
 */

/** イベントの種類: 閲覧・記事のクリック・サイト内検索・あとで読むに保存・閲覧時間・表示中の合図（保存しない） */
export const EVENT_TYPES = ['view', 'click', 'search', 'save', 'time', 'ping'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 保存するイベント（ping は保存しない） */
export interface StoredEvent {
  /** 受け取った日時（ミリ秒） */
  ts: number;
  type: Exclude<EventType, 'ping'>;
  /** 匿名の訪問者番号（日ごとに変わる） */
  vid: string;
  /** ページのパス（サイトのベースパスを除く。例: /category/tech/） */
  path: string;
  /** ページの種類（home・category・summary など）。クリックではクリックしたページの種類 */
  kind: string;
  /** 記事の ID（クリック・保存・要約ページの閲覧） */
  aid: string;
  /** 掲載元の ID */
  src: string;
  /** カテゴリ */
  cat: string;
  /** 外部から来たときの参照元（ホスト名か utm_source） */
  ref: string;
  /** 検索した言葉 */
  q: string;
  /** 数値（検索の件数・閲覧時間の秒数） */
  n: number;
  /** 端末（m: スマホ・t: タブレット・d: パソコン） */
  dev: string;
  os: string;
  br: string;
  /** 国・地域（Cloudflare が IP から判定した2文字のコード。IP 自体は保存しない） */
  country: string;
  /** 前にも来たことがある人の訪問か（入口のページだけ） */
  ret: number;
  /** サイトの外から来た最初のページ（入口）か */
  land: number;
}

/** 管理画面で記事名を出すための記事の情報（クリック・保存・要約ページの閲覧で届く） */
export interface ArticleInfo {
  aid: string;
  title: string;
  url: string;
  src: string;
  cat: string;
}

/** 受け付けたイベント（訪問者番号・日時・ブラウザの情報は、受け取った側で付ける） */
export type ParsedEvent = Omit<StoredEvent, 'ts' | 'vid' | 'os' | 'br' | 'country' | 'type'> & { type: EventType };

const ID = /^[0-9a-f]{16}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const KIND = /^[a-z][a-z-]{0,19}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,99}$/;
/** 閲覧時間の上限（30分。開いたまま放置したタブで平均がゆがまないように） */
export const MAX_SECONDS = 30 * 60;
export const MAX_QUERY_LENGTH = 50;

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** ページのパス（? や # 以降は捨てる。ASCII だけ） */
export function cleanPath(value: unknown): string {
  const path = str(value, 300).split(/[?#]/)[0];
  return /^\/[\x21-\x7e]*$/.test(path) ? path.slice(0, 200) : '';
}

/** 検索した言葉をそろえる（全角・半角、英字の大小、空白をそろえ、長すぎる部分は切る） */
export function normalizeQuery(value: unknown): string {
  const text = oneLine(str(value, 500).normalize('NFKC')).toLowerCase();
  return Array.from(text).slice(0, MAX_QUERY_LENGTH).join('').trim();
}

/** ブラウザから届いたイベントを検証する（おかしな値は空にし、必要な値がなければ undefined） */
export function parseEvent(body: unknown): { event: ParsedEvent; article?: ArticleInfo } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const input = body as Record<string, unknown>;
  const type = input.t;
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) return undefined;
  const pick = (value: unknown, pattern: RegExp, max: number) => {
    const text = str(value, max);
    return pattern.test(text) ? text : '';
  };
  const number = typeof input.n === 'number' && Number.isFinite(input.n) ? Math.max(0, Math.floor(input.n)) : 0;
  const event: ParsedEvent = {
    type: type as EventType,
    path: cleanPath(input.p),
    kind: pick(input.k, KIND, 20),
    aid: pick(input.a, ID, 16),
    src: pick(input.s, SLUG, 40),
    cat: pick(input.c, SLUG, 40),
    ref: pick(str(input.r, 100).toLowerCase(), HOST, 100),
    q: type === 'search' ? normalizeQuery(input.q) : '',
    n: type === 'time' ? Math.min(number, MAX_SECONDS) : Math.min(number, 1_000_000),
    dev: input.d === 'm' || input.d === 't' || input.d === 'd' ? input.d : '',
    // 1: 前にも来た人、2: この週（月曜から）初めての訪問、4: この月初めての訪問（WAU・MAU に使う）
    ret: typeof input.ret === 'number' && Number.isInteger(input.ret) && input.ret >= 0 && input.ret <= 7 ? input.ret : input.ret === true ? 1 : 0,
    land: input.l === 1 || input.l === true ? 1 : 0,
  };
  // 種類ごとに必要な値
  if ((event.type === 'view' || event.type === 'time') && !event.path) return undefined;
  if ((event.type === 'click' || event.type === 'save') && !event.aid) return undefined;
  if (event.type === 'search' && !event.q) return undefined;
  if (event.type === 'time' && event.n < 1) return undefined;
  // 入口の情報（参照元・再訪）は閲覧のイベントでだけ使う
  if (event.type !== 'view' || !event.land) {
    event.ref = '';
    event.ret = 0;
    event.land = 0;
  }

  let article: ArticleInfo | undefined;
  const title = oneLine(str(input.ti, 300)).slice(0, 200);
  const url = str(input.u, 600);
  if (event.aid && title && /^https?:\/\/[^\s]+$/.test(url) && url.length <= 500) {
    article = { aid: event.aid, title, url, src: event.src, cat: event.cat };
  }
  return { event, article };
}

/** 検索エンジン・SNS のクローラーや監視ツールなど、人ではないアクセス（CUBOT はスマホのメーカー名なので除く） */
const BOT_UA =
  /(?<!cu)bot\b|bot\/|crawl|spider|slurp|mediapartners|bingpreview|facebookexternalhit|embedly|preview|whatsapp|telegram|discord|skype|headless|phantomjs|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl\/|wget|python|httpclient|okhttp|go-http-client|java\/|axios|node-fetch|undici|postman|insomnia/i;

export function isBot(userAgent: string): boolean {
  return userAgent.trim().length < 20 || BOT_UA.test(userAgent);
}

export function osOf(userAgent: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  if (/Windows/.test(userAgent)) return 'windows';
  if (/CrOS/.test(userAgent)) return 'chromeos';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macos';
  if (/Linux/.test(userAgent)) return 'linux';
  return 'other';
}

export function browserOf(userAgent: string): string {
  if (/\bLine\//i.test(userAgent)) return 'line';
  if (/FBAN|FBAV|Instagram|Twitter|BytedanceWebview|musical_ly/i.test(userAgent)) return 'in-app';
  if (/EdgA?\/|EdgiOS|Edg\//.test(userAgent)) return 'edge';
  if (/SamsungBrowser/.test(userAgent)) return 'samsung';
  if (/OPR\/|Opera|OPiOS/.test(userAgent)) return 'opera';
  if (/Firefox\/|FxiOS/.test(userAgent)) return 'firefox';
  if (/CriOS|Chrome\//.test(userAgent)) return 'chrome';
  if (/Safari\//.test(userAgent)) return 'safari';
  return 'other';
}

/** 流入元の分類（AI チャット・検索・SNS・ほかのサイト・直接） */
export type Channel = 'ai' | 'search' | 'social' | 'other' | 'direct';

const AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|copilot\.microsoft\.com|gemini\.google\.com|claude\.ai|you\.com|felo\.ai|genspark\.ai)$/;
const SEARCH_HOSTS =
  /(^|\.)(google\.[a-z.]+|bing\.com|search\.yahoo\.(co\.jp|com)|duckduckgo\.com|ecosia\.org|baidu\.com|yandex\.[a-z.]+|search\.naver\.com|search\.brave\.com|startpage\.com|search\.goo\.ne\.jp|kagi\.com|qwant\.com)$/;
const SOCIAL_HOSTS =
  /(^|\.)(t\.co|x\.com|twitter\.com|facebook\.com|fb\.me|instagram\.com|threads\.net|threads\.com|bsky\.app|line\.me|reddit\.com|b\.hatena\.ne\.jp|note\.com|youtube\.com|tiktok\.com|pinterest\.[a-z.]+|linkedin\.com|mastodon\.[a-z.]+|misskey\.[a-z.]+|mstdn\.jp|pawoo\.net|discord\.com)$/;
/** utm_source に書かれることの多い名前 */
const SOCIAL_LABELS = new Set(['x', 'twitter', 'bluesky', 'bsky', 'mastodon', 'misskey', 'line', 'facebook', 'instagram', 'threads', 'social', 'sns']);

export function channelOf(ref: string): Channel {
  if (!ref) return 'direct';
  if (AI_HOSTS.test(ref) || ref === 'chatgpt.com' || ref === 'perplexity') return 'ai';
  if (SEARCH_HOSTS.test(ref)) return 'search';
  if (SOCIAL_HOSTS.test(ref) || SOCIAL_LABELS.has(ref)) return 'social';
  return 'other';
}

// ===== 日付（日本時間で数える） =====

const JST_OFFSET = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 日本時間の日付（YYYY-MM-DD） */
export const jstDay = (ms: number) => new Date(ms + JST_OFFSET).toISOString().slice(0, 10);
/** 日本時間の時（0〜23） */
export const jstHour = (ms: number) => new Date(ms + JST_OFFSET).getUTCHours();
/** 日本時間のその日の0時（ミリ秒） */
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00+09:00`);
export const addDays = (day: string, days: number) => jstDay(dayStart(day) + days * DAY_MS);
/** その日を含む週の月曜日（YYYY-MM-DD） */
export const weekStartDay = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
export const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && jstDay(dayStart(value)) === value;

// ===== 集計 =====

/**
 * 集計の1行。metric は「何を数えたか」、key はその内訳（記事 ID・ページなど。合計は空文字）。
 * count は回数、uniq は人数（日ごと。複数の日をまとめると日ごとの人数の合計になる）、sum は数値の合計（秒数など）
 */
export interface RollupRow {
  metric: string;
  key: string;
  count: number;
  uniq: number;
  sum: number;
}

/** 集計の指標の一覧（Aggregator が作るもの。日ごとの集計を読むときに使う） */
export const METRICS = [
  'all',
  'view',
  'view.path',
  'view.kind',
  'view.cat',
  'view.aid',
  'view.dev',
  'view.os',
  'view.br',
  'view.country',
  'view.hour',
  'visit',
  'visit.channel',
  'visit.ref',
  'visit.path',
  'visit.ret',
  'visit.wk',
  'visit.mo',
  'click',
  'click.aid',
  'click.src',
  'click.cat',
  'click.kind',
  'search',
  'search.q',
  'save',
  'save.aid',
  'time',
  'time.path',
  'art.aid',
  'depth',
  'bounce',
] as const;
export type Metric = (typeof METRICS)[number];
/** 合計だけの指標（key が空） */
export const TOTAL_METRICS = ['all', 'view', 'visit', 'click', 'search', 'save', 'time', 'bounce'] as const;

/** 1人が何ページ見たか（「1ページだけ」は直帰の目安） */
export function depthBucket(views: number): string {
  if (views <= 1) return '1';
  if (views === 2) return '2';
  if (views === 3) return '3';
  if (views <= 5) return '4-5';
  if (views <= 9) return '6-9';
  return '10+';
}

interface Cell {
  count: number;
  sum: number;
  vids: Set<string>;
}

/**
 * イベントを足していく集計（日ごとの集計と、今日の分をその場で数えるのに使う）。
 * 主な metric:
 * - all: すべてのイベント（uniq はその日の訪問者数）
 * - view / view.path / view.kind / view.cat / view.aid / view.dev / view.os / view.br / view.country / view.hour: 閲覧
 * - visit / visit.channel / visit.ref / visit.path / visit.ret: サイトの外から来た訪問（入口のページ）
 * - visit.wk / visit.mo: この週・この月に初めて来た人（日ごとの合計が週・月の訪問者数になる）
 * - click / click.aid / click.src / click.cat / click.kind: 記事のクリック
 * - search / search.q（sum は0件だった回数）、save / save.aid、time / time.path（sum は秒数）
 * - art.aid: 記事ごとの「読んだ・クリックした・保存した人」（人気の記事の順位に使う）
 * - depth: 1人が見たページ数ごとの人数、bounce: 1ページだけ見て何もせずに離れた人
 */
export class Aggregator {
  private cells = new Map<string, Cell>();
  private visitors = new Map<string, { views: number; actions: number }>();

  private add(metric: string, key: string, vid: string, sum = 0) {
    const id = `${metric}\u0000${key}`;
    let cell = this.cells.get(id);
    if (!cell) {
      cell = { count: 0, sum: 0, vids: new Set() };
      this.cells.set(id, cell);
    }
    cell.count++;
    cell.sum += sum;
    cell.vids.add(vid);
  }

  push(event: StoredEvent): void {
    const { vid } = event;
    const visitor = this.visitors.get(vid) ?? { views: 0, actions: 0 };
    this.visitors.set(vid, visitor);
    this.add('all', '', vid);
    switch (event.type) {
      case 'view':
        visitor.views++;
        this.add('view', '', vid);
        this.add('view.path', event.path, vid);
        if (event.kind) this.add('view.kind', event.kind, vid);
        if (event.cat) this.add('view.cat', event.cat, vid);
        if (event.aid) {
          this.add('view.aid', event.aid, vid);
          this.add('art.aid', event.aid, vid);
        }
        if (event.dev) this.add('view.dev', event.dev, vid);
        if (event.os) this.add('view.os', event.os, vid);
        if (event.br) this.add('view.br', event.br, vid);
        if (event.country) this.add('view.country', event.country, vid);
        this.add('view.hour', String(jstHour(event.ts)).padStart(2, '0'), vid);
        if (event.land) {
          this.add('visit', '', vid);
          this.add('visit.channel', channelOf(event.ref), vid);
          if (event.ref) this.add('visit.ref', event.ref, vid);
          this.add('visit.path', event.path, vid);
          this.add('visit.ret', String(event.ret & 1), vid);
          // この週・この月に初めて来た人（日をまたいで同じ人を数えずに、週・月の訪問者数を出すため）
          if (event.ret & 2) this.add('visit.wk', '', vid);
          if (event.ret & 4) this.add('visit.mo', '', vid);
        }
        break;
      case 'click':
        visitor.actions++;
        this.add('click', '', vid);
        this.add('click.aid', event.aid, vid);
        this.add('art.aid', event.aid, vid);
        if (event.src) this.add('click.src', event.src, vid);
        if (event.cat) this.add('click.cat', event.cat, vid);
        if (event.kind) this.add('click.kind', event.kind, vid);
        break;
      case 'search':
        visitor.actions++;
        this.add('search', '', vid, event.n === 0 ? 1 : 0);
        this.add('search.q', event.q, vid, event.n === 0 ? 1 : 0);
        break;
      case 'save':
        visitor.actions++;
        this.add('save', '', vid);
        this.add('save.aid', event.aid, vid);
        this.add('art.aid', event.aid, vid);
        break;
      case 'time':
        this.add('time', '', vid, event.n);
        this.add('time.path', event.path, vid, event.n);
        break;
    }
  }

  rows(): RollupRow[] {
    const rows: RollupRow[] = [];
    for (const [id, cell] of this.cells) {
      const [metric, key] = id.split('\u0000');
      rows.push({ metric, key, count: cell.count, uniq: cell.vids.size, sum: cell.sum });
    }
    const depth = new Map<string, { count: number; uniq: number }>();
    let bounce = 0;
    for (const visitor of this.visitors.values()) {
      if (visitor.views === 0) continue;
      const bucket = depthBucket(visitor.views);
      const entry = depth.get(bucket) ?? { count: 0, uniq: 0 };
      entry.count += visitor.views;
      entry.uniq++;
      depth.set(bucket, entry);
      if (visitor.views === 1 && visitor.actions === 0) bounce++;
    }
    for (const [key, entry] of depth) rows.push({ metric: 'depth', key, count: entry.count, uniq: entry.uniq, sum: 0 });
    if (bounce > 0) rows.push({ metric: 'bounce', key: '', count: bounce, uniq: bounce, sum: 0 });
    return rows;
  }

  /** 合計の指標（key が空のもの）の値 */
  total(metric: string): { count: number; uniq: number; sum: number } {
    const cell = this.cells.get(`${metric}\u0000`);
    return { count: cell?.count ?? 0, uniq: cell?.vids.size ?? 0, sum: cell?.sum ?? 0 };
  }

  /** 記事ごとの人数（art.aid の uniq）だけを返す */
  popularity(): Map<string, number> {
    const result = new Map<string, number>();
    for (const [id, cell] of this.cells) {
      if (id.startsWith('art.aid\u0000')) result.set(id.slice('art.aid\u0000'.length), cell.vids.size);
    }
    return result;
  }
}

export function aggregate(events: Iterable<StoredEvent>): RollupRow[] {
  const aggregator = new Aggregator();
  for (const event of events) aggregator.push(event);
  return aggregator.rows();
}

/** 同じ metric・key の行を足し合わせる（複数の日をまとめる） */
export function mergeRows(...lists: RollupRow[][]): RollupRow[] {
  const merged = new Map<string, RollupRow>();
  for (const list of lists) {
    for (const row of list) {
      const id = `${row.metric}\u0000${row.key}`;
      const current = merged.get(id);
      if (current) {
        current.count += row.count;
        current.uniq += row.uniq;
        current.sum += row.sum;
      } else {
        merged.set(id, { ...row });
      }
    }
  }
  return [...merged.values()];
}

/** 人気の順（人数→回数の多い順） */
export const byPopularity = (a: { uniq: number; count: number; key: string }, b: { uniq: number; count: number; key: string }) =>
  b.uniq - a.uniq || b.count - a.count || a.key.localeCompare(b.key);

export type Totals = Record<string, { count: number; uniq: number; sum: number }>;

/** 合計の行（key が空の行）だけを metric ごとにまとめる */
export function totalsOf(rows: RollupRow[]): Totals {
  const totals: Totals = {};
  for (const row of rows) {
    if (row.key === '') totals[row.metric] = { count: row.count, uniq: row.uniq, sum: row.sum };
  }
  return totals;
}

/** 内訳の行を metric ごとに人気の順で上位 limit 件まで（depth と view.hour はすべて） */
export function topOf(rows: RollupRow[], limit: number): Record<string, Omit<RollupRow, 'metric'>[]> {
  const groups: Record<string, Omit<RollupRow, 'metric'>[]> = {};
  for (const row of rows) {
    if (row.key === '' && row.metric !== 'depth') continue;
    (groups[row.metric] ??= []).push({ key: row.key, count: row.count, uniq: row.uniq, sum: row.sum });
  }
  for (const [metric, list] of Object.entries(groups)) {
    list.sort(byPopularity);
    if (metric !== 'depth' && metric !== 'view.hour') groups[metric] = list.slice(0, limit);
  }
  return groups;
}

/** 人気の記事（記事 ID と人数。人数の多い順） */
export function rankArticles(counts: Map<string, number>, limit: number): { id: string; n: number }[] {
  return [...counts]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, n]) => ({ id, n }));
}

/** 訪問者番号（塩・IP・ブラウザの種類から作る。元の値には戻せない） */
export async function visitorId(salt: string, ip: string, userAgent: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}|${userAgent}`));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 新しい塩（ランダムな32バイト） */
export function newSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 許可するサイトのオリジン（カンマ区切り）。末尾の / は除く */
export function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => /^https?:\/\/[^/\s]+$/.test(origin));
}
