/**
 * 通知（ブラウザのプッシュ通知・Web Push）。アクセス解析と同じ Durable Object（SQLite）で動く。
 *
 * - 読者がフォローしたジャンル・掲載元・キーワードの新着、いま話題のニュース、運営からのお知らせを送る
 * - 新着は、サイトを公開するたびに GitHub Actions が /api/push/check を呼び、公開したサイトの updates.json
 *   （直近の新着記事と話題）を読んで、はじめて見た記事を購読ごとのフォローと照らし合わせて送る
 * - 購読（通知を届ける会社の URL と鍵）とフォローの設定だけを保存する（IP アドレスや閲覧の記録とは結び付けない）
 * - 無料プランの上限（1回の処理で外へ送れるのは50件まで・1日の書き込み10万行）に収まるよう、
 *   購読は40件ずつ順に処理し（残りはアラームで続ける）、送ったことは購読ごとには書き込まない
 */
import {
  cleanFollow,
  cleanMute,
  isEmptyPrefs,
  matchFollow,
  parseUpdates,
  withBase,
  type FollowMatch,
  type FollowPrefs,
  type FollowReason,
  type MutePrefs,
  type UpdateEntry,
  type UpdateTopic,
} from '../../src/lib/follow-core.ts';
import { DAY_MS, dayStart, jstDay, jstHour } from './core.ts';
import type { Sql } from './store.ts';
import { classifyPushStatus, fromBase64Url, generateVapidKeys, isVapidKeys, pushRequest, VapidSigner, type PushTarget, type VapidKeys } from './webpush.ts';

// ===== 設定 =====

/** 通知の受け取り方 */
export interface NotifyOptions {
  /** フォローに当てはまる新着を知らせる */
  follow: boolean;
  /** いま話題のニュース（多くのメディアが報じた出来事）を知らせる */
  hot: boolean;
  /** 運営からのお知らせ */
  news: boolean;
  /** 1日1回（朝7時ごろ）まとめて知らせる（false ならおよそ1時間ごと） */
  daily: boolean;
  /** 夜（23時〜7時）は送らず、朝にまとめて知らせる */
  quiet: boolean;
}

export interface PushSettings {
  follow: FollowPrefs;
  mute: MutePrefs;
  notify: NotifyOptions;
}

export const DEFAULT_NOTIFY: NotifyOptions = { follow: true, hot: false, news: true, daily: false, quiet: true };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 送られてきた設定を整える（形の正しくないものは既定値にする） */
export function cleanSettings(value: unknown): PushSettings {
  const record = isObject(value) ? value : {};
  const notify = isObject(record.notify) ? record.notify : {};
  const flag = (key: keyof NotifyOptions) => (typeof notify[key] === 'boolean' ? (notify[key] as boolean) : DEFAULT_NOTIFY[key]);
  return {
    follow: cleanFollow(record.follow),
    mute: cleanMute(record.mute),
    notify: { follow: flag('follow'), hot: flag('hot'), news: flag('news'), daily: flag('daily'), quiet: flag('quiet') },
  };
}

/** 何も受け取らない設定か（フォローがなく、話題・お知らせも受け取らない） */
export function wantsNothing(settings: PushSettings): boolean {
  const follows = settings.notify.follow && !isEmptyPrefs(settings.follow);
  return !follows && !settings.notify.hot && !settings.notify.news;
}

// ===== 購読 =====

/** 通知を届ける会社（ブラウザごと）。ほかの URL へは送らない（このサーバーを使って任意の URL へ送らせないため） */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
const MAX_ENDPOINT = 1024;

/** 通知を届ける会社の URL か。extraHosts は手元の試験で使う偽の届け先（host:port） */
export function isPushEndpoint(endpoint: string, extraHosts: string[] = []): boolean {
  if (endpoint.length > MAX_ENDPOINT) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (extraHosts.includes(url.host)) return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol !== 'https:' || url.port) return false;
  return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** ブラウザの購読（PushSubscription.toJSON()）を確かめる。正しくなければ undefined */
export function parseTarget(value: unknown, extraHosts: string[] = []): PushTarget | undefined {
  if (!isObject(value)) return undefined;
  const { endpoint } = value;
  const keys = isObject(value.keys) ? value.keys : {};
  const { p256dh, auth } = keys;
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return undefined;
  if (!isPushEndpoint(endpoint, extraHosts)) return undefined;
  try {
    const publicKey = fromBase64Url(p256dh);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || fromBase64Url(auth).length !== 16) return undefined;
  } catch {
    return undefined;
  }
  return { endpoint, p256dh, auth };
}

