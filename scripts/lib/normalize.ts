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

/** 抜粋を作る。全文転載にならないよう max 文字（コードポイント単位）で切り詰める */
export function makeExcerpt(html: string, max = 120): string {
  const chars = Array.from(stripHtml(html));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|yclid|msclkid|mc_cid|mc_eid|_ga)$/i;

/** http(s) 以外や不正なURLは null。トラッキング用パラメータとハッシュを除去する */
export function normalizeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
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

export function itemId(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

/** 公開日時を ISO 文字列にする。欠落・不正・未来日付は取得時刻 now に置き換える */
export function normalizePublishedAt(raw: string | undefined, now: Date): string {
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getTime() > now.getTime()) {
    return now.toISOString();
  }
  return date.toISOString();
}
