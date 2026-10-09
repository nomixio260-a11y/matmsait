import { describe, expect, it } from 'vitest';
import { extractArticleText, pageNumber } from '../scripts/lib/article-text.ts';

const para = (n: number) => `これは記事の${n}段落目です。新製品の価格は3万9800円で、11月12日に発売されます。性能は従来モデルより約2割向上しました。`;

describe('extractArticleText', () => {
  it('本文・小見出し・箇条書きを取り出し、メニュー・共有ボタン・関連記事・写真の説明・スクリプトは除く', () => {
    const html = `<!doctype html><html><head><title>新製品を発表 | 例</title><meta name="robots" content="index, noai"></head><body>
      <nav><p>メニューの説明文がここに入ります。メニューの説明文です。</p></nav>
      <main><article><h1>新製品「テスト」を発表</h1>
        <div class="share-buttons"><p>この記事をシェアしてください。シェアしてください。</p></div>
        <div class="body"><p>${para(1)}</p><h2>小見出し</h2><p>${para(2)}</p><p>${para(3)}</p>
        <figure><figcaption>写真の説明（本文ではない）</figcaption></figure><ul><li>箇条書きの項目1</li></ul></div>
        <section class="related-articles"><p>関連記事の見出しがここに入ります。関連記事です。</p></section>
      </article></main>
      <aside><p>サイドバーの人気記事ランキングの文章です。</p></aside>
      <footer><p>フッターの文章です。無断転載を禁じます。</p></footer>
      <script>var x = "スクリプトの文字";</script></body></html>`;
    const { title, text, robots } = extractArticleText(html);
    expect(title).toBe('新製品「テスト」を発表');
    for (const n of [1, 2, 3]) expect(text).toContain(para(n));
    expect(text).toContain('小見出し');
    expect(text).toContain('箇条書きの項目1');
    expect(text).not.toMatch(/メニューの説明文|シェアしてください|関連記事の見出し|人気記事|フッターの文章|写真の説明|スクリプトの文字/);
    expect(robots).toEqual(['index, noai']);
  });

  it('本文の目印（itemprop="articleBody"）があれば、その中だけを使う', () => {
    const html = `<html><body><h1>見出し</h1><div class="teaser"><p>${para(9).repeat(3)}</p></div>
      <div itemprop="articleBody"><p>${para(1)}</p><p>${para(2)}</p></div></body></html>`;
    const { text } = extractArticleText(html);
    expect(text).toContain(para(1));
    expect(text).not.toContain(para(9));
  });

  it('ページや記事全体に「breadcrumb」「share」などのクラス名が付いていても、本文を消さない', () => {
    // <body class="news breadcrumb">（Impress Watch）・<div class="hidden_share post">（WordPress のサイト）
    const html = `<html><body class="news breadcrumb"><header><a href="/">ロゴ</a></header>
      <div class="hidden_share post type-post"><h2 class="entry-title">記事の見出し</h2>
        <div class="entry-content"><p>${para(1)}</p><p>${para(2)}</p></div>
        <div class="share-box"><p>シェアしてください。</p></div></div></body></html>`;
    const { text } = extractArticleText(html);
    for (const n of [1, 2]) expect(text).toContain(para(n));
    expect(text).not.toContain('シェアしてください');
  });

  it('リンクの一覧（メニュー・おすすめ）や、文でない短いラベルの多いまとまりを本文に選ばない', () => {
    const pickup = Array.from({ length: 12 }, (_, i) => `<li><p class="label">sponsored</p><p class="sub">製品${i}をレビュー</p><h4><a href="/${i}">おすすめ記事の長い見出しがここに入ります その${i}</a></h4></li>`).join('');
    const menu = Array.from({ length: 20 }, (_, i) => `<li><a href="/m${i}">メニューの項目${i}</a></li>`).join('');
    const html = `<html><body><div class="menu"><ul>${menu}</ul></div><div class="pickup"><ul>${pickup}</ul></div>
      <h1>新製品を発表</h1><div id="detail"><p>${para(1)}</p><p>${para(2)}</p></div></body></html>`;
    const { text } = extractArticleText(html);
    expect(text).toContain(para(1));
    expect(text).not.toMatch(/おすすめ記事|メニューの項目|sponsored/);
  });

  it('小見出しごとに同じ形のまとまりに分かれた本文は、まとめて取り出す', () => {
    const section = (n: number) => `<div class="contents-section" id="contents-section-${n}"><h2>小見出し${n}</h2><p>${para(n)}${para(n + 10)}</p></div>`;
    const html = `<html><body><div id="main"><article><div class="title-header"><h1>見出し</h1></div>
      <div class="main-contents">${section(1)}${section(2)}${section(3)}</div></article>
      <aside><p>${para(9)}${para(9)}${para(9)}</p></aside>
      <div class="links">${'<p><a href="/">ほかの記事の見出しがここに入ります</a></p>'.repeat(30)}</div></div></body></html>`;
    const { text } = extractArticleText(html);
    for (const n of [1, 2, 3]) expect(text).toContain(para(n));
    expect(text).not.toMatch(/ほかの記事の見出し|9段落目/);
  });

  it('タグの閉じ方の都合で本文が body の外に置かれたページでも取り出す', () => {
    const html = `<html><head><title>見出し</title></head><body><div id="side"><p>サイドの文章です。</p></div></body>
      <div id="container"><h1>見出し</h1><div id="contents_detail"><p>${para(1)}</p><p>${para(2)}</p></div></div></html>`;
    const { text } = extractArticleText(html);
    for (const n of [1, 2]) expect(text).toContain(para(n));
  });

  it('段落（p）を使わず改行で書かれたページも取り出す', () => {
    const html = `<html><body><h1>見出し</h1><article><div class="text">${para(1)}<br><br>${para(2)}<br><br>${para(3)}</div></article><div>短い</div></body></html>`;
    const { text } = extractArticleText(html);
    for (const n of [1, 2, 3]) expect(text).toContain(para(n));
  });
});

