/**
 * サイト内検索（ブラウザで動く。検索ページと共通のロジックをテストできるよう分けている）
 */

/** search-index.json の1件（キーを短くしてサイズを抑えている） */
export interface SearchEntry {
  /** 記事ID */
  i: string;
  /** 見出し */
  t: string;
  /** 元記事の URL */
  u: string;
  /** 掲載元の名前 */
  s: string;
  /** 掲載元のホスト名 */
  h: string;
  /** カテゴリの slug */
  c: string;
  /** 公開日時（ISO 8601） */
  d: string;
  /** AI 要約（ある記事だけ） */
  m?: string;
  /** AI 要約のキーワード（空白区切り。ある記事だけ） */
  k?: string;
  /** 抜粋の先頭（要約のない記事だけ） */
  e?: string;
  /** 話題度（同じ話題を報じた掲載元の数。2以上のときだけ） */
  v?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** 1文字ずつ正規化する（全角・半角、大文字・小文字、カタカナ・ひらがなの違いを吸収） */
function normalizeChar(char: string): string {
  return char
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 検索用に正規化した文字列 */
export function normalizeText(text: string): string {
  return Array.from(text, normalizeChar).join('');
}

/** 検索語を分ける（全角スペースも区切りにする）。terms は正規化したもの */
export function parseQuery(query: string): { words: string[]; terms: string[] } {
  const words = query
    .normalize('NFKC')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return { words, terms: words.map(normalizeText) };
}

export interface RankOptions {
  now: number;
  category?: string;
  /** 公開から何日以内の記事に絞るか */
  days?: number;
  summaryOnly?: boolean;
  sort?: 'relevance' | 'new';
}

interface Prepared {
  entry: SearchEntry;
  title: string;
  keywords: string;
  body: string;
  site: string;
}

const prepared = new WeakMap<SearchEntry, Prepared>();

function prepare(entry: SearchEntry): Prepared {
  let value = prepared.get(entry);
  if (!value) {
    value = {
      entry,
      title: normalizeText(entry.t),
      keywords: normalizeText(entry.k ?? ''),
      body: normalizeText(entry.m ?? entry.e ?? ''),
      site: normalizeText(`${entry.s} ${entry.h}`),
    };
    prepared.set(entry, value);
  }
  return value;
}

/**
 * 条件に合う記事を、関連度（見出し > 要約のキーワード > 要約・抜粋 > 掲載元の順に重く、新しい記事・話題の記事・要約のある記事を少し上げる）
 * または新しい順に並べて返す。検索語はすべて含む記事だけ（AND 検索）
 */
export function rankEntries(entries: SearchEntry[], terms: string[], options: RankOptions): SearchEntry[] {
  const { now, category, days, summaryOnly = false, sort = 'relevance' } = options;
  const cutoff = days ? now - days * DAY : -Infinity;
  const scored: { entry: SearchEntry; score: number; time: number }[] = [];
  for (const entry of entries) {
    if (category && entry.c !== category) continue;
    if (summaryOnly && !entry.m) continue;
    const time = Date.parse(entry.d);
    if (time < cutoff) continue;
    const { title, keywords, body, site } = prepare(entry);
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      if (title.includes(term)) score += title.startsWith(term) ? 8 : 5;
      else if (keywords.includes(term)) score += 4;
      else if (body.includes(term)) score += 3;
      else if (site.includes(term)) score += 2;
      else {
        matchedAll = false;
        break;
      }
    }
    if (!matchedAll) continue;
    const age = Math.max(0, now - time) / DAY;
    score += Math.max(0, 3 - age / 3) + Math.min(entry.v ?? 1, 6) * 0.4 + (entry.m ? 1 : 0);
    scored.push({ entry, score, time });
  }
  return scored
    .sort((a, b) => (sort === 'new' ? b.time - a.time : b.score - a.score || b.time - a.time))
    .map(({ entry }) => entry);
}

/** 表示する文字列を、検索語に一致する部分とそれ以外に分ける（正規化した文字列で照合し、元の文字列の位置に戻す） */
export function highlightParts(text: string, terms: string[]): { text: string; match: boolean }[] {
  const chars = Array.from(text);
  // 正規化した文字列の各位置が、元の文字列の何文字目から来たか
  const origin: number[] = [];
  let normalized = '';
  chars.forEach((char, index) => {
    const value = normalizeChar(char);
    normalized += value;
    for (let n = 0; n < value.length; n++) origin.push(index);
  });
  const marked = new Array<boolean>(chars.length).fill(false);
  for (const term of terms.filter(Boolean)) {
    for (let from = normalized.indexOf(term); from >= 0; from = normalized.indexOf(term, from + term.length)) {
      for (let n = from; n < from + term.length; n++) marked[origin[n]] = true;
    }
  }
  const parts: { text: string; match: boolean }[] = [];
  chars.forEach((char, index) => {
    const last = parts.at(-1);
    if (last && last.match === marked[index]) last.text += char;
    else parts.push({ text: char, match: marked[index] });
  });
  return parts;
}

/** キーワードの候補にしない言葉（どの記事にも出てくる言葉） */
const STOP_WORDS = new Set(
  [
    'ニュース',
    'まとめ',
    'レビュー',
    'セール',
    'コラム',
    'インタビュー',
    'イベント',
    'キャンペーン',
    'プレゼント',
    'アップデート',
    'リリース',
    'サービス',
    'シリーズ',
    'モデル',
    'スタート',
    '発表',
    '発売',
    '公開',
    '開始',
    '開催',
    '決定',
    '予定',
    '対応',
    '提供',
    '実施',
    '販売',
    '登場',
    '記事',
    '情報',
    '日本',
    '今年',
    '来年',
    '年度',
    '本日',
    '今日',
    '可能',
    '新型',
    '最新',
    '限定',
    '無料',
    '注目',
    '話題',
    '会見',
    '速報',
    '動画',
    '写真',
    '一覧',
    '解説',
    'the',
    'and',
    'for',
    'with',
    'new',
  ].map(normalizeText),
);

/**
 * 直近の見出しによく出てくる言葉（カタカナ語・英数字の語・漢字の熟語）を、話題のキーワードとして返す。
 * 単語に区切る仕組みがないので、文字の種類で切り出す簡易な方法
 */
export function suggestKeywords(entries: SearchEntry[], now: number, { hours = 48, limit = 12, minCount = 3 } = {}): string[] {
  const cutoff = now - hours * 60 * 60 * 1000;
  const counts = new Map<string, { label: string; count: number }>();
  const pattern = /[ァ-ヴー]{3,12}|[A-Za-z][A-Za-z0-9.+-]{2,15}|[一-龠々]{2,6}/g;
  for (const entry of entries) {
    if (Date.parse(entry.d) < cutoff) continue;
    const seen = new Set<string>();
    for (const match of entry.t.normalize('NFKC').matchAll(pattern)) {
      const label = match[0].replace(/[.+-]+$/, '');
      const key = normalizeText(label);
      if (label.length < 2 || STOP_WORDS.has(key) || /^ー/.test(label) || seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      if (current) current.count++;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= minCount)
    .sort((a, b) => b.count - a.count || b.label.length - a.label.length)
    .slice(0, limit)
    .map((entry) => entry.label);
}
