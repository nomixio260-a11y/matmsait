import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  Aggregator,
  DAY_MS,
  addDays,
  aggregate,
  browserOf,
  channelOf,
  dayStart,
  depthBucket,
  isBot,
  isDay,
  jstDay,
  jstHour,
  mergeRows,
  normalizeQuery,
  osOf,
  parseEvent,
  parseOrigins,
  rankArticles,
  topOf,
  totalsOf,
  visitorId,
  type StoredEvent,
} from '../analytics/src/core.ts';
import { AnalyticsStore, RAW_DAYS, type Sql } from '../analytics/src/store.ts';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

describe('イベントの検証', () => {
  it('入口の閲覧は参照元と再訪の印を残し、入口でなければ消す', () => {
    const landing = parseEvent({ t: 'view', p: '/category/tech/?utm=x#top', k: 'category', c: 'tech', l: 1, r: 'WWW.Google.co.jp', ret: 1, d: 'm' });
    expect(landing?.event).toMatchObject({ type: 'view', path: '/category/tech/', kind: 'category', cat: 'tech', land: 1, ref: 'www.google.co.jp', ret: 1, dev: 'm' });
    const inner = parseEvent({ t: 'view', p: '/', r: 'www.google.com', ret: 1 });
    expect(inner?.event).toMatchObject({ land: 0, ref: '', ret: 0 });
  });

  it('種類ごとに必要な値がなければ受け付けない', () => {
    expect(parseEvent({ t: 'view' })).toBeUndefined();
    expect(parseEvent({ t: 'view', p: 'https://evil.example/' })).toBeUndefined();
    expect(parseEvent({ t: 'click', p: '/', a: 'not-an-id' })).toBeUndefined();
    expect(parseEvent({ t: 'search', q: '   ' })).toBeUndefined();
    expect(parseEvent({ t: 'time', p: '/', n: 0 })).toBeUndefined();
    expect(parseEvent({ t: 'hack', p: '/' })).toBeUndefined();
    expect(parseEvent(null)).toBeUndefined();
    expect(parseEvent([{ t: 'view', p: '/' }])).toBeUndefined();
    expect(parseEvent({ t: 'ping' })?.event.type).toBe('ping');
  });

  it('検索した言葉をそろえ、閲覧時間は30分までにする', () => {
    expect(parseEvent({ t: 'search', q: '  ＡＩ　ニュース\n', n: 0 })?.event.q).toBe('ai ニュース');
    expect(normalizeQuery('あ'.repeat(80))).toHaveLength(50);
    expect(parseEvent({ t: 'time', p: '/', n: 99999 })?.event.n).toBe(1800);
  });

  it('記事の名前と URL は、正しい形のときだけ受け取る', () => {
    const ok = parseEvent({ t: 'click', a: '0123456789abcdef', ti: ' 見出し\n2行目 ', u: 'https://example.jp/news/1', s: 'gigazine', c: 'tech' });
    expect(ok?.article).toEqual({ aid: '0123456789abcdef', title: '見出し 2行目', url: 'https://example.jp/news/1', src: 'gigazine', cat: 'tech' });
    expect(parseEvent({ t: 'click', a: '0123456789abcdef', ti: 'x', u: 'javascript:alert(1)' })?.article).toBeUndefined();
  });

  it('許可するオリジンを読み取る', () => {
    expect(parseOrigins('https://a.github.io/, http://localhost:4321 ,bad')).toEqual(['https://a.github.io', 'http://localhost:4321']);
  });
});

