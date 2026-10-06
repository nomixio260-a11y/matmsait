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

/** 要約の書き方のルール */
export function summaryRules(length: SummaryLength, points: boolean): string[] {
  const { min, max } = SUMMARY_LENGTHS[length];
  return [
    `- summary は${min}〜${max}字程度。何が・誰が・どうなったのかが一読でわかるように書く。`,
    '- 文体は常体（だ・である調）。見出しをそのまま繰り返して始めない。',
    ...(points
      ? ['- points には記事の重要なポイントを重要な順に3つまで。1つ40字以内の短い文にする。']
      : ['- points は常に空の配列 [] にする。']),
    '- 原文の文章をそのまま書き写さず、自分の言葉で言い換える（直接の引用はしない）。',
    '- 記事に書かれていないこと、推測、意見や感想は加えない。',
  ];
}

/** 出力例に使う架空の記事の id（実際の id と同じ16桁の英数字） */
const EXAMPLE_IDS = ['0123456789abcdef', 'fedcba9876543210'];

/** 出力例の要約（架空の記事。指定した長さに合わせて、どのくらい書けばよいかを示す） */
const EXAMPLE_SUMMARIES: Record<SummaryLength, string> = {
  short: '○○社は新型スマートフォン「△△」を11月に国内で発売すると発表した。価格は前モデルから据え置き、カメラ性能と電池の持ちを改善した。',
  normal:
    '○○社は新型スマートフォン「△△」を発表した。11月に国内で発売し、価格は前モデルから据え置く。新しい画像処理で暗い場所でも明るく撮影できるようになったほか、電池の容量を増やして連続使用時間を約2割延ばした。同社は若い世代を中心に販売を伸ばしたい考えだ。',
  long:
    '○○社は新型スマートフォン「△△」を発表した。11月に国内で発売し、価格は前モデルから据え置く。新しい画像処理で暗い場所でも明るく撮影できるようになったほか、電池の容量を増やして連続使用時間を約2割延ばした。本体は前モデルより1割ほど軽くなり、画面の明るさも上がった。部品の価格が上がるなか値上げを見送った理由について、同社は「手に取りやすい価格を保ち、若い世代を中心に販売を伸ばしたい」と説明している。',
};

/**
 * AI に丸ごと貼り付けて使うプロンプト。
 * 回答の JSON はそのまま管理画面で読み込むので、形式の指示をできるだけ具体的に書く
 */
