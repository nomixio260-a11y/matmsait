/**
 * フォロー（気になるジャンル・掲載元・キーワード）とミュート（表示しない）の共通処理。
 * ブラウザ（フォロー中のページ・ヘッダーの新着件数・一覧のミュート）と、
 * 通知を送るサーバー（analytics/ の Durable Object）の両方で使う（どちらでも動くよう、DOM や Node の機能は使わない）
 */
import { normalizeText } from './search-core.ts';

/** フォローしているもの */
export interface FollowPrefs {
  /** ジャンル（カテゴリの slug） */
  cats: string[];
  /** 掲載元の ID */
  srcs: string[];
  /** キーワード（見出しに含まれていれば当てはまる。空白で区切ると、すべて含むものだけ） */
  words: string[];
}

/** 表示しないもの（ミュート） */
export interface MutePrefs {
  /** ジャンル（総合・新着などの一覧で隠す。そのジャンルのページでは隠さない） */
  cats: string[];
  srcs: string[];
  words: string[];
}

/** updates.json の1件（新着の記事。キーを短くしてサイズを抑えている） */
export interface UpdateEntry {
  /** 記事 ID */
  i: string;
  /** 見出し */
  t: string;
  /** ジャンル（カテゴリの slug） */
  c: string;
  /** 掲載元の ID */
  s: string;
  /** 掲載元の名前 */
  n: string;
  /** 開くページ（AI 要約のある記事はサイト内のパス、ない記事は元記事の URL） */
  u: string;
  /** 公開日時（ISO 8601） */
  d: string;
  /** 話題度（同じ話題を報じた掲載元の数。2以上のときだけ） */
  k?: number;
  /** 話題の ID（話題のページ /topic/<ID>/ へのリンクに使う。2つ以上のメディアが報じた話題だけ） */
  p?: string;
  /** AI 要約がある */
  m?: 1;
}

/** updates.json の話題（多くの掲載元が報じた出来事） */
export interface UpdateTopic {
  /** 同じ話題の記事の ID（通知を同じ話題で何度も送らないために使う） */
  i: string[];
  /** 見出し */
  t: string;
  /** 報じた掲載元の数 */
  k: number;
  /** 開くページ（サイト内のパス） */
  u: string;
}

/** updates.json（ビルドのたびに作る、直近の新着記事と話題） */
export interface UpdatesFile {
  /** ビルドした日時 */
  builtAt: string;
  /** サイトのベースパス（"/" や "/matmsait/"） */
  base: string;
  /** カテゴリの slug → 名前（通知の文に使う） */
  cats: Record<string, string>;
  items: UpdateEntry[];
  hot: UpdateTopic[];
}

/** フォロー・ミュートできる数の上限（通知のサーバーに送る大きさを抑える） */
export const FOLLOW_LIMITS = { cats: 30, srcs: 100, words: 30, wordLength: 30 } as const;

/** カテゴリの slug・掲載元の ID の形 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 文字列の一覧を整える（形の正しくないもの・重複・多すぎるものを除く） */
function cleanList(value: unknown, max: number, check: (text: string) => boolean, key: (text: string) => string = (text) => text): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (out.length >= max) break;
    if (typeof entry !== 'string') continue;
    // 制御文字を除き、全角・半角をそろえる
    const text = entry
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || !check(text)) continue;
    const k = key(text);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(text);
  }
  return out;
}

const isId = (text: string) => ID_PATTERN.test(text);
const isWord = (text: string) => Array.from(text).length <= FOLLOW_LIMITS.wordLength;

function cleanPrefs(value: unknown): FollowPrefs {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    cats: cleanList(record.cats, FOLLOW_LIMITS.cats, isId),
    srcs: cleanList(record.srcs, FOLLOW_LIMITS.srcs, isId),
    words: cleanList(record.words, FOLLOW_LIMITS.words, isWord, normalizeText),
  };
}

/** フォローの設定を整える（保存されていた値・送られてきた値をそのまま信じない） */
export function cleanFollow(value: unknown): FollowPrefs {
  return cleanPrefs(value);
}

/** ミュートの設定を整える */
export function cleanMute(value: unknown): MutePrefs {
  return cleanPrefs(value);
}

export const emptyFollow = (): FollowPrefs => ({ cats: [], srcs: [], words: [] });

/** 何もフォロー（ミュート）していない */
export const isEmptyPrefs = (prefs: FollowPrefs | MutePrefs) => prefs.cats.length + prefs.srcs.length + prefs.words.length === 0;

/** キーワードの照合に使う形（空白で区切った語を、それぞれ正規化したもの） */
export function wordTerms(word: string): string[] {
  return word
    .normalize('NFKC')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeText);
}

const ASCII_WORD = /^[a-z0-9]+$/;
const ASCII_CHAR = /[a-z0-9]/;

/**
 * 正規化した見出しに語が含まれるか。英数字だけの語は、前後が英数字でないときだけ当てはまる
 * （「AI」が「MAIL」に当てはまらないように。「生成AI」「AIエージェント」には当てはまる）
 */
export function containsTerm(normalizedTitle: string, term: string): boolean {
  if (!term) return false;
  if (!ASCII_WORD.test(term)) return normalizedTitle.includes(term);
  for (let at = normalizedTitle.indexOf(term); at !== -1; at = normalizedTitle.indexOf(term, at + 1)) {
    const before = normalizedTitle[at - 1] ?? '';
    const after = normalizedTitle[at + term.length] ?? '';
    if (!ASCII_CHAR.test(before) && !ASCII_CHAR.test(after)) return true;
  }
  return false;
}

