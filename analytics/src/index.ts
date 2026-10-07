/**
 * トピあつめのアクセス解析のサーバー（Cloudflare Workers の無料プラン）。集計は1つの Durable Object（SQLite）が行う。
 * 公開しているサイトでは、この Worker は Durable Object を置くためだけに使い（workers.dev では公開しない）、
 * サイトと同じドメインの /api（Cloudflare Pages の Functions。functions/api/[[path]].ts）から Durable Object を直接使う。
 * 入口（送り元の確認・振り分け）は src/front.ts、受け付ける API も src/front.ts を参照。
 *
 * 運営者かどうかは、管理画面が送る GitHub のトークンでサイトのリポジトリに書き込めるかを GitHub に問い合わせて確かめる
 * （トークンは保存しない。確かめた結果だけを、トークンのハッシュをキーにして10分間覚えておく）
 */
import { DurableObject } from 'cloudflare:workers';
import {
  Aggregator,
  DAY_MS,
  TOTAL_METRICS,
  addDays,
  browserOf,
  dayStart,
  isBot,
  isDay,
  jstDay,
  mergeRows,
  osOf,
  parseEvent,
  rankArticles,
  topOf,
  totalsOf,
  visitorId,
  weekStartDay,
  type StoredEvent,
} from './core.ts';
import { handle } from './front.ts';
import { PushService, PushStore, type PushResponse } from './push.ts';
import { AnalyticsStore, ROLLUP_DAYS } from './store.ts';

export interface Env {
  ANALYTICS: DurableObjectNamespace<Analytics>;
  /** この Worker に直接送るときに受け付けるオリジン（カンマ区切り。手元で試すときの http://localhost:4321 など） */
  ALLOWED_ORIGINS?: string;
  /** サイトのリポジトリ（owner/repo）。運営者の確認に使う */
  REPOSITORY?: string;
  /** GitHub API の URL（試験のときに差し替える） */
  GITHUB_API?: string;
  /** 1日に保存するイベントの上限（無料枠の書き込みの上限を超えないように） */
  MAX_EVENTS_PER_DAY?: string;
  /** 公開しているサイトの URL（通知の送り主の連絡先。この Worker を直接使うときは updates.json をここから読む） */
  SITE_URL?: string;
  /** 通知の試験で使う偽の届け先（host:port のカンマ区切り。手元で試すときだけ設定する） */
  PUSH_TEST_HOSTS?: string;
  /** 通知の購読の数の上限 */
  MAX_PUSH_SUBSCRIBERS?: string;
}

/** いま見ている人とみなす時間（表示中のページは1分ごとに合図を送る） */
const ONLINE_WINDOW = 3 * 60_000;
/** 1人が1分間に送れるイベントの数 */
const RATE_LIMIT = 60;
/** 最近の動きとして覚えておく数 */
const RECENT_LIMIT = 40;
/** 分ごとの閲覧数を覚えておく分数 */
const MINUTES = 30;
const DEFAULT_MAX_EVENTS = 40_000;