export function buildSummaryPrompt(articles: PromptArticle[], { siteName, length, points }: PromptOptions): string {
  const { min, max } = SUMMARY_LENGTHS[length];
  const count = articles.length;
  const input = articles.map(({ id, title, url, site, excerpt }) => ({
    id,
    title,
    url,
    site,
    ...(excerpt ? { excerpt } : {}),
  }));
  const example = [
    {
      id: EXAMPLE_IDS[0],
      status: 'ok',
      summary: EXAMPLE_SUMMARIES[length],
      points: points ? ['価格は前モデルから据え置き', '11月に国内で発売', 'カメラ性能と電池の持ちが向上'] : [],
    },
    { id: EXAMPLE_IDS[1], status: 'unavailable', summary: '', points: [] },
  ];
  const lines = [
    `あなたはニュースまとめサイト「${siteName}」の編集者です。`,
    `下の「記事一覧」にある${count}件の記事について、それぞれの url のページを開いて本文を読み、日本語で要約してください。`,
    'あなたの回答はプログラムがそのまま読み込んでサイトに掲載します。下の「出力形式」と少しでも違うと読み込めないため、形式を厳密に守ってください。',
    '',
    '# 作業の手順',
    '1. 記事一覧の記事を上から順に1件ずつ、url のページを開いて本文を読む。',
    points ? '2. 本文にもとづいて summary（要約文）と points（要点）を書く。' : '2. 本文にもとづいて summary（要約文）を書く。',
    '3. ページを開けない、本文が読めない（有料会員限定・ログインが必要・削除済みなど）、見出しと本文が合わない場合は、推測で書かずに status を "unavailable" にする。',
    `4. ${count}件すべての結果を、下の「出力形式」の JSON 配列1つにまとめて出力する。`,
    '',
    '# 要約の書き方',
    ...summaryRules(length, points),
    '- excerpt は RSS の抜粋。記事を見分ける参考にとどめ、要約は必ず本文にもとづいて書く。',
    '',
    '# 出力形式（必ず守る）',
    '- 回答は ```json で始まり ``` で終わるコードブロック1つだけにする。コードブロックの前後に説明・あいさつ・注意書きを書かない。',
    `- コードブロックの中身は JSON 配列。記事一覧の1件につきオブジェクト1つを、記事一覧と同じ順番で、ちょうど${count}件入れる。`,
    '- 各オブジェクトには次の4つの項目だけを入れる（項目名は英字のまま。ほかの項目は足さない）。',
    '  - "id"（文字列）: 記事一覧の id を1文字も変えずにそのまま書き写す。',
    '  - "status"（文字列）: 要約できた記事は "ok"、本文を読めなかった記事は "unavailable"。この2つ以外の値にしない。',
    `  - "summary"（文字列）: 要約文（${min}〜${max}字程度）。status が "unavailable" のときは空文字 ""。`,
    points
      ? '  - "points"（文字列の配列）: 要点を0〜3個。status が "unavailable" のときは空の配列 []。'
      : '  - "points"（文字列の配列）: 常に空の配列 []。',
    '- JSON の書き方:',
    '  - 文字列はダブルクォート（"）で囲む。項目名もダブルクォートで囲む。',
    '  - 文中で引用符を使うときは「」を使い、" は使わない（どうしても使うときは \\" と書く）。',
    '  - 文字列の中に改行・タブ・HTML タグ・Markdown の記号（** や # など）を入れない。',
    '  - 要点の先頭に「・」「-」「1.」などの記号や番号を付けない。',
    '  - 最後の項目や要素の後ろにカンマを付けない。コメント（// や /* */）を書かない。',
    '- 件数が多くて一度に出力しきれない場合も、出力できたところまでで配列を "]" で正しく閉じ、コードブロックを閉じる（残りの記事はあとで改めて依頼します）。',
    '',
    `# 出力例（架空の記事2件の場合。実際には記事一覧の${count}件を同じ形で出力する）`,
    '```json',
    JSON.stringify(example, null, 2),
    '```',
    '',
    '# 出力する前の確認',
    `- オブジェクトが${count}件あり、記事一覧と同じ順番になっているか`,
    '- すべての id が記事一覧の id と完全に一致しているか',
    '- 読めなかった記事を推測で要約せず、status を "unavailable" にしたか',
    '- 出力がコードブロック1つだけで、JSON として正しい形（括弧・カンマ・ダブルクォート）になっているか',
    '',
    `# 記事一覧（${count}件）`,
    '```json',
    JSON.stringify(input, null, 2),
    '```',
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

/** JSON として読む。末尾の余分なカンマや、配列の括弧がない「1行に1件」の形も読めるよう直して試す */
function parseLenient(json: string): unknown {
  const attempts = [
    json,
    // よくある崩れ: 末尾の余分なカンマ
    json.replace(/,\s*([\]}])/g, '$1'),
    // 配列の [ ] がなく、オブジェクトが並んでいるだけの形
    `[${json.replace(/,\s*([\]}])/g, '$1').replace(/}\s*,?\s*(?=\{)/g, '},')}]`,
  ];
  let firstError: unknown;
  for (const text of attempts) {
    try {
      return JSON.parse(text);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw new Error(`JSON として読み込めません（${firstError instanceof Error ? firstError.message : firstError}）`);
}

/** 文字列から最初の { または [ から最後の } または ] までを取り出す */
function jsonPart(text: string): string {
  const body = text.trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error('回答の中に JSON が見つかりません');
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (end <= start) throw new Error('JSON が途中で切れているようです（AI の回答が最後まで出力されたか確認してください）');
  return body.slice(start, end + 1);
}

/**
 * 回答文から JSON 部分を取り出して読み込む（コードブロックや前後の説明文があっても読める）。
 * コードブロックが複数ある場合（回答が2回に分かれた場合など）は、配列をつなげて1つにする
 */
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)].map((match) => match[1]).filter((block) => /[[{]/.test(block));
  if (blocks.length > 1) {
    const parsed = blocks.map((block) => parseLenient(jsonPart(block)));
    if (parsed.every(Array.isArray)) return (parsed as unknown[][]).flat();
    return parsed[0];
  }
  return parseLenient(jsonPart(blocks[0] ?? text));
}

/** 項目名のゆれ（日本語の項目名など）を吸収するための別名 */
const KEY_ALIASES: Record<'id' | 'status' | 'summary' | 'points', string[]> = {
  id: ['id', 'ID', 'Id', 'article_id', 'articleId', '記事ID', '記事id'],
  status: ['status', 'Status', '状態', 'ステータス'],
  summary: ['summary', 'Summary', '要約', '要約文'],
  points: ['points', 'Points', 'key_points', 'keyPoints', 'bullets', '要点', 'ポイント'],
};

function pick(record: Record<string, unknown>, key: keyof typeof KEY_ALIASES): unknown {
  for (const name of KEY_ALIASES[key]) if (record[name] !== undefined) return record[name];
  return undefined;
}

/** 要点の先頭に付いた「・」「-」「1.」「①」などを外す */
function stripBullet(text: string): string {
  return text.replace(/^\s*(?:[・\-–—*•●○◆◇■□▪︎►▶︎]|\d{1,2}\s*[.)．、）:]|[①-⑳]|[(（]\d{1,2}[)）])\s*/, '');
}

