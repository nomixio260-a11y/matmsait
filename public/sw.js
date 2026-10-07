/*
 * トピあつめのサービスワーカー。
 * - 通知: 届いた通知を表示し、押したらページを開く
 * - オフライン: ページはいつもネットから読み（新しい記事を出すため）、つながらないときだけ前に見たページかオフラインのページを出す。
 *   名前に中身のハッシュが入るファイル（/_astro/）は、一度読んだものを使い回す
 * 登録は src/scripts/pwa.ts（すべての閲覧者）と src/scripts/push-client.ts（通知をオンにしたとき。同じ URL）。
 * ?api= はアクセス解析・通知のサーバーの場所
 */
const API = new URL(self.location.href).searchParams.get('api') || '';
const BASE = new URL('./', self.location.href).href;
/** キャッシュの名前（中身の作り方を変えたら番号を上げる。古いものは activate で消す） */
const PAGES = 'pages-v1';
const ASSETS = 'assets-v1';
const OFFLINE_URL = new URL('offline/', BASE).href;
/** 前に見たページを残す数・ファイルを残す数 */
const MAX_PAGES = 40;
const MAX_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGES);
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' })).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PAGES, ASSETS]);
      for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
      // ページの読み込みとサービスワーカーの起動を並行させる（表示が遅くならないように）
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

/** キャッシュを決めた数までに減らす（古く入れたものから消す） */
async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (const request of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(request);
}

/** ページ: ネットから読み、読めたら保存する。つながらなければ保存したもの、なければオフラインのページ */
async function page(event) {
  try {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(
        (async () => {
          const cache = await caches.open(PAGES);
          await cache.put(event.request, copy);
          await trim(PAGES, MAX_PAGES);
        })(),
      );
    }
    return response;
  } catch (error) {
    const cache = await caches.open(PAGES);
    const saved = (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match(OFFLINE_URL));
    if (saved) return saved;
    throw error;
  }
}

/** 名前にハッシュが入るファイル: 保存したものがあればそれを使い、なければネットから読んで保存する */
async function asset(event) {
  const cache = await caches.open(ASSETS);
  const saved = await cache.match(event.request);
  if (saved) return saved;
  const response = await fetch(event.request);
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(cache.put(event.request, copy).then(() => trim(ASSETS, MAX_ASSETS)));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // ほかのサイト・管理画面・アクセス解析のサーバー・データ（JSON）はブラウザに任せる
  if (url.origin !== self.location.origin || !url.href.startsWith(BASE)) return;
  const path = url.pathname.slice(new URL(BASE).pathname.length - 1);
  if (/^\/(admin|api)\//.test(path)) return;
  if (request.mode === 'navigate') {
    event.respondWith(page(event));
    return;
  }
  if (path.startsWith('/_astro/')) event.respondWith(asset(event));
});

/** 開くページはこのサイトの中だけ（ほかのサイトの URL が入っていたらトップを開く） */
function pageUrl(url) {
  try {
    const target = new URL(typeof url === 'string' && url ? url : BASE, BASE);
    return target.origin === self.location.origin ? target.href : BASE;
  } catch {
    return BASE;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'トピあつめ';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'topiatsume';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      icon: new URL('icon-192.png', BASE).href,
      badge: new URL('badge-96.png', BASE).href,
      tag,
      // 同じ種類の通知を置き換えるときも、もう一度知らせる
      renotify: true,
      lang: 'ja',
      data: { url: pageUrl(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = pageUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const same = windows.find((client) => client.url === url && 'focus' in client);
      if (same) return same.focus();
      return self.clients.openWindow(url);
    })(),
  );
});

/** ブラウザが購読を作り直したとき（期限切れなど）は、新しい購読をサーバーに登録し直す（設定は前の購読から引き継ぐ） */
self.addEventListener('pushsubscriptionchange', (event) => {
  if (!API) return;
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const response = await fetch(`${API}/push/key`);
      const { key } = await response.json();
      const base64 = key.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
      const subscription =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: Uint8Array.from(binary, (char) => char.charCodeAt(0)),
        }));
      await fetch(`${API}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 前の購読の認証の秘密が分かれば、サーバーは設定を引き継ぐ（分からなければ、次にサイトを開いたときに設定を送り直す）
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          replaces: old ? old.endpoint : undefined,
          replacesAuth: old && old.toJSON().keys ? old.toJSON().keys.auth : undefined,
        }),
      });
    })(),
  );
});