/** 購読の番号（URL のハッシュ。URL そのものは送り先としてだけ使う） */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ===== 通知の中身 =====

export type MessageKind = 'follow' | 'hot' | 'news' | 'test';

/** ブラウザに届ける内容（サービスワーカー（public/sw.js）が表示する） */
export interface PushMessage {
  kind: MessageKind;
  title: string;
  body: string;
  /** 押したときに開くページ（サイト内のパス） */
  url: string;
  /** 同じ tag の通知は置き換わる */
  tag: string;
}

/** 通知の材料（1回の確認ぶん） */
export interface NotifyContext {
  /** 今回はじめて見た記事 */
  fresh: UpdateEntry[];
  /** 夜の間（23時から）にはじめて見た記事（朝の回だけ。夜は送らない人に、朝まとめて知らせる） */
  overnight: UpdateEntry[];
  /** 24時間のうちにはじめて見た記事（朝の回だけ。1日1回にまとめる人に知らせる） */
  day: UpdateEntry[];
  /** 今回あらたに話題になった出来事 */
  hot: UpdateTopic[];
  /** いまいちばんの話題（朝のまとめに添える） */
  topHot?: UpdateTopic;
  /** 夜（23時〜7時）か */
  quietNow: boolean;
  /** その日の最初の朝の回か */
  morning: boolean;
  /** サイトのベースパス */
  base: string;
  /** カテゴリの slug → 名前 */
  cats: Record<string, string>;
}

/** 文字数（見た目の1文字）で切り詰める */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

const PUSH_QUERY = 'utm_source=push';

/** サイト内のパスに、通知から来たことの印を付ける（アクセス解析の流入元が「push」になる） */
export function fromPush(path: string, base: string): string {
  const url = withBase(path, base);
  const [main, hash = ''] = url.split('#');
  return `${main}${main.includes('?') ? '&' : '?'}${PUSH_QUERY}${hash ? `#${hash}` : ''}`;
}

function reasonText(match: FollowMatch, cats: Record<string, string>): string {
  const { reason, entry }: { reason: FollowReason; entry: UpdateEntry } = match;
  if (reason.kind === 'word') return `キーワード「${reason.value}」`;
  if (reason.kind === 'src') return `${entry.n}をフォロー中`;
  return `${cats[reason.value] ?? reason.value}をフォロー中`;
}

/** 購読ごとの、フォローの新着と話題の通知（送るものがなければ undefined） */
export function buildFollowMessage(settings: PushSettings, ctx: NotifyContext): PushMessage | undefined {
  const { notify } = settings;
  let items: UpdateEntry[];
  let topics: UpdateTopic[];
  if (notify.daily) {
    if (!ctx.morning) return undefined;
    items = ctx.day;
    topics = ctx.topHot ? [ctx.topHot] : [];
  } else if (notify.quiet && ctx.quietNow) {
    return undefined;
  } else if (notify.quiet && ctx.morning) {
    items = ctx.overnight;
    topics = ctx.hot.length > 0 ? ctx.hot : ctx.topHot ? [ctx.topHot] : [];
  } else {
    items = ctx.fresh;
    topics = ctx.hot;
  }
  const matches = notify.follow && !isEmptyPrefs(settings.follow) ? matchFollow(items, settings.follow, settings.mute) : [];
  const hot = notify.hot ? topics.slice(0, 1) : [];
  const following = fromPush('/following/', ctx.base);

  if (matches.length === 0) {
    const topic = hot[0];
    if (!topic) return undefined;
    return { kind: 'hot', title: `いま話題（${topic.k}社が報道）`, body: truncate(topic.t, 90), url: fromPush(topic.u, ctx.base), tag: 'hot' };
  }
  if (matches.length === 1 && hot.length === 0) {
    const [match] = matches;
    const { entry } = match;
    // AI 要約のある記事は要約ページ、ない記事は「フォロー中」のページでその記事を先頭に出す
    const url = entry.m ? fromPush(entry.u, ctx.base) : `${following}#a-${entry.i}`;
    return { kind: 'follow', title: truncate(entry.t, 90), body: `${entry.n}・${reasonText(match, ctx.cats)}`, url, tag: 'follow' };
  }
  const lines = matches.slice(0, 3).map(({ entry }) => `・${truncate(entry.t, 38)}`);
  if (matches.length > 3) lines.push(`ほか${matches.length - 3}件`);
  if (hot[0]) lines.push(`いま話題: ${truncate(hot[0].t, 30)}`);
  return {
    kind: 'follow',
    title: `${notify.daily || ctx.morning ? 'きょうの' : ''}フォロー中の新着 ${matches.length}件`,
    body: lines.join('\n'),
    url: following,
    tag: 'follow',
  };
}

