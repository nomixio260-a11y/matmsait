/**
 * 記事のページ（HTML）から本文を取り出す（本文の自動取得用。管理画面のブックマークレットと同じ考え方）。
 * 本文の目印（itemprop="articleBody"）があればそれを、なければリンクでない文字がいちばん多いまとまりを本文とし、
 * メニュー・関連記事・ランキング・共有ボタン・コメント・写真の説明などは除く
 */
import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

/** 本文とは関係ない部分 */
const JUNK = 'script,style,noscript,template,title,iframe,video,audio,canvas,svg,button,select,figure,nav,aside,footer';
/** 本文とは関係ないことが多い部分（ただし、ページの文の大半を含むまとまりは消さない） */
const SKIP =
  'form,[hidden],[aria-hidden="true"],[class*="share"],[class*="related"],[class*="ranking"],[class*="recommend"],[class*="banner"],[class*="breadcrumb"],[class*="sns"],[class*="comment"],[id*="comment"]';
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
  const h1 = root.querySelector('h1');
  const title = clean(h1?.text ?? '') || clean(root.querySelector('title')?.text ?? '');
  for (const element of root.querySelectorAll(JUNK)) element.remove();
  // 見出し・本文の目印を含むまとまり、html・body・main、ページの文の大半を含むまとまりは、クラス名などが当てはまっても消さない
  // （<body class="news breadcrumb">・<div class="hidden_share post"> のように、ページや記事全体のクラス名に「breadcrumb」「share」などが入っているサイトや、
  // ページ全体を form で囲むサイトがある）
  const keep = new Set<Node>();
  for (const anchor of [h1, root.querySelector('[itemprop="articleBody"]')]) {
    for (let node: Node | null = anchor; node; node = node.parentNode) keep.add(node);
  }
  const sentences = sentenceLength(root);
  for (const element of root.querySelectorAll(SKIP)) {
    if (keep.has(element) || ['HTML', 'BODY', 'MAIN'].includes(element.tagName)) continue;
    if (sentences > 0 && sentenceLength(element) >= sentences * 0.5) continue;
    element.remove();
  }

  // タグの閉じ忘れなどで本文が body の外に置かれるページもあるので、body に限らずページ全体から探す
  const page = root.querySelector('html') ?? root;
  const marked = root.querySelector('[itemprop="articleBody"]');
  const container = marked && clean(marked.structuredText).length >= 100 ? marked : densest(page);
  return { title, text: clean(container.structuredText), robots };
}

/** 文の終わり（本文の文章にはあり、見出しの一覧やラベルにはふつうない） */
const SENTENCE = /[。！？]/;
/** 文（「。」などを含む文字）の文字数。リンクの中は数えない */
function sentenceLength(node: Node, inLink = false): number {
  let sum = 0;
  for (const child of node.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      const text = child.text.trim();
      if (!inLink && SENTENCE.test(text)) sum += text.length;
    } else if (child instanceof HTMLElement) {
      sum += sentenceLength(child, inLink || child.tagName === 'A');
    }
  }
  return sum;
}

/** これより上には広げない */
const TOP = new Set(['BODY', 'HTML']);
/** 空白を除いた文字の数（リンクの文字も数える） */
const size = (element: HTMLElement) => element.structuredText.replace(/\s+/g, '').length;
/** まとまりの形（タグと最初のクラス名。小見出しごとに分かれた本文の、同じ形のまとまりを見分ける） */
const shape = (element: HTMLElement) => `${element.tagName}.${(element.getAttribute('class') ?? '').trim().split(/\s+/)[0]}`;

/**
 * 本文らしい文字がいちばん多いまとまり（小見出しごとに分かれていれば、大きすぎない範囲で記事全体に広げる）。
 * リンクの文字は数えず（メニュー・関連記事やおすすめの見出しの一覧は、ほとんどがリンク）、
 * 「。」などで終わる文を含まない文字（見出しの一覧・ラベル・日付など）は軽く数える
 */
function densest(page: HTMLElement): HTMLElement {
  const own = new Map<HTMLElement, number>();
  const walk = (node: Node, container: HTMLElement, inLink: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) {
        const text = child.text.trim();
        if (!inLink && text) own.set(container, (own.get(container) ?? 0) + text.length * (SENTENCE.test(text) ? 1 : 0.3));
      } else if (child instanceof HTMLElement) {
        walk(child, CONTAINERS.has(child.tagName) ? child : container, inLink || child.tagName === 'A');
      }
    }
  };
  walk(page, page, false);
  let best = page;
  let top = 0;
  for (const [element, count] of own) {
    if (count > top) {
      best = element;
      top = count;
    }
  }
  // 小見出しごとに同じ形のまとまりが並んでいて、それが親の文字の大半なら、親に広げる
  let result = best;
  const parent = best.parentNode;
  if (parent instanceof HTMLElement && parent.tagName && !TOP.has(parent.tagName)) {
    const same = parent.childNodes.filter((child): child is HTMLElement => child instanceof HTMLElement && shape(child) === shape(best));
    if (same.length >= 2 && same.reduce((sum, element) => sum + size(element), 0) >= size(parent) * 0.6) result = parent;
  }
  // さらに、親が大きすぎなければ（見出し・日付などを足す程度なら）記事全体に広げる（body までは広げない）
  const limit = size(result) * 1.5;
  for (let next = result.parentNode; next instanceof HTMLElement && next.tagName && !TOP.has(next.tagName); next = next.parentNode) {
    if (size(next) > limit) break;
    result = next;
  }
  return result;
}
