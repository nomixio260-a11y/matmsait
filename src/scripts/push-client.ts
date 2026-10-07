/**
 * ブラウザのプッシュ通知の登録（「フォロー中」のページで使う）。
 * 通知をオンにすると、サービスワーカー（public/sw.js）を登録して、ブラウザの通知の購読を作り、
 * フォロー・ミュート・受け取り方を通知のサーバー（サイトの /api）に送る。オフにすると購読を消す
 */
import { serviceWorkerUrl } from './sw-url.ts';
import { loadFollow, loadMute, readStored, STORE_KEYS, writeStored } from './personal-store.ts';

/** 通知の受け取り方（サーバーの NotifyOptions と同じ形） */
export interface NotifyOptions {
  follow: boolean;
  hot: boolean;
  news: boolean;
  daily: boolean;
  quiet: boolean;
}

export const DEFAULT_NOTIFY: NotifyOptions = { follow: true, hot: false, news: true, daily: false, quiet: true };

/** このブラウザの通知の状態（購読の URL と受け取り方。ブラウザにだけ保存） */
export interface PushLocal {
  enabled: boolean;
  endpoint?: string;
  notify: NotifyOptions;
  /** 最後にサーバーへ設定を送った日時 */
  syncedAt?: number;
}

export function loadPushLocal(): PushLocal {
  const stored = readStored<Partial<PushLocal>>(STORE_KEYS.push, {});
  const notify = { ...DEFAULT_NOTIFY };
  for (const key of Object.keys(DEFAULT_NOTIFY) as (keyof NotifyOptions)[]) {
    if (typeof stored.notify?.[key] === 'boolean') notify[key] = stored.notify[key];
  }
  return {
    enabled: stored.enabled === true,
    ...(typeof stored.endpoint === 'string' ? { endpoint: stored.endpoint } : {}),
    notify,
    ...(typeof stored.syncedAt === 'number' ? { syncedAt: stored.syncedAt } : {}),
  };
}

function savePushLocal(state: PushLocal): void {
  writeStored(STORE_KEYS.push, state);
  window.dispatchEvent(new CustomEvent('tp:prefs', { detail: { what: 'push' } }));
}

/** 通知がオフのときに、受け取り方だけを覚えておく（オンにしたときに使う） */
export function setNotifyOptions(notify: NotifyOptions): void {
  savePushLocal({ ...loadPushLocal(), notify });
}

export type PushSupport = 'ok' | 'unsupported' | 'ios-install' | 'denied' | 'no-server';

/** このブラウザで通知を使えるか（使えないときはその理由） */
export function pushSupport(apiBase: string): PushSupport {
  if (!apiBase) return 'no-server';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iPhone・iPad の Safari は、ホーム画面に追加したときだけ通知を使える（iOS 16.4 以降）
    return ios && !standalone ? 'ios-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** サービスワーカーの登録（サイトのベースパスの下に置く） */
async function registration(base: string, apiBase: string): Promise<ServiceWorkerRegistration> {
  const script = serviceWorkerUrl(base, apiBase);
  const existing = await navigator.serviceWorker.getRegistration(`${base}/`);
  if (existing?.active && new URL(existing.active.scriptURL).search === new URL(script, location.href).search) return existing;
  await navigator.serviceWorker.register(script, { scope: `${base}/` });
  return navigator.serviceWorker.ready;
}

async function api(apiBase: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${apiBase}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // 本文のない返事
  }
  return { ok: response.ok, status: response.status, data };
}

const settingsFor = (notify: NotifyOptions) => ({ follow: loadFollow(), mute: loadMute(), notify });

export class PushError extends Error {}