/** 運営からのお知らせ（管理画面から送る） */
export interface NewsInput {
  title: string;
  body: string;
  /** 開くページ（サイト内のパス） */
  url: string;
  /** このジャンルをフォローしている人だけに送る（空ならお知らせを受け取る全員） */
  cat: string;
}

/** 管理画面から送られたお知らせを確かめる */
export function parseNews(value: unknown): NewsInput | undefined {
  if (!isObject(value)) return undefined;
  const text = (key: string, max: number) => (typeof value[key] === 'string' ? (value[key] as string).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const title = text('title', 60);
  const body = text('body', 200);
  const url = text('url', 300) || '/';
  const cat = text('cat', 64);
  if (!title || !/^\/(?!\/)[^\s\\]*$/.test(url) || (cat && !/^[a-z0-9][a-z0-9-]*$/.test(cat))) return undefined;
  return { title, body, url, cat };
}

// ===== 保存（SQLite） =====

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_subs (
    id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    settings TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, fails INTEGER NOT NULL
  ) WITHOUT ROWID`,
  // 通知の材料にした記事（はじめて見た時刻 batch と、通知に使う中身）。72時間で消す
  `CREATE TABLE IF NOT EXISTS push_items (id TEXT PRIMARY KEY, batch INTEGER NOT NULL, data TEXT NOT NULL) WITHOUT ROWID`,
  // 話題として知らせた記事（同じ話題を何度も知らせないため）。7日で消す
  `CREATE TABLE IF NOT EXISTS push_topics (id TEXT PRIMARY KEY, ts INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS push_log (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, items INTEGER NOT NULL,
    targets INTEGER NOT NULL, sent INTEGER NOT NULL, failed INTEGER NOT NULL, removed INTEGER NOT NULL, done INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
];

export interface StoredSubscription extends PushTarget {
  id: string;
  settings: PushSettings;
  created: number;
  fails: number;
}

export interface LogEntry {
  id: number;
  kind: MessageKind | 'check';
  title: string;
  /** 材料にした新着の記事の数 */
  items: number;
  /** 送ろうとした購読の数 */
  targets: number;
  sent: number;
  failed: number;
  /** 取り消されていたので消した購読の数 */
  removed: number;
  /** 送り終えた時刻 */
  done: number;
}

const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const str = (value: unknown) => (typeof value === 'string' ? value : '');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class PushStore {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: <T>(fn: () => T) => T = (fn) => fn(),
  ) {
    for (const statement of SCHEMA) sql.exec(statement);
  }

  getMeta(key: string): string | undefined {
    const [row] = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray();
    return row ? str(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
  }

  deleteMeta(key: string): void {
    this.sql.exec('DELETE FROM meta WHERE key = ?', key);
  }

  private toSubscription(row: Record<string, unknown>): StoredSubscription {
    return {
      id: str(row.id),
      endpoint: str(row.endpoint),
      p256dh: str(row.p256dh),
      auth: str(row.auth),
      settings: cleanSettings(parseJson(str(row.settings))),
      created: num(row.created),
      fails: num(row.fails),
    };
  }

  getSubscription(id: string): StoredSubscription | undefined {
    const [row] = this.sql.exec('SELECT * FROM push_subs WHERE id = ?', id).toArray();
    return row ? this.toSubscription(row) : undefined;
  }

  /** 購読を保存する（同じ URL なら鍵と設定を新しくする） */
  saveSubscription(id: string, target: PushTarget, settings: PushSettings, now: number): void {
    this.sql.exec(
      `INSERT INTO push_subs (id, endpoint, p256dh, auth, settings, created, updated, fails) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
         settings = excluded.settings, updated = excluded.updated, fails = 0`,
      id,
      target.endpoint,
      target.p256dh,
      target.auth,
      JSON.stringify(settings),
      now,
      now,
    );
  }

  deleteSubscription(id: string): void {
    this.sql.exec('DELETE FROM push_subs WHERE id = ?', id);
  }

  setFails(id: string, fails: number): void {
    this.sql.exec('UPDATE push_subs SET fails = ? WHERE id = ?', fails, id);
  }

  countSubscriptions(): number {
    const [row] = this.sql.exec('SELECT COUNT(*) AS n FROM push_subs').toArray();
    return num(row?.n);
  }

  /** 購読を番号の順に limit 件（after より後ろから） */
  subscriptionsAfter(after: string, limit: number): StoredSubscription[] {
    return this.sql.exec('SELECT * FROM push_subs WHERE id > ? ORDER BY id LIMIT ?', after, limit).toArray().map((row) => this.toSubscription(row));
  }

  /** すべての購読の設定（管理画面の集計用） */
  allSettings(): PushSettings[] {
    return this.sql
      .exec('SELECT settings FROM push_subs')
      .toArray()
      .map((row) => cleanSettings(parseJson(str(row.settings))));
  }

  /** 記事のうち、まだ見ていないものを記録して返す（first なら記録だけして、何も返さない） */
  recordItems(entries: UpdateEntry[], batch: number, first: boolean): UpdateEntry[] {
    const known = new Set(
      this.sql
        .exec('SELECT id FROM push_items')
        .toArray()
        .map((row) => str(row.id)),
    );
    const fresh = entries.filter((entry) => !known.has(entry.i));
    this.transaction(() => {
      for (const entry of fresh) {
        this.sql.exec('INSERT OR IGNORE INTO push_items (id, batch, data) VALUES (?, ?, ?)', entry.i, first ? 0 : batch, JSON.stringify(entry));
      }
    });
    return first ? [] : fresh;
  }

  /** はじめて見た時刻（batch）が since 以降の記事（新しく見た順） */
  itemsSince(since: number): { entry: UpdateEntry; batch: number }[] {
    return this.sql
      .exec('SELECT batch, data FROM push_items WHERE batch >= ? ORDER BY batch DESC', since)
      .toArray()
      .flatMap((row) => {
        const entry = parseJson(str(row.data));
        return isObject(entry) && typeof entry.i === 'string' ? [{ entry: entry as unknown as UpdateEntry, batch: num(row.batch) }] : [];
      });
  }

  /** まだ知らせていない話題を記録して返す（同じ話題の記事のどれかを知らせていれば、知らせ済み） */
  recordTopics(topics: UpdateTopic[], now: number, first: boolean): UpdateTopic[] {
    const fresh: UpdateTopic[] = [];
    this.transaction(() => {
      for (const topic of topics) {
        const placeholders = topic.i.map(() => '?').join(', ');
        const [row] = this.sql.exec(`SELECT COUNT(*) AS n FROM push_topics WHERE id IN (${placeholders})`, ...topic.i).toArray();
        const known = num(row?.n) > 0;
        for (const id of topic.i) this.sql.exec('INSERT OR IGNORE INTO push_topics (id, ts) VALUES (?, ?)', id, now);
        if (!known && !first) fresh.push(topic);
      }
    });
    return fresh;
  }

  /** 古い記録を消す */
  cleanup(now: number): void {
    this.sql.exec('DELETE FROM push_items WHERE batch < ? AND batch <> 0', now - 3 * DAY_MS);
    // 最初の確認で記録だけした記事（batch = 0）も、3日たったら消す（記事は48時間で updates.json から外れる）
    const firstAt = Number(this.getMeta('push:first') ?? 0);
    if (firstAt && now - firstAt > 3 * DAY_MS) this.sql.exec('DELETE FROM push_items WHERE batch = 0');
    this.sql.exec('DELETE FROM push_topics WHERE ts < ?', now - 7 * DAY_MS);
    this.sql.exec('DELETE FROM push_log WHERE id NOT IN (SELECT id FROM push_log ORDER BY id DESC LIMIT 200)');
  }

  /** 送った記録を残す（送り終えた順に番号を付ける） */
  addLog(entry: Omit<LogEntry, 'id'>): void {
    this.sql.exec(
      'INSERT INTO push_log (kind, title, items, targets, sent, failed, removed, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      entry.kind,
      entry.title,
      entry.items,
      entry.targets,
      entry.sent,
      entry.failed,
      entry.removed,
      entry.done,
    );
  }

  log(limit: number): LogEntry[] {
    return this.sql
      .exec('SELECT * FROM push_log ORDER BY id DESC LIMIT ?', limit)
      .toArray()
      .map((row) => ({
        id: num(row.id),
        kind: str(row.kind) as LogEntry['kind'],
        title: str(row.title),
        items: num(row.items),
        targets: num(row.targets),
        sent: num(row.sent),
        failed: num(row.failed),
        removed: num(row.removed),
        done: num(row.done),
      }));
  }
}

// ===== 送る処理 =====

/** 1回の処理で送る通知の数（無料プランは1回の処理で外へ送れるのが50件まで） */
export const BATCH_SIZE = 40;
/** 同時に送る数 */
const CONCURRENCY = 6;
/** 続けて失敗したら購読を消す回数（取り消された購読は1回で消す） */
const MAX_FAILS = 5;
/** 購読の数の上限（無料プランの範囲で送り切れる数） */
const DEFAULT_MAX_SUBSCRIBERS = 20_000;
/** 話題として知らせる、報じた掲載元の数の下限 */
export const HOT_MIN = 4;
/** 1人が1時間に登録・変更できる回数 */
const SUBSCRIBE_LIMIT = 30;
/** お知らせを続けて送れる間隔 */
const NEWS_INTERVAL = 5 * 60_000;
/** 運営者が送れるテストの間隔（購読ごと） */
const TEST_INTERVAL = 30_000;

/** 送る仕事（新着の確認・お知らせ）。購読を番号の順に少しずつ処理する */
export interface PushJob {
  id: number;
  kind: 'check' | 'news';
  /** 新着の確認: はじめて見た時刻（push_items の batch） */
  batch: number;
  morning: boolean;
  quietNow: boolean;
  base: string;
  cats: Record<string, string>;
  hot: UpdateTopic[];
  topHot?: UpdateTopic;
  /** 新着の確認で、はじめて見た記事の数 */
  items: number;
  /** お知らせ */
  news?: PushMessage & { cat: string };
  cursor: string;
  targets: number;
  sent: number;
  failed: number;
  removed: number;
}

export interface PushEnv {
  /** 公開しているサイトの URL（VAPID の連絡先。updates.json をここから読むこともある） */
  SITE_URL?: string;
  /** 手元の試験で使う偽の届け先（host:port のカンマ区切り。公開しているサーバーでは設定しない） */
  PUSH_TEST_HOSTS?: string;
  /** 購読の数の上限 */
  MAX_PUSH_SUBSCRIBERS?: string;
}

export interface PushResponse {
  status: number;
  data: unknown;
}

const reply = (status: number, data: unknown): PushResponse => ({ status, data });

export class PushService {
  private signer?: VapidSigner;
  private jobItems?: { id: number; fresh: UpdateEntry[]; overnight: UpdateEntry[]; day: UpdateEntry[] };
  private readonly subscribeRate = new Map<string, { hour: number; count: number }>();
  private readonly tests = new Map<string, number>();
  private lastNews = 0;

  constructor(
    private readonly store: PushStore,
    private readonly env: PushEnv,
    private readonly send: (request: Request) => Promise<Response> = (request) => fetch(request),
  ) {}

  private extraHosts(): string[] {
    return (this.env.PUSH_TEST_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
  }

  private siteUrl(): string {
    return (this.env.SITE_URL || 'https://topiatsume.pages.dev').replace(/\/+$/, '');
  }

  /** VAPID の鍵（なければ作って保存する） */
  private async vapid(): Promise<VapidSigner> {
    if (this.signer) return this.signer;
    let keys = parseJson(this.store.getMeta('push:vapid') ?? '') as VapidKeys | undefined;
    if (!isVapidKeys(keys)) {
      keys = await generateVapidKeys();
      this.store.setMeta('push:vapid', JSON.stringify(keys));
    }
    this.signer = new VapidSigner(keys, `${this.siteUrl()}/`);
    return this.signer;
  }

  /** ブラウザが購読するときに使う公開鍵 */
  async publicKey(): Promise<PushResponse> {
    return reply(200, { key: (await this.vapid()).publicKey });
  }

  /** 1人が短い間に登録・変更しすぎていないか */
  private allowSubscribe(vid: string, now: number): boolean {
    const hour = Math.floor(now / 3_600_000);
    const entry = this.subscribeRate.get(vid);
    if (!entry || entry.hour !== hour) {
      if (this.subscribeRate.size > 10_000) this.subscribeRate.clear();
      this.subscribeRate.set(vid, { hour, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= SUBSCRIBE_LIMIT;
  }

  /** 購読の登録・設定の変更（{ subscription, settings }。購読を作り直したときは { subscription, replaces, replacesAuth }） */
  async subscribe(body: unknown, vid: string, now: number): Promise<PushResponse> {
    if (!this.allowSubscribe(vid, now)) return reply(429, { error: '短い間に何度も変更されました。しばらくしてからお試しください' });
    const record = isObject(body) ? body : {};
    const target = parseTarget(record.subscription, this.extraHosts());
    if (!target) return reply(400, { error: 'このブラウザの通知の登録を確認できませんでした' });
    const id = await subscriptionId(target.endpoint);
    const existing = this.store.getSubscription(id);
    // 同じ URL の登録は、同じ鍵（認証の秘密）でしか変えられない
    if (existing && existing.auth !== target.auth) return reply(403, { error: '登録を確認できませんでした' });
    let settings = cleanSettings(record.settings);
    // ブラウザが購読を作り直したとき（サービスワーカーから）は、前の購読の認証の秘密が合えば設定を引き継ぐ
    if (typeof record.replaces === 'string' && !isObject(record.settings)) {
      const previousId = await subscriptionId(record.replaces);
      const previous = this.store.getSubscription(previousId);
      if (!previous || previous.auth !== record.replacesAuth) return reply(404, { error: '前の登録が見つかりませんでした' });
      settings = previous.settings;
      if (previousId !== id) this.store.deleteSubscription(previousId);
    }
    if (wantsNothing(settings)) {
      if (existing) this.store.deleteSubscription(id);
      return reply(200, { ok: true, subscribed: false });
    }
    if (!existing) {
      const max = Number(this.env.MAX_PUSH_SUBSCRIBERS) || DEFAULT_MAX_SUBSCRIBERS;
      if (this.store.countSubscriptions() >= max) return reply(503, { error: 'いまは通知の登録を受け付けられません' });
    }
    this.store.saveSubscription(id, target, settings, now);
    return reply(200, { ok: true, subscribed: true });
  }

  /** 登録している購読を、URL と認証の秘密で確かめて返す */
  private async owned(body: unknown): Promise<StoredSubscription | undefined> {
    const record = isObject(body) ? body : {};
    if (typeof record.endpoint !== 'string' || typeof record.auth !== 'string') return undefined;
    const subscription = this.store.getSubscription(await subscriptionId(record.endpoint));
    return subscription && subscription.auth === record.auth ? subscription : undefined;
  }

  /** 通知をやめる（{ endpoint, auth }） */
  async unsubscribe(body: unknown): Promise<PushResponse> {
    const subscription = await this.owned(body);
    if (subscription) this.store.deleteSubscription(subscription.id);
    return reply(200, { ok: true });
  }

  /** 登録できているか（{ endpoint, auth }）。ブラウザ側の表示を確かめるのに使う */
  async status(body: unknown): Promise<PushResponse> {
    const subscription = await this.owned(body);
    return reply(200, { subscribed: Boolean(subscription) });
  }

  /** テストの通知を1件送る（{ endpoint, auth }） */
  async test(body: unknown, now: number): Promise<PushResponse> {
    const subscription = await this.owned(body);
    if (!subscription) return reply(404, { error: 'このブラウザの通知の登録が見つかりませんでした。通知をいったんオフにして、もう一度オンにしてください' });
    if ((this.tests.get(subscription.id) ?? 0) > now - TEST_INTERVAL) return reply(429, { error: '少し時間をおいてからお試しください' });
    this.tests.set(subscription.id, now);
    const message: PushMessage = {
      kind: 'test',
      title: 'テストの通知です',
      body: '通知は正しく届いています。フォローしたジャンルやキーワードの新着をお知らせします。',
      url: fromPush('/following/', parseJson(this.store.getMeta('push:base') ?? '"/"') as string),
      tag: 'test',
    };
    const result = await this.deliver(subscription, message, now);
    if (result === 'ok') return reply(200, { ok: true });
    return reply(502, { error: '通知を届けられませんでした。ブラウザの通知の許可を確かめて、通知をいったんオフにしてから、もう一度オンにしてください' });
  }

  /** 1件送る。結果に合わせて購読の失敗の回数を記録する（取り消された購読は消す） */
  private async deliver(subscription: StoredSubscription, message: PushMessage, now: number): Promise<'ok' | 'gone' | 'failed'> {
    let result: ReturnType<typeof classifyPushStatus>;
    try {
      const signer = await this.vapid();
      const request = await pushRequest(subscription, JSON.stringify(message), signer, now, {
        ttl: message.kind === 'follow' || message.kind === 'hot' ? 6 * 3600 : 24 * 3600,
        urgency: 'normal',
        topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
      });
      result = classifyPushStatus((await this.send(request)).status);
    } catch (error) {
      console.error(error);
      result = 'retry';
    }
    if (result === 'ok') {
      if (subscription.fails > 0) this.store.setFails(subscription.id, 0);
      return 'ok';
    }
    if (result === 'gone' || (result === 'error' && subscription.fails + 1 >= MAX_FAILS)) {
      this.store.deleteSubscription(subscription.id);
      return 'gone';
    }
    // 一時的な失敗（送りすぎ・相手の不調）は数えるだけにする
    this.store.setFails(subscription.id, subscription.fails + 1);
    if (subscription.fails + 1 >= MAX_FAILS * 2) this.store.deleteSubscription(subscription.id);
    return 'failed';
  }

  private jobs(): PushJob[] {
    const jobs = parseJson(this.store.getMeta('push:jobs') ?? '[]');
    return Array.isArray(jobs) ? (jobs as PushJob[]) : [];
  }

  private saveJobs(jobs: PushJob[]): void {
    if (jobs.length === 0) this.store.deleteMeta('push:jobs');
    else this.store.setMeta('push:jobs', JSON.stringify(jobs));
  }

  /** 送る仕事が残っているか */
  hasJobs(): boolean {
    return this.jobs().length > 0;
  }

  /**
   * 公開したサイトの updates.json を受け取り、はじめて見た記事と話題を記録して、送る仕事を作る。
   * 同じビルドの内容は1回だけ扱う。最初の1回は記録だけして送らない（それまでの記事をまとめて送らないように）
   */
  check(text: string, now: number): PushResponse {
    const file = parseUpdates(text);
    if (!file) return reply(400, { error: 'updates.json を読めませんでした' });
    if (file.builtAt && this.store.getMeta('push:built') === file.builtAt) return reply(200, { ok: true, fresh: 0, duplicate: true });
    const first = !this.store.getMeta('push:first');
    const fresh = this.store.recordItems(file.items, now, first);
    const hot = this.store.recordTopics(
      file.hot.filter((topic) => topic.k >= HOT_MIN),
      now,
      first,
    );
    this.store.cleanup(now);
    if (first) this.store.setMeta('push:first', String(now));
    if (file.builtAt) this.store.setMeta('push:built', file.builtAt);
    this.store.setMeta('push:base', JSON.stringify(file.base));

    const hour = jstHour(now);
    const today = jstDay(now);
    const morning = hour >= 7 && hour < 23 && this.store.getMeta('push:morning') !== today;
    if (morning) this.store.setMeta('push:morning', today);
    const quietNow = hour >= 23 || hour < 7;
    this.store.setMeta('push:last', JSON.stringify({ at: now, items: file.items.length, fresh: fresh.length, hot: hot.length }));
    if (first || (fresh.length === 0 && hot.length === 0 && !morning)) return reply(200, { ok: true, fresh: fresh.length, hot: hot.length, queued: false });
    if (this.store.countSubscriptions() === 0) return reply(200, { ok: true, fresh: fresh.length, hot: hot.length, queued: false });

    const job: PushJob = {
      id: now,
      kind: 'check',
      batch: now,
      morning,
      quietNow,
      base: file.base,
      cats: file.cats,
      hot,
      topHot: file.hot.find((topic) => topic.k >= HOT_MIN),
      items: fresh.length,
      cursor: '',
      targets: 0,
      sent: 0,
      failed: 0,
      removed: 0,
    };
    this.saveJobs([...this.jobs(), job].slice(-5));
    return reply(200, { ok: true, fresh: fresh.length, hot: hot.length, queued: true });
  }

  /** お知らせを送る（管理画面から。お知らせを受け取る人に。ジャンルを指定したら、そのジャンルをフォローしている人だけ） */
  broadcast(body: unknown, now: number): PushResponse {
    const news = parseNews(body);
    if (!news) return reply(400, { error: 'タイトルと、サイト内のページ（/ から始まるパス）を確かめてください' });
    if (now - this.lastNews < NEWS_INTERVAL) return reply(429, { error: 'お知らせは5分以上あけて送ってください' });
    this.lastNews = now;
    const base = parseJson(this.store.getMeta('push:base') ?? '"/"');
    const message: PushMessage & { cat: string } = {
      kind: 'news',
      title: news.title,
      body: news.body,
      url: fromPush(news.url, typeof base === 'string' ? base : '/'),
      tag: `news${now}`,
      cat: news.cat,
    };
    const job: PushJob = {
      id: now,
      kind: 'news',
      batch: 0,
      morning: false,
      quietNow: false,
      base: typeof base === 'string' ? base : '/',
      cats: {},
      hot: [],
      items: 0,
      news: message,
      cursor: '',
      targets: 0,
      sent: 0,
      failed: 0,
      removed: 0,
    };
    this.saveJobs([...this.jobs(), job].slice(-5));
    return reply(200, { ok: true, queued: true, subscribers: this.store.countSubscriptions() });
  }

  /** 仕事の材料（はじめて見た記事など。同じ仕事の間はメモリに置いて読み直さない） */
  private itemsFor(job: PushJob) {
    if (this.jobItems?.id !== job.id) {
      // 朝の回は24時間分、それ以外は今回はじめて見た記事だけを読む
      const rows = this.store.itemsSince(job.morning ? job.batch - DAY_MS : job.batch);
      // 夜の間 = 前の日の23時から
      const nightStart = dayStart(jstDay(job.batch)) - 3_600_000;
      this.jobItems = {
        id: job.id,
        fresh: rows.filter((row) => row.batch >= job.batch).map((row) => row.entry),
        overnight: job.morning ? rows.filter((row) => row.batch >= nightStart).map((row) => row.entry) : [],
        day: job.morning ? rows.map((row) => row.entry) : [],
      };
    }
    return this.jobItems;
  }

  /**
   * 仕事を少し進める（購読を BATCH_SIZE 件）。まだ残っていれば true（アラームで続ける）
   */
  async processJobs(now: number): Promise<boolean> {
    const jobs = this.jobs();
    const job = jobs[0];
    if (!job) return false;
    const subscriptions = this.store.subscriptionsAfter(job.cursor, BATCH_SIZE);
    const deliveries: { subscription: StoredSubscription; message: PushMessage }[] = [];
    if (job.kind === 'check') {
      const items = this.itemsFor(job);
      const ctx: NotifyContext = {
        fresh: items.fresh,
        overnight: items.overnight,
        day: items.day,
        hot: job.hot,
        topHot: job.topHot,
        quietNow: job.quietNow,
        morning: job.morning,
        base: job.base,
        cats: job.cats,
      };
      for (const subscription of subscriptions) {
        const message = buildFollowMessage(subscription.settings, ctx);
        if (message) deliveries.push({ subscription, message });
      }
    } else if (job.news) {
      const { cat, ...message } = job.news;
      for (const subscription of subscriptions) {
        const { settings } = subscription;
        if (settings.notify.news && (!cat || settings.follow.cats.includes(cat))) deliveries.push({ subscription, message });
      }
    }

    for (let i = 0; i < deliveries.length; i += CONCURRENCY) {
      const results = await Promise.all(deliveries.slice(i, i + CONCURRENCY).map(({ subscription, message }) => this.deliver(subscription, message, now)));
      for (const result of results) {
        if (result === 'ok') job.sent++;
        else if (result === 'gone') job.removed++;
        else job.failed++;
      }
    }
    job.targets += deliveries.length;
    job.cursor = subscriptions.at(-1)?.id ?? job.cursor;

    if (subscriptions.length < BATCH_SIZE) {
      // 送り終えた
      const title = job.kind === 'news' ? (job.news?.title ?? '') : `新着の記事 ${job.items}件${job.hot.length > 0 ? `・話題 ${job.hot.length}件` : ''}${job.morning ? '（朝のまとめ）' : ''}`;
      if (job.targets > 0 || job.kind === 'news') {
        this.store.addLog({ kind: job.kind === 'news' ? 'news' : 'check', title, items: job.items, targets: job.targets, sent: job.sent, failed: job.failed, removed: job.removed, done: now });
      }
      this.jobItems = undefined;
      jobs.shift();
    } else {
      jobs[0] = job;
    }
    this.saveJobs(jobs);
    return jobs.length > 0;
  }

  /** 管理画面の集計（購読の数・受け取り方・よくフォローされているもの・送った記録） */
  stats(): Record<string, unknown> {
    const all = this.store.allSettings();
    const count = (pick: (settings: PushSettings) => string[]) => {
      const counts = new Map<string, number>();
      for (const settings of all) for (const key of new Set(pick(settings))) counts.set(key, (counts.get(key) ?? 0) + 1);
      return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key, n]) => ({ key, n }));
    };
    return {
      subscribers: all.length,
      modes: {
        follow: all.filter((s) => s.notify.follow && !isEmptyPrefs(s.follow)).length,
        hot: all.filter((s) => s.notify.hot).length,
        news: all.filter((s) => s.notify.news).length,
        daily: all.filter((s) => s.notify.daily).length,
        quiet: all.filter((s) => s.notify.quiet).length,
      },
      cats: count((s) => s.follow.cats),
      srcs: count((s) => s.follow.srcs).slice(0, 30),
      // キーワードは、2人以上がフォローしているものだけ（1人だけの関心を運営者にも見せない）
      words: count((s) => s.follow.words.map((word) => word.toLowerCase()))
        .filter((entry) => entry.n >= 2)
        .slice(0, 30),
      log: this.store.log(30),
      last: parseJson(this.store.getMeta('push:last') ?? 'null'),
      pending: this.jobs().map((job) => ({ kind: job.kind, id: job.id, targets: job.targets, sent: job.sent })),
    };
  }
}