describe('extractArticleText: 前後の余計な行・リンクだけの段落', () => {
  const title = '新製品「テスト」を11月に発売';

  it('見出しの後のカテゴリ・日付・筆者、写真へのリンク、ページ送り・ページ番号、次ページの案内を落とす', () => {
    const html = `<html><body><main><article><h1>${title}</h1>
      <div class="date"><p><a href="/c/tech">テクノロジー</a> <a href="/c/pc">パソコン</a></p><time datetime="2026-10-09">2026年10月9日</time></div>
      <div class="photo"><a href="/a/1?photo=1"><img src="a.jpg"><p>発表会の様子（他の写真を見る）</p></a></div>
      <p>${para(1)}</p><p class="link"><a href="/a/1?photo=2">【写真】発表会に登場した新製品の外観</a></p><p>${para(2)}</p>
      <p class="next"><a href="/a/1?page=2">次ページ：開発の背景</a></p>
      <p class="p-pagination"><span>前へ</span> <span>1</span> <a href="/a/1?page=2">2</a> <a href="/a/1?page=2">次へ</a></p>
      <p class="page">[1/2ページ]</p></article></main></body></html>`;
    const { text } = extractArticleText(html, { url: 'https://news.example.jp/a/1', title });
    expect(text.split('\n')).toEqual([para(1), para(2)]);
  });

  it('見出しとほぼ同じ内容のリード文（「。」で終わる文）は、見出しの行として落とさない', () => {
    const lead = `${title}することを、テスト株式会社が9日に発表した。`;
    const html = `<html><body><h1>${title}</h1><div class="body"><p>${lead}</p><p>${para(1)}</p><p>${para(2)}</p></div></body></html>`;
    const { text } = extractArticleText(html, { title });
    expect(text.split('\n')[0]).toBe(lead);
  });

  it('「キーワード :」とその値の行、著作権表示・筆者紹介の見出しから後ろを落とす', () => {
    const html = `<html><body><article><h1>${title}</h1><dl><dt>キーワード :</dt><dd>家電, 新製品</dd></dl>
      <p>${para(1)}</p><p>${para(2)}</p><p>筆者：テスト太郎</p><p>家電を中心に取材している。著書に『家電の本』がある。</p>
      <p>© 2026 Example Inc. All Rights Reserved.</p></article></body></html>`;
    const { text } = extractArticleText(html, { title });
    expect(text.split('\n')).toEqual([para(1), para(2)]);
  });

  it('「，．」で文を書くページ・表の中に本文があるページも取り出す', () => {
    const sentence = (n: number) => `テスト鉄道では，${n}月から新しい車両の運転を始めます．車両は4両編成で，定員は約500人です．`;
    const html = `<html><body><table class="layout"><tr><td class="menu"><a href="/">トップ</a></td></tr>
      <tr><td><h1>${title}</h1></td></tr><tr><td><p>${sentence(1)}</p><p>${sentence(2)}</p><p>${sentence(3)}</p></td></tr></table></body></html>`;
    const { text } = extractArticleText(html, { title });
    for (const n of [1, 2, 3]) expect(text).toContain(sentence(n));
    expect(text).not.toContain('トップ');
  });

  it('見出しの「。」「？」につられて、横の欄や筆者紹介まで本文に含めない', () => {
    const question = '新製品は売れるのか？ 発売前の評判を調べた';
    const html = `<html><body><div id="container"><div id="main"><h1>${question}</h1>
      <div class="entry">${[1, 2, 3, 4].map((n) => `<p>${para(n)}</p>`).join('')}</div></div>
      <div id="side"><p>編集長のプロフィールです。2009年にサイトを始めました。</p><ul>${'<li><a href="/x">ほかの記事の見出し</a></li>'.repeat(8)}</ul></div></div></body></html>`;
    const { text } = extractArticleText(html, { title: question });
    for (const n of [1, 2, 3, 4]) expect(text).toContain(para(n));
    expect(text).not.toMatch(/プロフィール|ほかの記事/);
  });
});

