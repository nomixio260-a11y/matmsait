import { describe, expect, it } from 'vitest';
import { clipText, decodeHtml, extractArticle, isAboutTitle } from '../scripts/lib/article.ts';

const paragraphs = [
  '東京都は6日、新しい子育て支援策を発表した。0歳から2歳までの子どもがいる世帯を対象に、保育料の負担を軽くする。',
  '対象となるのは都内に住む約20万世帯で、来年4月から申請を受け付ける。所得による制限は設けない。',
  '都の担当者は「子育て世帯の経済的な負担を減らし、安心して子どもを育てられる環境を整えたい」と話している。',
  '支援策には一時預かりの拡充や、保育士の処遇改善も含まれる。必要な費用は来年度の予算案に盛り込む方針だ。',
];

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>都が新たな子育て支援策 | ニュース</title>
<meta property="og:title" content="都が新たな子育て支援策を発表"></head>
<body>
<header><nav><a href="/">トップ</a><a href="/news">ニュース</a><a href="/sports">スポーツ</a></nav></header>
<main><article>
<h1>都が新たな子育て支援策を発表</h1>
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
<script>console.log('x')</script>
</article></main>
<aside><ul><li><a href="/1">関連記事1</a></li><li><a href="/2">関連記事2</a></li></ul></aside>
<footer>© Example</footer>
</body></html>`;

describe('extractArticle', () => {
  it('本文の段落だけを改行区切りで取り出す', () => {
    const article = extractArticle(page);
    expect(article?.title).toBe('都が新たな子育て支援策を発表');
    for (const paragraph of paragraphs) expect(article?.text).toContain(paragraph);
    expect(article?.text).not.toContain('console.log');
    expect(article?.text).not.toContain('© Example');
    expect(article?.text.split('\n').length).toBeGreaterThanOrEqual(paragraphs.length);
  });

  it('本文がないページは null', () => {
    expect(extractArticle('<html><body><p>ログインしてください</p></body></html>')).toBeNull();
    expect(extractArticle('')).toBeNull();
  });
});

describe('isAboutTitle', () => {
  const text = paragraphs.join('\n');
  it('見出しの言葉が本文に出てくれば同じ記事とみなす', () => {
    expect(isAboutTitle('東京都が子育て支援策を発表 保育料の負担を軽く', text)).toBe(true);
    // サイト名の部分は比べない
    expect(isAboutTitle('東京都が子育て支援策を発表 - 長い長いニュースサイトの名前ですよ', text)).toBe(true);
  });

  it('関係ない本文なら false', () => {
    expect(isAboutTitle('新型スマートフォンの発売日が決定、価格は据え置き', text)).toBe(false);
  });
});

describe('clipText', () => {
  it('段落の切れ目で切り、省略を示す', () => {
    const text = ['あ'.repeat(30), 'い'.repeat(30), 'う'.repeat(30)].join('\n');
    expect(clipText(text, 100)).toBe(text);
    const clipped = clipText(text, 70);
    expect(clipped).toBe(`${'あ'.repeat(30)}\n${'い'.repeat(30)}\n（以下略）`);
  });

  it('最初の段落が長すぎるときはその途中で切る', () => {
    expect(clipText('か'.repeat(50), 10)).toBe(`${'か'.repeat(10)}\n（以下略）`);
  });
});

describe('decodeHtml', () => {
  it('meta タグの文字コードで読む', () => {
    const sjis = Buffer.concat([
      Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>'),
      Buffer.from([0x93, 0xfa, 0x96, 0x7b]), // 「日本」
      Buffer.from('</body></html>'),
    ]);
    expect(decodeHtml(sjis, 'text/html')).toContain('日本');
    expect(decodeHtml(Buffer.from('<meta charset="utf-8"><p>日本</p>'), undefined)).toContain('日本');
  });

  it('Content-Type に charset があればそれを優先する', () => {
    const eucjp = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc]); // 「日本」
    expect(decodeHtml(eucjp, 'text/html; charset=EUC-JP')).toBe('日本');
  });
});
