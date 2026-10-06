import { createHash } from 'node:crypto';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '・',
  times: '×',
  yen: '¥',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** HTMLタグ・エンティティを除去し、空白を1つにまとめたプレーンテキストを返す */
export function stripHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // 二重エスケープされたフィード(&lt;p&gt;...)にも対応するため、デコード後にもう一度タグを除去する
  const once = decodeEntities(withoutBlocks.replace(/<[^>]*>/g, ' '));
  return decodeEntities(once.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** max 文字（コードポイント単位）を超えたら … を付けて切り詰める */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** 抜粋を作る。全文転載にならないよう max 文字で切り詰める */
export function makeExcerpt(html: string, max = 120): string {
  return truncate(stripHtml(html), max);
}

// 記事末尾などに付くサイト名（「記事名 - 日本経済新聞」「記事名：朝日新聞」など）
const SITE_SUFFIX = /\s*(?:\s[|｜\-–—]\s|[|｜]|：)\s*[^|｜：]{1,30}$/;

/** 本文の冒頭がタイトルの繰り返しになっている場合は取り除く */
export function removeLeadingTitle(title: string, text: string): string {
  const candidates = [title, title.replace(SITE_SUFFIX, '')].filter((c) => Array.from(c).length >= 8);
  for (const candidate of candidates) {
    if (text.startsWith(candidate)) {
      return text.slice(candidate.length).replace(/^[\s|｜:：\-–—、。,.]+/, '');
    }
  }
  return text;
}

// ページの部品やスクリプトの断片が説明文として配信されてしまっているもの
const JUNK_PATTERNS = [
  /^(?:©|\(c\)\s|copyright\b|all rights reserved)/i,
  /[a-z][\w-]*#[a-z]\w*/i,
  /->[a-z]/i,
  /\{\{|\}\}/,
  /\bfunction\s*\(|\b(?:window|document)\.[a-z]+\s*[(=[]/i,
];

export function isJunkText(text: string): boolean {
  return JUNK_PATTERNS.some((pattern) => pattern.test(text));
}

/** タイトルの繰り返しやゴミを除いた抜粋。意味のある長さが残らなければ空文字 */
export function buildExcerpt(title: string, html: string, max = 120): string {
  const text = removeLeadingTitle(title, stripHtml(html));
  if (Array.from(text).length < 15 || isJunkText(text)) return '';
  return truncate(text, max);
}

/** タイトルを整形する。stripPattern（例: ITmedia の「[ITmedia News]」）に一致する部分は消す */
export function cleanTitle(raw: string, stripPattern?: RegExp): string {
  const title = stripHtml(raw);
  if (!stripPattern) return title;
  return title.replace(stripPattern, '').trim() || title;
}

const TRACKING_PARAMS =
  /^(utm_[a-z_]+|at_[a-z_]+|fbclid|gclid|dclid|yclid|msclkid|igshid|mc_cid|mc_eid|_ga|_gl|spm)$/i;

/** http(s) 以外や不正なURLは null。相対URLは base で解決し、トラッキング用パラメータとハッシュを除去する */
export function normalizeUrl(raw: string | undefined, base?: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString();
}

/** 同じ記事を指すURLを同一視するためのキー（http/https・www・末尾スラッシュ・パラメータ順の違いを無視） */
export function dedupeKey(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  return `${host}${path}${query ? `?${query}` : ''}`;
}

export function itemId(url: string): string {
  return createHash('sha1').update(dedupeKey(url)).digest('hex').slice(0, 16);
}

/** 公開日時を ISO 文字列にする。欠落・不正・未来日付は取得時刻 now に置き換える */
export function normalizePublishedAt(raw: string | undefined, now: Date): string {
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getTime() > now.getTime()) {
    return now.toISOString();
  }
  return date.toISOString();
}
