import { describe, expect, it } from 'vitest';
import { indexNowPayload } from '../scripts/lib/ping.ts';

describe('indexNowPayload', () => {
  it('鍵ファイルの場所とURLをサイトのベースURLから作り、重複を除く', () => {
    expect(indexNowPayload('https://example.github.io/site/', 'abc123', ['/', '/ranking/', '/'])).toEqual({
      host: 'example.github.io',
      key: 'abc123',
      keyLocation: 'https://example.github.io/site/abc123.txt',
      urlList: ['https://example.github.io/site/', 'https://example.github.io/site/ranking/'],
    });
  });
});
