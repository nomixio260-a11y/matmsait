import { describe, expect, it } from 'vitest';
import { extractArticleText } from '../scripts/lib/article-text.ts';

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
