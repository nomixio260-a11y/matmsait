/**
 * 記事のページ（HTML）から本文を取り出す（本文の自動取得用。管理画面のブックマークレットと同じ考え方）。
 * 本文の目印（itemprop="articleBody"）があればそれを、なければ文字がいちばん多いまとまりを本文とし、
 * メニュー・関連記事・ランキング・共有ボタン・コメント・写真の説明などは除く
 */
import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

/** 本文とは関係ない部分 */
const SKIP =
  'script,style,noscript,template,iframe,video,audio,canvas,svg,nav,aside,footer,form,button,select,figure,[hidden],[aria-hidden="true"],[class*="share"],[class*="related"],[class*="ranking"],[class*="recommend"],[class*="banner"],[class*="breadcrumb"],[class*="sns"],[class*="comment"],[id*="comment"]';
/** 文字を数えるまとまり */
const CONTAINERS = new Set(['ARTICLE', 'MAIN', 'SECTION', 'DIV', 'TD', 'BODY']);
/** これより短ければ本文が取れなかったとみなす */
export const MIN_TEXT_LENGTH = 200;

export interface ExtractedArticle {
  title: string;
  text: string;
  /** ページの meta robots の値（noai などの確認用） */
  robots: string[];
}

const clean = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function extractArticleText(html: string): ExtractedArticle {
  const root = parse(html, { comment: false });
  const robots = root
    .querySelectorAll('meta[name="robots"], meta[name="ROBOTS"]')
    .map((meta) => meta.getAttribute('content') ?? '');
  const title = clean(root.querySelector('h1')?.text ?? '') || clean(root.querySelector('title')?.text ?? '');
  for (const element of root.querySelectorAll(SKIP)) element.remove();

  const body = root.querySelector('body') ?? root;
  const marked = root.querySelector('[itemprop="articleBody"]');
  const container = marked && clean(marked.structuredText).length >= 100 ? marked : densest(body);
  return { title, text: clean(container.structuredText), robots };
}

/** 文字がいちばん多いまとまり（小見出しごとに分かれていれば、大きすぎない範囲で記事 article 全体に広げる） */
function densest(body: HTMLElement): HTMLElement {
  const own = new Map<HTMLElement, number>();
  const total = new Map<HTMLElement, number>();
  const walk = (node: Node, container: HTMLElement): number => {
    let sum = 0;
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) {
        const length = child.text.trim().length;
        if (length > 0) {
          own.set(container, (own.get(container) ?? 0) + length);
          sum += length;
        }
      } else if (child instanceof HTMLElement) {
        const next = CONTAINERS.has(child.tagName) ? child : container;
        const inner = walk(child, next);
        sum += inner;
        if (next === child) total.set(child, inner);
      }
    }
    return sum;
  };
  total.set(body, walk(body, body));
  let best = body;
  let top = 0;
  for (const [element, count] of own) {
    if (count > top) {
      best = element;
      top = count;
    }
  }
  const article = best.closest('article');
  return article && (total.get(article) ?? 0) <= (total.get(best) ?? 0) * 2.5 ? article : best;
}
