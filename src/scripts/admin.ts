// 管理画面の「AI要約・記事」（/admin/summaries/）: 要約待ちの記事を選んでプロンプトを作り、AI の回答を検証して GitHub に保存する。
// 記事の非表示・収集元の状況もここで扱う（サイトの更新の実行は「概要」（/admin/、admin-dashboard.ts））
import {
  BLOCKLIST_PATH,
  emptyBlocklist,
  normalizeHost,
  parseBlocklist,
  serializeBlocklist,
  type Blocklist,
} from '../lib/blocklist-core.ts';
import { createGitHubClient, GitHubError, type Repository } from '../lib/github-commit.ts';
import {
  ARTICLE_TEXT_MAX,
  PASTE_MARKER,
  buildFixPrompt,
  buildSummaryPrompt,
  comparePastedUrl,
  editSummaryRecord,
  extractJson,
  groupByFile,
  mergeSummaryRecords,
  normalizeEntries,
  parsePastedText,
  parseSummaryFile,
  splitPastedBlocks,
  splitPromptArticles,
  serializeSummaryFile,
  summaryFilePath,
  toSummaryRecord,
  validateEntries,
  type AcceptedSummary,
  type AnswerMode,
  type PastedText,
  type PromptArticle,
  type PromptOptions,
  type SummaryEdit,
  type SummaryLength,
  type ValidationResult,
} from '../lib/summary-core.ts';
import { summaryWarnings, type QualityWarning } from '../lib/summary-quality.ts';
import type { AutoSummaryState, AutoSummaryStatus } from '../lib/auto-summary-state.ts';
import type { Item, SummaryRecord } from '../lib/types.ts';
import {
  TEXT_KEYS_PATH,
  TEXT_REQUESTS_PATH,
  TEXT_STATUS_LABELS,
  mergeTextKeys,
  mergeTextRequests,
  parseJsonList,
  pickKeys,
  pickRequests,
  pickResults,
  serializeLines,
  type TextRequest,
  type TextResult,
} from '../lib/article-texts.ts';
import { decryptText, type TextKeyPair } from '../lib/text-crypto.ts';
import { requireSession, watchSession } from './admin-common.ts';

interface AdminArticle extends Item {
  site: string;
  /** 同じ話題（同じ出来事を報じた記事のまとまり）のキー。ほかの掲載元も報じている記事だけ */
  topic?: string;
}

interface AdminSummary extends AdminArticle {
  summary: string;
  points: string[];
  background?: string;
  keywords?: string[];
  summarizedAt: string;
  /** AI が自動で作った要約のモデル（運営者がチャット AI で作った要約にはない） */
  generator?: string;
  /** 手直しした日時 */
  updatedAt?: string;
}

interface HiddenArticle extends AdminArticle {
  /** 非表示の理由（「個別に非表示」「NGワード「〇〇」」など） */
  reason: string;
}

interface SourceStat {
  id: string;
  name: string;
  category: string;
  siteUrl: string;
  count: number;
  latest: string | null;
  /** 最後に取得できた日時 */
  okAt?: string | null;
  /** 連続で取得に失敗している回数 */
  failures?: number;
  error?: string | null;
}

interface AdminData {
  sources?: SourceStat[];
  generatedAt: string;
  siteName: string;
  repository: Repository;
  categories: { slug: string; name: string }[];
  pending: AdminArticle[];
  summarized: AdminSummary[];
  blocklist?: Blocklist;
  hidden?: HiddenArticle[];
  /** 本文の自動取得に登録してある公開鍵の ID */
  textKeys?: string[];
  /** AI の自動要約の状況（まだ動いていなければ null） */
  autoSummary?: AutoSummaryStatus | null;
}

const KEYS = {
  saved: 'admin.savedIds',
  deleted: 'admin.deletedIds',
  hidden: 'admin.hiddenIds',
  unhidden: 'admin.unhiddenIds',
  edited: 'admin.editedSummaries',
  options: 'admin.options',
  unavailable: 'admin.unavailable',
  readable: 'admin.aiReadable',
};
/** 保存・削除した記事を、サイトに反映されるまで一覧から隠しておく時間 */
const HIDE_FOR = 6 * 60 * 60 * 1000;
const LIST_LIMIT = 300;
/** この時間以上サイトが更新されていなければ警告する */
const STALE_HOURS = 3;
/** 収集元の最新記事がこれより古ければ、フィードが止まっている可能性を示す */
const SOURCE_STALE_DAYS = 3;
/** 取得の失敗がこの回数続いたら確認を促す（一時的な失敗は数えない） */
const SOURCE_FAILURE_ALERT = 3;

// ===== ストレージ（使えない環境でも動くようにする） =====

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 保存できなくても画面の操作は続けられる
    }
  },
};

/** 記事ID → 保存した時刻（サイトに反映されるまでの間、一覧から外すため） */
function readMarks(key: string): Map<string, number> {
  try {
    const entries = JSON.parse(storage.get(key) ?? '[]') as [string, number][];
    return new Map(entries.filter(([, at]) => Date.now() - at < HIDE_FOR));
  } catch {
    return new Map();
  }
}

function addMarks(key: string, ids: string[]) {
  const marks = readMarks(key);
  for (const id of ids) marks.set(id, Date.now());
  storage.set(key, JSON.stringify([...marks]));
}

function removeMarks(key: string, ids: string[]) {
  const marks = readMarks(key);
  for (const id of ids) marks.delete(id);
  storage.set(key, JSON.stringify([...marks]));
}

// ===== 画面の要素 =====

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = document.querySelector<HTMLElement>('[data-admin]')!;
const base = root.dataset.base ?? '';

const ui = {
  dataInfo: $('data-info'),
  count: $<HTMLSelectElement>('count'),
  category: $<HTMLSelectElement>('category'),
  sort: $<HTMLSelectElement>('sort'),
  counter: $('pick-counter'),
  pickList: $<HTMLUListElement>('pick-list'),
  length: $<HTMLSelectElement>('length'),
  points: $<HTMLInputElement>('points'),
  prompt: $<HTMLTextAreaElement>('prompt'),
  promptInfo: $('prompt-info'),
  promptParts: $('prompt-parts'),
  promptStatus: $('prompt-status'),
  downloadPromptAll: $<HTMLButtonElement>('download-prompt-all'),
  maxChars: $<HTMLSelectElement>('max-chars'),
  answerMode: $<HTMLSelectElement>('answer-mode'),
  responseFile: $<HTMLInputElement>('response-file'),
  responseFileStatus: $('response-file-status'),
  response: $<HTMLTextAreaElement>('response'),
  checkResult: $('check-result'),
  saveInfo: $('save-info'),
  save: $<HTMLButtonElement>('save'),
  downloadJson: $<HTMLButtonElement>('download-json'),
  saveStatus: $('save-status'),
  savedCount: $('saved-count'),
  savedList: $<HTMLUListElement>('saved-list'),
  deleteSelected: $<HTMLButtonElement>('delete-selected'),
  deleteStatus: $('delete-status'),
  pasteCard: $<HTMLDetailsElement>('paste-card'),
  pasteCount: $('paste-count'),
  pasteList: $<HTMLUListElement>('paste-list'),
  pasteFlagged: $('paste-flagged'),
  pasteStatus: $('paste-status'),
  bulkText: $<HTMLTextAreaElement>('bulk-text'),
  textFile: $<HTMLInputElement>('text-file'),
  pastePromptPanel: $('paste-prompt-panel'),
  includeSummarized: $<HTMLInputElement>('include-summarized'),
  savedFilter: $<HTMLInputElement>('saved-filter'),
  savedWarnOnly: $<HTMLInputElement>('saved-warn-only'),
  savedWarnCount: $('saved-warn-count'),
  savedAutoOnly: $<HTMLInputElement>('saved-auto-only'),
  savedAutoCount: $('saved-auto-count'),
  autoBadge: $('auto-badge'),
  autoStatus: $<HTMLUListElement>('auto-status'),
  hideSelected: $<HTMLButtonElement>('hide-selected'),
  hideStatus: $('hide-status'),
  hiddenCount: $('hidden-count'),
  blockWords: $<HTMLTextAreaElement>('block-words'),
  blockHosts: $<HTMLTextAreaElement>('block-hosts'),
  saveBlocklist: $<HTMLButtonElement>('save-blocklist'),
  blocklistStatus: $('blocklist-status'),
  hiddenList: $<HTMLUListElement>('hidden-list'),
  unhideSelected: $<HTMLButtonElement>('unhide-selected'),
  unhideStatus: $('unhide-status'),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(target: HTMLElement, text: string, kind: 'ok' | 'error' | '' = '') {
  target.textContent = text;
  target.className = `status ${kind}`.trim();
}

/** エラーの説明。トークンが使えなくなったときは、設定し直す方法も伝える */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof GitHubError && error.status === 401
    ? `${message}。ログアウトして、ログインページの「保存したトークンを消してやり直す」から設定し直してください`
    : message;
}

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// ===== 状態 =====

let data: AdminData | undefined;
const selected = new Set<string>();
/** プロンプトに入れた記事（回答に含まれていない記事を見つけるため） */
let batch: AdminArticle[] = [];
let validation: ValidationResult | undefined;
const excluded = new Set<string>();
/** ログイン中に使う GitHub のトークン（ログインページで暗号化を解いたもの。このタブの中だけで使う） */
let token = '';
/** 運営者が貼り付けた記事の本文（記事ID → 本文）。プロンプトを作るのに使うだけで、サイトや GitHub には保存・公開しない */
const texts = new Map<string, string>();
/** 「本文を貼る」で、本文を貼り付ける記事に加えた記事 */
const pasteIds = new Set<string>();
/** 自動で取得した本文の記事（運営者が自分で貼った本文と見分ける） */
const autoTexts = new Set<string>();
/** 運営者が自動で取得した本文を消した記事（自動の本文を入れ直さない） */
const noAuto = new Set<string>();
/** 自動で取得した本文を読むための鍵（ログイン中だけ） */
let textKey: TextKeyPair | undefined;
/** 本文の自動取得の依頼と結果 */
let textRequests: TextRequest[] = [];
const textResults = new Map<string, TextResult>();
/** 鍵が違って読めなかった記事 */
const undecryptable = new Set<string>();

const categoryName = (slug: string) => data?.categories.find((c) => c.slug === slug)?.name ?? slug;

/** アクセス解析のサーバー（設定されていれば、要約の候補を「よく読まれている順」に並べられる） */
const analyticsEndpoint = document.body.dataset.analytics ?? '';
/** 記事ごとの読まれた人数（直近7日。アクセス解析のサーバーから） */
let readCounts = new Map<string, number>();

function articleMeta(article: AdminArticle): string {
  const read = readCounts.get(article.id);
  return [
    article.site,
    categoryName(article.category),
    dateFormat.format(new Date(article.publishedAt)),
    article.coverage ? `${article.coverage}媒体が報道` : '',
    read ? `${read}人が読んだ（7日間）` : '',
  ]
    .filter(Boolean)
    .join(' ・ ');
}

/** 要約待ちの記事（保存直後でまだサイトに反映されていないものは除く） */
function pendingArticles(): AdminArticle[] {
  if (!data) return [];
  const saved = readMarks(KEYS.saved);
  const deleted = readMarks(KEYS.deleted);
  const hidden = readMarks(KEYS.hidden);
  // 削除した要約はサイトに反映されるまで pending に入っていないので、ここで戻す。
  // 「要約済みの記事も選べるようにする」なら、要約済みの記事も候補に入れる（AI で作り直す）
  const restored = ui.includeSummarized.checked
    ? data.summarized
    : data.summarized.filter((article) => deleted.has(article.id));
  const category = ui.category.value;
  const list = [...data.pending, ...restored].filter(
    (article) => !saved.has(article.id) && !hidden.has(article.id) && (!category || article.category === category),
  );
  const byCoverage = (a: AdminArticle, b: AdminArticle) => (b.coverage ?? 1) - (a.coverage ?? 1) || b.publishedAt.localeCompare(a.publishedAt);
  const sorted =
    ui.sort.value === 'latest'
      ? list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      : ui.sort.value === 'read'
        ? list.sort((a, b) => (readCounts.get(b.id) ?? 0) - (readCounts.get(a.id) ?? 0) || byCoverage(a, b))
        : list.sort(byCoverage);
  if (!ui.includeSummarized.checked) return sorted;
  // 作り直しのときは、要約済みの記事を先に並べる（多数の記事に埋もれないように）
  const summarizedIds = new Set(data.summarized.map((article) => article.id));
  return [...sorted.filter((article) => summarizedIds.has(article.id)), ...sorted.filter((article) => !summarizedIds.has(article.id))];
}

