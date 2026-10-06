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

  it('段落（p）を使わず改行で書かれたページも取り出す', () => {
    const html = `<html><body><h1>見出し</h1><article><div class="text">${para(1)}<br><br>${para(2)}<br><br>${para(3)}</div></article><div>短い</div></body></html>`;
    const { text } = extractArticleText(html);
    for (const n of [1, 2, 3]) expect(text).toContain(para(n));
  });
});
