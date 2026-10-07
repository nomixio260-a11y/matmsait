import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD,
  VapidSigner,
  classifyPushStatus,
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  pushRequest,
  toBase64Url,
} from '../analytics/src/webpush.ts';
import { browserKeys, decryptPush } from './helpers/webpush.ts';

const encoder = new TextEncoder();

describe('Web Push の暗号化（RFC 8291）', () => {
  it('RFC 8291 の例と同じ結果になる', async () => {
    const example = {
      plaintext: 'When I grow up, I want to be a watermelon',
      asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    };
    const asPublic = fromBase64Url(example.asPublic);
    const jwk = { kty: 'EC', crv: 'P-256', d: example.asPrivate, x: toBase64Url(asPublic.slice(1, 33)), y: toBase64Url(asPublic.slice(33)) };
    const serverKeys = {
      privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    };
    const body = await encryptPayload(encoder.encode(example.plaintext), { p256dh: example.uaPublic, auth: example.auth }, { salt: fromBase64Url(example.salt), serverKeys });
    expect(toBase64Url(body)).toBe(example.body);
  });

  it('ブラウザの鍵で復号できる（毎回ちがう鍵と salt を使う）', async () => {
    const browser = await browserKeys();
    const message = JSON.stringify({ title: 'フォロー中の新着 3件', body: '・見出し'.repeat(20) });
    const a = await encryptPayload(encoder.encode(message), { p256dh: browser.p256dh, auth: browser.authText });
    const b = await encryptPayload(encoder.encode(message), { p256dh: browser.p256dh, auth: browser.authText });
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
    expect(await decryptPush(a, browser)).toBe(message);
    expect(await decryptPush(b, browser)).toBe(message);
  });

  it('鍵の形が正しくないもの・大きすぎる内容は暗号化しない', async () => {
    const browser = await browserKeys();
    await expect(encryptPayload(encoder.encode('x'), { p256dh: browser.p256dh.slice(0, 40), auth: browser.authText })).rejects.toThrow();
    await expect(encryptPayload(encoder.encode('x'), { p256dh: browser.p256dh, auth: 'AAAA' })).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(MAX_PAYLOAD + 1), { p256dh: browser.p256dh, auth: browser.authText })).rejects.toThrow();
    expect(() => fromBase64Url('not base64!')).toThrow();
    expect(toBase64Url(fromBase64Url('AQID'))).toBe('AQID');
    expect(toBase64Url(fromBase64Url('AQI='))).toBe('AQI');
  });
});

describe('VAPID（送り主の証明）', () => {
  it('ES256 の署名を公開鍵で確かめられ、届け先のオリジンごとに作って使い回す', async () => {
    const keys = await generateVapidKeys();
    expect(fromBase64Url(keys.publicKey)).toHaveLength(65);
    const signer = new VapidSigner(keys, 'https://topiatsume.pages.dev/');
    const now = Date.parse('2026-10-07T03:00:00Z');
    const header = await signer.authorization('https://fcm.googleapis.com/fcm/send/abc', now);
    const match = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    const [, head, payload, signature, publicKey] = match!;
    expect(publicKey).toBe(keys.publicKey);
    const raw = fromBase64Url(publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toBase64Url(raw.slice(1, 33)), y: toBase64Url(raw.slice(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, fromBase64Url(signature))).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://topiatsume.pages.dev/' });
    expect(await signer.authorization('https://fcm.googleapis.com/fcm/send/other', now + 60_000)).toBe(header);
    expect(await signer.authorization('https://updates.push.services.mozilla.com/wpush/v2/x', now)).not.toBe(header);
  });

  it('届け先へのリクエストと、返事の扱い', async () => {
    const browser = await browserKeys();
    const signer = new VapidSigner(await generateVapidKeys(), 'https://topiatsume.pages.dev/');
    const request = await pushRequest(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: browser.p256dh, auth: browser.authText },
      '{"title":"t"}',
      signer,
      Date.now(),
      { ttl: 600, topic: 'follow' },
    );
    expect(request.method).toBe('POST');
    expect(request.headers.get('TTL')).toBe('600');
    expect(request.headers.get('Topic')).toBe('follow');
    expect(request.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(request.headers.get('Authorization')).toMatch(/^vapid t=/);
    expect(await decryptPush(new Uint8Array(await request.arrayBuffer()), browser)).toBe('{"title":"t"}');
    expect([201, 404, 410, 429, 503, 400, 403, 413].map(classifyPushStatus)).toEqual(['ok', 'gone', 'gone', 'retry', 'retry', 'error', 'error', 'error']);
  });
});
