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
    '万円',
    '時代',
    'メディア',
    'オリジナル',
    '理由',
    '最大',
    '衝撃',
    '世界',
    '搭載',
    'ファン',
    'digital',
    '本当',
    '令和',
    'アクセス',
    '選手',
    '監督',
    'ゲーム',
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
export function suggestKeywords(
  entries: Pick<SearchEntry, 't' | 'd' | 's'>[],
  now: number,
  { hours = 48, limit = 12, minCount = 3, minSources = 1 } = {},
): string[] {
  const cutoff = now - hours * 60 * 60 * 1000;
  const counts = new Map<string, { label: string; count: number; sources: Set<string> }>();
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
      if (current) {
        current.count++;
        current.sources.add(entry.s);
      } else {
        counts.set(key, { label, count: 1, sources: new Set([entry.s]) });
      }
    }
  }
  return [...counts.values()]
    // 1つの掲載元だけの決まり文句（サイト名など）を除くため、いくつの掲載元の見出しに出たかも見る
    .filter((entry) => entry.count >= minCount && entry.sources.size >= minSources)
    .sort((a, b) => b.count - a.count || b.label.length - a.label.length)
    .slice(0, limit)
    .map((entry) => entry.label);
}

// ===== 言葉での検索（「今日 急上昇 AI」のような入力を、期間・並べ方・ジャンルの条件と検索語に分ける） =====

export type QueryKind = 'rising' | 'hot' | 'new';

export interface QueryCondition {
  /** 入力された言葉 */
  word: string;
  /** どう読んだか（「24時間以内」など） */
  meaning: string;
}

export interface InterpretedQuery {
  /** 検索語として残った言葉（表示用と正規化したもの） */
  words: string[];
  terms: string[];
  /** 条件として読んだもの */
  days?: number;
  kind?: QueryKind;
  category?: string;
  summaryOnly?: boolean;
  conditions: QueryCondition[];
}

const PERIOD_WORDS: [RegExp, number, string][] = [
  [/^(今日|きょう|本日|24時間|二十四時間)$/, 1, '24時間以内'],
  [/^(昨日|きのう)$/, 2, '48時間以内'],
  [/^(3日|三日|3日間)$/, 3, '3日以内'],
  [/^(今週|1週間|一週間|7日|7日間|最近|この1週間)$/, 7, '1週間以内'],
];

const KIND_WORDS: [RegExp, QueryKind, string][] = [
  [/^(急上昇|急増|伸びている|拡大中|広がっている)$/, 'rising', '報じる媒体が増えているトピックを先に'],
  [/^(話題|人気|注目|話題の|ホット|ランキング)$/, 'hot', '話題度の高い順'],
  [/^(新着|最新|新しい|速報)$/, 'new', '新しい順'],
];

/**
 * 入力を、期間（今日・今週…）・並べ方（急上昇・話題・新着）・ジャンル（ジャンル名）・AI 要約の有無の条件と、検索語に分ける。
 * 条件の言葉だけのときは、検索語なしで条件だけで探す
 */
export function interpretQuery(query: string, categories: readonly { slug: string; name: string }[] = []): InterpretedQuery {
  const { words } = parseQuery(query);
  const result: InterpretedQuery = { words: [], terms: [], conditions: [] };
  // ジャンルの名前（「ゲーム・アニメ」は「ゲーム」「アニメ」でも当てはめる）
  const categoryAliases = new Map<string, { slug: string; name: string }>();
  for (const category of categories) {
    for (const alias of [category.name, ...category.name.split('・'), category.slug]) categoryAliases.set(normalizeText(alias), category);
  }
  for (const word of words) {
    const key = normalizeText(word);
    const period = PERIOD_WORDS.find(([pattern]) => pattern.test(word));
    if (period && result.days === undefined) {
      result.days = period[1];
      result.conditions.push({ word, meaning: period[2] });
      continue;
    }
    const kind = KIND_WORDS.find(([pattern]) => pattern.test(word));
    if (kind && result.kind === undefined) {
      result.kind = kind[1];
      result.conditions.push({ word, meaning: kind[2] });
      continue;
    }
    const category = categoryAliases.get(key);
    // ジャンル名は、ほかに検索語があるときもジャンルの条件として読む（「AI テクノロジー」）
    if (category && result.category === undefined) {
      result.category = category.slug;
      result.conditions.push({ word, meaning: `ジャンル「${category.name}」` });
      continue;
    }
    if (/^(ai要約|要約|要約あり)$/.test(key) && !result.summaryOnly) {
      result.summaryOnly = true;
      result.conditions.push({ word, meaning: 'AI 要約のある記事' });
      continue;
    }
    result.words.push(word);
    result.terms.push(key);
  }
  return result;
}

/** search-topics.json のトピック（キーを短くしている） */
export interface TopicEntry {
  /** トピックの ID（最初の記事の ID） */
  i: string;
  /** 見出し */
  t: string;
  /** トピックのすべての記事の見出し（正規化して空白でつないだもの） */
  w: string;
  /** 報じた媒体の数 */
  v: number;
  /** 話題度 */
  sc: number;
  /** 直近3時間に新しく報じた媒体の数 */
  g: number;
  /** 最後に報じられた日時 */
  d: string;
  /** ジャンル */
  c: string;
}

/** search-topics.json のキーワード */
export interface WordEntry {
  /** 言葉 */
  w: string;
  /** ページの URL の言葉の部分 */
  s: string;
  /** 直近の記事の数 */
  n: number;
}

/** 条件と検索語に合うトピック（検索語はすべて、どれかの記事の見出しに含まれること） */
export function rankTopics(topics: readonly TopicEntry[], query: InterpretedQuery, now: number): TopicEntry[] {
  const cutoff = query.days ? now - query.days * DAY : -Infinity;
  const matched = topics.filter(
    (topic) =>
      Date.parse(topic.d) >= cutoff &&
      (!query.category || topic.c === query.category) &&
      query.terms.every((term) => topic.w.includes(term)) &&
      (query.kind !== 'rising' || topic.g >= 1),
  );
  const sorter: Record<QueryKind, (a: TopicEntry, b: TopicEntry) => number> = {
    rising: (a, b) => b.g - a.g || b.sc - a.sc,
    hot: (a, b) => b.sc - a.sc || b.v - a.v,
    new: (a, b) => b.d.localeCompare(a.d),
  };
  return [...matched].sort(sorter[query.kind ?? 'hot']);
}

/** 検索語に合うキーワードのページ（言葉が検索語を含むか、検索語が言葉を含む。記事の多い順） */
export function matchWords(words: readonly WordEntry[], terms: readonly string[], limit = 8): WordEntry[] {
  if (terms.length === 0) return [];
  return words
    .filter((entry) => {
      const key = normalizeText(entry.w);
      return terms.some((term) => term.length >= 2 && (key.includes(term) || (key.length >= 2 && term.includes(key))));
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/** 記事がどこで一致したか（「見出しに一致」などの表示に使う） */
export function matchPlace(entry: SearchEntry, terms: readonly string[]): 'title' | 'keywords' | 'summary' | 'excerpt' | 'site' | undefined {
  if (terms.length === 0) return undefined;
  const { title, keywords, body, site } = prepare(entry);
  if (terms.every((term) => title.includes(term))) return 'title';
  if (terms.every((term) => title.includes(term) || keywords.includes(term))) return 'keywords';
  if (terms.every((term) => title.includes(term) || keywords.includes(term) || body.includes(term))) return entry.m ? 'summary' : 'excerpt';
  return 'site';
}
