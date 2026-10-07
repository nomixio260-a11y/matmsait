/**
 * アクセス解析のデータの保存（SQLite）。Durable Object の SQL（ctx.storage.sql）でも、テストの node:sqlite でも動くよう、
 * 使う機能は exec(...).toArray() だけにしている。
 *
 * 無料枠（1日に書き込み10万行・読み込み500万行）に収まるよう:
 * - 生のイベントは events に1件1行（主キーを時刻にして、別の索引を作らない＝書き込みは1行）。14日で消す
 * - 過去の日は日ごとの集計（daily）にまとめ、期間の集計は daily から読む（今日の分はメモリで数える）
 */
import { DAY_MS, METRICS, addDays, aggregate, dayStart, jstDay, newSalt, type ArticleInfo, type RollupRow, type StoredEvent } from './core.ts';

type SqlValue = string | number | null;
export interface Sql {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, unknown>[] };
}

/** 生のイベントを残す日数（日ごとの集計を作り直せるように少し長めに残す） */
export const RAW_DAYS = 14;
/** 日ごとの集計を残す日数 */
export const ROLLUP_DAYS = 400;

const EVENT_COLUMNS = ['type', 'vid', 'path', 'kind', 'aid', 'src', 'cat', 'ref', 'q', 'n', 'dev', 'os', 'br', 'country', 'ret', 'land'] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL, vid TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, aid TEXT NOT NULL,
    src TEXT NOT NULL, cat TEXT NOT NULL, ref TEXT NOT NULL, q TEXT NOT NULL, n INTEGER NOT NULL,
    dev TEXT NOT NULL, os TEXT NOT NULL, br TEXT NOT NULL, country TEXT NOT NULL, ret INTEGER NOT NULL, land INTEGER NOT NULL
  )`,
  // metric を先頭にして、「この指標のこの期間」を索引だけで読めるようにする
  `CREATE TABLE IF NOT EXISTS daily (
    metric TEXT NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL,
    count INTEGER NOT NULL, uniq INTEGER NOT NULL, sum INTEGER NOT NULL,
    PRIMARY KEY (metric, day, key)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS articles (
    aid TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, src TEXT NOT NULL, cat TEXT NOT NULL, seen INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
];

const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const text = (value: unknown) => (typeof value === 'string' ? value : '');

function toEvent(row: Record<string, unknown>): StoredEvent {
  return {
    ts: Math.floor(num(row.id) / 1000),
    type: text(row.type) as StoredEvent['type'],
    vid: text(row.vid),
    path: text(row.path),
    kind: text(row.kind),
    aid: text(row.aid),
    src: text(row.src),
    cat: text(row.cat),
    ref: text(row.ref),
    q: text(row.q),
    n: num(row.n),
    dev: text(row.dev),
    os: text(row.os),
    br: text(row.br),
    country: text(row.country),
    ret: num(row.ret),
    land: num(row.land),
  };
}

const toRow = (row: Record<string, unknown>): RollupRow => ({
  metric: text(row.metric),
  key: text(row.key),
  count: num(row.count),
  uniq: num(row.uniq),
  sum: num(row.sum),
});

export class AnalyticsStore {
  private seq = 0;

  constructor(
    private readonly sql: Sql,
    /** 書き込みをまとめて1つのトランザクションにする（Durable Object では ctx.storage.transactionSync） */
    private readonly transaction: <T>(fn: () => T) => T = (fn) => fn(),
  ) {
    for (const statement of SCHEMA) sql.exec(statement);
  }

  getMeta(key: string): string | undefined {
    const [row] = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray();
    return row ? text(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
  }

  /** その日の塩（なければ作る）。訪問者番号を作るのに使い、日が変わったら消す */
  salt(day: string): string {
    const key = `salt:${day}`;
    const current = this.getMeta(key);
    if (current) return current;
    const salt = newSalt();
    this.setMeta(key, salt);
    return salt;
  }

  insertEvent(event: StoredEvent): void {
    // 主キー = 時刻（ミリ秒）× 1000 + 通し番号（同じミリ秒に届いたイベントを見分ける）
    this.seq = (this.seq + 1) % 1000;
    this.sql.exec(
      `INSERT OR IGNORE INTO events (id, ${EVENT_COLUMNS.join(', ')}) VALUES (?${', ?'.repeat(EVENT_COLUMNS.length)})`,
      event.ts * 1000 + this.seq,
      ...EVENT_COLUMNS.map((column) => event[column]),
    );
  }

  /** 記事の名前と URL（はじめて届いたときだけ保存する） */
  saveArticle(article: ArticleInfo, now: number): void {
    this.sql.exec(
      'INSERT OR IGNORE INTO articles (aid, title, url, src, cat, seen) VALUES (?, ?, ?, ?, ?, ?)',
      article.aid,
      article.title,
      article.url,
      article.src,
      article.cat,
      now,
    );
  }

  /** [from, to) の生のイベント（古い順） */
  events(from: number, to: number): StoredEvent[] {
    return this.sql
      .exec(`SELECT id, ${EVENT_COLUMNS.join(', ')} FROM events WHERE id >= ? AND id < ? ORDER BY id`, from * 1000, to * 1000)
      .toArray()
      .map(toEvent);
  }

  /** その日の生のイベントを日ごとの集計にまとめる（何度実行しても同じ結果になる） */
  rollupDay(day: string): number {
    const rows = aggregate(this.events(dayStart(day), dayStart(day) + DAY_MS));
    this.transaction(() => {
      for (const row of rows) {
        this.sql.exec(
          'INSERT OR REPLACE INTO daily (metric, day, key, count, uniq, sum) VALUES (?, ?, ?, ?, ?, ?)',
          row.metric,
          day,
          row.key,
          row.count,
          row.uniq,
          row.sum,
        );
      }
    });
    return rows.length;
  }

  /** まだ日ごとの集計にしていない過去の日（昨日まで）をまとめる。まとめた日を返す */
  rollupPending(today: string): string[] {
    const earliest = addDays(today, -RAW_DAYS);
    const last = this.getMeta('rolled');
    let day: string;
    if (last) {
      day = addDays(last, 1);
    } else {
      // 初めて動いたときは、残っている最も古いイベントの日から
      const [row] = this.sql.exec('SELECT MIN(id) AS id FROM events').toArray();
      day = row?.id ? jstDay(Math.floor(num(row.id) / 1000)) : today;
    }
    if (day < earliest) day = earliest;
    const done: string[] = [];
    for (; day < today; day = addDays(day, 1)) {
      this.rollupDay(day);
      this.setMeta('rolled', day);
      done.push(day);
    }
    return done;
  }

  /** 古いデータを消す（生のイベントは RAW_DAYS 日、集計は ROLLUP_DAYS 日、塩は今日の分だけ残す） */
  cleanup(today: string): void {
    this.sql.exec('DELETE FROM events WHERE id < ?', dayStart(addDays(today, -RAW_DAYS)) * 1000);
    const oldest = addDays(today, -ROLLUP_DAYS);
    for (const metric of METRICS) this.sql.exec('DELETE FROM daily WHERE metric = ? AND day < ?', metric, oldest);
    this.sql.exec('DELETE FROM articles WHERE seen < ?', dayStart(oldest));
    this.sql.exec("DELETE FROM meta WHERE key >= 'salt:' AND key < ?", `salt:${today}`);
  }

  /** 日ごとの集計を期間 [fromDay, toDay] でまとめる（metrics を指定すると、その指標だけ） */
  rollups(fromDay: string, toDay: string, metrics: readonly string[] = METRICS): RollupRow[] {
    if (fromDay > toDay || metrics.length === 0) return [];
    return this.sql
      .exec(
        `SELECT metric, key, SUM(count) AS count, SUM(uniq) AS uniq, SUM(sum) AS sum FROM daily
         WHERE metric IN (${metrics.map(() => '?').join(', ')}) AND day >= ? AND day <= ? GROUP BY metric, key`,
        ...metrics,
        fromDay,
        toDay,
      )
      .toArray()
      .map(toRow);
  }

  /** 日ごとの値（グラフ用） */
  daily(fromDay: string, toDay: string, metrics: readonly string[]): (RollupRow & { day: string })[] {
    if (fromDay > toDay || metrics.length === 0) return [];
    return this.sql
      .exec(
        `SELECT metric, day, key, count, uniq, sum FROM daily
         WHERE metric IN (${metrics.map(() => '?').join(', ')}) AND day >= ? AND day <= ? ORDER BY day`,
        ...metrics,
        fromDay,
        toDay,
      )
      .toArray()
      .map((row) => ({ ...toRow(row), day: text(row.day) }));
  }

  /** 記事の名前と URL（一度に聞けるのは90件ずつ） */
  articles(aids: string[]): Record<string, ArticleInfo> {
    const result: Record<string, ArticleInfo> = {};
    const unique = [...new Set(aids)];
    for (let i = 0; i < unique.length; i += 90) {
      const chunk = unique.slice(i, i + 90);
      const rows = this.sql
        .exec(`SELECT aid, title, url, src, cat FROM articles WHERE aid IN (${chunk.map(() => '?').join(', ')})`, ...chunk)
        .toArray();
      for (const row of rows) {
        result[text(row.aid)] = { aid: text(row.aid), title: text(row.title), url: text(row.url), src: text(row.src), cat: text(row.cat) };
      }
    }
    return result;
  }
}
