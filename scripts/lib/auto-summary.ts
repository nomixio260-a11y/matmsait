/**
 * AI による自動要約（Cloudflare Workers AI の無料枠で、Qwen を使う。既定は Qwen3.8 27B を考える量 xhigh で）。
 *
 * チャット AI の画面（chat.qwen.ai など）をプログラムで動かす（スクレイピングする）ことは、各サービスの利用規約で禁じられているので行わない
 * （2026-10-09 に運営者から指示があったが、同じ理由で行わなかった。Qwen3.8-Max は有料の API だけで使える）。
 * 代わりに、公式に提供されている Cloudflare Workers AI の API を、無料枠（1日1万ニューロン）の中だけで使う。
 * 無料プランでは無料枠を超えた依頼は失敗するだけで料金はかからず、ここでも1回・1日の件数と使った量の見積もりに上限を設け、
 * 使う量を1日の時間で均す（考える量の多いモデルは1日に数件になるので、朝にまとめて使い切らないように）。
 *
 * 1. 要約のない記事から選ぶ（多くの媒体が報じたトピックの記事を先に。要約を載せられる掲載元・非表示でない記事だけ）
 * 2. 記事の本文を取得する（本文の自動取得と同じ決まり: robots.txt・AI での利用の拒否・アクセスの拒否を守る。本文は保存しない）
 * 3. 管理画面と同じプロンプト（本文入り）で要約を頼む
 * 4. 管理画面と同じ検証（validateEntries）を通ったものだけを使う。品質の注意（推測・宣伝・定型文・見出しの言い換えなど）が
 *    あれば1回だけ直してもらい、それでも残れば保存しない
 * 通信（記事の取得・AI への依頼）は差し替えられるので、テストではネットワークを使わない
 */
import { ARTICLE_TEXT_MAX, buildFixPrompt, buildSummaryPrompt, extractJson, normalizeEntries, validateEntries, type AcceptedSummary } from '../../src/lib/summary-core.ts';
import { mainTitle } from '../../src/lib/related.ts';
import { bigrams, type QualityKind } from '../../src/lib/summary-quality.ts';
import { ATTEMPT_LABELS, type Attempt, type AttemptResult, type AutoSummaryState } from '../../src/lib/auto-summary-state.ts';
import type { Item } from '../../src/lib/types.ts';
import type { HttpGetOptions, HttpResponse } from './http.ts';
import type { RobotsGroup } from './robots.ts';
import { fetchArticleText, loadRobots } from './text-fetcher.ts';

// 試した記録（data/auto-summary.json）の読み書きは管理画面のデータと共通（src/lib/auto-summary-state.ts）
export {
  ATTEMPT_LABELS,
  AUTO_SUMMARY_STATE_PATH,
  parseAutoSummaryState,
  serializeAutoSummaryState,
  type Attempt,
  type AttemptResult,
  type AutoSummaryState,
} from '../../src/lib/auto-summary-state.ts';

const DAY = 24 * 60 * 60 * 1000;

/** 既定のモデル（Qwen3.8 27B。Workers AI にある Qwen 3.8 世代のモデルで、考える（推論の）量を選べる） */
export const DEFAULT_MODEL = '@cf/qwen/qwen3.8-27b';

/** 考える量: off = 考えない（考えるのを止められないモデルでは low）/ low・medium・xhigh = 推論の量（xhigh がいちばん多い） */
export type Reasoning = 'off' | 'low' | 'medium' | 'xhigh';
export const DEFAULT_REASONING: Reasoning = 'xhigh';
const REASONINGS: readonly Reasoning[] = ['off', 'low', 'medium', 'xhigh'];

export const AUTO_SUMMARY_DEFAULTS = {
  /** 1回の実行で要約する記事の数の上限（毎時の更新ごと） */
  perRun: 4,
  /** 1日（UTC の日付。無料枠が戻る区切り）に要約する記事の数の上限 */
  perDay: 60,
  /** 1日に使ってよいニューロンの見積もり（無料枠 1万の手前で止める） */
  neuronBudget: 8000,
  /** 失敗した記事を、もう一度試すまでの日数 */
  retryDays: 7,
  /** 話題のトピックとして選ぶ、最後の報道からの時間 */
  topicHours: 48,
  /** 1つの媒体だけの記事として選ぶ、公開からの時間 */
  singleHours: 24,
} as const;

