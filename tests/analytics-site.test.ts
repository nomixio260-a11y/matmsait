import { describe, expect, it } from 'vitest';
import { cleanEndpoint } from '../src/lib/analytics-config.ts';
import { parsePopularFile } from '../src/lib/popular.ts';
import { isLanding, pageKind, referrerLabel } from '../src/scripts/analytics.ts';

describe('サイトの計測（ブラウザ側）', () => {
  it('パスからページの種類・カテゴリ・掲載元を決める', () => {
    expect(pageKind('/')).toEqual({ kind: 'home' });
    expect(pageKind('/category/tech/2/')).toEqual({ kind: 'category', cat: 'tech' });
    expect(pageKind('/source/gigazine/')).toEqual({ kind: 'source', src: 'gigazine' });
    expect(pageKind('/summary/0123456789abcdef/')).toEqual({ kind: 'summary' });
    expect(pageKind('/popular/')).toEqual({ kind: 'popular' });
    expect(pageKind('/privacy/')).toEqual({ kind: 'info' });
    expect(pageKind('/unknown/page/')).toEqual({ kind: 'other' });
  });

  it('参照元はホスト名だけ（www. を除く）。utm_source があればそちら、サイトの中からなら入口ではない', () => {
    expect(referrerLabel('https://www.google.co.jp/search?q=secret', '', 'example.github.io')).toBe('google.co.jp');
    expect(referrerLabel('https://t.co/abc', '?utm_source=Bluesky&x=1', 'example.github.io')).toBe('bluesky');
    expect(referrerLabel('', '', 'example.github.io')).toBe('');
    expect(referrerLabel('https://example.github.io/matmsait/', '', 'example.github.io')).toBeUndefined();
    expect(referrerLabel('not a url', '', 'example.github.io')).toBe('');
  });

  it('前の閲覧から30分以内なら同じ訪問の続き（入口にしない）', () => {
    const now = Date.parse('2026-10-07T10:00:00Z');
    expect(isLanding({ returning: false, available: true }, false, now)).toBe(true);
    expect(isLanding({ lastView: now - 5 * 60_000, returning: false, available: true }, false, now)).toBe(false);
    expect(isLanding({ lastView: now - 31 * 60_000, returning: true, available: true }, true, now)).toBe(true);
    // 訪問の記録を読めないブラウザでは、参照元で決める
    expect(isLanding({ returning: false, available: false }, true, now)).toBe(false);
    expect(isLanding({ returning: false, available: false }, false, now)).toBe(true);
  });
});

describe('アクセス解析の設定とデータ', () => {
  it('接続先は https（試験用の localhost は http も可）のオリジンだけ', () => {
    expect(cleanEndpoint('https://topiatsume-analytics.example.workers.dev/')).toBe('https://topiatsume-analytics.example.workers.dev');
    expect(cleanEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(cleanEndpoint('http://example.com')).toBe('');
    expect(cleanEndpoint('https://example.com/path')).toBe('');
    expect(cleanEndpoint('javascript:alert(1)')).toBe('');
    expect(cleanEndpoint(undefined)).toBe('');
  });

  it('よく読まれている記事のファイルは、正しい形の行だけ読む', () => {
    const file = parsePopularFile(
      JSON.stringify({
        updatedAt: '2026-10-07T00:00:00Z',
        day: [{ id: '0123456789abcdef', n: 3 }, { id: 'bad', n: 1 }, { id: 'fedcba9876543210', n: 0 }],
        week: 'oops',
      }),
    );
    expect(file).toEqual({ updatedAt: '2026-10-07T00:00:00Z', day: [{ id: '0123456789abcdef', n: 3 }], week: [] });
    expect(parsePopularFile('{broken')).toBeUndefined();
    expect(parsePopularFile(undefined)).toBeUndefined();
  });
});
