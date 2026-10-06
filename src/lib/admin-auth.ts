/**
 * 管理画面のログイン（ブラウザだけで動く。サーバーはないので、守る対象は GitHub のトークンと、自動で取得した本文を読む秘密鍵）
 * - トークンと秘密鍵は運営者が決めたパスワードで暗号化して、このブラウザ（localStorage）に保存する
 *   （PBKDF2-SHA256 で鍵を作り、AES-GCM で暗号化。パスワードがわからなければ取り出せない。パスワード自体はどこにも保存しない）
 * - ログイン中だけ、取り出したトークンをこのタブ（sessionStorage）に置く。操作がないまま一定時間たつと自動でログアウト
 * - パスワードを続けて間違えると、しばらくログインできなくする
 */

import type { TextKeyPair } from './text-crypto.ts';

export const VAULT_KEY = 'admin.vault';
export const SESSION_KEY = 'admin.session';
export const FAILURES_KEY = 'admin.loginFailures';
/** 以前の版が暗号化せずに保存していたトークン（ログインの初回設定で暗号化して保存し直し、消す） */
export const LEGACY_TOKEN_KEY = 'admin.githubToken';

/** パスワードの最低の長さ */
export const MIN_PASSWORD_LENGTH = 10;
/** 鍵を作るときの繰り返しの回数（総当たりで調べるのに時間がかかるようにする） */
export const PBKDF2_ITERATIONS = 600_000;
/** 操作がないまま、この時間たつと自動でログアウト */
export const IDLE_TIMEOUT = 30 * 60 * 1000;
/** ログインしてからこの時間たつと、操作中でも再ログインを求める */
export const MAX_SESSION = 8 * 60 * 60 * 1000;
/** この回数続けて間違えたら、しばらくログインできなくする */
export const MAX_FAILURES = 5;

export interface Vault {
  v: 1;
  /** 鍵を作るときの繰り返しの回数 */
  iterations: number;
  salt: string;
  iv: string;
  /** 暗号化したトークンと秘密鍵（base64） */
  data: string;
  /** GitHub のユーザー名（表示用） */
  login?: string;
  createdAt: string;
}

/** パスワードで暗号化して保存するもの */
export interface VaultSecrets {
  token: string;
  /** 自動で取得した本文を読むための鍵（以前の版で保存したものにはない） */
  textKey?: TextKeyPair;
}

export interface Session {
  token: string;
  login?: string;
  /** 自動で取得した本文を読むための鍵 */
  textKey?: TextKeyPair;
  startedAt: number;
  lastActive: number;
}

export interface Failures {
  count: number;
  /** この時刻まではログインできない */
  lockedUntil: number;
}

/** localStorage / sessionStorage と同じ形（テストでは差し替える） */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** パスワードとして使えるか（使えなければ理由を返す） */
export function passwordProblem(password: string, confirm?: string): string | undefined {
  if (Array.from(password).length < MIN_PASSWORD_LENGTH) return `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`;
  if (/^(.)\1+$/u.test(password)) return '同じ文字だけのパスワードは使えません';
  if (confirm !== undefined && password !== confirm) return '確認用のパスワードが一致しません';
  return undefined;
}

/** トークン（と秘密鍵）をパスワードで暗号化する */
export async function createVault(
  secrets: VaultSecrets | string,
  password: string,
  { login, iterations = PBKDF2_ITERATIONS, now = new Date() }: { login?: string; iterations?: number; now?: Date } = {},
): Promise<Vault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const { token, textKey } = typeof secrets === 'string' ? { token: secrets, textKey: undefined } : secrets;
  // 秘密鍵がなければ、以前の版と同じくトークンだけを暗号化する
  const plain = textKey ? JSON.stringify({ token, textKey }) : token;
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain)));
  return {
    v: 1,
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(data),
    ...(login ? { login } : {}),
    createdAt: now.toISOString(),
  };
}