function findArticle(id: string): { article: AdminArticle; summarized: boolean } | undefined {
  if (!data) return undefined;
  const pending = data.pending.find((article) => article.id === id);
  if (pending) return { article: pending, summarized: false };
  const summarized = data.summarized.find((article) => article.id === id);
  return summarized ? { article: summarized, summarized: true } : undefined;
}

// ===== 1. 記事の選択 =====

function autoSelect() {
  selected.clear();
  // 要約済みの記事（作り直し）は自動では選ばず、チェックしたものだけを作り直す。
  // AI が開けなかった記事と、開けないことが多いサイトの記事も（本文を貼るまでは）選ばない
  const blocked = aiBlocked();
  const pending = pendingArticles().filter((article) => !findArticle(article.id)?.summarized && !blocked(article));
  for (const article of pending.slice(0, Number(ui.count.value))) selected.add(article.id);
}

function renderPickList() {
  const list = pendingArticles();
  const marks = readUnavailable();
  const flagged = flaggedSources(marks);
  ui.pickList.replaceChildren(
    ...list.slice(0, LIST_LIMIT).map((article) => {
      const item = el('li');
      const label = el('label');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = selected.has(article.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(article.id);
        else selected.delete(article.id);
        renderCounter(list.length);
        renderPrompt();
      });
      const meta = el('span', 'pick-meta', articleMeta(article));
      if (findArticle(article.id)?.summarized) meta.append(el('span', 'badge-inline', '要約済み・作り直し'));
      if (texts.has(article.id)) meta.append(el('span', 'badge-inline ok', '本文あり'));
      else if (marks.has(article.id)) meta.append(el('span', 'badge-inline warn', 'AI が開けなかった'));
      else if (flagged.has(article.sourceId)) meta.append(el('span', 'badge-inline warn', 'AI が開けないことが多いサイト'));
      label.append(box, el('span', 'pick-title', article.title), meta);
      item.className = 'pick-row';
      item.dataset.id = article.id;
      const paste = el('button', 'ghost small', '本文を貼る');
      paste.type = 'button';
      paste.title = 'AI が記事を開けないときに、本文を貼り付けて要約する';
      paste.addEventListener('click', () => addToPaste(article.id));
      item.append(label, paste);
      return item;
    }),
  );
  if (list.length === 0) ui.pickList.append(el('li', 'pick-meta', '要約待ちの記事はありません。'));
  renderCounter(list.length);
}

/** 一覧のチェックを、選んだ記事に合わせる（一覧を作り直さずに） */
function syncPickList() {
  for (const box of ui.pickList.querySelectorAll<HTMLInputElement>('li[data-id] input[type="checkbox"]')) {
    box.checked = selected.has(box.closest<HTMLElement>('li')!.dataset.id!);
  }
  renderCounter(pendingArticles().length);
}

function renderCounter(total: number) {
  const shown = Math.min(total, LIST_LIMIT);
  const blocked = aiBlocked();
  const skipped = pendingArticles().filter(blocked).length;
  ui.counter.textContent = [
    `要約待ち ${total}件${total > shown ? `（上位${shown}件を表示）` : ''}`,
    `選択中 ${selected.size}件`,
    skipped > 0 ? `AI が開けない記事・本文を貼った記事 ${skipped}件は自動では選びません` : '',
  ]
    .filter(Boolean)
    .join(' ・ ');
}

// ===== 2. プロンプト =====

/** 選んでいる記事（カテゴリで絞り込んでいても、選んだ記事はすべてプロンプトに入れる） */
function selectedArticles(): AdminArticle[] {
  const saved = readMarks(KEYS.saved);
  const hidden = readMarks(KEYS.hidden);
  return [...selected].flatMap((id) => {
    const found = findArticle(id);
    return found && !saved.has(id) && !hidden.has(id) ? [found.article] : [];
  });
}

// ===== プロンプトの表示（上限を超えるときは何回かに分ける・ファイルで保存する） =====

/** 1回分のプロンプトと、その記事 */
interface PromptPart {
  text: string;
  ids: string[];
}

interface PromptPanel {
  /** 保存するファイル名の先頭 */
  name: string;
  textarea: HTMLTextAreaElement;
  parts: HTMLElement;
  info: HTMLElement;
  status: HTMLElement;
  downloadAll: HTMLButtonElement;
  list: PromptPart[];
  /** 分けないプロンプト全体（ファイルで AI に渡すとき用） */
  whole: string;
  current: number;
  empty: string;
}

/** プロンプトのファイルを AI に添付したときに一緒に送る一言 */
const FILE_MESSAGE = '添付したファイルは記事の要約の依頼です。ファイルに書かれた指示どおりに、記事の要約を作ってください。';

const promptPanel: PromptPanel = {
  name: 'summary-prompt',
  textarea: ui.prompt,
  parts: ui.promptParts,
  info: ui.promptInfo,
  status: ui.promptStatus,
  downloadAll: ui.downloadPromptAll,
  list: [],
  whole: '',
  current: 0,
  empty: '記事を選ぶとプロンプトが表示されます',
};

const pastePanel: PromptPanel = {
  name: 'honbun-prompt',
  textarea: $<HTMLTextAreaElement>('paste-prompt'),
  parts: $('paste-prompt-parts'),
  info: $('paste-prompt-info'),
  status: $('paste-prompt-status'),
  downloadAll: $<HTMLButtonElement>('paste-prompt-download-all'),
  list: [],
  whole: '',
  current: 0,
  empty: '',
};

function promptOptions(): PromptOptions {
  return {
    siteName: data?.siteName ?? '',
    length: ui.length.value as SummaryLength,
    points: ui.points.checked,
    answer: ui.answerMode.value as AnswerMode,
  };
}

const maxChars = () => Number(ui.maxChars.value) || 0;

const toPromptArticle = ({ id, title, url, site, excerpt, publishedAt }: AdminArticle): PromptArticle => ({
  id,
  title,
  url,
  site,
  excerpt,
  publishedAt,
  text: texts.get(id),
});

/** パネルにプロンプトを出す（1回に貼り付ける長さの上限を超えるときは何回かに分ける） */
function fillPanel(panel: PromptPanel, articles: AdminArticle[]) {
  const options = promptOptions();
  const groups = splitPromptArticles(articles.map(toPromptArticle), options, maxChars());
  panel.list = groups.map((group, i) => ({
    text: buildSummaryPrompt(group, { ...options, part: groups.length > 1 ? { index: i + 1, total: groups.length } : undefined }),
    ids: group.map((article) => article.id),
  }));
  panel.whole = groups.length > 1 ? buildSummaryPrompt(articles.map(toPromptArticle), options) : (panel.list[0]?.text ?? '');
  panel.current = Math.min(panel.current, Math.max(0, panel.list.length - 1));
  showPart(panel);
}

function showPart(panel: PromptPanel) {
  const part = panel.list[panel.current];
  const total = panel.list.length;
  panel.textarea.value = part?.text ?? '';
  panel.parts.hidden = total <= 1;
  panel.downloadAll.hidden = total <= 1;
  panel.parts.replaceChildren();
  if (total > 1) {
    panel.parts.append(el('span', 'note', `長いので${total}回に分けました:`));
    panel.list.forEach((item, i) => {
      const button = el('button', 'small', `${i + 1}回目（${item.ids.length}件）`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(i === panel.current));
      button.addEventListener('click', () => {
        panel.current = i;
        showPart(panel);
      });
      panel.parts.append(button);
    });
  }
  if (!part) {
    panel.info.textContent = panel.empty;
    panel.info.className = 'note';
    return;
  }
  const withText = part.ids.filter((id) => texts.has(id)).length;
  const over = maxChars() > 0 && part.text.length > maxChars();
  panel.info.textContent = [
    total > 1 ? `${panel.current + 1}回目:` : '',
    `${part.ids.length}件${withText > 0 ? `（本文あり ${withText}件）` : ''} ・ ${part.text.length.toLocaleString()}字`,
    over ? '1件だけで上限を超えています。「ファイルで保存」して AI に添付するか、上限を上げてください' : '',
  ]
    .filter(Boolean)
    .join(' ');
  panel.info.className = over ? 'note warn' : 'note';
}

/** 「ファイルで保存」のあとに、AI にファイルを添付するときの一言をコピーできるようにする */
function fileSavedMessage(panel: PromptPanel, filename: string) {
  panel.status.replaceChildren();
  const box = el('span', 'file-message');
  box.append(`${filename} を保存しました。AI の画面でこのファイルを添付し、次の一言を送ってください: 「${FILE_MESSAGE}」`);
  const copy = el('button', 'small', '一言をコピー');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(FILE_MESSAGE);
      copy.textContent = 'コピーしました';
    } catch {
      copy.textContent = 'コピーできませんでした';
    }
  });
  box.append(copy);
  panel.status.append(box);
  panel.status.className = 'status';
}

function setupPanel(panel: PromptPanel, copyButton: HTMLButtonElement, downloadButton: HTMLButtonElement) {
  copyButton.addEventListener('click', async () => {
    const part = panel.list[panel.current];
    if (!part) return;
    const label = copyButton.textContent;
    try {
      await navigator.clipboard.writeText(part.text);
      copyButton.textContent = 'コピーしました';
    } catch {
      panel.textarea.select();
      copyButton.textContent = '選択しました（Ctrl+C でコピー）';
    }
    setTimeout(() => (copyButton.textContent = label), 2500);
    const total = panel.list.length;
    setStatus(
      panel.status,
      total > 1
        ? `${panel.current + 1}回目（全${total}回）をコピーしました。AI の回答を手順3で確認・保存したら、${panel.current + 1 < total ? `次の${panel.current + 2}回目に進んでください。` : 'すべての回が終わりです。'}`
        : 'コピーしました。AI に貼り付けて、回答を手順3で確認・保存してください。',
    );
  });
  downloadButton.addEventListener('click', () => {
    const part = panel.list[panel.current];
    if (!part) return;
    const total = panel.list.length;
    const filename = `${panel.name}-${stamp()}${total > 1 ? `-${panel.current + 1}of${total}` : ''}.txt`;
    download(filename, part.text, 'text/plain');
    fileSavedMessage(panel, filename);
  });
  panel.downloadAll.addEventListener('click', () => {
    if (!panel.whole) return;
    const filename = `${panel.name}-${stamp()}-all.txt`;
    download(filename, panel.whole, 'text/plain');
    fileSavedMessage(panel, filename);
  });
}

function renderPrompt() {
  if (!data) return;
  batch = selectedArticles();
  saveDraft();
  fillPanel(promptPanel, batch);
  saveOptions();
}

/** 本文を貼った記事の、本文入りのプロンプト */
function renderPastePrompt() {
  if (!data) return;
  const articles = pasteArticles().filter((article) => texts.has(article.id));
  ui.pastePromptPanel.hidden = articles.length === 0;
  fillPanel(pastePanel, articles);
}

/** AI の回答がどの回のプロンプトに対するものか（回答に含まれる記事で見分ける） */
function promptGroupsFor(answered: Set<string>): string[][] {
  return [...promptPanel.list, ...pastePanel.list].map((part) => part.ids).filter((ids) => ids.some((id) => answered.has(id)));
}