describe('extractArticleText: 本文の候補', () => {
  it('ページに本文がなければ、構造化データ（JSON-LD の articleBody）を使う', () => {
    const body = [1, 2, 3, 4, 5].map(para).join('\n');
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebPage' }, { '@type': 'NewsArticle', headline: '見出し', articleBody: body }],
    })}</script></head><body><h1>見出し</h1><div id="app">読み込み中</div></body></html>`;
    const result = extractArticleText(html);
    expect(result.method).toBe('jsonld');
    expect(result.text).toBe(body);
  });

  it('ページに埋め込まれたデータ（Next.js の __NEXT_DATA__）の本文の HTML を使う', () => {
    const html = `<html><body><h1>見出し</h1><div id="__next">読み込み中</div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { article: { bodyHtml: [1, 2, 3, 4, 5].map((n) => `<p>${para(n)}</p>`).join('') } } },
    })}</script></body></html>`;
    const result = extractArticleText(html);
    expect(result.method).toBe('embedded');
    for (const n of [1, 2, 3, 4, 5]) expect(result.text).toContain(para(n));
  });

  it('動画が中心のページは media で知らせる', () => {
    const html = `<html><head><meta property="og:type" content="video.other"></head><body><h1>会見</h1><p>会見の動画です。</p></body></html>`;
    expect(extractArticleText(html).media).toBe('video');
  });
});

describe('extractArticleText: たどれるリンク', () => {
  const url = 'https://news.example.jp/article/2026/100/';

  it('「全文を読む」「つづきを読む」の先・2ページ目以降・AMP 版・WordPress の API を見つける（ほかの記事・ほかのサイトは除く）', () => {
    const html = `<html><head><link rel="amphtml" href="/article/2026/100/amp/">
      <link rel="alternate" type="application/json" href="https://news.example.jp/wp-json/wp/v2/posts/100"></head><body>
      <h1>見出し</h1><p>${para(1)}</p><a href="?all=1">つづきを読む</a>
      <a href="/article/2026/100/2/">2</a><a href="/article/2026/100/3/">3</a><a href="/article/2026/101/">次の記事</a>
      <a href="https://other.example.com/article/2026/100/2/">2</a></body></html>`;
    const { links } = extractArticleText(html, { url });
    expect(links).toEqual({
      more: 'https://news.example.jp/article/2026/100/?all=1',
      pages: ['https://news.example.jp/article/2026/100/2/', 'https://news.example.jp/article/2026/100/3/'],
      amp: 'https://news.example.jp/article/2026/100/amp/',
      wpJson: 'https://news.example.jp/wp-json/wp/v2/posts/100',
    });
  });

  it('本文がなく、見出しと同じ文字のリンク（記事本体のページ）だけがあれば、そのリンクを返す', () => {
    const title = '新しい制度の開始について（お知らせ）';
    const html = `<html><body><h1>お知らせ</h1><p>2026年10月9日</p><ul><li><a href="/policy/new-system/">${title}</a></li></ul></body></html>`;
    const result = extractArticleText(html, { url: 'https://www.example.go.jp/notice/entry/123/', title });
    expect(result.links.stub).toBe('https://www.example.go.jp/policy/new-system/');
  });
});

describe('pageNumber', () => {
  const base = new URL('https://news.example.jp/articles/-/100');
  const of = (href: string) => pageNumber(base, new URL(href, base));

  it('パスの後ろの番号・page などのクエリを、同じ記事の何ページ目として数える', () => {
    expect(of('/articles/-/100/2')).toBe(2);
    expect(of('/articles/-/100?page=3')).toBe(3);
    expect(of('/articles/-/100/page/4/')).toBe(4);
    expect(pageNumber(new URL('https://e.jp/news/100.html'), new URL('https://e.jp/news/100-2.html'))).toBe(2);
    expect(pageNumber(new URL('https://e.jp/post/100/'), new URL('https://e.jp/post/100_3/'))).toBe(3);
  });

  it('ほかの記事・ほかのサイト・ほかのクエリが違うものは数えない', () => {
    expect(of('/articles/-/101')).toBeUndefined();
    expect(of('/articles/-/1002')).toBeUndefined();
    expect(of('https://other.example.jp/articles/-/100/2')).toBeUndefined();
    expect(of('/articles/-/100?page=2&utm_source=x')).toBeUndefined();
  });
});
