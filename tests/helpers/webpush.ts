/** テスト用: ブラウザの側の処理（購読の鍵を作る・届いた通知を復号する） */
import { toBase64Url } from '../../analytics/src/webpush.ts';

const encoder = new TextEncoder();

/** WebCrypto に渡せる形（ArrayBuffer の Uint8Array）にする */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, length * 8));
}

/** ブラウザの側の処理（RFC 8291 の復号）。テストで暗号化の結果を確かめるのに使う */
export async function decryptPush(body: Uint8Array, browser: { privateKey: CryptoKey; publicKey: Uint8Array; auth: Uint8Array }): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20];
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const serverKey = await crypto.subtle.importKey('raw', buf(serverPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, browser.privateKey, 256));
  const info = new Uint8Array([...encoder.encode('WebPush: info\0'), ...browser.publicKey, ...serverPublic]);
  const ikm = await hkdf(browser.auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(ciphertext)));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('最後の記録の印がありません');
  return new TextDecoder().decode(plain.slice(0, end));
}

/** ブラウザの購読の鍵（テスト用に作る） */
export async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, publicKey, auth, p256dh: toBase64Url(publicKey), authText: toBase64Url(auth) };
}
