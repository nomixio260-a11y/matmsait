import { describe, expect, it } from 'vitest';
import {
  buildExcerpt,
  cleanTitle,
  dedupeKey,
  isJunkText,
  itemId,
  makeExcerpt,
  normalizePublishedAt,
  normalizeUrl,
  removeLeadingTitle,
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
    expect(makeExcerpt('😀'.repeat(10), 5)).toBe('😀😀😀😀…');
  });
});

describe('removeLeadingTitle / buildExcerpt', () => {
  it('本文の冒頭がタイトルの繰り返しなら取り除く', () => {
    expect(removeLeadingTitle('新製品を発表しました', '新製品を発表しました 詳細は以下の通りです')).toBe(
      '詳細は以下の通りです',
    );
  });

  it('タイトル末尾のサイト名を除いた形で一致しても取り除く', () => {
    expect(
      removeLeadingTitle('首相が会議を欠席した理由を説明：時事ドットコム', '首相が会議を欠席した理由を説明 時事通信 政治部'),
    ).toBe('時事通信 政治部');
  });

  it('タイトルと関係ない本文はそのまま', () => {
    expect(removeLeadingTitle('タイトルです。とても長いタイトル', '本文はこちら')).toBe('本文はこちら');
  });

  it('タイトルを除くと短すぎる抜粋は空にする', () => {
    expect(buildExcerpt('新製品を発表しました', '<p>新製品を発表しました</p>')).toBe('');
  });

  it('ページ部品やスクリプトの断片は抜粋にしない', () => {
    expect(
      buildExcerpt('記事', 'search-modal#open search-modal:open@window->search-suggest#onOpen keydown.esc'),
    ).toBe('');
    expect(buildExcerpt('記事', '© 2026 Example Co., Ltd. All rights reserved Cover Illustration')).toBe('');
  });

  it('通常の本文は抜粋になる', () => {
    expect(buildExcerpt('記事', '<p>今日は新しいスマートフォンが発表されました。価格は未定です。</p>')).toBe(
      '今日は新しいスマートフォンが発表されました。価格は未定です。',
    );
  });
});

describe('isJunkText', () => {
  it('普通の文章やハッシュタグは誤判定しない', () => {
    expect(isJunkText('C#とF#の比較記事。#おはようVtuber も話題に')).toBe(false);
    expect(isJunkText('この document. は誤検知しない')).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('指定した正規表現に一致する部分を取り除く', () => {
    expect(cleanTitle('[ITmedia News] 新サービス開始', /^\[ITmedia [^\]]+\]\s*/)).toBe('新サービス開始');
  });

  it('取り除くと空になる場合は元のタイトルを残す', () => {
    expect(cleanTitle('[ITmedia News]', /^\[ITmedia [^\]]+\]\s*/)).toBe('[ITmedia News]');
  });
});

describe('normalizeUrl', () => {
  it('トラッキングパラメータとハッシュを除去する', () => {
    expect(normalizeUrl('https://example.com/a?id=1&utm_source=rss&at_medium=RSS&fbclid=x#top')).toBe(
      'https://example.com/a?id=1',
    );
  });

  it('相対URLは base で解決する', () => {
    expect(normalizeUrl('/news/1', 'https://example.com/feed.xml')).toBe('https://example.com/news/1');
  });

  it('http(s) 以外・不正なURLは null', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });
});

describe('dedupeKey / itemId', () => {
  it('http/https・www・末尾スラッシュ・パラメータ順の違いを同一視する', () => {
    const key = dedupeKey('https://www.example.com/a/?b=2&a=1');
    expect(dedupeKey('http://example.com/a?a=1&b=2')).toBe(key);
    expect(itemId('http://example.com/a?a=1&b=2')).toBe(itemId('https://www.example.com/a/?b=2&a=1'));
  });

  it('別の記事は別のID', () => {
    expect(itemId('https://example.com/a')).not.toBe(itemId('https://example.com/b'));
    expect(itemId('https://example.com/a')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizePublishedAt', () => {
  const now = new Date('2026-01-10T00:00:00Z');

  it('正しい日時は ISO 形式に変換', () => {
    expect(normalizePublishedAt('Fri, 09 Jan 2026 12:00:00 +0900', now)).toBe('2026-01-09T03:00:00.000Z');
  });

  it('欠落・不正・未来日付は now', () => {
    expect(normalizePublishedAt(undefined, now)).toBe(now.toISOString());
    expect(normalizePublishedAt('invalid', now)).toBe(now.toISOString());
    expect(normalizePublishedAt('2030-01-01T00:00:00Z', now)).toBe(now.toISOString());
  });
});