interface ModelSpec {
  /** 料金（ニューロン/100万トークン。Workers AI の料金表から） */
  rates: [input: number, output: number];
  /** 考える量の指定のしかた: effort = reasoning_effort（low・medium・xhigh）/ switch = 指示の末尾の /no_think で止める（Qwen3）/ none = 指定しない */
  reasoning: 'effort' | 'switch' | 'none';
}

const MODELS: Record<string, ModelSpec> = {
  '@cf/qwen/qwen3.8-27b': { rates: [40909, 290909], reasoning: 'effort' },
  '@cf/qwen/qwen3-30b-a3b-fp8': { rates: [4625, 30475], reasoning: 'switch' },
  '@cf/google/gemma-4-26b-a4b-it': { rates: [9091, 27273], reasoning: 'none' },
  '@cf/openai/gpt-oss-20b': { rates: [18182, 27273], reasoning: 'none' },
  '@cf/openai/gpt-oss-120b': { rates: [31818, 68182], reasoning: 'none' },
};
/** 料金表にないモデルは高めに見積もり、考える量は指定しない */
const UNKNOWN_MODEL: ModelSpec = { rates: [60000, 300000], reasoning: 'none' };
const specOf = (model: string) => MODELS[model] ?? UNKNOWN_MODEL;

/** 直してもらってもこれらの注意が残る要約は保存しない（事実と違って読まれるおそれがあるもの・中身のないもの） */
const BLOCKING_KINDS = new Set<QualityKind>(['guess', 'promo', 'cliche', 'title', 'opening', 'sns', 'date']);

export interface AutoSummaryOptions {
  perRun: number;
  perDay: number;
  model: string;
  reasoning: Reasoning;
  neuronBudget: number;
}

/** 考える量の設定を読む（high は xhigh とみなす。分からない値は既定） */
export function parseReasoning(value: string | undefined): Reasoning {
  const text = value?.trim().toLowerCase();
  if (text === 'high') return 'xhigh';
  return REASONINGS.find((reasoning) => reasoning === text) ?? DEFAULT_REASONING;
}

