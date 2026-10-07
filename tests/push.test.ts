import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { dayStart } from '../analytics/src/core.ts';
import {
  BATCH_SIZE,
  DEFAULT_NOTIFY,
  PushService,
  PushStore,
  buildFollowMessage,
  cleanSettings,
  fromPush,
  isPushEndpoint,
  parseNews,
  parseTarget,
  subscriptionId,
  type NotifyContext,
  type PushMessage,
  type PushSettings,
} from '../analytics/src/push.ts';
import type { Sql } from '../analytics/src/store.ts';
import type { UpdateEntry, UpdateTopic } from '../src/lib/follow-core.ts';
import { browserKeys, decryptPush } from './helpers/webpush.ts';

const entry = (i: number, over: Partial<UpdateEntry> = {}): UpdateEntry => ({
  i: i.toString(16).padStart(16, '0'),
  t: `記事${i}`,
  c: 'tech',
  s: 'gigazine',
  n: 'GIGAZINE',
  u: `https://gigazine.net/news/${i}/`,
  d: '2026-10-07T01:00:00.000Z',
  ...over,
});

const settings = (over: { follow?: Partial<PushSettings['follow']>; notify?: Partial<PushSettings['notify']>; mute?: Partial<PushSettings['mute']> }): PushSettings => ({
  follow: { cats: [], srcs: [], words: [], ...over.follow },
  mute: { cats: [], srcs: [], words: [], ...over.mute },
  notify: { ...DEFAULT_NOTIFY, ...over.notify },
});

const ctx = (over: Partial<NotifyContext> = {}): NotifyContext => ({
  fresh: [],
  overnight: [],
  day: [],
  hot: [],
  quietNow: false,
  morning: false,
  base: '/',
  cats: { tech: 'テクノロジー', sports: 'スポーツ' },
  ...over,
});

