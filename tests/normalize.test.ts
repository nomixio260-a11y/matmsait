import { describe, expect, it } from 'vitest';
import {
  itemId,
  makeExcerpt,
  normalizePublishedAt,
  normalizeUrl,
  stripHtml,
} from '../scripts/lib/normalize.ts';

describe('stripHtml', () => {
  it('タグとエンティティを除去して空白をまとめる', () => {
    expect(stripHtml('<p>Hello&nbsp;<b>world</b></p>\n<p>&amp; &#x3042;&#12354;</p>')).toBe(
      'Hello world & ああ',
    );
  });

  it('script/style の中身と CDATA を処理する', () => {
    expect(stripHtml('<![CDATA[本文]]><script>alert(1)</script><style>p{}</style>')).toBe('本文');
  });

  it('二重エスケープされたHTMLのタグも除去する', () => {
    expect(stripHtml('&lt;p&gt;本文&lt;/p&gt;')).toBe('本文');
  });
});

describe('makeExcerpt', () => {
  it('短い文はそのまま', () => {
    expect(makeExcerpt('<p>短い文</p>', 10)).toBe('短い文');
  });

  it('上限を超えると … を付けて max 文字に切り詰める', () => {
    const result = makeExcerpt('あ'.repeat(200), 120);
    expect(Array.from(result)).toHaveLength(120);
    expect(result.endsWith('…')).toBe(true);
  });

  it('サロゲートペアを壊さない', () => {
    const result = makeExcerpt('😀'.repeat(10), 5);
    expect(result).toBe('😀😀😀😀…');
  });
});

describe('normalizeUrl', () => {
  it('トラッキングパラメータとハッシュを除去する', () => {
    expect(normalizeUrl('https://example.com/a?id=1&utm_source=rss&fbclid=x#top')).toBe(
      'https://example.com/a?id=1',
    );
  });

  it('http(s) 以外・不正なURLは null', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });
});

describe('itemId', () => {
  it('同じURLから同じIDを作る', () => {
    expect(itemId('https://example.com/')).toBe(itemId('https://example.com/'));
    expect(itemId('https://example.com/')).not.toBe(itemId('https://example.com/b'));
    expect(itemId('https://example.com/')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizePublishedAt', () => {
  const now = new Date('2026-01-10T00:00:00Z');

  it('正しい日時は ISO 形式に変換', () => {
    expect(normalizePublishedAt('Fri, 09 Jan 2026 12:00:00 +0900', now)).toBe(
      '2026-01-09T03:00:00.000Z',
    );
  });

  it('欠落・不正・未来日付は now', () => {
    expect(normalizePublishedAt(undefined, now)).toBe(now.toISOString());
    expect(normalizePublishedAt('invalid', now)).toBe(now.toISOString());
    expect(normalizePublishedAt('2030-01-01T00:00:00Z', now)).toBe(now.toISOString());
  });
});