/** 見出しがキーワードに当てはまるか（空白で区切った語をすべて含むとき） */
export function matchesWord(normalizedTitle: string, terms: string[]): boolean {
  return terms.length > 0 && terms.every((term) => containsTerm(normalizedTitle, term));
}

/** 照合のために用意したフォロー・ミュート（記事ごとに作り直さない） */
export interface PreparedPrefs {
  cats: Set<string>;
  srcs: Set<string>;
  words: { word: string; terms: string[] }[];
}

export function preparePrefs(prefs: FollowPrefs | MutePrefs): PreparedPrefs {
  return {
    cats: new Set(prefs.cats),
    srcs: new Set(prefs.srcs),
    words: prefs.words.map((word) => ({ word, terms: wordTerms(word) })).filter((entry) => entry.terms.length > 0),
  };
}

/** フォローに当てはまった理由 */
export interface FollowReason {
  kind: 'cat' | 'src' | 'word';
  value: string;
}

/** 記事がフォローに当てはまる理由（キーワード → 掲載元 → ジャンルの順に、いちばん具体的なもの）。当てはまらなければ undefined */
export function followReason(entry: Pick<UpdateEntry, 't' | 'c' | 's'>, follow: PreparedPrefs, normalizedTitle = normalizeText(entry.t)): FollowReason | undefined {
  for (const { word, terms } of follow.words) if (matchesWord(normalizedTitle, terms)) return { kind: 'word', value: word };
  if (follow.srcs.has(entry.s)) return { kind: 'src', value: entry.s };
  if (follow.cats.has(entry.c)) return { kind: 'cat', value: entry.c };
  return undefined;
}

/**
 * ミュートしている記事か。掲載元・キーワードのミュートはいつも効く。
 * ジャンルのミュートは、そのジャンルをフォローしていないときだけ効く（「フォロー中」に出したいものを隠さない）
 */
export function isMuted(
  entry: Pick<UpdateEntry, 't' | 'c' | 's'>,
  mute: PreparedPrefs,
  follow?: PreparedPrefs,
  normalizedTitle = normalizeText(entry.t),
): boolean {
  if (mute.srcs.has(entry.s)) return true;
  if (mute.words.some(({ terms }) => matchesWord(normalizedTitle, terms))) return true;
  return mute.cats.has(entry.c) && !follow?.cats.has(entry.c);
}

export interface FollowMatch {
  entry: UpdateEntry;
  reason: FollowReason;
}

/** 新着の記事のうち、フォローに当てはまり、ミュートしていないもの（並びはそのまま） */
export function matchFollow(entries: UpdateEntry[], follow: FollowPrefs, mute: MutePrefs = emptyFollow()): FollowMatch[] {
  const followPrepared = preparePrefs(follow);
  const mutePrepared = preparePrefs(mute);
  const out: FollowMatch[] = [];
  for (const entry of entries) {
    const title = normalizeText(entry.t);
    const reason = followReason(entry, followPrepared, title);
    if (reason && !isMuted(entry, mutePrepared, followPrepared, title)) out.push({ entry, reason });
  }
  return out;
}

const isString = (value: unknown): value is string => typeof value === 'string';

function cleanEntry(value: unknown): UpdateEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (![v.i, v.t, v.c, v.s, v.n, v.u, v.d].every(isString)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(v.i as string) || Number.isNaN(Date.parse(v.d as string))) return undefined;
  const link = v.u as string;
  if (!/^https?:\/\//.test(link) && !/^\/(?!\/)/.test(link)) return undefined;
  return {
    i: v.i as string,
    t: v.t as string,
    c: v.c as string,
    s: v.s as string,
    n: v.n as string,
    u: link,
    d: v.d as string,
    ...(typeof v.k === 'number' && v.k >= 2 ? { k: Math.floor(v.k) } : {}),
    ...(isString(v.p) && /^[0-9a-f]{16}$/.test(v.p) ? { p: v.p } : {}),
    ...(v.m === 1 ? { m: 1 as const } : {}),
  };
}

function cleanTopic(value: unknown): UpdateTopic | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.i) || !isString(v.t) || typeof v.k !== 'number' || !isString(v.u) || !/^\/(?!\/)/.test(v.u)) return undefined;
  const ids = v.i.filter((id): id is string => isString(id) && /^[0-9a-f]{16}$/.test(id)).slice(0, 50);
  return ids.length > 0 ? { i: ids, t: v.t, k: Math.floor(v.k), u: v.u } : undefined;
}

/** updates.json を読む（形の正しくない記事は除く）。読めなければ undefined */
export function parseUpdates(text: string | undefined): UpdatesFile | undefined {
  if (!text) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.items)) return undefined;
  const base = isString(record.base) && /^\/([a-z0-9_-]+\/)*$/.test(record.base) ? record.base : '/';
  const cats: Record<string, string> = {};
  if (typeof record.cats === 'object' && record.cats !== null) {
    for (const [slug, name] of Object.entries(record.cats as Record<string, unknown>)) {
      if (ID_PATTERN.test(slug) && isString(name)) cats[slug] = name.slice(0, 30);
    }
  }
  return {
    builtAt: isString(record.builtAt) ? record.builtAt : '',
    base,
    cats,
    items: record.items.map(cleanEntry).filter((entry): entry is UpdateEntry => entry !== undefined),
    hot: Array.isArray(record.hot) ? record.hot.map(cleanTopic).filter((topic): topic is UpdateTopic => topic !== undefined) : [],
  };
}

/** サイト内のパス（"/summary/..."）をベースパスつきにする。元記事の URL はそのまま */
export function withBase(link: string, base: string): string {
  if (/^https?:\/\//.test(link)) return link;
  return `${base.replace(/\/$/, '')}${link}`;
}
