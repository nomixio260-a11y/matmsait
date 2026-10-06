/**
 * 記事ページから本文を取り出す（AI 要約に渡すため。サイトには掲載しない）
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { decodeBody } from './http.ts';

export interface ArticleText {
  title: string;
  /** 段落ごとに改行した本文 */
  text: string;
}

/** Content-Type → <meta charset> → <meta http-equiv> の順で文字コードを決めて HTML を文字列にする */
export function decodeHtml(body: Buffer, contentType: string | undefined): string {
  if (/charset\s*=/i.test(contentType ?? '')) return decodeBody(body, contentType);
  const head = body.subarray(0, 4096).toString('latin1');
  const charset =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1] ??
    head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w.:-]+)/i)?.[1];
  return decodeBody(body, charset ? `text/html; charset=${charset}` : contentType);
}

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dt, dd, tr, figcaption, div, br';

/** HTML の断片をテキストにする。ブロック要素の切れ目を改行にし、空白をそろえる */
function blockText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const element of document.querySelectorAll('script, style, noscript, template, iframe, svg, button, form')) {
    element.remove();
  }
  for (const element of document.querySelectorAll(BLOCKS)) {
    element.after(document.createTextNode('\n'));
  }
  return (document.body.textContent ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** 本文が短すぎるページ（ログイン画面・目次・動画だけのページなど）は要約しない */
export const MIN_ARTICLE_LENGTH = 200;

/** 文字の2連続（記号・空白を除く）。日本語は単語に区切れないので2文字単位で比べる */
function bigrams(text: string): Set<string> {
  const chars = Array.from(text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''));
  const result = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]);
  return result;
}

/**
 * 取り出した本文が見出しの記事のものらしいか（サイドバーや別記事を拾っていないか）。
 * 見出しの2文字の組のうち一定の割合が本文に出てくれば同じ記事とみなす
 */
export function isAboutTitle(title: string, text: string, threshold = 0.3): boolean {
  // 「記事名 - サイト名」「記事名 | 新聞名」のサイト名部分は本文に出てこないので、先頭の記事名の部分で比べる
  const parts = title.split(/\s+[-|｜–—]\s+|｜/);
  const main = bigrams(parts[0]).size >= 4 ? parts[0] : parts.reduce((a, b) => (b.length > a.length ? b : a), '');
  const wanted = bigrams(main);
  if (wanted.size < 4) return true;
  const found = bigrams(text);
  let hits = 0;
  for (const pair of wanted) if (found.has(pair)) hits++;
  return hits / wanted.size >= threshold;
}

/**
 * Readability で本文らしい部分を取り出す。取り出せないときは null。
 * 本文に見えないもの（短すぎる・同じ行の繰り返しなど）も null にする。
 */
export function extractArticle(html: string): ArticleText | null {
  if (!/<html|<body/i.test(html)) return null;
  let title = '';
  let content: string | null | undefined;
  try {
    const { document } = parseHTML(html);
    title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || document.title?.trim() || '';
    content = new Readability(document as unknown as Document, { charThreshold: 300 }).parse()?.content;
  } catch {
    return null;
  }
  if (!content) return null;
  const lines = blockText(content).split('\n');
  // 「関連記事」「この記事をシェア」などの短い行が続く部分は本文ではないので除く
  const text = lines.filter((line, index) => line.length >= 8 || (lines[index + 1]?.length ?? 0) >= 40).join('\n');
  if (Array.from(text).length < MIN_ARTICLE_LENGTH) return null;
  if (new Set(lines).size < lines.length / 2) return null;
  return { title, text };
}

/** 長い本文は先頭から max 字まで（段落の途中で切らない） */
export function clipText(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;
  const out: string[] = [];
  let length = 0;
  for (const line of text.split('\n')) {
    const size = Array.from(line).length + 1;
    if (length + size > max) {
      if (out.length === 0) out.push(Array.from(line).slice(0, max).join(''));
      break;
    }
    out.push(line);
    length += size;
  }
  return `${out.join('\n')}\n（以下略）`;
}
