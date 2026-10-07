import { describe, expect, it } from 'vitest';
import { cleanEndpoint } from '../src/lib/analytics-config.ts';
import { parsePopularFile } from '../src/lib/popular.ts';
import { isLanding, pageKind, referrerLabel, visitFlags } from '../src/scripts/analytics.ts';

describe('サイトの計測（ブラウザ側）', () => {
  it('パスからページの種類・カテゴリ・掲載元を決める', () => {
    expect(pageKind('/')).toEqual({ kind: 'home' });
    expect(pageKind('/category/tech/2/')).toEqual({ kind: 'category', cat: 'tech' });
    expect(pageKind('/source/gigazine/')).toEqual({ kind: 'source', src: 'gigazine' });
    expect(pageKind('/summary/0123456789abcdef/')).toEqual({ kind: 'summary' });
    expect(pageKind('/popular/')).toEqual({ kind: 'popular' });
    expect(pageKind('/topic/0123456789abcdef/')).toEqual({ kind: 'topic' });
    expect(pageKind('/tag/ai/')).toEqual({ kind: 'tag' });
    expect(pageKind('/tags/')).toEqual({ kind: 'tag' });
    expect(pageKind('/rising/')).toEqual({ kind: 'rising' });
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

  it('週（月曜から）・月に初めての訪問の印（WAU・MAU のもと）', () => {
    const now = Date.parse('2026-10-07T03:00:00Z'); // 10月7日（水）12時（日本時間）
    const at = (iso: string) => ({ lastView: Date.parse(iso), returning: true, available: true });
    expect(visitFlags({ returning: false, available: true }, now)).toBe(2 | 4);
    expect(visitFlags(at('2026-10-06T10:00:00Z'), now)).toBe(1);
    // 月曜0時（日本時間）より前に見ていれば、この週は初めて
    expect(visitFlags(at('2026-10-04T14:59:00Z'), now)).toBe(1 | 2);
    expect(visitFlags(at('2026-10-04T15:00:00Z'), now)).toBe(1);
    // 10月1日0時（日本時間）より前なら、この月も初めて
    expect(visitFlags(at('2026-09-30T14:00:00Z'), now)).toBe(1 | 2 | 4);
    // 保存を読めないブラウザでは週・月はわからない
    expect(visitFlags({ returning: false, available: false }, now)).toBe(0);
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
  it('接続先は、サイトと同じドメインのパスか、https（試験用の localhost は http も可）のオリジンだけ', () => {
    expect(cleanEndpoint('/api')).toBe('/api');
    expect(cleanEndpoint('/api/')).toBe('');
    expect(cleanEndpoint('//evil.example')).toBe('');
    expect(cleanEndpoint('/api?x=1')).toBe('');
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
