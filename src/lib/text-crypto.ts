/**
 * 自動で取得した記事の本文の暗号化（ブラウザと Node の両方で動く Web Crypto API だけを使う）。
 * リポジトリとサイトは公開されているので、本文はそのまま置かず、運営者の公開鍵で暗号化して置く。
 * 復号に使う秘密鍵は、運営者のブラウザにだけ（ログインのパスワードで暗号化して）保存する。
 * しくみ: 本文ごとに使い捨ての AES-GCM の鍵で暗号化し、その鍵を各運営者の RSA-OAEP 公開鍵で包む
 */

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: 'RSA-OAEP',
  modulusLength: 3072,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};
const RSA_IMPORT: RsaHashedImportParams = { name: 'RSA-OAEP', hash: 'SHA-256' };

/** 運営者の鍵（秘密鍵はブラウザの外に出さない） */
export interface TextKeyPair {
  /** 鍵を見分ける ID（公開鍵の SHA-256 の先頭16桁） */
  kid: string;
  /** 公開鍵（SPKI・Base64） */
  publicKey: string;
  /** 秘密鍵（PKCS#8・Base64） */
  privateKey: string;
}

/** リポジトリに置く公開鍵 */
export interface PublicTextKey {
  kid: string;
  publicKey: string;
  createdAt?: string;
}

export interface EncryptedText {
  /** AES-GCM の初期化ベクトル（Base64） */
  iv: string;
  /** 暗号化した本文（Base64） */
  data: string;
  /** 鍵の ID → その公開鍵で包んだ AES の鍵（Base64） */
  keys: Record<string, string>;
}

const subtle = () => globalThis.crypto.subtle;

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < array.length; i += 0x8000) binary += String.fromCharCode(...array.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 公開鍵から鍵の ID を作る */
export async function keyIdOf(publicKey: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', fromBase64(publicKey));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function generateTextKeyPair(): Promise<TextKeyPair> {
  const pair = (await subtle().generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt'])) as CryptoKeyPair;
  const publicKey = toBase64(await subtle().exportKey('spki', pair.publicKey));
  const privateKey = toBase64(await subtle().exportKey('pkcs8', pair.privateKey));
  return { kid: await keyIdOf(publicKey), publicKey, privateKey };
}

/** 本文を暗号化する（どの公開鍵の持ち主でも復号できるように、鍵ごとに AES の鍵を包む） */
export async function encryptText(text: string, recipients: PublicTextKey[]): Promise<EncryptedText> {
  if (recipients.length === 0) throw new Error('暗号化に使う公開鍵がありません');
  const aes = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(text));
  const raw = await subtle().exportKey('raw', aes);
  const keys: Record<string, string> = {};
  for (const recipient of recipients) {
    const publicKey = await subtle().importKey('spki', fromBase64(recipient.publicKey), RSA_IMPORT, false, ['encrypt']);
    keys[recipient.kid] = toBase64(await subtle().encrypt({ name: 'RSA-OAEP' }, publicKey, raw));
  }
  return { iv: toBase64(iv), data: toBase64(data), keys };
}

/** 自分の秘密鍵で本文を復号する（自分の鍵で包まれていなければエラー） */
export async function decryptText(encrypted: EncryptedText, key: { kid: string; privateKey: string }): Promise<string> {
  const wrapped = encrypted.keys[key.kid];
  if (!wrapped) throw new Error('この鍵では読めません（鍵を作り直す前に取得した本文です）');
  const privateKey = await subtle().importKey('pkcs8', fromBase64(key.privateKey), RSA_IMPORT, false, ['decrypt']);
  const raw = await subtle().decrypt({ name: 'RSA-OAEP' }, privateKey, fromBase64(wrapped));
  const aes = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const data = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(encrypted.iv) }, aes, fromBase64(encrypted.data));
  return new TextDecoder().decode(data);
}