interface RecentEvent {
  ts: number;
  type: string;
  path: string;
  kind: string;
  aid: string;
  title: string;
  q: string;
  ref: string;
  country: string;
  dev: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const pushJson = ({ status, data }: PushResponse) => json(data, status);

/** 送られてきた JSON（読めなければ undefined） */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** 送る仕事を続けるときの、次のアラームまでの間隔 */
const PUSH_STEP = 1_000;

const toRecent = (event: StoredEvent, title: string): RecentEvent => ({
  ts: event.ts,
  type: event.type,
  path: event.path,
  kind: event.kind,
  aid: event.aid,
  title,
  q: event.q,
  ref: event.ref,
  country: event.country,
  dev: event.dev,
});

/** 次の集計の時刻（毎時5分） */
const nextAlarm = (now: number) => Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000 + 5 * 60_000;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** トークンの持ち主がサイトのリポジトリに書き込めるか（GitHub に問い合わせる） */
async function canWrite(token: string, env: Env): Promise<boolean> {
  const api = (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'topiatsume-analytics',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  try {
    const res = await fetch(`${api}/repos/${env.REPOSITORY}`, { headers });
    if (!res.ok) return false;
    const repo = (await res.json()) as { permissions?: Record<string, boolean>; owner?: { login?: string } };
    if (repo.permissions) return Boolean(repo.permissions.admin || repo.permissions.maintain || repo.permissions.push);
    // 権限が返らないときは、トークンの持ち主がリポジトリの持ち主かで確かめる
    const user = await fetch(`${api}/user`, { headers });
    if (!user.ok) return false;
    const login = ((await user.json()) as { login?: string }).login;
    return Boolean(login && repo.owner?.login && login.toLowerCase() === repo.owner.login.toLowerCase());
  } catch {
    return false;
  }
}

export class Analytics extends DurableObject<Env> {
  private readonly store: AnalyticsStore;
  /** いま見ている人（訪問者番号 → 最後に届いた時刻・見ているページ） */
  private readonly presence = new Map<string, { at: number; path: string }>();
  private readonly rate = new Map<string, { minute: number; count: number }>();
  private recent: RecentEvent[] = [];
  /** 分ごとの閲覧数・クリック数（分の番号 → 数） */
  private readonly minutes = new Map<number, { views: number; clicks: number }>();
  /** 今日の集計（生のイベントを読み直さずに今日の分を数える） */
  private today?: { day: string; aggregator: Aggregator; stored: number };
  private readonly salts = new Map<string, string>();
  private readonly admins = new Map<string, { ok: boolean; until: number }>();
  private readonly cache = new Map<string, { until: number; data: unknown }>();
  /** 記事の名前（リアルタイムの表示で、記事 ID の代わりに出す。届いたものと読んだものを覚えておく） */
  private readonly titles = new Map<string, string>();
  /** 過去の日を日ごとの集計にまとめ終えた日（毎時の処理の前に集計を見られても、昨日の分が欠けないように） */
  private rolledFor = '';
  private ready = false;
  /** 通知（購読・新着の確認・送信） */
  private readonly push: PushService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const transaction = <T>(fn: () => T) => ctx.storage.transactionSync(fn);
    this.store = new AnalyticsStore(ctx.storage.sql, transaction);
    this.push = new PushService(new PushStore(ctx.storage.sql, transaction), env);
  }

  /** 通知を送る仕事ができたら、すぐにアラームで送り始める */
  private async startPush(now: number) {
    if (this.push.hasJobs()) await this.ctx.storage.setAlarm(now + 50);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    try {
      await this.warmUp(now);
      switch (url.pathname) {
        case '/collect':
          return await this.collect(request, now);
        case '/popular':
          return json(this.popular(now));
        case '/push/key':
          return pushJson(await this.push.publicKey());
        case '/push/subscribe': {
          const vid = await visitorId(this.saltFor(jstDay(now)), request.headers.get('x-ip') ?? '', request.headers.get('x-ua') ?? '');
          return pushJson(await this.push.subscribe(await readJson(request), vid, now));
        }
        case '/push/unsubscribe':
          return pushJson(await this.push.unsubscribe(await readJson(request)));
        case '/push/status':
          return pushJson(await this.push.status(await readJson(request)));
        case '/push/test':
          return pushJson(await this.push.test(await readJson(request), now));
        case '/push/check': {
          const result = this.push.check(await request.text(), now);
          await this.startPush(now);
          return pushJson(result);
        }
        case '/admin/live':
        case '/admin/stats':
        case '/admin/articles':
        case '/admin/push':
        case '/admin/push/send': {
          if (!(await this.isAdmin(request.headers.get('authorization') ?? '', now))) {
            return json({ error: 'GitHub のトークンを確認できませんでした（サイトのリポジトリに書き込めるトークンが必要です）' }, 401);
          }
          if (url.pathname === '/admin/live') return json(this.live(now));
          if (url.pathname === '/admin/articles') return json(this.articleCounts(url, now));
          if (url.pathname === '/admin/push') return json(this.push.stats());
          if (url.pathname === '/admin/push/send') {
            const result = this.push.broadcast(await readJson(request), now);
            await this.startPush(now);
            return pushJson(result);
          }
          return this.statsResponse(url, now);
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: 'internal error' }, 500);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const today = jstDay(now);
    // 通知を送る仕事があれば少し進める（残っていれば、すぐ次のアラームで続ける）
    let pushing = false;
    try {
      pushing = await this.push.processJobs(now);
    } catch (error) {
      console.error(error);
      pushing = this.push.hasJobs();
    }
    try {
      this.ensureRolled(today);
      if (this.store.getMeta('cleaned') !== today) {
        this.store.cleanup(today);
        this.store.setMeta('cleaned', today);
      }
    } catch (error) {
      // 無料枠の上限に達したときなど。次の回にやり直す
      console.error(error);
    }
    this.prune(now);
    await this.ctx.storage.setAlarm(pushing ? now + PUSH_STEP : nextAlarm(now));
  }

  /** 起動して最初の1回だけ: 今日のイベントから、今日の集計・いま見ている人・最近の動きを作り直す */
  private async warmUp(now: number) {
    if (this.ready) return;
    this.ready = true;
    const day = jstDay(now);
    const events = this.store.events(dayStart(day), now + 1);
    const aggregator = new Aggregator();
    for (const event of events) {
      aggregator.push(event);
      this.countMinute(event);
      if (event.ts >= now - ONLINE_WINDOW) this.presence.set(event.vid, { at: event.ts, path: event.path });
    }
    this.recent = events
      .slice(-RECENT_LIMIT)
      .reverse()
      .map((event) => toRecent(event, ''));
    this.today = { day, aggregator, stored: events.length };
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(nextAlarm(now));
  }

  /** 昨日までの日ごとの集計を作る（今日の最初の1回だけ実際に動く） */
  private ensureRolled(today: string) {
    if (this.rolledFor === today) return;
    this.store.rollupPending(today);
    this.rolledFor = today;
  }

  /** 今日の集計（日が変わっていたら新しく始める。昨日の分は毎時の処理が生のイベントから日ごとの集計にまとめる） */
  private todayState(now: number) {
    const day = jstDay(now);
    if (!this.today || this.today.day !== day) this.today = { day, aggregator: new Aggregator(), stored: 0 };
    return this.today;
  }

  private saltFor(day: string): string {
    let salt = this.salts.get(day);
    if (!salt) {
      salt = this.store.salt(day);
      this.salts.set(day, salt);
    }
    return salt;
  }

  /** 1人が短い間に送りすぎていないか */
  private allow(vid: string, now: number): boolean {
    const minute = Math.floor(now / 60_000);
    const entry = this.rate.get(vid);
    if (!entry || entry.minute !== minute) {
      if (this.rate.size > 20_000) this.rate.clear();
      this.rate.set(vid, { minute, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT;
  }

  private online(now: number): number {
    let count = 0;
    for (const [vid, entry] of this.presence) {
      if (entry.at < now - ONLINE_WINDOW) this.presence.delete(vid);
      else count++;
    }
    return count;
  }

  private countMinute(event: StoredEvent) {
    if (event.type !== 'view' && event.type !== 'click') return;
    const minute = Math.floor(event.ts / 60_000);
    const bucket = this.minutes.get(minute) ?? { views: 0, clicks: 0 };
    if (event.type === 'view') bucket.views++;
    else bucket.clicks++;
    this.minutes.set(minute, bucket);
  }

  private maxEvents(): number {
    const value = Number(this.env.MAX_EVENTS_PER_DAY);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_EVENTS;
  }

  private async collect(request: Request, now: number): Promise<Response> {
    const userAgent = request.headers.get('x-ua') ?? '';
    if (isBot(userAgent)) return new Response(null, { status: 204 });
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json({ error: 'bad request' }, 400);
    }
    const parsed = parseEvent(body);
    if (!parsed) return json({ error: 'bad request' }, 400);
    const vid = await visitorId(this.saltFor(jstDay(now)), request.headers.get('x-ip') ?? '', userAgent);
    if (!this.allow(vid, now)) return json({ error: 'too many requests' }, 429);

    const { event, article } = parsed;
    this.presence.set(vid, { at: now, path: event.path || this.presence.get(vid)?.path || '' });
    if (event.type !== 'ping') {
      const stored: StoredEvent = {
        ...event,
        type: event.type,
        ts: now,
        vid,
        os: osOf(userAgent),
        br: browserOf(userAgent),
        country: (request.headers.get('x-country') ?? '').slice(0, 2).toUpperCase(),
      };
      const today = this.todayState(now);
      // 1日の上限を超えたら保存しない（いま見ている人数は数え続ける）
      if (today.stored < this.maxEvents()) {
        this.store.insertEvent(stored);
        if (article) {
          this.store.saveArticle(article, now);
          if (!this.titles.has(article.aid)) this.rememberTitle(article.aid, article.title);
        }
        today.stored++;
        today.aggregator.push(stored);
        this.countMinute(stored);
        this.recent.unshift(toRecent(stored, article?.title ?? ''));
        if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
      }
    }
    return json({ online: this.online(now) });
  }

  private cached<T>(key: string, ttl: number, now: number, compute: () => T): T {
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.data as T;
    const data = compute();
    this.cache.set(key, { until: now + ttl, data });
    return data;
  }

  /** よく読まれている記事（要約ページを読んだ・記事をクリックした・保存した人の数の順） */
  private popular(now: number) {
    return this.cached('popular', 10 * 60_000, now, () => {
      const today = jstDay(now);
      this.ensureRolled(today);
      // 24時間: 生のイベントから数える
      const day = new Aggregator();
      for (const event of this.store.events(now - DAY_MS, now + 1)) if (event.aid) day.push(event);
      // 1週間: 過去6日の集計と今日の分
      const week = new Map<string, number>();
      for (const row of this.store.rollups(addDays(today, -6), addDays(today, -1), ['art.aid'])) week.set(row.key, row.uniq);
      for (const [id, n] of this.todayState(now).aggregator.popularity()) week.set(id, (week.get(id) ?? 0) + n);
      return { generatedAt: new Date(now).toISOString(), day: rankArticles(day.popularity(), 50), week: rankArticles(week, 50) };
    });
  }

  private rememberTitle(aid: string, title: string) {
    if (this.titles.size > 5000) this.titles.clear();
    this.titles.set(aid, title);
  }

  /** 記事の名前（覚えていなければ保存したものを読む。見つからなければ空） */
  private titlesOf(aids: Iterable<string>): Record<string, string> {
    const missing = [...new Set(aids)].filter((aid) => !this.titles.has(aid));
    if (missing.length > 0) {
      const found = this.store.articles(missing);
      for (const aid of missing) this.rememberTitle(aid, found[aid]?.title ?? '');
    }
    const result: Record<string, string> = {};
    for (const aid of new Set(aids)) {
      const title = this.titles.get(aid);
      if (title) result[aid] = title;
    }
    return result;
  }

  private live(now: number) {
    const pages = new Map<string, number>();
    const online = this.online(now);
    for (const entry of this.presence.values()) if (entry.path) pages.set(entry.path, (pages.get(entry.path) ?? 0) + 1);
    const current = Math.floor(now / 60_000);
    const { aggregator } = this.todayState(now);
    // 要約ページ・記事の名前（記事 ID のままでは分からないので）
    const aids = [
      ...this.recent.filter((event) => event.aid).map((event) => event.aid),
      ...[...pages.keys()].flatMap((path) => path.match(/^\/summary\/([0-9a-f]{16})\/$/)?.[1] ?? []),
    ];
    return {
      titles: this.titlesOf(aids),
      now: new Date(now).toISOString(),
      online,
      pages: [...pages]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([path, n]) => ({ path, n })),
      minutes: Array.from({ length: MINUTES }, (_, i) => {
        const minute = current - (MINUTES - 1 - i);
        const bucket = this.minutes.get(minute);
        return { t: minute * 60_000, views: bucket?.views ?? 0, clicks: bucket?.clicks ?? 0 };
      }),
      recent: this.recent,
      // この週（月曜から）・この月の訪問者数（その期間に初めて来た人を、日ごとに足したもの）
      period: this.periodVisitors(now),
      today: {
        visitors: aggregator.total('all').uniq,
        views: aggregator.total('view').count,
        visits: aggregator.total('visit').count,
        clicks: aggregator.total('click').count,
      },
    };
  }

  /** この週・この月の訪問者数（WAU・MAU） */
  private periodVisitors(now: number): { week: number; month: number; weekFrom: string; monthFrom: string } {
    const today = jstDay(now);
    this.ensureRolled(today);
    const weekFrom = weekStartDay(today);
    const monthFrom = `${today.slice(0, 8)}01`;
    const { aggregator } = this.todayState(now);
    const past = (from: string, metric: string) => (from < today ? this.store.rollups(from, addDays(today, -1), [metric]) : []).reduce((sum, row) => sum + row.count, 0);
    return {
      week: past(weekFrom, 'visit.wk') + aggregator.total('visit.wk').count,
      month: past(monthFrom, 'visit.mo') + aggregator.total('visit.mo').count,
      weekFrom,
      monthFrom,
    };
  }

  private statsResponse(url: URL, now: number): Response {
    const today = jstDay(now);
    const from = url.searchParams.get('from') ?? today;
    const to = url.searchParams.get('to') ?? today;
    if (!isDay(from) || !isDay(to) || from > to || to > today || from < addDays(today, -ROLLUP_DAYS)) {
      return json({ error: '期間の指定が正しくありません' }, 400);
    }
    return json(this.cached(`stats:${from}:${to}`, to === today ? 30_000 : 10 * 60_000, now, () => this.stats(from, to, now)));
  }

  /** 期間 [from, to] の集計（過去の日は日ごとの集計から、今日の分はメモリの集計から） */
  private stats(from: string, to: string, now: number) {
    const today = jstDay(now);
    this.ensureRolled(today);
    const pastTo = to < today ? to : addDays(today, -1);
    const live = to === today ? this.todayState(now).aggregator.rows() : [];
    const rows = mergeRows(this.store.rollups(from, pastTo), live);
    const days = Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;
    const previous = totalsOf(this.store.rollups(addDays(from, -days), addDays(from, -1), TOTAL_METRICS));

    // 推移: 1日だけなら時間ごと、複数の日なら日ごと
    let series: { label: string; views: number; visitors: number; clicks: number }[];
    if (from === to) {
      const hours = from === today ? live.filter((row) => row.metric === 'view.hour') : this.store.rollups(from, from, ['view.hour']);
      const byHour = new Map(hours.map((row) => [row.key, row]));
      series = Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.get(String(hour).padStart(2, '0'));
        return { label: `${hour}時`, views: row?.count ?? 0, visitors: row?.uniq ?? 0, clicks: 0 };
      });
    } else {
      const daily = this.store.daily(from, pastTo, ['view', 'all', 'click']);
      const value = (day: string, metric: string) => daily.find((row) => row.day === day && row.metric === metric);
      series = [];
      for (let day = from; day <= to; day = addDays(day, 1)) {
        if (day === today) {
          const { aggregator } = this.todayState(now);
          series.push({ label: day, views: aggregator.total('view').count, visitors: aggregator.total('all').uniq, clicks: aggregator.total('click').count });
        } else {
          series.push({
            label: day,
            views: value(day, 'view')?.count ?? 0,
            visitors: value(day, 'all')?.uniq ?? 0,
            clicks: value(day, 'click')?.count ?? 0,
          });
        }
      }
    }

    const top = topOf(rows, 100);
    const aids = ['art.aid', 'click.aid', 'save.aid', 'view.aid'].flatMap((metric) => (top[metric] ?? []).map((row) => row.key));
    return {
      from,
      to,
      days,
      generatedAt: new Date(now).toISOString(),
      totals: totalsOf(rows),
      previous,
      series,
      top,
      articles: this.store.articles(aids),
    };
  }

  /** 記事ごとの人数（直近 days 日。管理画面で要約する記事を選ぶときの並べ替えに使う） */
  private articleCounts(url: URL, now: number) {
    const days = Math.min(90, Math.max(1, Math.floor(Number(url.searchParams.get('days')) || 7)));
    return this.cached(`articles:${days}`, 5 * 60_000, now, () => {
      const today = jstDay(now);
      this.ensureRolled(today);
      const counts = new Map<string, number>();
      for (const row of this.store.rollups(addDays(today, -(days - 1)), addDays(today, -1), ['art.aid'])) counts.set(row.key, row.uniq);
      for (const [id, n] of this.todayState(now).aggregator.popularity()) counts.set(id, (counts.get(id) ?? 0) + n);
      return { days, generatedAt: new Date(now).toISOString(), items: rankArticles(counts, 1000) };
    });
  }

  private async isAdmin(authorization: string, now: number): Promise<boolean> {
    const token = authorization.match(/^Bearer\s+(\S{20,255})$/i)?.[1];
    if (!token || !this.env.REPOSITORY) return false;
    const key = await sha256(token);
    const cached = this.admins.get(key);
    if (cached && cached.until > now) return cached.ok;
    const ok = await canWrite(token, this.env);
    this.admins.set(key, { ok, until: now + (ok ? 10 * 60_000 : 60_000) });
    return ok;
  }

  /** メモリの古い情報を消す */
  private prune(now: number) {
    this.online(now);
    const minute = Math.floor(now / 60_000);
    for (const [vid, entry] of this.rate) if (entry.minute < minute) this.rate.delete(vid);
    for (const key of this.minutes.keys()) if (key < minute - MINUTES) this.minutes.delete(key);
    for (const [key, entry] of this.admins) if (entry.until <= now) this.admins.delete(key);
    for (const [key, entry] of this.cache) if (entry.until <= now) this.cache.delete(key);
    const today = jstDay(now);
    for (const day of this.salts.keys()) if (day !== today) this.salts.delete(day);
  }
}

/** 手元で試すときの入口（公開しているサイトでは、Pages Functions が同じ処理をサイトの /api で行う） */
export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