/** パスワードでトークン（と秘密鍵）を取り出す。パスワードが違えばエラー */
export async function openVault(vault: Vault, password: string): Promise<VaultSecrets> {
  const key = await deriveKey(password, fromBase64(vault.salt), vault.iterations);
  let plain: string;
  try {
    plain = decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(vault.iv) }, key, fromBase64(vault.data)));
  } catch {
    throw new Error('パスワードが違います');
  }
  // 以前の版はトークンだけを暗号化していた
  if (plain.startsWith('{')) {
    try {
      const secrets = JSON.parse(plain) as VaultSecrets;
      if (typeof secrets.token === 'string') return secrets;
    } catch {
      // トークンとして扱う
    }
  }
  return { token: plain };
}

function readJson<T>(store: KeyValueStore, key: string): T | undefined {
  try {
    const text = store.getItem(key);
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境では、ログインはできてもこのタブを閉じるまで
  }
}

function remove(store: KeyValueStore, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // 同上
  }
}

const isVault = (value: unknown): value is Vault =>
  typeof value === 'object' &&
  value !== null &&
  (value as Vault).v === 1 &&
  typeof (value as Vault).salt === 'string' &&
  typeof (value as Vault).iv === 'string' &&
  typeof (value as Vault).data === 'string' &&
  Number.isInteger((value as Vault).iterations);

export function loadVault(store: KeyValueStore): Vault | undefined {
  const vault = readJson<unknown>(store, VAULT_KEY);
  return isVault(vault) ? vault : undefined;
}

export function saveVault(store: KeyValueStore, vault: Vault): void {
  writeJson(store, VAULT_KEY, vault);
  // 以前の版の、暗号化していないトークンは消す
  remove(store, LEGACY_TOKEN_KEY);
}

export function deleteVault(store: KeyValueStore): void {
  remove(store, VAULT_KEY);
  remove(store, LEGACY_TOKEN_KEY);
}

// ===== ログイン中の状態 =====

export function startSession(
  store: KeyValueStore,
  token: string,
  login: string | undefined,
  now: number,
  textKey?: TextKeyPair,
): Session {
  const session: Session = { token, ...(login ? { login } : {}), ...(textKey ? { textKey } : {}), startedAt: now, lastActive: now };
  writeJson(store, SESSION_KEY, session);
  return session;
}

/** 有効なログインの状態（期限が切れていれば消して undefined） */
export function currentSession(store: KeyValueStore, now: number): Session | undefined {
  const session = readJson<Session>(store, SESSION_KEY);
  if (!session || typeof session.token !== 'string' || !session.token) return undefined;
  if (now - session.lastActive > IDLE_TIMEOUT || now - session.startedAt > MAX_SESSION) {
    remove(store, SESSION_KEY);
    return undefined;
  }
  return session;
}

/** 操作があったことを記録する（自動ログアウトまでの時間を延ばす） */
export function touchSession(store: KeyValueStore, now: number): Session | undefined {
  const session = currentSession(store, now);
  if (!session) return undefined;
  const next = { ...session, lastActive: now };
  writeJson(store, SESSION_KEY, next);
  return next;
}

export function endSession(store: KeyValueStore): void {
  remove(store, SESSION_KEY);
}

// ===== 続けて間違えたときの制限 =====

/** ログインできるまでの残り時間（ミリ秒。0 ならすぐにできる） */
export function lockRemaining(store: KeyValueStore, now: number): number {
  const failures = readJson<Failures>(store, FAILURES_KEY);
  return failures ? Math.max(0, failures.lockedUntil - now) : 0;
}

/** 間違えた回数を記録する。MAX_FAILURES 回からは、30秒・1分・2分…（最大15分）ログインできなくする */
export function recordFailure(store: KeyValueStore, now: number): Failures {
  const previous = readJson<Failures>(store, FAILURES_KEY) ?? { count: 0, lockedUntil: 0 };
  const count = previous.count + 1;
  const lock = count >= MAX_FAILURES ? Math.min(30_000 * 2 ** (count - MAX_FAILURES), 15 * 60 * 1000) : 0;
  const failures = { count, lockedUntil: lock ? now + lock : 0 };
  writeJson(store, FAILURES_KEY, failures);
  return failures;
}

export function clearFailures(store: KeyValueStore): void {
  remove(store, FAILURES_KEY);
}