function toPoints(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.filter((point): point is string => typeof point === 'string')
    : typeof value === 'string'
      ? value.split(/\n/)
      : [];
  return list.map(stripBullet);
}

/** さまざまな形の回答（配列 / {summaries: [...]} / {id: {...}}）を同じ形にそろえる */
export function normalizeEntries(data: unknown): SummaryEntry[] {
  let list: unknown[];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>;
    // オブジェクトの配列を持つ項目がちょうど1つなら、それを要約の一覧とみなす（{"output": [...]} など）
    const arrays = Object.values(object).filter(
      (value): value is unknown[] => Array.isArray(value) && value.some((element) => element && typeof element === 'object'),
    );
    const inner = object.summaries ?? object.items ?? object.results ?? object.articles ?? (arrays.length === 1 ? arrays[0] : undefined);
    if (pick(object, 'id') !== undefined) {
      // 1件だけの回答
      list = [object];
    } else if (Array.isArray(inner)) {
      list = inner;
    } else {
      list = Object.entries(object).map(([id, value]) =>
        typeof value === 'string' ? { id, summary: value } : { id, ...(value as Record<string, unknown>) },
      );
    }
  } else {
    throw new Error('要約の一覧（JSON の配列）になっていません');
  }
  return list.map((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const summary = pick(record, 'summary');
    return {
      id: String(pick(record, 'id') ?? '').trim(),
      status: String(pick(record, 'status') ?? 'ok').trim().toLowerCase(),
      summary: typeof summary === 'string' ? summary : '',
      points: toPoints(pick(record, 'points')),
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

/**
 * 「記事にアクセスできませんでした」のような、要約の代わりに書かれた断り文。
 * 要約は常体（だ・である調）で書かせるので、「サイトにアクセスできない状態が続いた」のような
 * ニュースの文ははじかず、AI 自身の「〜できません（でした）」という報告だけをはじく
 */
const REFUSAL = new RegExp(
  [
    '(?:記事|ページ|URL|ＵＲＬ|リンク|サイト|本文|内容|情報)\\s*(?:の内容|の本文)?(?:に|へ|を|が|は)?\\s*(?:直接)?' +
      '(?:アクセス|閲覧|表示|確認|取得|参照|読み込み|読み込|開)(?:すること)?(?:が)?(?:でき|け|め)ませ',
    '要約(?:することが)?(?:でき(?:ませ|ない)|いたしかね)',
    '申し訳(?:ありません|ございません)',
    "(?:cannot|can't|can not|unable to|could not|couldn't|was not able to) (?:access|open|browse|read|retrieve|view)",
    'not accessible',
  ].join('|'),
  'i',
);

/** 要約できたことを表す status の値 */
const OK_STATUSES = new Set(['ok', 'success', 'done', 'completed', '成功', '完了']);

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
  /** 断り文をはじくか（運営者が自分で直した要約では確認しない） */
  checkRefusal?: boolean;
}

/**
 * 回答を検証する。lookup は id から記事を探す関数（一覧にない id は受け付けない）。
 * 本文は回答の summary / points だけを使い、記事のタイトルやURLは AI の回答ではなくサイトのデータから取る。
 */
export function validateEntries(
  entries: SummaryEntry[],
  lookup: (id: string) => { summarized: boolean } | undefined,
  { minLength = 20, maxLength = 500, maxPoints = 5, maxPointLength = 100, checkRefusal = true }: ValidationOptions = {},
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
    if (!OK_STATUSES.has(entry.status) || summary === '') {
      result.skipped.push({ id, reason: 'AI が記事を読めなかったため要約がありません' });
      continue;
    }
    if (checkRefusal && REFUSAL.test(summary)) {
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
      .map((point) => cleanText(stripBullet(point)))
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

/** 運営者が手直しした要約（記事情報と最初に保存した日時はそのまま） */
export function editSummaryRecord(
  record: SummaryRecord,
  { summary, points }: { summary: string; points: string[] },
  now: Date,
): SummaryRecord {
  return { ...record, summary, points, updatedAt: now.toISOString() };
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