/** 環境変数から設定を読む（AUTO_SUMMARY_PER_RUN=0 で止める） */
export function parseAutoSummaryOptions(env: Record<string, string | undefined>): AutoSummaryOptions {
  const number = (value: string | undefined, fallback: number, max: number) => {
    const parsed = Math.round(Number(value));
    return value?.trim() && Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : fallback;
  };
  return {
    perRun: number(env.AUTO_SUMMARY_PER_RUN, AUTO_SUMMARY_DEFAULTS.perRun, 10),
    perDay: number(env.AUTO_SUMMARY_PER_DAY, AUTO_SUMMARY_DEFAULTS.perDay, 120),
    model: env.AUTO_SUMMARY_MODEL?.trim() || DEFAULT_MODEL,
    reasoning: parseReasoning(env.AUTO_SUMMARY_REASONING),
    neuronBudget: AUTO_SUMMARY_DEFAULTS.neuronBudget,
  };
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** 使ったニューロンの見積もり */
export function estimateNeurons(model: string, usage: TokenUsage | undefined, fallbackChars: { input: number; output: number }): number {
  const [input, output] = specOf(model).rates;
  // 使った量が返ってこなければ文字数から多めに見積もる（日本語は1トークンあたり1字ほどとみなす）
  const promptTokens = usage?.prompt_tokens ?? fallbackChars.input;
  const completionTokens = usage?.completion_tokens ?? fallbackChars.output;
  return Math.ceil((promptTokens * input + completionTokens * output) / 1_000_000);
}

/** このモデルが考える（推論する）か */
function thinks(model: string, reasoning: Reasoning): boolean {
  const style = specOf(model).reasoning;
  return style === 'effort' || (style === 'switch' && reasoning !== 'off');
}

/** 1回の依頼で書かせるトークンの上限（考える分も含む。考えるときは、考えている途中で切れないよう多めに） */
export function outputLimit(model: string, reasoning: Reasoning): number {
  return thinks(model, reasoning) ? 8192 : 2048;
}

/** 1回の依頼で使う量の多めの見積もり（依頼の前の上限の確認に使う。指示と本文は、直しの依頼でも 16,000 トークンに収まる） */
export function reserveNeurons(model: string, reasoning: Reasoning): number {
  return estimateNeurons(model, { prompt_tokens: 16_000, completion_tokens: outputLimit(model, reasoning) }, { input: 0, output: 0 });
}

/** その日（UTC）のうちに使ってよい量（1日の上限を時間で均す。0時台は1/24、23時台で上限まで） */
export function pacedBudget(budget: number, now: Date): number {
  const hours = (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 3_600_000;
  return budget * Math.min(1, (Math.floor(hours) + 1) / 24);
}

// ===== 本文が見出しの記事のものか =====

/** target の文字の組のうち、source にあるものの割合 */
export function overlapRatio(target: string, source: string): number {
  const wanted = bigrams(target);
  if (wanted.size === 0) return 0;
  const have = bigrams(source);
  return [...wanted].filter((gram) => have.has(gram)).length / wanted.size;
}

/** 本文として認める、見出しの文字の組が本文にある割合（メニューだけ・別の記事を取り出したときを除く） */
const TEXT_MATCH = 0.25;
/** 要約として認める、見出しの文字の組が要約にある割合（まったく別の内容の要約を除く） */
const SUMMARY_MATCH = 0.1;

/**
 * 取り出した本文が見出しの記事のものなら、見出しの位置から後ろを返す（前にあるメニュー・パンくずを除く）。
 * 見出しの言葉がほとんど本文にないとき（広告や別の記事を取り出したとき）は undefined
 */
export function focusOnTitle(text: string, title: string): string | undefined {
  const headline = mainTitle(title);
  if (overlapRatio(headline, text) < TEXT_MATCH) return undefined;
  const head = Array.from(headline).slice(0, 10).join('');
  const position = head.length >= 4 ? text.indexOf(head) : -1;
  return position > 0 ? text.slice(position) : text;
}

// ===== 要約する記事を選ぶ =====

export interface CandidateTopic {
  coverage: number;
  score: number;
  latestAt: string;
  /** トピックの記事（見出しにした記事が先頭） */
  items: Item[];
  /** トピックの記事のどれかに要約があるか */
  summarized: boolean;
}

export interface PickInput {
  topics: CandidateTopic[];
  /** 掲載中の記事（新しい順） */
  items: Item[];
  isSummarized: (id: string) => boolean;
  /** 要約を載せられる記事か（掲載元が要約を禁じていない・非表示でない） */
  canSummarize: (item: Item) => boolean;
  attempts: Attempt[];
  now: Date;
  limit: number;
  /** 1つの媒体だけの記事でも選ぶジャンル */
  preferredCategories: readonly string[];
}

/**
 * 要約する記事を選ぶ。多くの媒体が報じたトピック（要約のないもの。報じた媒体の多い順）の記事を先に、
 * 次に反応のよいジャンル（テクノロジーなど）の新しい記事。失敗した記事は retryDays 日のあいだ選ばない
 */
export function pickCandidates({ topics, items, isSummarized, canSummarize, attempts, now, limit, preferredCategories }: PickInput): Item[] {
  if (limit <= 0) return [];
  const recent = new Set(
    attempts.filter((attempt) => now.getTime() - Date.parse(attempt.at) < AUTO_SUMMARY_DEFAULTS.retryDays * DAY).map((attempt) => attempt.id),
  );
  const usable = (item: Item) => canSummarize(item) && !isSummarized(item.id) && !recent.has(item.id);
  const picked: Item[] = [];
  const seen = new Set<string>();
  const add = (item: Item | undefined) => {
    if (!item || seen.has(item.id) || picked.length >= limit) return;
    seen.add(item.id);
    picked.push(item);
  };
  const topicCutoff = now.getTime() - AUTO_SUMMARY_DEFAULTS.topicHours * 60 * 60 * 1000;
  const inTopic = new Set(topics.flatMap((topic) => topic.items.map((item) => item.id)));
  [...topics]
    .filter((topic) => !topic.summarized && Date.parse(topic.latestAt) >= topicCutoff)
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
    .forEach((topic) => add(topic.items.find(usable)));
  const singleCutoff = now.getTime() - AUTO_SUMMARY_DEFAULTS.singleHours * 60 * 60 * 1000;
  items
    .filter((item) => !inTopic.has(item.id) && preferredCategories.includes(item.category) && Date.parse(item.publishedAt) >= singleCutoff)
    .filter(usable)
    .forEach(add);
  return picked;
}

// ===== Workers AI への依頼 =====

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    /** auth: 権限がない / quota: 無料枠を使い切った / other: そのほか */
    readonly kind: 'auth' | 'quota' | 'other',
  ) {
    super(message);
  }
}