// ===== AI が開けない記事（本文の貼り付け・同じ話題の別の記事） =====

/** AI が開けなかった記事の記録（このブラウザに残す） */
interface UnavailableMark {
  at: number;
  sourceId: string;
  site: string;
  /** 「リストから外す」で一覧から外した（自動の選択からは引き続き外す） */
  dismissed?: boolean;
}
/** AI が開けなかった記録を残す期間 */
const UNAVAILABLE_FOR = 14 * 24 * 60 * 60 * 1000;
/** AI が開けなかった記事がこの件数以上あるサイトは、本文を貼るまで自動では選ばない */
const FLAG_THRESHOLD = 2;

function readUnavailable(): Map<string, UnavailableMark> {
  try {
    const entries = JSON.parse(storage.get(KEYS.unavailable) ?? '[]') as [string, UnavailableMark][];
    return new Map(entries.filter(([, mark]) => typeof mark?.at === 'number' && Date.now() - mark.at < UNAVAILABLE_FOR));
  } catch {
    return new Map();
  }
}

function writeUnavailable(marks: Map<string, UnavailableMark>) {
  storage.set(KEYS.unavailable, JSON.stringify([...marks]));
}

/** 本文を貼らずに要約できた（AI が開けた）最後の時刻（掲載元ID → 時刻） */
function readReadable(): Record<string, number> {
  try {
    return JSON.parse(storage.get(KEYS.readable) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/** AI が開けないことが多いサイト（最後に開けたあとに、開けなかった記事が FLAG_THRESHOLD 件以上あるサイト） */
function flaggedSources(marks = readUnavailable()): Map<string, { site: string; count: number }> {
  const readable = readReadable();
  const counts = new Map<string, { site: string; count: number }>();
  for (const mark of marks.values()) {
    if (mark.at <= (readable[mark.sourceId] ?? 0)) continue;
    const entry = counts.get(mark.sourceId) ?? { site: mark.site, count: 0 };
    entry.count++;
    counts.set(mark.sourceId, entry);
  }
  return new Map([...counts].filter(([, entry]) => entry.count >= FLAG_THRESHOLD));
}

/**
 * 手順1で自動では選ばない記事か（AI が開けなかった記事、開けないことが多いサイトの記事、
 * 本文を貼った記事。本文を貼った記事は「本文入りのプロンプト」で依頼する）
 */
function aiBlocked(): (article: AdminArticle) => boolean {
  const marks = readUnavailable();
  const flagged = flaggedSources(marks);
  return (article) => texts.has(article.id) || marks.has(article.id) || flagged.has(article.sourceId);
}

/** AI が開けなかった記事を記録して、「AI が開けない記事」に出す */
function markUnavailable(ids: string[]) {
  const marks = readUnavailable();
  for (const id of ids) {
    const found = findArticle(id);
    if (found) marks.set(id, { at: Date.now(), sourceId: found.article.sourceId, site: found.article.site });
  }
  writeUnavailable(marks);
  renderPickList();
  renderPasteList();
}

/** 保存した記事を片付ける。本文を貼らずに要約できたサイトは「AI が開けた」と記録する */
function clearPasted(ids: string[]) {
  const marks = readUnavailable();
  const readable = readReadable();
  for (const id of ids) {
    const found = findArticle(id);
    if (found && !texts.has(id)) readable[found.article.sourceId] = Date.now();
    marks.delete(id);
    texts.delete(id);
    pasteIds.delete(id);
  }
  writeUnavailable(marks);
  storage.set(KEYS.readable, JSON.stringify(readable));
  renderPasteList();
}

/** 本文を貼り付ける記事（AI が開けなかった記事・「本文を貼る」で加えた記事・本文を貼った記事） */
function pasteArticles(marks = readUnavailable()): AdminArticle[] {
  const saved = readMarks(KEYS.saved);
  const ids = [
    ...[...marks]
      .filter(([, mark]) => !mark.dismissed)
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id]) => id),
    ...pasteIds,
    ...texts.keys(),
  ];
  return [...new Set(ids)].flatMap((id) => {
    const found = findArticle(id);
    return found && !saved.has(id) ? [found.article] : [];
  });
}

/** 同じ話題を報じたほかの掲載元の記事（要約待ちで AI が開けそうなもの）と、同じ話題の要約済みの記事 */
function sameTopic(article: AdminArticle): { pending: AdminArticle[]; summarized?: AdminArticle } {
  if (!data || !article.topic) return { pending: [] };
  const blocked = aiBlocked();
  const saved = readMarks(KEYS.saved);
  const others = (list: AdminArticle[]) => list.filter((other) => other.topic === article.topic && other.id !== article.id);
  const summarized = others(data.summarized)[0] ?? others(data.pending).find((other) => saved.has(other.id));
  const pending = others(data.pending).filter(
    (other) => other.sourceId !== article.sourceId && !saved.has(other.id) && !blocked(other),
  );
  return { pending, summarized };
}

const shorten = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text);

function openPasteCard(focusId?: string) {
  ui.pasteCard.open = true;
  ui.pasteCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (focusId) {
    ui.pasteList.querySelector<HTMLTextAreaElement>(`li[data-id="${CSS.escape(focusId)}"] textarea`)?.focus({ preventScroll: true });
  }
}

/** 「本文を貼る」: 記事を本文を貼り付ける記事に加えて選ぶ */
function addToPaste(id: string) {
  pasteIds.add(id);
  selected.delete(id);
  const marks = readUnavailable();
  const mark = marks.get(id);
  if (mark?.dismissed) {
    delete mark.dismissed;
    writeUnavailable(marks);
  }
  syncPickList();
  renderPasteList();
  renderPrompt();
  openPasteCard(id);
}

/** 本文を貼り付ける記事から外す（AI が開けなかった記録は残し、自動では選ばないままにする） */
function removeFromPaste(id: string) {
  const marks = readUnavailable();
  const mark = marks.get(id);
  if (mark) {
    mark.dismissed = true;
    writeUnavailable(marks);
  }
  pasteIds.delete(id);
  texts.delete(id);
  selected.delete(id);
}

/** AI が開けない記事の代わりに、同じ話題の別の記事を選ぶ */
function switchTo(article: AdminArticle, other: AdminArticle) {
  removeFromPaste(article.id);
  selected.add(other.id);
  syncPickList();
  renderPasteList();
  renderPrompt();
  setStatus(ui.pasteStatus, `代わりに「${other.title}」（${other.site}）を選びました。手順2のプロンプトに入っています。`, 'ok');
}

function pasteRow(article: AdminArticle, marks: Map<string, UnavailableMark>): HTMLLIElement {
  const item = el('li', 'paste-item');
  item.dataset.id = article.id;
  const title = el('a', 'pick-title', `${article.title} ↗`);
  title.href = article.url;
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.title = '記事を新しいタブで開く';
  const meta = el('div', 'pick-meta', articleMeta(article));
  if (marks.has(article.id)) meta.append(el('span', 'badge-inline warn', 'AI が開けなかった'));

  const area = el('textarea');
  area.rows = 4;
  area.spellcheck = false;
  area.placeholder = '記事のページで本文をコピーして、ここに貼り付け（「本文をコピー」ボタンを使うと本文だけを取り出せます）';
  area.value = texts.get(article.id) ?? '';
  area.setAttribute('aria-label', `「${article.title}」の本文`);
  const info = el('p', 'paste-info');
  const auto = autoInfo(article);
  /** 本文を読み取って表示を更新する（edited: 運営者が書き換えたとき） */
  const update = (edited = false) => {
    const parsed = parsePastedText(area.value);
    if (edited) {
      // 自分で書き換えた本文は、自動で取得した本文として扱わない（消したら自動の本文を入れ直さない）
      autoTexts.delete(article.id);
      if (!parsed.text) noAuto.add(article.id);
      else noAuto.delete(article.id);
    }
    if (parsed.text) texts.set(article.id, parsed.text);
    else texts.delete(article.id);
    const warnings: string[] = [];
    if (parsed.url) {
      const match = comparePastedUrl(parsed.url, article.url);
      if (match === 'other') warnings.push('別のサイトのページの本文のようです。貼り間違えていないか確かめてください。');
      if (match === 'same-site') warnings.push('記事の URL と違うページの本文です。同じ記事か確かめてください。');
    }
    const length = Array.from(parsed.text).length;
    if (parsed.truncated) warnings.push(`長いので先頭の${ARTICLE_TEXT_MAX.toLocaleString()}字だけを使います。`);
    else if (parsed.text && length < 200) warnings.push('本文が短いようです。本文全体をコピーできているか確かめてください。');
    info.textContent = parsed.text
      ? [
          `${autoTexts.has(article.id) ? '自動で取得した本文' : '本文'} ${length.toLocaleString()}字（AI は URL を開かずに、この本文から要約します）。`,
          ...warnings,
        ].join(' ')
      : '本文はまだありません（このままでは AI が URL を開こうとします）。';
    info.className = warnings.length > 0 ? 'paste-info warn' : 'paste-info';
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  area.addEventListener('input', () => {
    update(true);
    saveDraft();
    // 本文入りのプロンプトを作り直す（打つたびに作り直さないよう少し待つ）
    clearTimeout(timer);
    timer = setTimeout(() => {
      renderPastePrompt();
      if (selected.has(article.id)) renderPrompt();
    }, 250);
  });
  update();

  const actions = el('div', 'paste-actions');
  const { pending, summarized } = sameTopic(article);
  if (summarized) {
    actions.append(el('span', 'alt', `同じ話題は「${shorten(summarized.title, 30)}」（${summarized.site}）で要約済みです。この記事は外してもかまいません。`));
  }
  for (const other of pending.slice(0, 2)) {
    const button = el('button', 'small', `代わりに ${other.site} の記事を選ぶ`);
    button.type = 'button';
    button.title = `同じ話題: ${other.title}`;
    button.addEventListener('click', () => switchTo(article, other));
    actions.append(button);
  }
  const remove = el('button', 'ghost small', 'リストから外す');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    removeFromPaste(article.id);
    syncPickList();
    renderPasteList();
    renderPrompt();
  });
  actions.append(remove);
  item.append(title, meta, area, info, ...(auto ? [auto] : []), actions);
  return item;
}

// ===== 本文の自動取得（依頼・結果の読み込み・復号） =====

/** 自動取得を断っているサイト（robots.txt・noai で断っていた結果があるサイト）。依頼しても同じなので、自動では依頼しない */
function refusedSources(): Set<string> {
  const sourceOf = new Map(textRequests.map((request) => [request.id, request.sourceId]));
  const refused = new Set<string>();
  for (const result of textResults.values()) {
    const sourceId = sourceOf.get(result.id) ?? findArticle(result.id)?.article.sourceId;
    if (sourceId && (result.status === 'robots' || result.status === 'ai-optout')) refused.add(sourceId);
  }
  return refused;
}

/** 記事の最新の依頼と結果 */
function textState(id: string): { request?: TextRequest; result?: TextResult; waiting: boolean } {
  const request = textRequests.find((entry) => entry.id === id);
  const result = textResults.get(id);
  const waiting = !!request && (!result || result.fetchedAt < request.requestedAt);
  return { request, result, waiting };
}

