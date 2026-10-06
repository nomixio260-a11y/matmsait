import { describe, expect, it } from 'vitest';
import { decryptText, encryptText, generateTextKeyPair, keyIdOf } from '../src/lib/text-crypto.ts';

describe('本文の暗号化', () => {
  it('登録したどの鍵の持ち主でも復号でき、ほかの鍵では読めない', async () => {
    const [a, b, outsider] = await Promise.all([generateTextKeyPair(), generateTextKeyPair(), generateTextKeyPair()]);
    expect(a.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(await keyIdOf(a.publicKey)).toBe(a.kid);
    const text = '記事の本文です。'.repeat(500);
    const encrypted = await encryptText(text, [a, b]);
    expect(encrypted.data).not.toContain('記事');
    expect(Object.keys(encrypted.keys).sort()).toEqual([a.kid, b.kid].sort());
    expect(await decryptText(encrypted, a)).toBe(text);
    expect(await decryptText(encrypted, b)).toBe(text);
    await expect(decryptText(encrypted, outsider)).rejects.toThrow('この鍵では読めません');
    // 同じ本文でも毎回違う暗号文になる
    expect((await encryptText(text, [a])).data).not.toBe(encrypted.data);
  });

  it('公開鍵がなければ暗号化しない', async () => {
    await expect(encryptText('本文', [])).rejects.toThrow('公開鍵がありません');
  });
});