export interface AiReply {
  text: string;
  usage?: TokenUsage;
}

export type AiClient = (messages: ChatMessage[]) => Promise<AiReply>;

/** Workers AI の返事から文章を取り出す（モデルによって形が違う。考えた過程の <think> は除く） */
export function replyText(result: unknown): string {
  const data = result as { response?: unknown; choices?: { message?: { content?: unknown }; text?: unknown }[] } | undefined;
  const choice = data?.choices?.[0];
  const raw = [data?.response, choice?.message?.content, choice?.text].find((value): value is string => typeof value === 'string') ?? '';
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

/** Qwen3 の「考える」モードを止める指示（Qwen3 は指示の末尾の /no_think で考えずに答える） */
const NO_THINK = '\n\n/no_think';

/**
 * Workers AI に送る中身（モデルに合わせて、考える量と書かせるトークンの上限を指定する）。
 * Qwen3.8 は reasoning_effort（low・medium・xhigh。考えるのを止められないので off は low）、Qwen3 は考えないときだけ /no_think
 */
export function requestBody(model: string, reasoning: Reasoning, messages: ChatMessage[]): Record<string, unknown> {
  const style = specOf(model).reasoning;
  const limit = outputLimit(model, reasoning);
  // 考えるときは Qwen のおすすめの温度（0.6）、考えないときは低め（決まりどおりに書かせる）
  const temperature = thinks(model, reasoning) ? 0.6 : 0.3;
  if (style === 'effort') {
    return { messages, max_completion_tokens: limit, temperature, reasoning_effort: reasoning === 'off' ? 'low' : reasoning };
  }
  if (style === 'switch' && reasoning === 'off') {
    const last = messages.length - 1;
    const withSwitch = messages.map((message, index) => (index === last && message.role === 'user' ? { ...message, content: `${message.content}${NO_THINK}` } : message));
    return { messages: withSwitch, max_tokens: limit, temperature };
  }
  return { messages, max_tokens: limit, temperature };
}

/** Cloudflare Workers AI の REST API で依頼する（トークンには Workers AI の権限が要る） */
export function workersAiClient({
  accountId,
  token,
  model,
  reasoning = DEFAULT_REASONING,
  fetchImpl = fetch,
}: {
  accountId: string;
  token: string;
  model: string;
  reasoning?: Reasoning;
  fetchImpl?: typeof fetch;
}): AiClient {
  // 考えるときは時間がかかるので長めに待つ
  const timeout = thinks(model, reasoning) ? 180_000 : 90_000;
  return async (messages) => {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(model, reasoning, messages)),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new AiError(`Workers AI に接続できませんでした: ${error instanceof Error ? error.message : error}`, 'other');
    }
    const body = await res.text();
    let json: { success?: boolean; result?: { usage?: TokenUsage }; errors?: { code?: number; message?: string }[] } = {};
    try {
      json = JSON.parse(body);
    } catch {
      // 下で HTTP の状態から判断する
    }
    const message = json.errors?.map((error) => `${error.code ?? ''} ${error.message ?? ''}`.trim()).join(' / ') || body.slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new AiError(`Workers AI を使う権限がありません（HTTP ${res.status}: ${message}）`, 'auth');
    }
    if (res.status === 429 || /daily free allocation|neurons/i.test(message)) {
      throw new AiError(`Workers AI の無料枠を使い切りました（${message}）`, 'quota');
    }
    if (!res.ok || json.success === false) throw new AiError(`Workers AI がエラーを返しました（HTTP ${res.status}: ${message}）`, 'other');
    return { text: replyText(json.result), usage: json.result?.usage };
  };
}

