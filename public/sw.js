/*
 * トピあつめの通知（サービスワーカー）。届いた通知を表示し、押したらページを開くだけで、
 * ページの読み込みやキャッシュには関わらない（fetch は扱わない）。
 * 登録は「フォロー中」のページで通知をオンにしたとき（src/scripts/push-client.ts）。?api= はアクセス解析・通知のサーバーの場所
 */
const API = new URL(self.location.href).searchParams.get('api') || '';
const BASE = new URL('./', self.location.href).href;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