/** 記事ごとの欄に出す、自動取得の状況（と、依頼し直すボタン） */
function autoInfo(article: AdminArticle): HTMLElement | undefined {
  const { request, result, waiting } = textState(article.id);
  if (autoTexts.has(article.id) && texts.has(article.id)) return undefined;
  const box = el('p', 'auto-info');
  const retry = (label: string) => {
    const button = el('button', 'ghost small', label);
    button.type = 'button';
    button.addEventListener('click', () => void requestTexts([article]));
    return button;
  };
  if (waiting) {
    box.append('本文を自動で取得しています（依頼から数分かかります。この画面を開いたままにすると自動で確認します）…');
  } else if (result && result.status === 'ok' && !textKey) {
    box.classList.add('warn');
    box.append('自動で取得した本文があります。読むには、いったんログアウトしてログインし直してください。');
  } else if (result && result.status === 'ok' && undecryptable.has(article.id)) {
    box.classList.add('warn');
    box.append('自動で取得した本文を、このログインの鍵では読めませんでした（鍵を作り直す前に取得した本文です）。', retry('もう一度自動で取得'));
  } else if (result && result.status !== 'ok') {
    box.classList.add('warn');
    box.append(`自動で取得できませんでした: ${TEXT_STATUS_LABELS[result.status]}${result.detail ? `（${result.detail}）` : ''}。本文を貼り付けてください。`);
    // サイトが断っている場合は、依頼し直しても同じなのでボタンを出さない
    if (result.status === 'error' || result.status === 'no-text') box.append(retry('もう一度自動で取得'));
  } else if (!request && !texts.has(article.id)) {
    box.append(retry('本文を自動で取得'));
  } else {
    return undefined;
  }
  return box;
}

/** 本文の自動取得を依頼する（data/text-requests.json に書く。書き込むと自動収集が動き、数分で結果が入る） */
async function requestTexts(articles: AdminArticle[]) {
  const status = $('auto-text-status');
  if (!data || articles.length === 0) return;
  if (!textKey) {
    setStatus(status, '本文の自動取得を使うには、いったんログアウトしてログインし直してください（本文を読むための鍵を作ります）。', 'error');
    return;
  }
  const requestedAt = new Date().toISOString();
  const additions = articles.map(({ id, url, sourceId }) => ({ id, url, sourceId, requestedAt }));
  setStatus(status, `${additions.length}件の本文の自動取得を依頼しています…`);
  try {
    const client = githubClient();
    const { defaultBranch } = await client.repository();
    await client.commitFiles(defaultBranch, `本文の自動取得を依頼（${additions.length}件）`, async (read) => {
      const current = parseJsonList((await read(TEXT_REQUESTS_PATH)) ?? undefined, pickRequests);
      return [{ path: TEXT_REQUESTS_PATH, content: serializeLines(mergeTextRequests(current, additions, Date.now())) }];
    });
    textRequests = mergeTextRequests(textRequests, additions, Date.now());
    for (const article of articles) {
      undecryptable.delete(article.id);
      // 依頼し直した記事は、取得できた本文を入れ直す
      noAuto.delete(article.id);
    }
    setStatus(
      status,
      `${additions.length}件の本文の自動取得を依頼しました。数分後に、取得できた本文がこの欄に入ります（この画面を開いたままにすると自動で確認します）。`,
      'ok',
    );
    renderPasteList();
    scheduleTextsCheck();
  } catch (error) {
    setStatus(status, `本文の自動取得を依頼できませんでした: ${errorText(error)}`, 'error');
  }
}

/** 一覧の記事のうち、まだ本文がなく、自動取得も依頼していない（または取得に失敗した）記事の本文を依頼する */
function requestListedTexts() {
  const refused = refusedSources();
  const targets = pasteArticles().filter((article) => {
    if (texts.has(article.id) || refused.has(article.sourceId)) return false;
    const { waiting, result } = textState(article.id);
    return !waiting && (!result || result.status === 'error' || result.status === 'no-text' || result.status === 'ok');
  });
  if (targets.length === 0) {
    setStatus($('auto-text-status'), '自動取得を依頼できる記事はありません（本文がある記事・取得中の記事・サイトが断っている記事は除きます）。');
    return;
  }
  void requestTexts(targets);
}

/** 自分の公開鍵がまだ登録されていなければ、data/text-keys.json に登録する（自動収集が本文をこの鍵で暗号化する） */
async function ensureTextKey() {
  if (!data || !textKey || (data.textKeys ?? []).includes(textKey.kid)) return;
  const key = textKey;
  try {
    const client = githubClient();
    const { defaultBranch } = await client.repository();
    await client.commitFiles(defaultBranch, '本文の自動取得の鍵を登録', async (read) => {
      const current = parseJsonList((await read(TEXT_KEYS_PATH)) ?? undefined, pickKeys);
      if (current.some((entry) => entry.kid === key.kid)) return [];
      const next = mergeTextKeys(current, { kid: key.kid, publicKey: key.publicKey, createdAt: new Date().toISOString() });
      return [{ path: TEXT_KEYS_PATH, content: serializeLines(next) }];
    });
    data.textKeys = [...(data.textKeys ?? []), key.kid];
  } catch (error) {
    setStatus($('auto-text-status'), `本文の自動取得の鍵を登録できませんでした: ${errorText(error)}`, 'error');
  }
}

let textsTimer: ReturnType<typeof setTimeout> | undefined;
let textsChecks = 0;

/** 取得を待っている記事があれば、しばらくして結果を確かめる（最大30分） */
function scheduleTextsCheck() {
  clearTimeout(textsTimer);
  const waiting = textRequests.some((request) => textState(request.id).waiting && findArticle(request.id));
  if (waiting && textsChecks < 30) textsTimer = setTimeout(() => void loadTexts(), 60_000);
}

/** 自動取得の依頼と結果を読み込み、取得できた本文を復号して入れる */
async function loadTexts() {
  textsChecks++;
  try {
    const res = await fetch(`${base}/admin/texts.json`, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { requests?: unknown; items?: unknown };
      textRequests = mergeTextRequests(textRequests, pickRequests(body.requests), Date.now());
      for (const result of pickResults({ items: body.items })) {
        const known = textResults.get(result.id);
        if (!known || known.fetchedAt < result.fetchedAt) textResults.set(result.id, result);
      }
      await applyTexts();
    }
  } catch {
    // 読めなくても、手で貼り付ける作業は続けられる
  }
  scheduleTextsCheck();
}

/** 取得できた本文を復号して、本文の欄に入れる（自分で貼った本文は上書きしない） */
async function applyTexts() {
  let added = 0;
  for (const result of textResults.values()) {
    if (result.status !== 'ok' || !result.enc || texts.has(result.id) || noAuto.has(result.id) || !findArticle(result.id)) continue;
    if (readMarks(KEYS.saved).has(result.id)) continue;
    if (!textKey) {
      undecryptable.add(result.id);
      continue;
    }
    try {
      texts.set(result.id, await decryptText(result.enc, textKey));
      autoTexts.add(result.id);
      pasteIds.add(result.id);
      selected.delete(result.id);
      undecryptable.delete(result.id);
      added++;
    } catch {
      undecryptable.add(result.id);
    }
  }
  if (added > 0) {
    syncPickList();
    renderPrompt();
    setStatus($('auto-text-status'), `${added}件の本文を自動で取得しました。下の本文入りのプロンプトに入っています。`, 'ok');
    ui.pasteCard.open = true;
  }
  renderPasteList();
}

function renderPasteList() {
  if (!data) return;
  const marks = readUnavailable();
  const list = pasteArticles(marks);
  ui.pasteCount.textContent = `${list.length}件`;
  ui.pasteList.replaceChildren(...list.map((article) => pasteRow(article, marks)));
  if (list.length === 0) {
    ui.pasteList.append(el('li', 'pick-meta', 'AI が開けなかった記事はまだありません。手順1の「本文を貼る」で加えることもできます。'));
  }
  renderPastePrompt();

  const flagged = flaggedSources(marks);
  ui.pasteFlagged.hidden = flagged.size === 0;
  ui.pasteFlagged.replaceChildren();
  if (flagged.size > 0) {
    const names = [...flagged.values()].map((entry) => `${entry.site}（${entry.count}件）`).join('、');
    const reset = el('button', 'ghost small', '記録を消す');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      if (!confirm('AI が開けなかった記録をすべて消しますか？（貼り付けた本文は消えません）')) return;
      writeUnavailable(new Map());
      renderPickList();
      renderPasteList();
    });
    ui.pasteFlagged.append(
      `AI が開けないことが多いサイト: ${names}。これらのサイトの記事は、本文を貼るまで手順1で自動では選びません。 `,
      reset,
    );
  }
}

/** ページの URL から記事を探す（本文を貼り付ける記事を先に探す） */
function findArticleByUrl(url: string): AdminArticle | undefined {
  if (!data) return undefined;
  const saved = readMarks(KEYS.saved);
  return [...pasteArticles(), ...data.pending, ...data.summarized].find(
    (article) => !saved.has(article.id) && comparePastedUrl(url, article.url) === 'same',
  );
}

/** 貼り付けた本文を、ページの URL で記事に振り分ける。振り分けられなかった本文を返す */
function assignTexts(blocks: PastedText[]): { assigned: AdminArticle[]; unmatched: PastedText[] } {
  const assigned: AdminArticle[] = [];
  const unmatched: PastedText[] = [];
  for (const block of blocks) {
    const article = block.url ? findArticleByUrl(block.url) : undefined;
    if (!article) {
      unmatched.push(block);
      continue;
    }
    texts.set(article.id, block.text);
    pasteIds.add(article.id);
    selected.delete(article.id);
    assigned.push(article);
  }
  return { assigned, unmatched };
}

/** 振り分けた結果を知らせる */
function reportAssigned(assigned: AdminArticle[], unmatched: string[], problems: string[] = []) {
  if (assigned.length > 0) {
    syncPickList();
    renderPasteList();
    renderPrompt();
  }
  const messages = [
    assigned.length > 0 ? `${assigned.length}件の本文を振り分けました（${assigned.map((article) => shorten(article.title, 20)).join('、')}）。下の本文入りのプロンプトに入っています。` : '',
    unmatched.length > 0
      ? `${unmatched.length}件はどの記事の本文か分かりませんでした（${unmatched.join('、')}）。URL のない本文や、一覧にない記事の本文は、記事ごとの欄に貼り付けてください。`
      : '',
    ...problems,
  ].filter(Boolean);
  setStatus(ui.pasteStatus, messages.join(' '), unmatched.length > 0 || problems.length > 0 ? 'error' : 'ok');
}

const blockLabel = (block: PastedText) => shorten(block.title ?? block.text.replace(/\s+/g, ' '), 20);

/** 「本文をまとめて貼り付け」の欄を振り分ける（振り分けられなかった本文は欄に残す） */
function assignBulkText() {
  const blocks = splitPastedBlocks(ui.bulkText.value);
  if (blocks.length === 0) return;
  const { assigned, unmatched } = assignTexts(blocks);
  ui.bulkText.value = unmatched
    .map((block) =>
      block.url || block.title
        ? [PASTE_MARKER, ...(block.title ? [`タイトル: ${block.title}`] : []), ...(block.url ? [`URL: ${block.url}`] : []), '', block.text].join('\n')
        : block.text,
    )
    .join('\n\n');
  reportAssigned(assigned, unmatched.map(blockLabel));
}

/** 本文のファイルを読み込んで、記事に振り分ける */
async function loadTextFiles(files: FileList | File[]) {
  const { loaded, problems } = await readTextFiles(files);
  const assigned: AdminArticle[] = [];
  const unmatched: string[] = [];
  for (const file of loaded) {
    const result = assignTexts(splitPastedBlocks(file.text));
    assigned.push(...result.assigned);
    unmatched.push(...result.unmatched.map((block) => `${file.name}: ${blockLabel(block)}`));
  }
  reportAssigned(assigned, unmatched, problems);
}