// ===== 1件の要約 =====

const SYSTEM_PROMPT = 'あなたはニュースの要約を作る編集者です。依頼の決まりに厳密に従い、指定された形の JSON だけを出力します。';

export type SummaryOutcome =
  | { result: 'saved'; entry: AcceptedSummary; neurons: number }
  | { result: 'quality' | 'unavailable' | 'invalid'; neurons: number; detail: string };

/** 回答を検証する（管理画面と同じ）。問題がなければ受け付けた要約、なければ理由 */
function check(item: Item, text: string): { accepted?: AcceptedSummary; problem?: { result: 'unavailable' | 'invalid'; detail: string } } {
  let entries;
  try {
    entries = normalizeEntries(extractJson(text));
  } catch (error) {
    return { problem: { result: 'invalid', detail: error instanceof Error ? error.message : String(error) } };
  }
  const result = validateEntries(
    entries.filter((entry) => entry.id === item.id),
    (id) => (id === item.id ? { summarized: false, title: item.title } : undefined),
  );
  const accepted = result.accepted.find((entry) => entry.id === item.id);
  if (accepted && overlapRatio(mainTitle(item.title), `${accepted.summary}${accepted.points.join('')}`) < SUMMARY_MATCH) {
    return { problem: { result: 'invalid', detail: '要約が見出しの記事の内容と一致しません' } };
  }
  if (accepted) return { accepted };
  const issues = [...result.skipped, ...result.errors];
  const reason = issues.map((issue) => issue.reason).join(' / ') || '回答に要約がありません';
  const unavailable = result.skipped.some((issue) => issue.unavailable);
  return { problem: { result: unavailable ? 'unavailable' : 'invalid', detail: reason } };
}

const blocking = (accepted: AcceptedSummary) => (accepted.warnings ?? []).filter((warning) => BLOCKING_KINDS.has(warning.kind));

/**
 * 1件を要約する（本文入りのプロンプト → 検証 → 品質の注意があれば1回だけ直してもらう）。
 * canSpend は、この記事でここまで使った量を受け取り、もう1回頼んでも上限を超えないかを返す（超えるなら直しは頼まない）。
 * AI への依頼に失敗したときは AiError を投げる
 */