/** 通知をオンにする（通知の許可を求め、購読を作ってサーバーに登録する） */
export async function enablePush(base: string, apiBase: string, notify: NotifyOptions): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushError(
      permission === 'denied'
        ? '通知がブロックされています。ブラウザのサイトの設定で、このサイトの通知を「許可」にしてから、もう一度お試しください'
        : '通知の許可が得られませんでした',
    );
  }
  const reg = await registration(base, apiBase);
  const key = await api(apiBase, '/push/key');
  if (!key.ok || typeof key.data.key !== 'string') throw new PushError('通知のサーバーに接続できませんでした。しばらくしてからお試しください');
  const applicationServerKey = keyBytes(key.data.key);
  let subscription = await reg.pushManager.getSubscription();
  // サーバーの鍵が変わっていたら作り直す
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && new Uint8Array(current).join() !== applicationServerKey.join()) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  const result = await api(apiBase, '/push/subscribe', { subscription: subscription.toJSON(), settings: settingsFor(notify) });
  if (!result.ok) throw new PushError(typeof result.data.error === 'string' ? result.data.error : '通知を登録できませんでした');
  savePushLocal({ enabled: result.data.subscribed === true, endpoint: subscription.endpoint, notify, syncedAt: Date.now() });
}

/** 通知をやめる（サーバーの登録とブラウザの購読を消す） */
export async function disablePush(base: string, apiBase: string): Promise<void> {
  const local = loadPushLocal();
  try {
    const reg = await navigator.serviceWorker.getRegistration(`${base}/`);
    const subscription = await reg?.pushManager.getSubscription();
    if (subscription) {
      const auth = subscription.toJSON().keys?.auth;
      await api(apiBase, '/push/unsubscribe', { endpoint: subscription.endpoint, auth }).catch(() => undefined);
      await subscription.unsubscribe();
    }
  } finally {
    savePushLocal({ enabled: false, notify: local.notify });
  }
}

/** いまの購読（なければ undefined） */
async function currentSubscription(base: string): Promise<PushSubscription | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const reg = await navigator.serviceWorker.getRegistration(`${base}/`);
  return (await reg?.pushManager.getSubscription()) ?? undefined;
}

/**
 * フォロー・ミュート・受け取り方が変わったら、サーバーの設定を新しくする（通知をオンにしているときだけ）。
 * 購読がなくなっていたら（ブラウザで通知を取り消したなど）、オフにする
 */
export async function syncPush(base: string, apiBase: string, notify?: NotifyOptions): Promise<boolean> {
  const local = loadPushLocal();
  if (!local.enabled || !apiBase) return false;
  const options = notify ?? local.notify;
  const subscription = await currentSubscription(base);
  if (!subscription || Notification.permission !== 'granted') {
    savePushLocal({ enabled: false, notify: options });
    return false;
  }
  const result = await api(apiBase, '/push/subscribe', { subscription: subscription.toJSON(), settings: settingsFor(options) });
  if (!result.ok) throw new PushError(typeof result.data.error === 'string' ? result.data.error : '通知の設定を保存できませんでした');
  savePushLocal({ enabled: result.data.subscribed === true, endpoint: subscription.endpoint, notify: options, syncedAt: Date.now() });
  return true;
}

/** テストの通知を送ってもらう */
export async function testPush(base: string, apiBase: string): Promise<void> {
  const subscription = await currentSubscription(base);
  if (!subscription) throw new PushError('このブラウザの通知の登録が見つかりませんでした。通知をいったんオフにして、もう一度オンにしてください');
  const result = await api(apiBase, '/push/test', { endpoint: subscription.endpoint, auth: subscription.toJSON().keys?.auth });
  if (!result.ok) throw new PushError(typeof result.data.error === 'string' ? result.data.error : 'テストの通知を送れませんでした');
}

/** ブラウザとサーバーの両方で登録できているか（「フォロー中」のページを開いたときに確かめる） */
export async function verifyPush(base: string, apiBase: string): Promise<boolean> {
  const local = loadPushLocal();
  if (!local.enabled) return false;
  const subscription = await currentSubscription(base);
  if (!subscription || Notification.permission !== 'granted') {
    savePushLocal({ enabled: false, notify: local.notify });
    return false;
  }
  const result = await api(apiBase, '/push/status', { endpoint: subscription.endpoint, auth: subscription.toJSON().keys?.auth });
  if (result.ok && result.data.subscribed === false) {
    // サーバーから消えていたら（届かなくなって消した・サーバーを作り直したなど）、登録し直す
    return syncPush(base, apiBase);
  }
  return true;
}