function setupPaste() {
  setupPanel(pastePanel, $<HTMLButtonElement>('paste-prompt-copy'), $<HTMLButtonElement>('paste-prompt-download'));
  $('request-texts').addEventListener('click', requestListedTexts);
  $('bulk-assign').addEventListener('click', assignBulkText);
  // 貼り付けたらすぐに振り分ける
  ui.bulkText.addEventListener('paste', () => setTimeout(assignBulkText, 0));
  $('text-file-button').addEventListener('click', () => ui.textFile.click());
  ui.textFile.addEventListener('change', () => {
    if (ui.textFile.files?.length) void loadTextFiles(ui.textFile.files);
    ui.textFile.value = '';
  });
  acceptDroppedFiles(ui.bulkText, loadTextFiles);
  // ブックマークレットは管理画面では動かない（ブックマークバーに登録して記事のページで使う）
  $('bookmarklet').addEventListener('click', (event) => {
    event.preventDefault();
    setStatus(ui.pasteStatus, 'このボタンはブックマークバーにドラッグして登録し、記事のページを開いてから押してください。');
  });
}

// ===== ファイルの読み込み =====

/** 読み込むファイルの大きさの上限（1ファイル） */
const FILE_MAX_BYTES = 5 * 1024 * 1024;

/** テキストのファイルを読む（大きすぎるファイル・読めないファイルは理由をつけて返す） */
async function readTextFiles(files: FileList | File[]): Promise<{ loaded: { name: string; text: string }[]; problems: string[] }> {
  const loaded: { name: string; text: string }[] = [];
  const problems: string[] = [];
  for (const file of Array.from(files).slice(0, 50)) {
    if (file.size > FILE_MAX_BYTES) {
      problems.push(`${file.name}: ファイルが大きすぎます（5MB まで）`);
      continue;
    }
    try {
      loaded.push({ name: file.name, text: await file.text() });
    } catch {
      problems.push(`${file.name}: 読み込めませんでした`);
    }
  }
  return { loaded, problems };
}

/** 欄にファイルをドラッグして読み込めるようにする */
function acceptDroppedFiles(target: HTMLElement, handler: (files: FileList) => void | Promise<void>) {
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  target.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    target.classList.add('dragging');
  });
  target.addEventListener('dragleave', () => target.classList.remove('dragging'));
  target.addEventListener('drop', (event) => {
    target.classList.remove('dragging');
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    void handler(event.dataTransfer.files);
  });
}

/** AI の回答のファイル（JSON・回答を保存したテキスト・保存用JSON）を読み込んで、内容を確認する */
async function loadResponseFiles(files: FileList | File[]) {
  const { loaded, problems } = await readTextFiles(files);
  const entries: ReturnType<typeof normalizeEntries> = [];
  for (const file of loaded) {
    try {
      entries.push(...normalizeEntries(extractJson(file.text)));
    } catch (error) {
      problems.push(`${file.name}: ${errorText(error)}`);
    }
  }
  if (entries.length > 0) {
    ui.response.value = JSON.stringify(entries, null, 1);
    saveDraft();
    checkResponse();
  }
  const names = loaded.map((file) => file.name).filter((name) => !problems.some((problem) => problem.startsWith(`${name}:`)));
  setStatus(
    ui.responseFileStatus,
    [names.length > 0 ? `${names.join('、')} を読み込みました（${entries.length}件）。` : '', ...problems].filter(Boolean).join(' '),
    problems.length > 0 ? 'error' : 'ok',
  );
}

// ===== 作業中の内容（自動ログアウトやページの再読み込みで消えないようにする） =====

/** 選んだ記事と貼り付けた回答。このタブの中にだけ残し、タブを閉じると消える */
interface Draft {
  selected: string[];
  response: string;
  category: string;
  includeSummarized: boolean;
  /** 貼り付けた本文（記事ID と本文） */
  texts?: [string, string][];
  /** 本文を貼り付ける記事に加えた記事 */
  pasteIds?: string[];
  /** 自動で取得した本文の記事・自動の本文を消した記事 */
  autoTexts?: string[];
  noAuto?: string[];
  savedAt: number;
}
const DRAFT_KEY = 'admin.draft';
const DRAFT_TTL = 12 * 60 * 60 * 1000;

function saveDraft() {
  const draft: Draft = {
    selected: [...selected],
    response: ui.response.value,
    category: ui.category.value,
    includeSummarized: ui.includeSummarized.checked,
    texts: [...texts],
    pasteIds: [...pasteIds],
    autoTexts: [...autoTexts],
    noAuto: [...noAuto],
    savedAt: Date.now(),
  };
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 残せなくても作業は続けられる
  }
}

/** 残しておいた作業中の内容を戻す。戻したら true */
function restoreDraft(): boolean {
  let draft: Partial<Draft> | null;
  try {
    draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<Draft> | null;
  } catch {
    return false;
  }
  if (!draft || !Array.isArray(draft.selected) || Date.now() - (draft.savedAt ?? 0) > DRAFT_TTL) return false;
  const draftTexts = Array.isArray(draft.texts) ? draft.texts : [];
  if (draft.selected.length === 0 && !draft.response && draftTexts.length === 0) return false;
  ui.includeSummarized.checked = draft.includeSummarized === true;
  if ([...ui.category.options].some((option) => option.value === draft.category)) ui.category.value = draft.category ?? '';
  const saved = readMarks(KEYS.saved);
  const exists = (id: string) => findArticle(id) !== undefined && !saved.has(id);
  selected.clear();
  for (const id of draft.selected) if (exists(id)) selected.add(id);
  texts.clear();
  for (const entry of draftTexts) {
    if (Array.isArray(entry) && typeof entry[1] === 'string' && exists(entry[0])) texts.set(entry[0], entry[1]);
  }
  pasteIds.clear();
  for (const id of Array.isArray(draft.pasteIds) ? draft.pasteIds : []) if (exists(id)) pasteIds.add(id);
  autoTexts.clear();
  for (const id of Array.isArray(draft.autoTexts) ? draft.autoTexts : []) if (texts.has(id)) autoTexts.add(id);
  noAuto.clear();
  for (const id of Array.isArray(draft.noAuto) ? draft.noAuto : []) if (exists(id)) noAuto.add(id);
  ui.response.value = typeof draft.response === 'string' ? draft.response : '';
  return true;
}

function saveOptions() {
  storage.set(
    KEYS.options,
    JSON.stringify({
      count: ui.count.value,
      sort: ui.sort.value,
      length: ui.length.value,
      points: ui.points.checked,
      maxChars: ui.maxChars.value,
      answer: ui.answerMode.value,
    }),
  );
}

function restoreOptions() {
  try {
    const options = JSON.parse(storage.get(KEYS.options) ?? '{}') as Record<string, unknown>;
    if (typeof options.count === 'string') ui.count.value = options.count;
    if (typeof options.sort === 'string') ui.sort.value = options.sort;
    if (typeof options.length === 'string') ui.length.value = options.length;
    if (typeof options.points === 'boolean') ui.points.checked = options.points;
    if (typeof options.maxChars === 'string') ui.maxChars.value = options.maxChars;
    if (typeof options.answer === 'string') ui.answerMode.value = options.answer;
    // 選択肢にない値（アクセス解析を使わなくなったときの「よく読まれている順」など）が残っていたら既定に戻す
    if (!ui.sort.value || ui.sort.selectedOptions[0]?.disabled) ui.sort.value = 'popular';
    if (!ui.maxChars.value) ui.maxChars.value = '15000';
    if (!ui.answerMode.value) ui.answerMode.value = 'codeblock';
  } catch {
    // 既定値のまま
  }
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// ===== 3. 回答の確認 =====

function acceptedToSave(): { accepted: AcceptedSummary; article: AdminArticle }[] {
  if (!validation) return [];
  return validation.accepted
    .filter((entry) => !excluded.has(entry.id))
    .flatMap((entry) => {
      const found = findArticle(entry.id);
      return found ? [{ accepted: entry, article: found.article }] : [];
    });
}

function renderSaveArea() {
  const count = acceptedToSave().length;
  ui.save.disabled = count === 0;
  ui.downloadJson.disabled = count === 0;
  ui.save.textContent = count > 0 ? `${count}件の要約を保存して公開` : '保存して公開';
  ui.saveInfo.textContent =
    count > 0
      ? `確認できた要約 ${count}件 を GitHub に保存します。保存後、1〜3分ほどでサイトに反映されます。`
      : '確認できた要約はまだありません。';
}

/** 品質の注意の一覧（要約の決まりに合っていない可能性がある点） */
function warningList(warnings: QualityWarning[]): HTMLElement {
  const list = el('ul', 'warn-list');
  list.setAttribute('aria-label', '要確認の点');
  list.append(...warnings.map((warning) => el('li', '', warning.message)));
  return list;
}

/**
 * 要確認の要約を AI に直してもらう手順: 直してもらうプロンプトのコピーと、直った回答の取り込み
 * （直った回答の要約で、今の回答の同じ id の要約を置き換えて、もう一度確認する）
 */
function fixBox(flagged: AcceptedSummary[]): HTMLElement {
  const box = el('div', 'fix-box');
  box.append(
    el(
      'p',
      'note',
      `要確認 ${flagged.length}件: 要約の決まり（見出しの言い換え・宣伝の言葉・中身のない定型文・推測・あいまいな日付・文体・長すぎる文など）に合っていない可能性がある点を、機械的に見つけました。記事と見比べて直したほうがよければ、「直してもらうプロンプト」をコピーして最初と同じ AI のチャットに貼り付け、直った回答をこの下に貼って「取り込む」を押してください（その要約だけが置き換わります）。そのまま保存することもできます。`,
    ),
  );
  const copy = el('button', 'small', '直してもらうプロンプトをコピー');
  copy.type = 'button';
  const input = el('textarea');
  input.rows = 5;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'AI が直した回答');
  input.placeholder = 'AI が直した回答（JSON）を貼り付け';
  const apply = el('button', 'small', '直した回答を取り込む');
  apply.type = 'button';
  const status = el('p', 'status');
  status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  actions.append(apply);
  box.append(copy, input, actions, status);

  copy.addEventListener('click', async () => {
    const prompt = buildFixPrompt(
      flagged.map((entry) => ({
        id: entry.id,
        title: findArticle(entry.id)?.article.title ?? '',
        summary: entry.summary,
        points: entry.points,
        background: entry.background,
        keywords: entry.keywords,
        issues: (entry.warnings ?? []).map((warning) => warning.message),
      })),
      promptOptions(),
    );
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus(status, `${flagged.length}件の直してもらうプロンプトをコピーしました。最初と同じ AI のチャットに貼り付けてください。`, 'ok');
    } catch {
      input.value = prompt;
      input.select();
      setStatus(status, 'コピーできなかったので、プロンプトを上の欄に入れました（Ctrl+C でコピーしてから、欄を空にして回答を貼ってください）。', 'error');
    }
  });
  apply.addEventListener('click', () => {
    try {
      const fixes = normalizeEntries(extractJson(input.value));
      const current = normalizeEntries(extractJson(ui.response.value));
      const byId = new Map(fixes.map((entry) => [entry.id, entry]));
      const merged = [...current.map((entry) => byId.get(entry.id) ?? entry), ...fixes.filter((entry) => !current.some((other) => other.id === entry.id))];
      ui.response.value = JSON.stringify(merged, null, 1);
      saveDraft();
      checkResponse({ record: false });
      setStatus(ui.saveStatus, `直した回答を取り込みました（${fixes.length}件）。内容を確かめてから保存してください。`, 'ok');
    } catch (error) {
      setStatus(status, `取り込めませんでした: ${errorText(error)}`, 'error');
    }
  });
  return box;
}

