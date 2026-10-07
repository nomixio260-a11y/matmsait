/**
 * Web Push（ブラウザのプッシュ通知）を送るための処理。Cloudflare Workers の WebCrypto だけで動く（テストでは Node の WebCrypto）。
 * - VAPID（RFC 8292）: 通知の送り主の証明。鍵の組は Durable Object が最初に作って保存する（秘密の値を設定する必要がない）
 * - 内容の暗号化（RFC 8291。aes128gcm（RFC 8188））: 通知の中身は、受け取るブラウザだけが読める（通知を届ける会社にも読めない）
 */

const encoder = new TextEncoder();
/** UTF-8 のバイト列（WebCrypto に渡せる形） */
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

/** 1つの記録の大きさ（暗号化した内容はこれより小さくする） */
const RECORD_SIZE = 4096;
/** 送れる内容の大きさの上限（記録の大きさから、区切りの1バイトと認証タグの16バイトを引いたもの） */
export const MAX_PAYLOAD = RECORD_SIZE - 17;
/** VAPID の証明の有効期間（仕様の上限は24時間） */
const TOKEN_TTL = 12 * 60 * 60;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url（= の埋めがあってもなくてもよい）を読む。正しくなければ例外 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('base64url ではありません');
  const base64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((sum, part) => sum + part.length, 0)));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const bytes = (buffer: ArrayBuffer | JsonWebKey): Uint8Array<ArrayBuffer> => new Uint8Array(buffer as ArrayBuffer);

/** HKDF（RFC 5869。SHA-256）で length バイトを作る */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return bytes(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** VAPID の鍵の組（公開鍵は 65 バイトの非圧縮形式を base64url にしたもの。ブラウザの applicationServerKey に使う） */
export interface VapidKeys {
  publicKey: string;
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = toBase64Url(bytes(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { publicKey, privateJwk };
}

/** 保存していた VAPID の鍵の組が使える形か */
export function isVapidKeys(value: unknown): value is VapidKeys {
  if (typeof value !== 'object' || value === null) return false;
  const keys = value as VapidKeys;
  return typeof keys.publicKey === 'string' && typeof keys.privateJwk === 'object' && keys.privateJwk !== null && typeof keys.privateJwk.d === 'string';
}

/**
 * VAPID の証明（Authorization ヘッダーの値）を作る。通知を届ける会社（オリジン）ごとに作り、有効期間の半分まで使い回す
 */
export class VapidSigner {
  private key?: CryptoKey;
  private readonly tokens = new Map<string, { value: string; until: number }>();

  constructor(
    private readonly keys: VapidKeys,
    /** 送り主の連絡先（mailto: か https: の URL） */
    private readonly subject: string,
  ) {}

  get publicKey(): string {
    return this.keys.publicKey;
  }

  async authorization(endpoint: string, now: number): Promise<string> {
    const audience = new URL(endpoint).origin;
    const cached = this.tokens.get(audience);
    if (cached && cached.until > now) return cached.value;
    this.key ??= await crypto.subtle.importKey('jwk', this.keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const encode = (data: unknown) => toBase64Url(utf8(JSON.stringify(data)));
    const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: audience, exp: Math.floor(now / 1000) + TOKEN_TTL, sub: this.subject })}`;
    // WebCrypto の ECDSA の署名は r||s の形（JWT の ES256 と同じ）
    const signature = bytes(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key, utf8(unsigned)));
    const value = `vapid t=${unsigned}.${toBase64Url(signature)}, k=${this.keys.publicKey}`;
    if (this.tokens.size > 50) this.tokens.clear();
    this.tokens.set(audience, { value, until: now + (TOKEN_TTL * 1000) / 2 });
    return value;
  }
}

/** ブラウザの購読の情報（PushSubscription.toJSON() の endpoint と keys） */
export interface PushTarget {
  endpoint: string;
  /** ブラウザの公開鍵（P-256、65 バイト、base64url） */
  p256dh: string;
  /** 認証の秘密（16 バイト、base64url） */
  auth: string;
}

/** 暗号化に使う値を決めて渡す（テストで RFC の例と比べるときだけ使う） */
export interface EncryptOptions {
  salt?: Uint8Array<ArrayBuffer>;
  serverKeys?: CryptoKeyPair;
}

/** 通知の内容を、受け取るブラウザの鍵で暗号化する（RFC 8291 の aes128gcm。1つの記録にまとめる） */
export async function encryptPayload(payload: Uint8Array<ArrayBuffer>, target: Pick<PushTarget, 'p256dh' | 'auth'>, options: EncryptOptions = {}): Promise<Uint8Array> {
  if (payload.length > MAX_PAYLOAD) throw new Error('通知の内容が大きすぎます');
  const uaPublic = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('購読の鍵の形が正しくありません');
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const serverKeys =
    options.serverKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = bytes(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // 標準の WebCrypto どおり public で渡す（Cloudflare の型定義では $public という名前になっているため、型だけ合わせる）
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdhSecret = bytes(await crypto.subtle.deriveBits(ecdh, serverKeys.privateKey, 256));

  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 最後の記録の印（0x02）を付けて暗号化する
  const ciphertext = bytes(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));

  // 見出し: salt（16）・記録の大きさ（4）・鍵の長さ（1）・送り側の公開鍵
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface PushOptions {
  /** 通知を届ける会社が、ブラウザがオフラインの間に預かっておく秒数 */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** 同じ名前の届いていない通知を置き換える（英数字・-・_ の32文字まで） */
  topic?: string;
}

/** 通知を届ける会社へ送るリクエストを作る */
export async function pushRequest(target: PushTarget, payload: string, signer: VapidSigner, now: number, options: PushOptions = {}): Promise<Request> {
  const body = await encryptPayload(utf8(payload), target);
  const headers: Record<string, string> = {
    Authorization: await signer.authorization(target.endpoint, now),
    TTL: String(options.ttl ?? 12 * 60 * 60),
    Urgency: options.urgency ?? 'normal',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
  };
  if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.Topic = options.topic;
  return new Request(target.endpoint, { method: 'POST', headers, body });
}

/** 通知を届ける会社の返事の意味 */
export type PushResult = 'ok' | 'gone' | 'retry' | 'error';

export function classifyPushStatus(status: number): PushResult {
  if (status >= 200 && status < 300) return 'ok';
  // 購読が取り消された・期限切れ
  if (status === 404 || status === 410) return 'gone';
  // 送りすぎ・一時的な不調
  if (status === 429 || status >= 500) return 'retry';
  return 'error';
}
