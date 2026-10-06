/**
 * AI 要約の共通ロジック（管理画面のブラウザと CLI の両方で使うので Node 専用の機能は使わない）
 * 1. 要約のない記事から AI に渡すプロンプトを作る
 * 2. AI の回答（JSON）を取り出して検証する
 * 3. 月別の要約ファイル（data/summaries/YYYY-MM.json）にマージする
 */
import { jstDateKey } from './dates.ts';
import type { Item, SummaryRecord } from './types.ts';

// ===== 1. プロンプト =====

export type SummaryLength = 'short' | 'normal' | 'long';

/** 要約の長さ（字数の目安） */
export const SUMMARY_LENGTHS: Record<SummaryLength, { label: string; min: number; max: number }> = {
  short: { label: '短め', min: 60, max: 100 },
  normal: { label: '標準', min: 120, max: 200 },
  long: { label: '長め', min: 200, max: 300 },
};

/** プロンプトに載せる記事 */
export interface PromptArticle {
  id: string;
  title: string;
  url: string;
  /** 配信元サイト名 */
  site: string;
  excerpt?: string;
}

export interface PromptOptions {
  siteName: string;
  length: SummaryLength;
  /** 要点（箇条書き）も書かせるか */
  points: boolean;
}

export function buildSummaryPrompt(articles: PromptArticle[], { siteName, length, points }: PromptOptions): string {
  const { min, max } = SUMMARY_LENGTHS[length];
  const input = articles.map(({ id, title, url, site, excerpt }) => ({
    id,
    title,
    url,
    site,
    ...(excerpt ? { excerpt } : {}),
  }));
  const example = {
    id: '入力の id',
    status: 'ok',
    summary: '要約文',
    ...(points ? { points: ['要点1', '要点2', '要点3'] } : {}),
  };
  const lines = [
    `あなたはニュースまとめサイト「${siteName}」の編集者です。下の「記事一覧」にある${articles.length}件の記事について、それぞれの url を開いて本文を読み、日本語で要約してください。`,
    '',
    '# ルール',
    '- 必ず各記事の url にアクセスし、本文の内容にもとづいて書いてください。',
    `- summary は${min}〜${max}字程度で、何が・誰が・どうなったのかが一読でわかるように書いてください。`,
    ...(points ? ['- points には記事の重要なポイントを3つまで、それぞれ40字以内の短い文で書いてください。'] : []),
    '- 原文の文章をそのまま書き写さず、自分の言葉で言い換えてください（直接の引用はしない）。',
    '- 記事に書かれていないこと、推測、意見や感想は加えないでください。',
    '- 記事にアクセスできない、または内容を確認できない場合は、推測で書かずに status を "unavailable"、summary を空文字にしてください。',
    '- excerpt は RSS の抜粋です。記事を特定する参考にとどめ、要約は本文にもとづいて書いてください。',
    '- id は入力の値をそのまま使い、入力したすべての記事について1件ずつ出力してください。',
    '- 出力は下の形式の JSON 配列だけにしてください。前後に説明文を付けないでください。',
    '',
    '# 出力形式',
    JSON.stringify([example], null, 2),
    '',
    `# 記事一覧（${articles.length}件）`,
    JSON.stringify(input, null, 2),
  ];
  return lines.join('\n');
}

// ===== 2. AI の回答の取り出しと検証 =====

export interface SummaryEntry {
  id: string;
  status: string;
  summary: string;
  points: string[];
}

/** 回答文から JSON 部分を取り出して読み込む（コードブロックや前後の説明文があっても読める） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error('回答の中に JSON が見つかりません');
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (end <= start) throw new Error('JSON が途中で切れているようです');
  const json = body.slice(start, end + 1);
  try {
    return JSON.parse(json);
  } catch (error) {
    // よくある崩れ（末尾の余分なカンマ）だけは直して読み直す
    try {
      return JSON.parse(json.replace(/,\s*([\]}])/g, '$1'));
    } catch {
      throw new Error(`JSON として読み込めません（${error instanceof Error ? error.message : error}）`);
    }
  }
}

/** さまざまな形の回答（配列 / {summaries: [...]} / {id: {...}}）を同じ形にそろえる */
export function normalizeEntries(data: unknown): SummaryEntry[] {
  let list: unknown[];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>;
    const inner = object.summaries ?? object.items ?? object.results ?? object.articles;
    list = Array.isArray(inner)
      ? inner
      : Object.entries(object).map(([id, value]) =>
          typeof value === 'string' ? { id, summary: value } : { id, ...(value as Record<string, unknown>) },
        );
  } else {
    throw new Error('要約の一覧（JSON の配列）になっていません');
  }
  return list.map((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return {
      id: String(record.id ?? '').trim(),
      status: String(record.status ?? 'ok').trim().toLowerCase(),
      summary: typeof record.summary === 'string' ? record.summary : '',
      points: Array.isArray(record.points) ? record.points.filter((p): p is string => typeof p === 'string') : [],
    };
  });
}