/** AI の回答を確認する。record が false なら（作業を戻したときなど）、AI が開けなかった記事の記録や自動取得の依頼はしない */
function checkResponse({ record = true }: { record?: boolean } = {}) {
  validation = undefined;
  excluded.clear();
  ui.checkResult.replaceChildren();
  setStatus(ui.saveStatus, '');
  const text = ui.response.value.trim();
  if (!text) {
    ui.checkResult.append(el('p', 'status error', 'AIの回答を貼り付けてください。'));
    renderSaveArea();
    return;
  }
  let entries;
  try {
    entries = normalizeEntries(extractJson(text));
  } catch (error) {
    ui.checkResult.append(el('p', 'status error', errorText(error)));
    renderSaveArea();
    return;
  }

  validation = validateEntries(entries, (id) => {
    const found = findArticle(id);
    return found ? { summarized: found.summarized, title: found.article.title } : undefined;
  });
  const answered = new Set(entries.map((entry) => entry.id));
  const missing = [...new Set(promptGroupsFor(answered).flat())]
    .filter((id) => !answered.has(id))
    .flatMap((id) => {
      const found = findArticle(id);
      return found ? [found.article] : [];
    });

  const flagged = validation.accepted.filter((entry) => entry.warnings?.length);
  const summary = el('div', 'result-summary');
  summary.append(
    el('span', 'badge ok', `保存できる ${validation.accepted.length}件`),
    ...(flagged.length > 0 ? [el('span', 'badge warn', `うち要確認 ${flagged.length}件`)] : []),
    el('span', 'badge', `見送り ${validation.skipped.length + missing.length}件`),
    el('span', 'badge', `エラー ${validation.errors.length}件`),
  );

  const table = el('table', 'result-table');
  const head = el('tr');
  head.append(el('th', '', '保存'), el('th', '', '記事と要約'), el('th', '', '状態'));
  table.append(head);

  for (const entry of validation.accepted) {
    const found = findArticle(entry.id)!;
    const row = el('tr');
    const include = el('td');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    box.setAttribute('aria-label', `${found.article.title} を保存する`);
    box.addEventListener('change', () => {
      if (box.checked) excluded.delete(entry.id);
      else excluded.add(entry.id);
      renderSaveArea();
    });
    include.append(box);
    const body = el('td');
    body.append(el('div', 'pick-title', found.article.title), el('div', '', entry.summary));
    if (entry.points.length > 0) {
      const points = el('ul', 'points');
      points.append(...entry.points.map((point) => el('li', '', point)));
      body.append(points);
    }
    if (entry.background) body.append(el('div', 'pick-meta', `背景: ${entry.background}`));
    if (entry.keywords?.length) body.append(el('div', 'pick-meta', `キーワード: ${entry.keywords.join('、')}`));
    if (entry.warnings?.length) body.append(warningList(entry.warnings));
    const state = `${entry.replaces ? 'OK（上書き）' : 'OK'}${entry.warnings?.length ? '・要確認' : ''}`;
    row.append(include, body, el('td', `result-state ok${entry.warnings?.length ? ' warn' : ''}`, state));
    table.append(row);
  }
  const issues = [
    ...validation.errors.map((issue) => ({ ...issue, kind: 'error' })),
    ...validation.skipped.map((issue) => ({ ...issue, kind: 'skip' })),
    ...missing.map((article) => ({ id: article.id, reason: '回答に含まれていません', kind: 'skip' })),
  ];
  for (const issue of issues) {
    const row = el('tr');
    const title = findArticle(issue.id)?.article.title ?? `id: ${issue.id}`;
    const body = el('td');
    body.append(el('div', 'pick-title', title), el('div', 'pick-meta', issue.reason));
    row.append(el('td'), body, el('td', `result-state ${issue.kind}`, issue.kind === 'error' ? 'エラー' : '見送り'));
    table.append(row);
  }
  // 要確認があれば、件数のすぐ下に直してもらう手順を出す（一覧が長くても見つけやすいように）
  ui.checkResult.append(summary, ...(flagged.length > 0 ? [fixBox(flagged)] : []), table);

  // AI が開けなかった記事を記録し、「AI が開けない記事」に移す（次からは自動で選ばない）
  const unavailable = validation.skipped.filter((issue) => issue.unavailable).map((issue) => issue.id);
  if (unavailable.length > 0 && record) {
    markUnavailable(unavailable);
    // 本文の自動取得を依頼する（本文がなく、まだ依頼していない記事）
    const refused = refusedSources();
    const toRequest = unavailable.flatMap((id) => {
      const found = findArticle(id);
      return found && !texts.has(id) && !textState(id).waiting && !refused.has(found.article.sourceId) ? [found.article] : [];
    });
    void requestTexts(toRequest);
    const note = el('div', 'unavailable-note');
    note.append(
      el(
        'p',
        'note',
        `AI が開けなかった記事 ${unavailable.length}件を「AI が開けない記事」に移し、本文の自動取得を依頼しました。数分後に本文が入ったら（入らない記事は本文を貼り付けるか、同じ話題の別の記事に切り替えて）、本文入りのプロンプトで依頼してください。`,
      ),
    );
    const go = el('button', 'small', '「AI が開けない記事」を開く');
    go.type = 'button';
    go.addEventListener('click', () => openPasteCard());
    note.append(go);
    ui.checkResult.append(note);
  }
  renderSaveArea();
}

// ===== 4. 保存（GitHub に1つのコミットとして保存） =====

function githubClient() {
  if (!data) throw new Error('記事データを読み込めていません');
  if (!token) throw new Error('ログインし直してください');
  return createGitHubClient(token, data.repository);
}

/** 追加・削除をファイルごとにまとめてコミットする */
async function commitSummaries(additions: SummaryRecord[], removals: AdminSummary[], message: string) {
  const client = githubClient();
  const { defaultBranch, canPush } = await client.repository();
  if (!canPush) throw new Error('このトークンには書き込み権限がありません（Contents の Read and write が必要です）');
  const addGroups = groupByFile(additions);
  const removeGroups = groupByFile(removals);
  const paths = new Set([...addGroups.keys(), ...removeGroups.keys()]);
  const result = await client.commitFiles(defaultBranch, message, async (read) => {
    const changes = [];
    for (const path of paths) {
      const current = parseSummaryFile(await read(path));
      const merged = mergeSummaryRecords(
        current,
        addGroups.get(path) ?? [],
        (removeGroups.get(path) ?? []).map((record) => record.id),
      );
      changes.push({ path, content: serializeSummaryFile(merged) });
    }
    return changes;
  });
  return { ...result, branch: defaultBranch };
}