export async function summarizeItem(
  item: Item,
  text: string,
  site: string,
  ai: AiClient,
  model: string,
  siteName: string,
  canSpend: (spent: number) => boolean = () => true,
): Promise<SummaryOutcome> {
  const prompt = buildSummaryPrompt(
    [{ id: item.id, title: item.title, url: item.url, site, excerpt: item.excerpt, publishedAt: item.publishedAt, text: text.slice(0, ARTICLE_TEXT_MAX) }],
    { siteName, length: 'normal', points: true },
  );
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  const first = await ai(messages);
  let neurons = estimateNeurons(model, first.usage, { input: SYSTEM_PROMPT.length + prompt.length, output: first.text.length });
  const firstCheck = check(item, first.text);
  if (!firstCheck.accepted) return { result: firstCheck.problem!.result, neurons, detail: firstCheck.problem!.detail };
  let accepted = firstCheck.accepted;
  // 保存を止める注意がなければそのまま使う（ほかの注意は管理画面の「要確認」に出る）
  if (blocking(accepted).length === 0) return { result: 'saved', entry: accepted, neurons };

  // 保存を止める注意があれば、同じ会話で1回だけ直してもらう（使う量の上限を超えそうなら頼まない）
  if (!canSpend(neurons)) {
    const issues = blocking(accepted).map((warning) => warning.message).join(' / ');
    return { result: 'quality', neurons, detail: `${issues}（使う量の上限に近いため、直しは頼まなかった）`.slice(0, 300) };
  }
  const fixPrompt = buildFixPrompt(
    [
      {
        id: item.id,
        title: item.title,
        summary: accepted.summary,
        points: accepted.points,
        background: accepted.background,
        keywords: accepted.keywords,
        issues: (accepted.warnings ?? []).map((warning) => warning.message),
      },
    ],
    { length: 'normal', points: true },
  );
  const second = await ai([...messages, { role: 'assistant', content: first.text }, { role: 'user', content: fixPrompt }]);
  neurons += estimateNeurons(model, second.usage, { input: SYSTEM_PROMPT.length + prompt.length + first.text.length + fixPrompt.length, output: second.text.length });
  const secondCheck = check(item, second.text);
  // 直した回答の形が崩れていたら、最初の回答で判断する
  if (secondCheck.accepted) accepted = secondCheck.accepted;
  const remaining = blocking(accepted);
  if (remaining.length > 0) {
    return { result: 'quality', neurons, detail: remaining.map((warning) => warning.message).join(' / ').slice(0, 300) };
  }
  return { result: 'saved', entry: accepted, neurons };
}

// ===== 本文の取得 =====

type Get = (url: string, options: HttpGetOptions) => Promise<HttpResponse>;
export type RobotsCache = Map<string, RobotsGroup[] | 'error'>;

export type ArticleOutcome = { status: 'ok'; text: string } | { status: 'failed'; result: AttemptResult; detail?: string };

/**
 * 記事の本文を取得し、見出しの記事の部分を返す（本文の自動取得と同じ決まり。robots.txt はサイトごとに1回だけ読む）。
 * 取れないとき・見出しの記事と一致しないときは、その理由
 */
export async function articleTextOf(item: Item, get: Get, robotsCache: RobotsCache): Promise<ArticleOutcome> {
  let origin: string;
  try {
    origin = new URL(item.url).origin;
  } catch {
    return { status: 'failed', result: 'fetch-error', detail: '記事の URL が正しくありません' };
  }
  if (!robotsCache.has(origin)) robotsCache.set(origin, await loadRobots(origin, get));
  const robots = robotsCache.get(origin)!;
  const article = robots === 'error' ? ({ status: 'error', detail: 'robots.txt を読めませんでした' } as const) : await fetchArticleText(item.url, robots, get);
  if (article.status !== 'ok') {
    return { status: 'failed', result: article.status === 'error' ? 'fetch-error' : article.status, ...(article.detail ? { detail: article.detail } : {}) };
  }
  // 取り出した本文が見出しの記事のものか（メニューだけ・広告や別の記事を取り出していないか）
  const text = focusOnTitle(article.text, item.title);
  return text ? { status: 'ok', text } : { status: 'failed', result: 'no-text', detail: '取り出した本文が見出しの記事と一致しません' };
}

// ===== まとめて実行 =====

export interface RunInput {
  candidates: Item[];
  state: AutoSummaryState;
  options: AutoSummaryOptions;
  now: Date;
  siteName: string;
  /** 記事の掲載元の名前 */
  siteOf: (item: Item) => string;
  ai: AiClient;
  get: Get;
  /** 同じサイトへのアクセスの間隔（テストでは 0） */
  wait?: () => Promise<void>;
  log?: (message: string) => void;
  /** この時刻を過ぎたら新しい記事に取りかからない */
  deadline?: number;
}

export interface RunOutput {
  /** 保存する要約（管理画面の AI の回答と同じ形。npm run summaries -- import で取り込む） */
  entries: { id: string; status: 'ok'; summary: string; points: string[]; background: string; keywords: string[] }[];
  state: AutoSummaryState;
}

/**
 * 選んだ記事を順に要約する（1日の件数・使った量の上限で止める。使う量は1日の時間で均す。権限がない・無料枠を使い切ったら止める）
 */