describe('購読の確認', () => {
  it('通知を届ける会社の URL だけを受け付ける', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(isPushEndpoint('https://wns2-by3p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://user@fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('http://127.0.0.1:9999/push/1')).toBe(false);
    expect(isPushEndpoint('http://127.0.0.1:9999/push/1', ['127.0.0.1:9999'])).toBe(true);
    expect(isPushEndpoint(`https://fcm.googleapis.com/${'x'.repeat(1100)}`)).toBe(false);
  });

  it('購読の鍵の形を確かめる', async () => {
    const browser = await browserKeys();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(parseTarget({ endpoint, keys: { p256dh: browser.p256dh, auth: browser.authText } })).toEqual({ endpoint, p256dh: browser.p256dh, auth: browser.authText });
    expect(parseTarget({ endpoint, keys: { p256dh: browser.p256dh.slice(4), auth: browser.authText } })).toBeUndefined();
    expect(parseTarget({ endpoint, keys: { p256dh: browser.p256dh, auth: 'xx' } })).toBeUndefined();
    expect(parseTarget({ endpoint: 'https://evil.example/', keys: { p256dh: browser.p256dh, auth: browser.authText } })).toBeUndefined();
    expect(parseTarget('nope')).toBeUndefined();
  });

  it('設定は既定値で埋め、お知らせは管理画面の入力を確かめる', () => {
    expect(cleanSettings(undefined)).toEqual({ follow: { cats: [], srcs: [], words: [] }, mute: { cats: [], srcs: [], words: [] }, notify: DEFAULT_NOTIFY });
    expect(cleanSettings({ notify: { daily: true, hot: 'yes' } }).notify).toEqual({ ...DEFAULT_NOTIFY, daily: true });
    expect(parseNews({ title: '大きなニュース', body: '本文', url: '/summary/0123456789abcdef/' })).toEqual({
      title: '大きなニュース',
      body: '本文',
      url: '/summary/0123456789abcdef/',
      cat: '',
    });
    expect(parseNews({ title: '', url: '/' })).toBeUndefined();
    expect(parseNews({ title: 'x', url: 'https://evil.example/' })).toBeUndefined();
    expect(parseNews({ title: 'x', url: '//evil.example/' })).toBeUndefined();
    expect(parseNews({ title: 'x', url: '/', cat: 'Bad Cat' })).toBeUndefined();
    expect(fromPush('/following/', '/matmsait/')).toBe('/matmsait/following/?utm_source=push');
    expect(fromPush('/following/?a=1#a-x', '/')).toBe('/following/?a=1&utm_source=push#a-x');
  });
});

describe('通知の中身', () => {
  const tech = settings({ follow: { cats: ['tech'] } });

  it('1件なら記事の見出し（要約があれば要約ページ、なければフォロー中のページでその記事）', () => {
    const one = buildFollowMessage(tech, ctx({ fresh: [entry(1)] }));
    expect(one).toEqual({
      kind: 'follow',
      title: '記事1',
      body: 'GIGAZINE・テクノロジーをフォロー中',
      url: '/following/?utm_source=push#a-0000000000000001',
      tag: 'follow',
    });
    const summarized = buildFollowMessage(tech, ctx({ fresh: [entry(2, { m: 1, u: '/summary/0000000000000002/' })], base: '/matmsait/' }));
    expect(summarized?.url).toBe('/matmsait/summary/0000000000000002/?utm_source=push');
    const word = buildFollowMessage(settings({ follow: { words: ['記事3'] } }), ctx({ fresh: [entry(3)] }));
    expect(word?.body).toBe('GIGAZINE・キーワード「記事3」');
  });

  it('複数なら件数と見出しを3件まで。話題を受け取る人には、いちばんの話題を添える', () => {
    const topic: UpdateTopic = { i: ['00000000000000aa'], t: '大きな出来事', k: 6, u: '/summary/00000000000000aa/' };
    const many = buildFollowMessage(settings({ follow: { cats: ['tech'] }, notify: { hot: true } }), ctx({ fresh: [1, 2, 3, 4, 5].map((i) => entry(i)), hot: [topic] }));
    expect(many?.title).toBe('フォロー中の新着 5件');
    expect(many?.body.split('\n')).toEqual(['・記事1', '・記事2', '・記事3', 'ほか2件', 'いま話題: 大きな出来事']);
    expect(many?.url).toBe('/following/?utm_source=push');
    const hotOnly = buildFollowMessage(settings({ notify: { hot: true } }), ctx({ hot: [topic] }));
    expect(hotOnly).toMatchObject({ kind: 'hot', title: 'いま話題（6社が報道）', body: '大きな出来事', url: '/summary/00000000000000aa/?utm_source=push' });
    // 話題を受け取らない人・当てはまる記事がない人には送らない
    expect(buildFollowMessage(tech, ctx({ hot: [topic] }))).toBeUndefined();
    expect(buildFollowMessage(tech, ctx({ fresh: [entry(9, { c: 'sports' })] }))).toBeUndefined();
  });

  it('夜は送らず朝にまとめる人・1日1回にまとめる人', () => {
    const night = settings({ follow: { cats: ['tech'] }, notify: { quiet: true } });
    const awake = settings({ follow: { cats: ['tech'] }, notify: { quiet: false } });
    const daily = settings({ follow: { cats: ['tech'] }, notify: { daily: true } });
    const atNight = ctx({ fresh: [entry(1)], quietNow: true });
    expect(buildFollowMessage(night, atNight)).toBeUndefined();
    expect(buildFollowMessage(awake, atNight)?.title).toBe('記事1');
    expect(buildFollowMessage(daily, atNight)).toBeUndefined();
    const morning = ctx({ fresh: [entry(5)], overnight: [entry(5), entry(4), entry(3)], day: [1, 2, 3, 4, 5].map((i) => entry(i)), morning: true });
    expect(buildFollowMessage(night, morning)?.title).toBe('きょうのフォロー中の新着 3件');
    expect(buildFollowMessage(daily, morning)?.title).toBe('きょうのフォロー中の新着 5件');
    expect(buildFollowMessage(daily, ctx({ fresh: [entry(1)] }))).toBeUndefined();
  });
});

// ===== 購読の保存と送信（SQLite と偽の届け先） =====

function openStore() {
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
  return new PushStore(sql, transaction);
}

/** 偽の届け先（受け取ったリクエストを記録する。status で返事を変えられる） */
function fakePushService(status: (request: Request) => number = () => 201) {
  const received: Request[] = [];
  const send = async (request: Request) => {
    received.push(request.clone());
    return new Response(null, { status: status(request) });
  };
  return { received, send };
}

async function subscriber(id: string) {
  const browser = await browserKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${id}`;
  return { browser, endpoint, json: { endpoint, keys: { p256dh: browser.p256dh, auth: browser.authText } } };
}

const updates = (builtAt: string, items: UpdateEntry[], hot: UpdateTopic[] = []) =>
  JSON.stringify({ builtAt, base: '/', cats: { tech: 'テクノロジー', news: 'ニュース' }, items, hot });

async function messagesOf(received: Request[], people: Awaited<ReturnType<typeof subscriber>>[]): Promise<Map<string, PushMessage>> {
  const out = new Map<string, PushMessage>();
  for (const request of received) {
    const person = people.find((p) => p.endpoint === request.url);
    if (!person) throw new Error(`知らない届け先: ${request.url}`);
    out.set(person.endpoint.split('/').at(-1)!, JSON.parse(await decryptPush(new Uint8Array(await request.arrayBuffer()), person.browser)));
  }
  return out;
}

/** 日本時間の時刻 */
const jst = (day: string, hour: number, minute = 0) => dayStart(day) + hour * 3_600_000 + minute * 60_000;

describe('通知のサーバー', () => {
  it('購読の登録・変更・取り消し（同じ URL は同じ鍵でしか変えられない）', async () => {
    const store = openStore();
    const service = new PushService(store, {});
    const now = jst('2026-10-07', 12);
    const a = await subscriber('a');
    const key = (await service.publicKey()).data as { key: string };
    expect(key.key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect((await service.publicKey()).data).toEqual(key);

    const ok = await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] } } }, 'v1', now);
    expect(ok).toEqual({ status: 200, data: { ok: true, subscribed: true } });
    expect(store.countSubscriptions()).toBe(1);
    // 別の鍵で同じ URL を変えようとしても断る
    const other = await subscriber('a');
    expect((await service.subscribe({ subscription: other.json, settings: {} }, 'v2', now)).status).toBe(403);
    expect((await service.status({ endpoint: a.endpoint, auth: a.browser.authText })).data).toEqual({ subscribed: true });
    expect((await service.status({ endpoint: a.endpoint, auth: other.browser.authText })).data).toEqual({ subscribed: false });
    // 何も受け取らない設定にしたら消す
    const none = await service.subscribe({ subscription: a.json, settings: { notify: { follow: false, hot: false, news: false } } }, 'v1', now);
    expect(none.data).toEqual({ ok: true, subscribed: false });
    expect(store.countSubscriptions()).toBe(0);
    expect((await service.subscribe({ subscription: { endpoint: 'https://evil.example/', keys: {} }, settings: {} }, 'v1', now)).status).toBe(400);

    await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] } } }, 'v1', now);
    // 購読を作り直したとき: 前の購読の認証の秘密が合えば設定を引き継ぎ、前の購読は消す
    const renewed = await subscriber('a-renewed');
    expect((await service.subscribe({ subscription: renewed.json, replaces: a.endpoint, replacesAuth: 'wrong' }, 'v1', now)).status).toBe(404);
    expect((await service.subscribe({ subscription: other.json, replaces: a.endpoint, replacesAuth: a.browser.authText }, 'v1', now)).status).toBe(403);
    expect((await service.subscribe({ subscription: renewed.json, replaces: a.endpoint, replacesAuth: a.browser.authText }, 'v1', now)).status).toBe(200);
    const moved = store.getSubscription(await subscriptionId(renewed.endpoint));
    expect(moved?.settings.follow.cats).toEqual(['tech']);
    expect(store.getSubscription(await subscriptionId(a.endpoint))).toBeUndefined();
    await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] } } }, 'v1', now);
    await service.unsubscribe({ endpoint: renewed.endpoint, auth: renewed.browser.authText });
    await service.unsubscribe({ endpoint: a.endpoint, auth: other.browser.authText });
    expect(store.countSubscriptions()).toBe(1);
    await service.unsubscribe({ endpoint: a.endpoint, auth: a.browser.authText });
    expect(store.countSubscriptions()).toBe(0);
  });

  it('短い間に何度も登録・変更されたら断る', async () => {
    const service = new PushService(openStore(), {});
    const a = await subscriber('a');
    const now = jst('2026-10-07', 12);
    const results = [];
    for (let i = 0; i < 31; i++) results.push((await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] } } }, 'same', now)).status);
    expect(results.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(results[30]).toBe(429);
    expect((await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] } } }, 'same', now + 3_600_000)).status).toBe(200);
  });

  it('最初の確認は記録だけ。次から、はじめて見た記事をフォローと照らし合わせて送る', async () => {
    const store = openStore();
    const fake = fakePushService();
    const service = new PushService(store, {}, fake.send);
    const a = await subscriber('a');
    const b = await subscriber('b');
    const c = await subscriber('c');
    let now = jst('2026-10-07', 12);
    await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] }, notify: { quiet: false } } }, 'va', now);
    await service.subscribe({ subscription: b.json, settings: { follow: { words: ['地震'] }, notify: { quiet: false } } }, 'vb', now);
    await service.subscribe({ subscription: c.json, settings: { follow: { cats: ['sports'] }, notify: { quiet: false } } }, 'vc', now);

    const first = service.check(updates('b1', [entry(1), entry(2)]), now);
    expect(first.data).toMatchObject({ fresh: 0, queued: false });
    expect(service.hasJobs()).toBe(false);

    now += 3_600_000;
    const second = service.check(updates('b2', [entry(3, { t: '新しいスマホ' }), entry(4, { c: 'news', t: '東京で地震' }), entry(1), entry(2)]), now);
    expect(second.data).toMatchObject({ fresh: 2, queued: true });
    // 同じビルドは2回扱わない
    expect(service.check(updates('b2', [entry(3)]), now).data).toMatchObject({ duplicate: true });

    expect(await service.processJobs(now)).toBe(false);
    const messages = await messagesOf(fake.received, [a, b, c]);
    expect([...messages.keys()].sort()).toEqual(['a', 'b']);
    expect(messages.get('a')).toMatchObject({ kind: 'follow', title: '新しいスマホ', body: 'GIGAZINE・テクノロジーをフォロー中' });
    expect(messages.get('b')).toMatchObject({ kind: 'follow', title: '東京で地震', body: 'GIGAZINE・キーワード「地震」' });
    const [log] = store.log(5);
    expect(log).toMatchObject({ kind: 'check', items: 2, targets: 2, sent: 2, failed: 0, removed: 0 });
    // 届け先へのリクエストは VAPID の証明つき
    expect(fake.received[0].headers.get('Authorization')).toMatch(/^vapid t=.+, k=/);
  });

  it('取り消された購読は消し、続けて失敗した購読もいずれ消す', async () => {
    const store = openStore();
    const fake = fakePushService((request) => (request.url.endsWith('/gone') ? 410 : request.url.endsWith('/bad') ? 400 : 201));
    const service = new PushService(store, {}, fake.send);
    const gone = await subscriber('gone');
    const bad = await subscriber('bad');
    const now = jst('2026-10-07', 12);
    for (const person of [gone, bad]) {
      await service.subscribe({ subscription: person.json, settings: { follow: { cats: ['tech'] }, notify: { quiet: false } } }, person.endpoint, now);
    }
    service.check(updates('b1', []), now);
    for (let round = 1; round <= 5; round++) {
      service.check(updates(`r${round}`, [entry(100 + round)]), now + round * 3_600_000);
      while (await service.processJobs(now + round * 3_600_000));
      if (round === 1) {
        expect(store.getSubscription(await subscriptionId(gone.endpoint))).toBeUndefined();
        expect(store.countSubscriptions()).toBe(1);
      }
    }
    expect(store.countSubscriptions()).toBe(0);
    expect(store.log(10).map((entry) => entry.removed).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('購読が多いときは40件ずつ処理して、アラームで続ける', async () => {
    const store = openStore();
    const fake = fakePushService();
    const service = new PushService(store, {}, fake.send);
    const now = jst('2026-10-07', 12);
    const people = [];
    for (let i = 0; i < BATCH_SIZE + 5; i++) {
      const person = await subscriber(`p${i}`);
      people.push(person);
      await service.subscribe({ subscription: person.json, settings: { follow: { cats: ['tech'] }, notify: { quiet: false } } }, `v${i}`, now);
    }
    service.check(updates('b1', []), now);
    service.check(updates('b2', [entry(1)]), now + 60_000);
    expect(await service.processJobs(now + 60_000)).toBe(true);
    expect(fake.received).toHaveLength(BATCH_SIZE);
    expect(await service.processJobs(now + 61_000)).toBe(false);
    expect(fake.received).toHaveLength(BATCH_SIZE + 5);
    expect(new Set(fake.received.map((request) => request.url)).size).toBe(BATCH_SIZE + 5);
  });

  it('夜の新着は朝にまとめ、1日1回の人には朝に24時間分を送る', async () => {
    const store = openStore();
    const fake = fakePushService();
    const service = new PushService(store, {}, fake.send);
    const night = await subscriber('night');
    const daily = await subscriber('daily');
    const start = jst('2026-10-07', 20);
    await service.subscribe({ subscription: night.json, settings: { follow: { cats: ['tech'] }, notify: { quiet: true } } }, 'n', start);
    await service.subscribe({ subscription: daily.json, settings: { follow: { cats: ['tech'] }, notify: { daily: true } } }, 'd', start);
    service.check(updates('b0', []), start);
    // 20時: 夜の人には送るが、1日1回の人には送らない
    service.check(updates('b1', [entry(1)]), jst('2026-10-07', 21));
    while (await service.processJobs(jst('2026-10-07', 21)));
    expect((await messagesOf(fake.received, [night, daily])).has('daily')).toBe(false);
    expect(fake.received).toHaveLength(1);
    // 0時・3時: 夜なので誰にも送らない
    service.check(updates('b2', [entry(2), entry(1)]), jst('2026-10-08', 0));
    service.check(updates('b3', [entry(3), entry(2), entry(1)]), jst('2026-10-08', 3));
    while (await service.processJobs(jst('2026-10-08', 3)));
    expect(fake.received).toHaveLength(1);
    // 7時: 夜の間の分（2・3と7時の4）をまとめて、1日1回の人には24時間分（1〜4）
    fake.received.length = 0;
    service.check(updates('b4', [entry(4), entry(3), entry(2), entry(1)]), jst('2026-10-08', 7, 5));
    while (await service.processJobs(jst('2026-10-08', 7, 5)));
    const morning = await messagesOf(fake.received, [night, daily]);
    expect(morning.get('night')?.title).toBe('きょうのフォロー中の新着 3件');
    expect(morning.get('daily')?.title).toBe('きょうのフォロー中の新着 4件');
    // 同じ日の2回目の朝はない
    fake.received.length = 0;
    service.check(updates('b5', [entry(5)]), jst('2026-10-08', 8));
    while (await service.processJobs(jst('2026-10-08', 8)));
    expect([...(await messagesOf(fake.received, [night, daily])).keys()]).toEqual(['night']);
  });

  it('話題は同じ出来事を一度だけ知らせ、お知らせはジャンルで絞れる。管理画面の集計', async () => {
    const store = openStore();
    const fake = fakePushService();
    const service = new PushService(store, {}, fake.send);
    const now = jst('2026-10-07', 12);
    const hotFan = await subscriber('hot');
    const techFan = await subscriber('tech');
    const quiet = await subscriber('quiet');
    await service.subscribe({ subscription: hotFan.json, settings: { notify: { hot: true, quiet: false }, follow: { words: ['スマホ', 'AI'] } } }, 'h', now);
    await service.subscribe({ subscription: techFan.json, settings: { follow: { cats: ['tech'], words: ['ai'] }, notify: { quiet: false } } }, 't', now);
    await service.subscribe({ subscription: quiet.json, settings: { follow: { cats: ['news'] }, notify: { news: false, quiet: false } } }, 'q', now);
    service.check(updates('b0', []), now);
    const topic: UpdateTopic = { i: ['00000000000000a1', '00000000000000a2'], t: '大きな出来事', k: 5, u: '/ranking/' };
    service.check(updates('b1', [], [topic, { i: ['00000000000000b1'], t: '小さな話題', k: 2, u: '/ranking/' }]), now + 60_000);
    while (await service.processJobs(now + 60_000));
    expect([...(await messagesOf(fake.received, [hotFan, techFan, quiet])).entries()]).toEqual([
      ['hot', { kind: 'hot', title: 'いま話題（5社が報道）', body: '大きな出来事', url: '/ranking/?utm_source=push', tag: 'hot' }],
    ]);
    // 同じ話題（記事が増えても）は2回目を送らない
    fake.received.length = 0;
    service.check(updates('b2', [], [{ ...topic, i: ['00000000000000a3', '00000000000000a2'], k: 7 }]), now + 120_000);
    while (await service.processJobs(now + 120_000));
    expect(fake.received).toHaveLength(0);

    // お知らせ（テクノロジーをフォローしている人だけ。お知らせを受け取らない人には送らない）
    expect(service.broadcast({ title: 'お知らせ', body: '本文', url: '/about/', cat: 'tech' }, now).status).toBe(200);
    expect(service.broadcast({ title: '続けて', url: '/' }, now + 1000).status).toBe(429);
    while (await service.processJobs(now));
    const news = await messagesOf(fake.received, [hotFan, techFan, quiet]);
    expect([...news.keys()]).toEqual(['tech']);
    expect(news.get('tech')).toMatchObject({ kind: 'news', title: 'お知らせ', body: '本文', url: '/about/?utm_source=push' });

    const stats = service.stats() as { subscribers: number; modes: Record<string, number>; cats: unknown[]; words: unknown[]; log: { kind: string }[] };
    expect(stats.subscribers).toBe(3);
    expect(stats.modes).toEqual({ follow: 3, hot: 1, news: 2, daily: 0, quiet: 0 });
    expect(stats.cats).toEqual([
      { key: 'news', n: 1 },
      { key: 'tech', n: 1 },
    ]);
    // キーワードは2人以上がフォローしているものだけ
    expect(stats.words).toEqual([{ key: 'ai', n: 2 }]);
    expect(stats.log.map((entry) => entry.kind)).toEqual(['news', 'check']);
  });

  it('テストの通知（登録した本人だけ・続けては送れない）', async () => {
    const store = openStore();
    const fake = fakePushService();
    const service = new PushService(store, {}, fake.send);
    const a = await subscriber('a');
    const now = jst('2026-10-07', 12);
    await service.subscribe({ subscription: a.json, settings: { follow: { cats: ['tech'] } } }, 'v', now);
    expect((await service.test({ endpoint: a.endpoint, auth: 'wrong' }, now)).status).toBe(404);
    expect((await service.test({ endpoint: a.endpoint, auth: a.browser.authText }, now)).status).toBe(200);
    expect((await service.test({ endpoint: a.endpoint, auth: a.browser.authText }, now + 1000)).status).toBe(429);
    const messages = await messagesOf(fake.received, [a]);
    expect(messages.get('a')).toMatchObject({ kind: 'test', url: '/following/?utm_source=push' });
  });
});