function actionsLink(): HTMLAnchorElement {
  const link = el('a', '', '公開の進み具合（GitHub Actions）');
  link.href = `https://github.com/${data!.repository.owner}/${data!.repository.repo}/actions`;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

async function saveSummaries() {
  const toSave = acceptedToSave();
  if (toSave.length === 0) return;
  const now = new Date();
  const records = toSave.map(({ accepted, article }) => toSummaryRecord(article, accepted, now));
  ui.save.disabled = true;
  setStatus(ui.saveStatus, `${records.length}件を保存しています…`);
  try {
    const { changed } = await commitSummaries(records, [], `要約を追加（${records.length}件）`);
    addMarks(KEYS.saved, records.map((record) => record.id));
    clearPasted(records.map((record) => record.id));
    // 作り直した要約は、サイトに反映されるまで「保存済みの要約」に新しい内容を出す
    for (const record of records) {
      if (!findArticle(record.id)?.summarized) continue;
      saveEdit(record.id, {
        summary: record.summary,
        points: record.points,
        background: record.background ?? '',
        keywords: record.keywords ?? [],
      });
    }
    setStatus(
      ui.saveStatus,
      changed
        ? `${records.length}件の要約を保存しました。1〜3分ほどでサイトに反映されます。`
        : '変更はありませんでした（同じ内容が保存済みです）。',
      'ok',
    );
    ui.saveStatus.append(' ', actionsLink());
    ui.response.value = '';
    validation = undefined;
    ui.checkResult.replaceChildren();
    autoSelect();
    renderPickList();
    renderPrompt();
    renderSavedList();
  } catch (error) {
    setStatus(ui.saveStatus, `保存できませんでした: ${errorText(error)}`, 'error');
  } finally {
    renderSaveArea();
  }
}

function downloadRecords() {
  const now = new Date();
  const records = acceptedToSave().map(({ accepted, article }) => toSummaryRecord(article, accepted, now));
  download(`summaries-${stamp()}.json`, `${JSON.stringify(records, null, 1)}\n`, 'application/json');
}

// ===== 保存済みの要約（削除） =====

type StoredEdit = SummaryEdit & { at: number };

/** 手直しした要約（サイトに反映されるまでの間、画面に手直し後の内容を出すため） */
function readEdits(): Map<string, StoredEdit> {
  try {
    const entries = JSON.parse(storage.get(KEYS.edited) ?? '[]') as [string, StoredEdit][];
    return new Map(entries.filter(([, edit]) => Date.now() - edit.at < HIDE_FOR));
  } catch {
    return new Map();
  }
}

function saveEdit(id: string, edit: SummaryEdit) {
  const edits = readEdits();
  edits.set(id, { ...edit, at: Date.now() });
  storage.set(KEYS.edited, JSON.stringify([...edits]));
}

/** 保存済みの要約（手直しした内容を反映したもの） */
function savedSummaries(): AdminSummary[] {
  if (!data) return [];
  const deleted = readMarks(KEYS.deleted);
  const edits = readEdits();
  return data.summarized
    .filter((record) => !deleted.has(record.id))
    .map((record) => {
      const edit = edits.get(record.id);
      return edit
        ? {
            ...record,
            summary: edit.summary,
            points: edit.points,
            background: edit.background ?? record.background,
            keywords: edit.keywords ?? record.keywords,
          }
        : record;
    });
}

/** 1件の要約を手直しして保存する（最新のファイルを読み直し、その要約だけを書き換える） */
async function commitSummaryEdit(record: AdminSummary, edit: SummaryEdit) {
  const client = githubClient();
  const { defaultBranch, canPush } = await client.repository();
  if (!canPush) throw new Error('このトークンには書き込み権限がありません（Contents の Read and write が必要です）');
  const path = summaryFilePath(record.publishedAt);
  return client.commitFiles(defaultBranch, `要約を修正: ${Array.from(record.title).slice(0, 40).join('')}`, async (read) => {
    const current = parseSummaryFile(await read(path));
    const target = current.find((other) => other.id === record.id);
    if (!target) throw new Error('この要約が見つかりません（削除されたか、まだサイトに反映されていない可能性があります）');
    const updated = editSummaryRecord(target, edit, new Date());
    return [{ path, content: serializeSummaryFile(mergeSummaryRecords(current, [updated])) }];
  });
}

/** 要約の編集フォーム */
function summaryEditor(record: AdminSummary, onSaved: () => void): HTMLElement {
  const editor = el('div', 'editor');
  const summaryField = el('label', 'field');
  const summaryCount = el('span', 'note');
  const summaryInput = el('textarea');
  summaryInput.rows = 5;
  summaryInput.value = record.summary;
  const summaryHead = el('span');
  summaryHead.append('要約', summaryCount);
  summaryField.append(summaryHead, summaryInput);
  const pointsField = el('label', 'field');
  const pointsInput = el('textarea');
  pointsInput.rows = 3;
  pointsInput.value = record.points.join('\n');
  const pointsHead = el('span');
  pointsHead.append('要点（1行に1つ。空欄なら要点なし）');
  pointsField.append(pointsHead, pointsInput);
  const backgroundField = el('label', 'field');
  const backgroundInput = el('textarea');
  backgroundInput.rows = 2;
  backgroundInput.value = record.background ?? '';
  const backgroundHead = el('span');
  backgroundHead.append('背景・用語の説明（空欄なら表示しない）');
  backgroundField.append(backgroundHead, backgroundInput);
  const keywordsField = el('label', 'field');
  const keywordsInput = el('input');
  keywordsInput.value = (record.keywords ?? []).join('、');
  const keywordsHead = el('span');
  keywordsHead.append('キーワード（「、」で区切る）');
  keywordsField.append(keywordsHead, keywordsInput);
  const status = el('p', 'status');
  const save = el('button', 'primary small', '保存して反映');
  save.type = 'button';
  const cancel = el('button', 'ghost small', 'キャンセル');
  cancel.type = 'button';
  const actions = el('div', 'actions');
  actions.append(save, cancel);
  // 書いている要約の注意（要約の決まりに合っていない可能性がある点）
  const warnArea = el('div', 'editor-warnings');
  warnArea.setAttribute('aria-live', 'polite');
  editor.append(summaryField, pointsField, backgroundField, keywordsField, warnArea, actions, status);

  const updateCount = () => (summaryCount.textContent = `${Array.from(summaryInput.value.trim()).length}字`);
  const updateWarnings = () => {
    const current = summaryWarnings(
      { summary: summaryInput.value, points: pointsInput.value.split('\n').map((line) => line.trim()).filter(Boolean), background: backgroundInput.value },
      { title: record.title },
    );
    warnArea.replaceChildren(...(current.length > 0 ? [warningList(current)] : []));
  };
  summaryInput.addEventListener('input', updateCount);
  for (const input of [summaryInput, pointsInput, backgroundInput]) input.addEventListener('input', updateWarnings);
  updateCount();
  updateWarnings();
  cancel.addEventListener('click', () => editor.remove());
  save.addEventListener('click', async () => {
    const points = pointsInput.value.split('\n').map((line) => line.trim()).filter(Boolean);
    const keywords = keywordsInput.value.split(/[、,，]/).map((keyword) => keyword.trim()).filter(Boolean);
    // AI の回答と同じ基準で確かめる（断り文の判定はしない）
    const checked = validateEntries(
      [{ id: record.id, status: 'ok', summary: summaryInput.value, points, background: backgroundInput.value, keywords }],
      () => ({ summarized: true, title: record.title }),
      { checkRefusal: false },
    );
    const accepted = checked.accepted[0];
    if (!accepted) {
      setStatus(status, [...checked.errors, ...checked.skipped][0]?.reason ?? '保存できない内容です', 'error');
      return;
    }
    save.disabled = true;
    setStatus(status, '保存しています…');
    try {
      // 空にした背景・キーワードは項目ごと消す
      const edit: SummaryEdit = {
        summary: accepted.summary,
        points: accepted.points,
        background: accepted.background ?? '',
        keywords: accepted.keywords ?? [],
      };
      const { changed } = await commitSummaryEdit(record, edit);
      saveEdit(record.id, edit);
      setStatus(status, changed ? '保存しました。1〜3分ほどでサイトに反映されます。' : '変更はありませんでした。', 'ok');
      setTimeout(onSaved, 1200);
    } catch (error) {
      setStatus(status, `保存できませんでした: ${errorText(error)}`, 'error');
      save.disabled = false;
    }
  });
  return editor;
}

/** AI が自動で作り、まだ手直ししていない要約か（手直し済み（反映待ち）のものも除く） */
function isUnreviewedAuto(record: AdminSummary): boolean {
  return Boolean(record.generator) && !record.updatedAt && !readEdits().has(record.id);
}

/** 自動要約の問題の説明（運営者がすること） */
function autoProblemText(problem: NonNullable<AutoSummaryState['problem']>): string {
  if (problem.kind === 'auth') {
    return `Workers AI を使う権限がないため、自動要約が止まっています。README の「AI の自動要約」の手順で Workers AI の権限のある API トークンを作り、GitHub の Secrets に CLOUDFLARE_AI_TOKEN として登録してください。詳細: ${problem.message}`;
  }
  if (problem.kind === 'quota') return `今日の無料枠を使い切ったため止めています。日本時間の9時（UTC の0時）に無料枠が戻ると再開します。詳細: ${problem.message}`;
  return `${problem.message}。続くようなら、変数 AUTO_SUMMARY_MODEL で別のモデルを選ぶか、README の「AI の自動要約」を確認してください。`;
}

/** AI の自動要約の状況（毎時の更新で記録したもの。サイトのビルドのときの内容） */
function renderAutoSummary() {
  if (!data) return;
  const status = data.autoSummary;
  if (!status) {
    ui.autoBadge.textContent = '記録なし';
    ui.autoStatus.replaceChildren(
      el('li', '', 'まだ自動要約の記録がありません。毎時の更新で動き始めます（Cloudflare の Secrets がないときや、変数 AUTO_SUMMARY_PER_RUN が 0 のときは動きません）。'),
    );
    return;
  }
  const rows: HTMLElement[] = [];
  if (status.problem) rows.push(el('li', 'warn', `${dateFormat.format(new Date(status.problem.at))} ${autoProblemText(status.problem)}`));
  if (status.lastRun) {
    const { at, saved, tried, message } = status.lastRun;
    rows.push(el('li', '', `最後の実行: ${dateFormat.format(new Date(at))}（保存 ${saved}件・AI に依頼 ${tried}件${message ? `。${message}` : ''}）`));
  }
  rows.push(
    el(
      'li',
      '',
      `今日（日本時間の9時に切り替わり）: 保存 ${status.saved}件・使った量の見積もり ${status.neurons.toLocaleString('ja-JP')} / ${status.freeNeurons.toLocaleString('ja-JP')}ニューロン（無料枠）`,
    ),
  );
  if (status.recent.length > 0) rows.push(el('li', '', `直近24時間に試した記事: ${status.recent.map((entry) => `${entry.label} ${entry.count}件`).join('・')}`));
  ui.autoStatus.replaceChildren(...rows);
  ui.autoBadge.textContent = status.problem?.kind === 'auth' ? '要対応' : `今日 ${status.saved}件`;
  ui.autoBadge.className = `badge${status.problem?.kind === 'auth' ? '' : ' ok'}`;
  ui.autoBadge.style.color = status.problem?.kind === 'auth' ? 'var(--hot)' : '';
}

function renderSavedList() {
  if (!data) return;
  const all = savedSummaries();
  // 要約の決まりに合っていない可能性がある点（保存済みの要約にも同じ確認をする）
  const warnings = new Map(all.map((record) => [record.id, summaryWarnings(record, { title: record.title })]));
  const flagged = all.filter((record) => (warnings.get(record.id) ?? []).length > 0);
  const query = ui.savedFilter.value.trim().toLowerCase();
  const automatic = all.filter(isUnreviewedAuto);
  const list = (ui.savedWarnOnly.checked ? flagged : all).filter(
    (record) =>
      (!ui.savedAutoOnly.checked || isUnreviewedAuto(record)) &&
      (!query || `${record.title} ${record.summary} ${record.points.join(' ')}`.toLowerCase().includes(query)),
  );
  ui.savedCount.textContent = `${all.length}件`;
  ui.savedWarnCount.textContent = String(flagged.length);
  ui.savedAutoCount.textContent = String(automatic.length);
  const checked = new Set<string>();
  const sync = () => {
    ui.deleteSelected.disabled = checked.size === 0;
    ui.deleteSelected.textContent = checked.size > 0 ? `選んだ${checked.size}件の要約を削除` : '選んだ要約を削除';
  };
  const edits = readEdits();
  ui.savedList.replaceChildren(
    ...list.map((record) => {
      const item = el('li', 'saved-row');
      const label = el('label');
      const box = el('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', `${record.title} の要約を削除する`);
      box.addEventListener('change', () => {
        if (box.checked) checked.add(record.id);
        else checked.delete(record.id);
        sync();
      });
      const meta = el('span', 'pick-meta', `${articleMeta(record)} ・ 要約 ${dateFormat.format(new Date(record.summarizedAt))}`);
      if (edits.has(record.id)) meta.append(el('span', 'badge-inline', '手直し済み（反映待ち）'));
      if (record.generator) {
        const badge = el('span', 'badge-inline', record.updatedAt ? '自動・手直し済み' : '自動');
        badge.title = `AI（${record.generator}）が自動で作った要約`;
        meta.append(badge);
      }
      const recordWarnings = warnings.get(record.id) ?? [];
      if (recordWarnings.length > 0) meta.append(el('span', 'badge-inline warn', '要確認'));
      label.append(box, el('span', 'pick-title', record.title), meta, el('span', 'pick-summary', record.summary));
      if (record.points.length > 0) label.append(el('span', 'pick-summary', record.points.map((point) => `・${point}`).join(' ')));
      if (record.background) label.append(el('span', 'pick-meta', `背景: ${record.background}`));
      if (record.keywords?.length) label.append(el('span', 'pick-meta', `キーワード: ${record.keywords.join('、')}`));
      if (recordWarnings.length > 0) label.append(warningList(recordWarnings));
      const editButton = el('button', 'ghost small edit-button', '編集');
      editButton.type = 'button';
      editButton.setAttribute('aria-label', `${record.title} の要約を編集`);
      editButton.addEventListener('click', () => {
        const open = item.querySelector('.editor');
        if (open) {
          open.remove();
          return;
        }
        item.append(summaryEditor(record, renderSavedList));
        item.querySelector('textarea')?.focus();
      });
      item.append(label, editButton);
      return item;
    }),
  );
  if (list.length === 0) {
    ui.savedList.append(
      el(
        'li',
        'pick-meta',
        all.length === 0
          ? '保存済みの要約はまだありません。'
          : ui.savedWarnOnly.checked && flagged.length === 0
            ? '要確認の要約はありません。'
            : ui.savedAutoOnly.checked && automatic.length === 0
              ? 'AI が自動で作り、まだ手直ししていない要約はありません。'
              : '条件に合う要約はありません。',
      ),
    );
  }
  sync();

  ui.deleteSelected.onclick = async () => {
    const targets = list.filter((record) => checked.has(record.id));
    if (targets.length === 0 || !confirm(`${targets.length}件の要約を削除します。よろしいですか？`)) return;
    ui.deleteSelected.disabled = true;
    setStatus(ui.deleteStatus, '削除しています…');
    try {
      await commitSummaries([], targets, `要約を削除（${targets.length}件）`);
      addMarks(KEYS.deleted, targets.map((record) => record.id));
      setStatus(ui.deleteStatus, `${targets.length}件の要約を削除しました。1〜3分ほどでサイトに反映されます。`, 'ok');
      renderSavedList();
      renderPickList();
    } catch (error) {
      setStatus(ui.deleteStatus, `削除できませんでした: ${errorText(error)}`, 'error');
      sync();
    }
  };
}

// ===== 収集元の状況 =====

function renderSources() {
  if (!data?.sources) return;
  const now = Date.now();
  const days = (iso: string | null) => (iso ? Math.floor((now - Date.parse(iso)) / (24 * 60 * 60 * 1000)) : Infinity);
  /** 確認が必要か（取得の失敗が続いている、または新しい記事が長く出ていない） */
  const trouble = (source: SourceStat) => (source.failures ?? 0) >= SOURCE_FAILURE_ALERT || days(source.latest) >= SOURCE_STALE_DAYS;
  const sources = [...data.sources].sort(
    (a, b) =>
      Number(trouble(b)) - Number(trouble(a)) ||
      (b.failures ?? 0) - (a.failures ?? 0) ||
      days(b.latest) - days(a.latest) ||
      a.name.localeCompare(b.name, 'ja'),
  );
  const troubled = sources.filter(trouble);
  const badge = $('sources-badge');
  badge.textContent = troubled.length > 0 ? `${troubled.length}件 要確認` : `${sources.length}件 正常`;
  badge.className = `badge${troubled.length > 0 ? '' : ' ok'}`;
  if (troubled.length > 0) badge.style.color = 'var(--hot)';
  const head = el('tr');
  head.append(el('th', '', '収集元'), el('th', '', '状態'), el('th', '', '記事数'), el('th', '', '最新の記事'));
  const rows = sources.map((source) => {
    const row = el('tr');
    const name = el('td');
    const link = el('a', '', source.name);
    link.href = source.siteUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    name.append(link, el('div', 'pick-meta', categoryName(source.category)));
    const failures = source.failures ?? 0;
    const state = el(
      'td',
      failures > 0 ? 'result-state error' : '',
      failures > 0
        ? `取得失敗 ${failures}回連続${source.error ? `（${source.error}）` : ''}`
        : source.okAt
          ? `正常（${dateFormat.format(new Date(source.okAt))} 取得）`
          : '—',
    );
    const age = days(source.latest);
    const latest = el(
      'td',
      `num${age >= SOURCE_STALE_DAYS ? ' result-state error' : ''}`,
      source.latest ? `${dateFormat.format(new Date(source.latest))}${age >= SOURCE_STALE_DAYS ? `（${age}日前）` : ''}` : 'なし',
    );
    row.append(name, state, el('td', 'num', `${source.count}件`), latest);
    return row;
  });
  $('sources-table').replaceChildren(head, ...rows);
}

// ===== 記事の非表示（data/blocklist.json） =====

/** 非表示の設定を最新の状態から読み直して変更し、1つのコミットで保存する */
async function updateBlocklist(change: (current: Blocklist) => Blocklist, message: string) {
  const client = githubClient();
  const { defaultBranch, canPush } = await client.repository();
  if (!canPush) throw new Error('このトークンには書き込み権限がありません（Contents の Read and write が必要です）');
  return client.commitFiles(defaultBranch, message, async (read) => {
    const current = parseBlocklist(await read(BLOCKLIST_PATH));
    const content = serializeBlocklist(change(current));
    return content === serializeBlocklist(current) ? [] : [{ path: BLOCKLIST_PATH, content }];
  });
}

async function hideSelectedArticles() {
  const ids = [...selected];
  if (ids.length === 0) {
    setStatus(ui.hideStatus, '非表示にする記事にチェックを入れてください。', 'error');
    return;
  }
  if (!confirm(`チェックした${ids.length}件の記事をサイトから非表示にします。よろしいですか？`)) return;
  ui.hideSelected.disabled = true;
  setStatus(ui.hideStatus, '保存しています…');
  try {
    await updateBlocklist((current) => ({ ...current, ids: [...current.ids, ...ids] }), `記事を非表示（${ids.length}件）`);
    addMarks(KEYS.hidden, ids);
    removeMarks(KEYS.unhidden, ids);
    setStatus(ui.hideStatus, `${ids.length}件を非表示にしました。1〜3分ほどでサイトに反映されます。`, 'ok');
    autoSelect();
    renderPickList();
    renderPrompt();
    renderHiddenList();
  } catch (error) {
    setStatus(ui.hideStatus, `非表示にできませんでした: ${errorText(error)}`, 'error');
  } finally {
    ui.hideSelected.disabled = false;
  }
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

async function saveBlocklistSettings() {
  const words = lines(ui.blockWords.value);
  const hostLines = lines(ui.blockHosts.value);
  const invalid = hostLines.filter((line) => !normalizeHost(line));
  if (invalid.length > 0) {
    setStatus(ui.blocklistStatus, `サイトの書き方が正しくありません: ${invalid.join('、')}`, 'error');
    return;
  }
  const hosts = hostLines.map(normalizeHost);
  ui.saveBlocklist.disabled = true;
  setStatus(ui.blocklistStatus, '保存しています…');
  try {
    const { changed } = await updateBlocklist((current) => ({ ...current, words, hosts }), 'NGワード・非表示サイトを更新');
    setStatus(
      ui.blocklistStatus,
      changed ? '保存しました。1〜3分ほどでサイトに反映されます。' : '変更はありませんでした。',
      'ok',
    );
  } catch (error) {
    setStatus(ui.blocklistStatus, `保存できませんでした: ${errorText(error)}`, 'error');
  } finally {
    ui.saveBlocklist.disabled = false;
  }
}

function renderHiddenList() {
  if (!data) return;
  const unhidden = readMarks(KEYS.unhidden);
  const justHidden = readMarks(KEYS.hidden);
  const known = new Set((data.hidden ?? []).map((article) => article.id));
  const list: HiddenArticle[] = [
    ...data.pending
      .filter((article) => justHidden.has(article.id) && !known.has(article.id))
      .map((article) => ({ ...article, reason: '個別に非表示（反映待ち）' })),
    ...(data.hidden ?? []).filter((article) => !unhidden.has(article.id)),
  ];
  ui.hiddenCount.textContent = `${list.length}件`;
  const checked = new Set<string>();
  const sync = () => {
    ui.unhideSelected.disabled = checked.size === 0;
    ui.unhideSelected.textContent = checked.size > 0 ? `選んだ${checked.size}件を再表示` : '選んだ記事を再表示';
  };
  ui.hiddenList.replaceChildren(
    ...list.map((article) => {
      const item = el('li');
      const label = el('label');
      // NGワード・サイトで外れている記事は、その設定を消すと戻る（ここでは個別に非表示にした記事だけ戻せる）
      const individual = article.reason.startsWith('個別');
      const box = el('input');
      box.type = 'checkbox';
      box.disabled = !individual;
      box.setAttribute('aria-label', `${article.title} を再表示する`);
      box.addEventListener('change', () => {
        if (box.checked) checked.add(article.id);
        else checked.delete(article.id);
        sync();
      });
      label.append(
        box,
        el('span', 'pick-title', article.title),
        el('span', 'pick-meta', articleMeta(article)),
        el('span', 'pick-reason', article.reason),
      );
      item.append(label);
      return item;
    }),
  );
  if (list.length === 0) ui.hiddenList.append(el('li', 'pick-meta', '非表示の記事はありません。'));
  sync();

  ui.unhideSelected.onclick = async () => {
    const ids = [...checked];
    if (ids.length === 0) return;
    ui.unhideSelected.disabled = true;
    setStatus(ui.unhideStatus, '保存しています…');
    try {
      await updateBlocklist(
        (current) => ({ ...current, ids: current.ids.filter((id) => !ids.includes(id)) }),
        `記事の非表示を解除（${ids.length}件）`,
      );
      addMarks(KEYS.unhidden, ids);
      removeMarks(KEYS.hidden, ids);
      setStatus(ui.unhideStatus, `${ids.length}件を再表示しました。1〜3分ほどでサイトに反映されます。`, 'ok');
      renderHiddenList();
    } catch (error) {
      setStatus(ui.unhideStatus, `再表示できませんでした: ${errorText(error)}`, 'error');
      sync();
    }
  };
}

function setupBlocklist() {
  const list = data?.blocklist ?? emptyBlocklist();
  ui.blockWords.value = list.words.join('\n');
  ui.blockHosts.value = list.hosts.join('\n');
  ui.hideSelected.addEventListener('click', hideSelectedArticles);
  ui.saveBlocklist.addEventListener('click', saveBlocklistSettings);
  renderHiddenList();
}

// ===== よく読まれている記事（アクセス解析） =====

/** 記事ごとの読まれた人数（直近7日）を読み込み、要約の候補の並びと表示に使う（選んだ記事はそのまま） */
async function loadReadCounts() {
  if (!analyticsEndpoint || !token) return;
  try {
    const res = await fetch(`${analyticsEndpoint}/admin/articles?days=7`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { items?: { id?: unknown; n?: unknown }[] };
    readCounts = new Map(
      (body.items ?? []).flatMap((item) => (typeof item.id === 'string' && typeof item.n === 'number' ? [[item.id, item.n] as const] : [])),
    );
    renderPickList();
  } catch {
    // アクセス解析が使えなくても、要約の作業には影響させない
  }
}

// ===== 起動 =====

async function main() {
  // ログインしていなければログインページへ（ログイン中だけ管理画面を表示する）
  const session = requireSession();
  if (!session) return;
  token = session.token;
  textKey = session.textKey;
  watchSession(session);
  root.hidden = false;

  // アクセス解析が使えるときだけ「よく読まれている順」を選べるようにする
  const readOption = ui.sort.querySelector<HTMLOptionElement>('option[value="read"]');
  if (readOption && analyticsEndpoint) {
    readOption.hidden = false;
    readOption.disabled = false;
  }
  restoreOptions();
  setupPaste();
  try {
    const res = await fetch(`${base}/admin/data.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as AdminData;
  } catch (error) {
    ui.dataInfo.textContent = `記事データを読み込めませんでした（${errorText(error)}）`;
    return;
  }
  ui.dataInfo.textContent = `記事データ: ${dateFormat.format(new Date(data.generatedAt))} 時点（要約待ち ${data.pending.length}件 ・ 要約済み ${data.summarized.length}件）`;
  // 毎時の更新が止まっていたら知らせる（GitHub の定期実行は遅れたり止まったりすることがある）
  const hours = Math.floor((Date.now() - Date.parse(data.generatedAt)) / (60 * 60 * 1000));
  if (hours >= STALE_HOURS) {
    ui.dataInfo.after(
      el(
        'p',
        'stale-warning',
        `サイトが${hours}時間以上更新されていません。定期実行が止まっている可能性があります。「概要」のページの「今すぐ更新」で更新できます。`,
      ),
    );
  }
  ui.category.append(
    ...data.categories.map((category) => {
      const option = el('option', '', category.name);
      option.value = category.slug;
      return option;
    }),
  );

  const refresh = () => {
    autoSelect();
    renderPickList();
    renderPrompt();
  };
  ui.count.addEventListener('change', refresh);
  ui.includeSummarized.addEventListener('change', refresh);
  ui.savedFilter.addEventListener('input', renderSavedList);
  ui.savedWarnOnly.addEventListener('change', renderSavedList);
  ui.savedAutoOnly.addEventListener('change', renderSavedList);
  ui.category.addEventListener('change', refresh);
  ui.sort.addEventListener('change', refresh);
  $('reselect').addEventListener('click', refresh);
  const rerenderPrompts = () => {
    renderPrompt();
    renderPastePrompt();
  };
  ui.length.addEventListener('change', rerenderPrompts);
  ui.points.addEventListener('change', rerenderPrompts);
  ui.maxChars.addEventListener('change', rerenderPrompts);
  ui.answerMode.addEventListener('change', rerenderPrompts);
  setupPanel(promptPanel, $<HTMLButtonElement>('copy-prompt'), $<HTMLButtonElement>('download-prompt'));
  $('check').addEventListener('click', () => checkResponse());
  $('response-file-button').addEventListener('click', () => ui.responseFile.click());
  ui.responseFile.addEventListener('change', () => {
    if (ui.responseFile.files?.length) void loadResponseFiles(ui.responseFile.files);
    ui.responseFile.value = '';
  });
  acceptDroppedFiles(ui.response, loadResponseFiles);
  ui.response.addEventListener('input', saveDraft);
  $('clear-response').addEventListener('click', () => {
    ui.response.value = '';
    validation = undefined;
    ui.checkResult.replaceChildren();
    renderSaveArea();
    saveDraft();
  });
  ui.save.addEventListener('click', saveSummaries);
  ui.downloadJson.addEventListener('click', downloadRecords);

  if (restoreDraft()) {
    renderPickList();
    renderPrompt();
    if (texts.size > 0) ui.pasteCard.open = true;
    ui.dataInfo.after(
      el('p', 'note', `前回の作業（選んだ記事 ${selected.size}件${ui.response.value.trim() ? '・貼り付けた回答' : ''}）を戻しました。`),
    );
    if (ui.response.value.trim()) checkResponse({ record: false });
  } else {
    refresh();
  }
  renderPasteList();
  void loadReadCounts();
  void ensureTextKey();
  void loadTexts();
  if (!textKey) {
    setStatus($('auto-text-status'), '本文の自動取得を使うには、いったんログアウトしてログインし直してください（本文を読むための鍵を作ります）。');
  }
  renderAutoSummary();
  renderSavedList();
  renderSaveArea();
  setupBlocklist();
  renderSources();
  // 「概要」などからのリンク（#sources-card・#blocklist-card）で開いたときは、その欄を開いて見せる
  openLinkedCard();
  window.addEventListener('hashchange', openLinkedCard);
}

/** ページ内のリンク（#sources-card など）の欄が閉じていれば開いて、そこまで動かす */
function openLinkedCard() {
  if (!/^#[a-z-]+$/.test(location.hash)) return;
  const target = document.querySelector(location.hash);
  if (target instanceof HTMLDetailsElement) target.open = true;
  target?.scrollIntoView();
}

void main();