export async function runAutoSummary({ candidates, state, options, now, siteName, siteOf, ai, get, wait, log = () => {}, deadline }: RunInput): Promise<RunOutput> {
  const entries: RunOutput['entries'] = [];
  const next: AutoSummaryState = { ...state, attempts: [...state.attempts] };
  // 1回の依頼で使う量の多めの見積もり（依頼の前に、これを足しても上限を超えないかを確かめる）
  const reserve = reserveNeurons(options.model, options.reasoning);
  const paced = pacedBudget(options.neuronBudget, now);
  const robotsCache: RobotsCache = new Map();
  const visited = new Set<string>();
  let tried = 0;
  let message: string | undefined;
  let aiErrors = 0;
  let lastAiError = '';
  const record = (attempt: Attempt) => next.attempts.push(attempt);

  for (const item of candidates) {
    if (deadline !== undefined && Date.now() > deadline) {
      message = '時間の上限に達したため、残りは次の実行に回します';
      break;
    }
    if (tried >= options.perRun) break;
    if (next.saved >= options.perDay) {
      message = `今日（UTC）の上限（${options.perDay}件）に達しました`;
      break;
    }
    if (next.neurons + reserve > options.neuronBudget) {
      message = `今日（UTC）の使用量の見積もりが上限（${options.neuronBudget}ニューロン）に近いため止めました`;
      break;
    }
    if (next.neurons > paced) {
      message = '1日の使う量を時間で均すため、残りは次の実行に回します';
      break;
    }
    // 本文を取得する（同じサイトへは間隔を空ける）
    const origin = URL.canParse(item.url) ? new URL(item.url).origin : item.url;
    if (visited.has(origin) && wait) await wait();
    visited.add(origin);
    const article = await articleTextOf(item, get, robotsCache);
    const at = new Date().toISOString();
    if (article.status !== 'ok') {
      record({ id: item.id, at, result: article.result, ...(article.detail ? { detail: article.detail } : {}) });
      log(`見送り: ${item.title}（${ATTEMPT_LABELS[article.result]}${article.detail ? `・${article.detail}` : ''}）`);
      continue;
    }
    const { text } = article;
    tried += 1;
    try {
      const outcome = await summarizeItem(item, text, siteOf(item), ai, options.model, siteName, (spent) => next.neurons + spent + reserve <= options.neuronBudget);
      next.neurons += outcome.neurons;
      if (outcome.result === 'saved') {
        next.saved += 1;
        const { summary, points, background = '', keywords = [] } = outcome.entry;
        entries.push({ id: item.id, status: 'ok', summary, points, background, keywords });
        record({ id: item.id, at, result: 'saved', neurons: outcome.neurons });
        log(`要約: ${item.title}（約${outcome.neurons}ニューロン）`);
      } else {
        record({ id: item.id, at, result: outcome.result, neurons: outcome.neurons, detail: outcome.detail });
        log(`保存せず: ${item.title}（${ATTEMPT_LABELS[outcome.result]}: ${outcome.detail}）`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof AiError && error.kind !== 'other') {
        // 権限がない・無料枠を使い切ったときは、この記事は試していないことにして止める
        next.problem = { at, kind: error.kind, message: detail };
        message = detail;
        log(`::warning::${detail}`);
        break;
      }
      // 使った量が分からないので、多めの見積もりを足しておく
      next.neurons += reserve;
      aiErrors += 1;
      lastAiError = detail;
      record({ id: item.id, at, result: 'ai-error', detail: detail.slice(0, 300) });
      log(`失敗: ${item.title}（${detail}）`);
    }
  }
  if (entries.length > 0) delete next.problem;
  // 1件も保存できず、AI への依頼が続けて失敗したとき（モデルの提供が終わったなど）は管理画面に出す
  else if (aiErrors >= 2) next.problem = { at: now.toISOString(), kind: 'other', message: `AI への依頼が続けて失敗しました（${lastAiError.slice(0, 200)}）` };
  next.lastRun = { at: now.toISOString(), saved: entries.length, tried, model: options.model, reasoning: options.reasoning, ...(message ? { message } : {}) };
  return { entries, state: next };
}