describe('ブラウザと流入元の分類', () => {
  it('ボットや自動のアクセスを見分ける', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBot('curl/8.5.0')).toBe(true);
    expect(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot(CHROME)).toBe(false);
    expect(isBot(IPHONE)).toBe(false);
    expect(isBot('Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toBe(false);
  });

  it('OS とブラウザ', () => {
    expect([osOf(IPHONE), browserOf(IPHONE)]).toEqual(['ios', 'safari']);
    expect([osOf(CHROME), browserOf(CHROME)]).toEqual(['windows', 'chrome']);
    expect(browserOf(`${CHROME} Edg/141.0.0.0`)).toBe('edge');
    expect(browserOf(`${IPHONE} Line/15.0.0`)).toBe('line');
    expect(osOf('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toBe('android');
  });

  it('流入元（AI チャット・検索・SNS・ほか・直接）', () => {
    expect(channelOf('')).toBe('direct');
    expect(channelOf('www.google.co.jp')).toBe('search');
    expect(channelOf('search.yahoo.co.jp')).toBe('search');
    expect(channelOf('news.yahoo.co.jp')).toBe('other');
    expect(channelOf('gemini.google.com')).toBe('ai');
    expect(channelOf('chatgpt.com')).toBe('ai');
    expect(channelOf('t.co')).toBe('social');
    expect(channelOf('bsky.app')).toBe('social');
    expect(channelOf('bluesky')).toBe('social');
    expect(channelOf('example.com')).toBe('other');
  });
});

describe('日付（日本時間）', () => {
  it('日付と時刻', () => {
    const at = Date.parse('2026-10-06T15:30:00Z'); // 日本時間 10/7 0:30
    expect(jstDay(at)).toBe('2026-10-07');
    expect(jstHour(at)).toBe(0);
    expect(dayStart('2026-10-07')).toBe(Date.parse('2026-10-06T15:00:00Z'));
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(isDay('2026-10-07')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('20261007')).toBe(false);
  });
});

const base: StoredEvent = {
  ts: Date.parse('2026-10-07T01:00:00Z'),
  type: 'view',
  vid: 'v1',
  path: '/',
  kind: 'home',
  aid: '',
  src: '',
  cat: '',
  ref: '',
  q: '',
  n: 0,
  dev: 'm',
  os: 'ios',
  br: 'safari',
  country: 'JP',
  ret: 0,
  land: 0,
};
const ev = (patch: Partial<StoredEvent>): StoredEvent => ({ ...base, ...patch });
const A = '0123456789abcdef';
const B = 'fedcba9876543210';

describe('集計', () => {
  const events = [
    ev({ vid: 'v1', land: 1, ref: 'www.google.com' }),
    ev({ vid: 'v1', type: 'click', aid: A, src: 'gigazine', cat: 'tech' }),
    ev({ vid: 'v1', path: '/summary/x/', kind: 'summary', aid: B }),
    ev({ vid: 'v1', type: 'time', path: '/', n: 40 }),
    ev({ vid: 'v2', land: 1, ret: 1 }),
    ev({ vid: 'v3', land: 1, ref: 't.co' }),
    ev({ vid: 'v3', type: 'search', path: '/search/', q: 'ai', n: 0 }),
    ev({ vid: 'v3', type: 'click', aid: A }),
    ev({ vid: 'v3', type: 'save', aid: A }),
  ];
  const rows = aggregate(events);
  const find = (metric: string, key = '') => rows.find((row) => row.metric === metric && row.key === key);

  it('閲覧・訪問・クリック・人数を数える', () => {
    expect(find('all')).toMatchObject({ count: 9, uniq: 3 });
    expect(find('view')).toMatchObject({ count: 4, uniq: 3 });
    expect(find('visit')).toMatchObject({ count: 3, uniq: 3 });
    expect(find('visit.channel', 'search')).toMatchObject({ uniq: 1 });
    expect(find('visit.channel', 'social')).toMatchObject({ uniq: 1 });
    expect(find('visit.channel', 'direct')).toMatchObject({ uniq: 1 });
    expect(find('visit.ret', '1')).toMatchObject({ uniq: 1 });
    expect(find('click')).toMatchObject({ count: 2, uniq: 2 });
    expect(find('click.src', 'gigazine')).toMatchObject({ count: 1 });
    expect(find('search.q', 'ai')).toMatchObject({ count: 1, sum: 1 });
    expect(find('time.path', '/')).toMatchObject({ count: 1, sum: 40 });
    expect(find('view.hour', '10')).toMatchObject({ count: 4 });
  });

  it('記事ごとの人数は、クリック・要約ページの閲覧・保存をまとめて1人1回で数える', () => {
    expect(find('art.aid', A)).toMatchObject({ uniq: 2 });
    expect(find('art.aid', B)).toMatchObject({ uniq: 1 });
    const aggregator = new Aggregator();
    events.forEach((event) => aggregator.push(event));
    expect(rankArticles(aggregator.popularity(), 10)).toEqual([
      { id: A, n: 2 },
      { id: B, n: 1 },
    ]);
  });

  it('見たページ数ごとの人数と、1ページだけで何もせずに離れた人', () => {
    expect(find('depth', '2')).toMatchObject({ uniq: 1 });
    expect(find('depth', '1')).toMatchObject({ uniq: 2 });
    // v3 は1ページだけでも検索・クリックしているので含めない
    expect(find('bounce')).toMatchObject({ uniq: 1 });
    expect(depthBucket(5)).toBe('4-5');
    expect(depthBucket(12)).toBe('10+');
  });

  it('複数の日を足し、合計と内訳の上位を取り出す', () => {
    const merged = mergeRows(rows, rows);
    expect(totalsOf(merged).view).toEqual({ count: 8, uniq: 6, sum: 0 });
    const top = topOf(merged, 1);
    expect(top['art.aid']).toEqual([{ key: A, count: 6, uniq: 4, sum: 0 }]);
    expect(top['view.hour']).toHaveLength(1);
    expect(top.view).toBeUndefined();
  });

  it('訪問者番号は塩が変わると変わる（日をまたいで同じ人を追えない）', async () => {
    const a = await visitorId('salt1', '203.0.113.1', CHROME);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorId('salt1', '203.0.113.1', CHROME)).toBe(a);
    expect(await visitorId('salt2', '203.0.113.1', CHROME)).not.toBe(a);
  });
});

describe('保存（SQLite）', () => {
  const open = () => {
    const db = new DatabaseSync(':memory:');
    const sql: Sql = {
      exec: (query, ...bindings) => {
        const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    };
    const transaction = <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    return { db, store: new AnalyticsStore(sql, transaction) };
  };

  it('生のイベントを保存し、過去の日を日ごとの集計にまとめて期間で読む', () => {
    const { store } = open();
    const today = '2026-10-07';
    const at = (day: string, hour: number) => dayStart(day) + hour * 3_600_000;
    store.insertEvent(ev({ ts: at('2026-10-05', 9), vid: 'a', land: 1, ref: 'www.google.com' }));
    store.insertEvent(ev({ ts: at('2026-10-05', 9), vid: 'a', type: 'click', aid: A }));
    store.insertEvent(ev({ ts: at('2026-10-06', 21), vid: 'b', land: 1 }));
    store.insertEvent(ev({ ts: at('2026-10-06', 22), vid: 'c', type: 'click', aid: A }));
    store.insertEvent(ev({ ts: at(today, 1), vid: 'd' }));
    expect(store.events(dayStart('2026-10-05'), dayStart(today))).toHaveLength(4);

    // 初めての集計は、残っている最も古いイベントの日から昨日まで
    expect(store.rollupPending(today)).toEqual(['2026-10-05', '2026-10-06']);
    expect(store.rollupPending(today)).toEqual([]);
    const rows = store.rollups('2026-10-05', '2026-10-06');
    expect(totalsOf(rows).view).toEqual({ count: 2, uniq: 2, sum: 0 });
    expect(rows.find((row) => row.metric === 'art.aid' && row.key === A)).toMatchObject({ uniq: 2 });
    expect(store.rollups('2026-10-06', '2026-10-06', ['click'])).toEqual([{ metric: 'click', key: '', count: 1, uniq: 1, sum: 0 }]);
    const daily = store.daily('2026-10-05', '2026-10-06', ['view']);
    expect(daily.map((row) => [row.day, row.count])).toEqual([
      ['2026-10-05', 1],
      ['2026-10-06', 1],
    ]);
  });

  it('塩は日ごとに同じものを使い、古いデータと一緒に消える', () => {
    const { store } = open();
    const salt = store.salt('2026-10-06');
    expect(store.salt('2026-10-06')).toBe(salt);
    const todaySalt = store.salt('2026-10-07');
    expect(todaySalt).not.toBe(salt);
    const old = addDays('2026-10-07', -RAW_DAYS - 1);
    store.insertEvent(ev({ ts: dayStart(old) + 1000, vid: 'old' }));
    store.insertEvent(ev({ ts: dayStart('2026-10-07') + 1000, vid: 'new' }));
    store.cleanup('2026-10-07');
    expect(store.events(0, dayStart('2026-10-08')).map((event) => event.vid)).toEqual(['new']);
    // 今日の塩は残し、昨日の塩は消す
    expect(store.salt('2026-10-07')).toBe(todaySalt);
    expect(store.getMeta('salt:2026-10-06')).toBeUndefined();
  });

  it('記事の名前は最初に届いたものを残し、たくさんの ID でも読める', () => {
    const { store } = open();
    store.saveArticle({ aid: A, title: '最初', url: 'https://example.jp/1', src: 's', cat: 'tech' }, 1);
    store.saveArticle({ aid: A, title: '別の名前', url: 'https://example.jp/1', src: 's', cat: 'tech' }, 2);
    const ids = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(16, '0'));
    expect(store.articles([...ids, A])[A].title).toBe('最初');
  });

  it('同じミリ秒に届いたイベントも別々に保存する', () => {
    const { store } = open();
    const ts = Date.now();
    for (let i = 0; i < 5; i++) store.insertEvent(ev({ ts, vid: `v${i}` }));
    expect(store.events(ts - DAY_MS, ts + 1)).toHaveLength(5);
  });
});