/** HTML タグや Markdown の強調記号を除き、空白をまとめる */
export function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** 「記事にアクセスできませんでした」のような、要約の代わりに書かれた断り文 */
const REFUSAL =
  /アクセスでき|閲覧でき|開けません|開くことができ|確認でき(?:ませ|な)|取得でき|読み込めませ|申し訳|cannot access|can't access|unable to (?:access|open|read|browse)|not accessible/i;

export interface AcceptedSummary {
  id: string;
  summary: string;
  points: string[];
  /** 既存の要約を置き換える */
  replaces: boolean;
}

export interface ValidationIssue {
  id: string;
  reason: string;
}

export interface ValidationResult {
  accepted: AcceptedSummary[];
  /** 保存しないが問題ではないもの（AI が記事を読めなかった等） */
  skipped: ValidationIssue[];
  /** 回答の誤り */
  errors: ValidationIssue[];
}

export interface ValidationOptions {
  minLength?: number;
  maxLength?: number;
  maxPoints?: number;
  maxPointLength?: number;
}

/**
 * 回答を検証する。lookup は id から記事を探す関数（一覧にない id は受け付けない）。
 * 本文は回答の summary / points だけを使い、記事のタイトルやURLは AI の回答ではなくサイトのデータから取る。
 */
export function validateEntries(
  entries: SummaryEntry[],
  lookup: (id: string) => { summarized: boolean } | undefined,
  { minLength = 20, maxLength = 500, maxPoints = 5, maxPointLength = 100 }: ValidationOptions = {},
): ValidationResult {
  const result: ValidationResult = { accepted: [], skipped: [], errors: [] };
  const seen = new Set<string>();
  for (const entry of entries) {
    const { id } = entry;
    if (!id) {
      result.errors.push({ id: '（なし）', reason: 'id がありません' });
      continue;
    }
    if (seen.has(id)) {
      result.skipped.push({ id, reason: '同じ id が重複しているため、最初のものだけを使います' });
      continue;
    }
    seen.add(id);
    const article = lookup(id);
    if (!article) {
      result.errors.push({ id, reason: '記事一覧にない id です' });
      continue;
    }
    const summary = cleanText(entry.summary);
    if (!['ok', 'success', 'done'].includes(entry.status) || summary === '') {
      result.skipped.push({ id, reason: 'AI が記事を読めなかったため要約がありません' });
      continue;
    }
    if (REFUSAL.test(summary)) {
      result.skipped.push({ id, reason: 'AI が記事にアクセスできなかったようです' });
      continue;
    }
    const length = charLength(summary);
    if (length < minLength) {
      result.errors.push({ id, reason: `要約が短すぎます（${length}字）` });
      continue;
    }
    if (length > maxLength) {
      result.errors.push({ id, reason: `要約が長すぎます（${length}字）` });
      continue;
    }
    const points = entry.points
      .map(cleanText)
      .filter(Boolean)
      .slice(0, maxPoints)
      .map((point) => truncate(point, maxPointLength));
    result.accepted.push({ id, summary, points, replaces: article.summarized });
  }
  return result;
}

// ===== 3. 要約ファイル =====

/** 要約を保存するファイル（記事の公開月ごと） */
export function summaryFilePath(publishedAt: string): string {
  return `data/summaries/${jstDateKey(publishedAt).slice(0, 7)}.json`;
}

export function toSummaryRecord(article: Item, accepted: AcceptedSummary, now: Date): SummaryRecord {
  const { id, title, url, excerpt, sourceId, category, publishedAt, hatebu } = article;
  return {
    id,
    title,
    url,
    excerpt,
    sourceId,
    category,
    publishedAt,
    ...(hatebu ? { hatebu } : {}),
    summary: accepted.summary,
    points: accepted.points,
    summarizedAt: now.toISOString(),
  };
}

/** 要約ファイルを読む。空なら空配列、壊れていればエラー（上書きして消さないため） */
export function parseSummaryFile(text: string | null): SummaryRecord[] {
  if (!text || !text.trim()) return [];
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) throw new Error('要約ファイルの形式が正しくありません');
  return data as SummaryRecord[];
}

/** 既存の要約に追加・上書き・削除を反映し、記事の新しい順に並べる */
export function mergeSummaryRecords(
  existing: SummaryRecord[],
  additions: SummaryRecord[],
  removals: Iterable<string> = [],
): SummaryRecord[] {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const id of removals) byId.delete(id);
  for (const record of additions) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}

/** 1記事1行の JSON（git の差分が記事単位で見やすい） */
export function serializeSummaryFile(records: SummaryRecord[]): string {
  return records.length === 0 ? '[]\n' : `[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`;
}

/** 追加・削除をファイルごとにまとめる */
export function groupByFile<T extends { publishedAt: string }>(records: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const path = summaryFilePath(record.publishedAt);
    groups.set(path, [...(groups.get(path) ?? []), record]);
  }
  return groups;
}
