// 管理画面（/admin/）: 要約待ちの記事を選んでプロンプトを作り、AI の回答を検証して GitHub に保存する。
// サイトの更新（GitHub Actions の実行）もここから行う
import {
  BLOCKLIST_PATH,
  emptyBlocklist,
  normalizeHost,
  parseBlocklist,
  serializeBlocklist,
  type Blocklist,
} from '../lib/blocklist-core.ts';
import { createGitHubClient, GitHubError, type Repository, type WorkflowRun } from '../lib/github-commit.ts';
import {
  ARTICLE_TEXT_MAX,
  buildSummaryPrompt,
  comparePastedUrl,
  editSummaryRecord,
  extractJson,
  groupByFile,
  mergeSummaryRecords,
  normalizeEntries,
  parsePastedText,
  parseSummaryFile,
  serializeSummaryFile,
  summaryFilePath,
  toSummaryRecord,
  validateEntries,
  type AcceptedSummary,
  type SummaryEdit,
  type SummaryLength,
  type ValidationResult,
} from '../lib/summary-core.ts';
import type { Item, SummaryRecord } from '../lib/types.ts';
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
  tokenBadge: $('token-badge'),
  tokenStatus: $('token-status'),
  repoName: $('repo-name'),
  count: $<HTMLSelectElement>('count'),
  category: $<HTMLSelectElement>('category'),
  sort: $<HTMLSelectElement>('sort'),
  counter: $('pick-counter'),
  pickList: $<HTMLUListElement>('pick-list'),
  length: $<HTMLSelectElement>('length'),
  points: $<HTMLInputElement>('points'),
  prompt: $<HTMLTextAreaElement>('prompt'),
  promptInfo: $('prompt-info'),
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
  runUpdate: $<HTMLButtonElement>('run-update'),
  runStatus: $('run-status'),
  runList: $<HTMLUListElement>('run-list'),
  pasteCard: $<HTMLDetailsElement>('paste-card'),
  pasteCount: $('paste-count'),
  pasteList: $<HTMLUListElement>('paste-list'),
  pasteFlagged: $('paste-flagged'),
  pasteStatus: $('paste-status'),
  selectPasted: $<HTMLButtonElement>('select-pasted'),
  includeSummarized: $<HTMLInputElement>('include-summarized'),
  savedFilter: $<HTMLInputElement>('saved-filter'),
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

const categoryName = (slug: string) => data?.categories.find((c) => c.slug === slug)?.name ?? slug;

function articleMeta(article: AdminArticle): string {
  return [
    article.site,
    categoryName(article.category),
    dateFormat.format(new Date(article.publishedAt)),
    article.coverage ? `${article.coverage}社が報道` : '',
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
  const sorted =
    ui.sort.value === 'latest'
      ? list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      : list.sort((a, b) => (b.coverage ?? 1) - (a.coverage ?? 1) || b.publishedAt.localeCompare(a.publishedAt));
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
    skipped > 0 ? `AI が開けない記事 ${skipped}件は自動では選びません` : '',
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

/** この字数を超えるプロンプトは、チャット AI に貼り付けられないことがある */
const PROMPT_WARN_CHARS = 30_000;

function renderPrompt() {
  if (!data) return;
  batch = selectedArticles();
  saveDraft();
  if (batch.length === 0) {
    ui.prompt.value = '';
    ui.promptInfo.textContent = '記事を選ぶとプロンプトが表示されます';
    ui.promptInfo.className = 'note';
    return;
  }
  ui.prompt.value = buildSummaryPrompt(
    batch.map(({ id, title, url, site, excerpt }) => ({ id, title, url, site, excerpt, text: texts.get(id) })),
    { siteName: data.siteName, length: ui.length.value as SummaryLength, points: ui.points.checked },
  );
  const withText = batch.filter((article) => texts.has(article.id)).length;
  const long = ui.prompt.value.length > PROMPT_WARN_CHARS;
  ui.promptInfo.textContent = [
    `${batch.length}件${withText > 0 ? `（本文あり ${withText}件）` : ''} ・ ${ui.prompt.value.length.toLocaleString()}字`,
    long ? '長すぎると AI に貼り付けられなかったり回答が途中で切れたりします。記事を減らしてください' : '',
  ]
    .filter(Boolean)
    .join(' ・ ');
  ui.promptInfo.className = long ? 'note warn' : 'note';
  saveOptions();
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

/** 本文を貼るまで自動では選ばない記事か（AI が開けなかった記事と、開けないことが多いサイトの記事） */
function aiBlocked(): (article: AdminArticle) => boolean {
  const marks = readUnavailable();
  const flagged = flaggedSources(marks);
  return (article) => !texts.has(article.id) && (marks.has(article.id) || flagged.has(article.sourceId));
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
  selected.add(id);
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
  /** 本文を読み取って表示を更新する。貼り付けたとき（pasted）は、その記事を選ぶ */
  const update = (pasted: boolean) => {
    const parsed = parsePastedText(area.value);
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
      ? [`本文 ${length.toLocaleString()}字（AI は URL を開かずに、この本文から要約します）。`, ...warnings].join(' ')
      : '本文はまだありません（このままでは AI が URL を開こうとします）。';
    info.className = warnings.length > 0 ? 'paste-info warn' : 'paste-info';
    ui.selectPasted.disabled = texts.size === 0;
    if (pasted && parsed.text && !selected.has(article.id)) {
      selected.add(article.id);
      syncPickList();
    }
  };
  area.addEventListener('input', () => {
    update(true);
    renderPrompt();
  });
  update(false);

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
  item.append(title, meta, area, info, actions);
  return item;
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
  ui.selectPasted.disabled = texts.size === 0;

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

function setupPaste() {
  ui.selectPasted.addEventListener('click', () => {
    const ids = [...texts.keys()].filter((id) => findArticle(id));
    if (ids.length === 0) return;
    selected.clear();
    for (const id of ids) selected.add(id);
    syncPickList();
    renderPrompt();
    setStatus(ui.pasteStatus, `本文を貼った${ids.length}件を選びました。手順2のプロンプトをコピーしてください。`, 'ok');
  });
  // ブックマークレットは管理画面では動かない（ブックマークバーに登録して記事のページで使う）
  $('bookmarklet').addEventListener('click', (event) => {
    event.preventDefault();
    setStatus(ui.pasteStatus, 'このボタンはブックマークバーにドラッグして登録し、記事のページを開いてから押してください。');
  });
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

function checkResponse() {
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
    return found ? { summarized: found.summarized } : undefined;
  });
  const answered = new Set(entries.map((entry) => entry.id));
  const missing = batch.filter((article) => !answered.has(article.id));

  const summary = el('div', 'result-summary');
  summary.append(
    el('span', 'badge ok', `保存できる ${validation.accepted.length}件`),
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
    row.append(include, body, el('td', 'result-state ok', entry.replaces ? 'OK（上書き）' : 'OK'));
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
  ui.checkResult.append(summary, table);

  // AI が開けなかった記事を記録し、「AI が開けない記事」に移す（次からは自動で選ばない）
  const unavailable = validation.skipped.filter((issue) => issue.unavailable).map((issue) => issue.id);
  if (unavailable.length > 0) {
    markUnavailable(unavailable);
    const note = el('div', 'unavailable-note');
    note.append(
      el(
        'p',
        'note',
        `AI が開けなかった記事 ${unavailable.length}件を「AI が開けない記事」に移しました。保存のあと、本文を貼り付けるか、同じ話題の別の記事に切り替えて、もう一度プロンプトを作ってください。`,
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
  editor.append(summaryField, pointsField, backgroundField, keywordsField, actions, status);

  const updateCount = () => (summaryCount.textContent = `${Array.from(summaryInput.value.trim()).length}字`);
  summaryInput.addEventListener('input', updateCount);
  updateCount();
  cancel.addEventListener('click', () => editor.remove());
  save.addEventListener('click', async () => {
    const points = pointsInput.value.split('\n').map((line) => line.trim()).filter(Boolean);
    const keywords = keywordsInput.value.split(/[、,，]/).map((keyword) => keyword.trim()).filter(Boolean);
    // AI の回答と同じ基準で確かめる（断り文の判定はしない）
    const checked = validateEntries(
      [{ id: record.id, status: 'ok', summary: summaryInput.value, points, background: backgroundInput.value, keywords }],
      () => ({ summarized: true }),
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

function renderSavedList() {
  if (!data) return;
  const all = savedSummaries();
  const query = ui.savedFilter.value.trim().toLowerCase();
  const list = query
    ? all.filter((record) => `${record.title} ${record.summary} ${record.points.join(' ')}`.toLowerCase().includes(query))
    : all;
  ui.savedCount.textContent = `${all.length}件`;
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
      label.append(box, el('span', 'pick-title', record.title), meta, el('span', 'pick-summary', record.summary));
      if (record.points.length > 0) label.append(el('span', 'pick-summary', record.points.map((point) => `・${point}`).join(' ')));
      if (record.background) label.append(el('span', 'pick-meta', `背景: ${record.background}`));
      if (record.keywords?.length) label.append(el('span', 'pick-meta', `キーワード: ${record.keywords.join('、')}`));
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
    ui.savedList.append(el('li', 'pick-meta', all.length === 0 ? '保存済みの要約はまだありません。' : '条件に合う要約はありません。'));
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

// ===== サイトの更新（GitHub Actions のワークフローを実行） =====

const WORKFLOW = 'update.yml';
const TIMER_WORKFLOW = 'timer.yml';
const RUN_EVENTS: Record<string, string> = {
  schedule: '定期更新',
  workflow_dispatch: '手動実行',
  push: '変更の反映',
};
/** 自動更新タイマーが実行したもの（Actions のトークンで実行される） */
const runLabel = (run: WorkflowRun) =>
  run.event === 'workflow_dispatch' && run.triggering_actor?.login === 'github-actions[bot]'
    ? '自動更新'
    : (RUN_EVENTS[run.event] ?? run.event);
let runsTimer: ReturnType<typeof setTimeout> | undefined;

function runState(run: WorkflowRun): { text: string; kind: 'ok' | 'error' | 'active' | '' } {
  if (run.status !== 'completed') {
    return { text: ['queued', 'pending', 'waiting', 'requested'].includes(run.status) ? '待機中' : '実行中', kind: 'active' };
  }
  switch (run.conclusion) {
    case 'success':
      return { text: '成功', kind: 'ok' };
    case 'cancelled':
      return { text: 'キャンセル', kind: '' };
    case 'skipped':
      return { text: 'スキップ', kind: '' };
    default:
      return { text: '失敗', kind: 'error' };
  }
}

async function renderRuns() {
  clearTimeout(runsTimer);
  if (!data || !token) {
    ui.runList.replaceChildren(el('li', 'pick-meta', 'ログインすると表示されます。'));
    return;
  }
  try {
    const runs = await githubClient().listWorkflowRuns(WORKFLOW, 6);
    ui.runList.replaceChildren(
      ...runs.map((run) => {
        const state = runState(run);
        const link = el('a', '', '詳細');
        link.href = run.html_url;
        link.target = '_blank';
        link.rel = 'noopener';
        const item = el('li');
        item.append(
          el('span', `run-state ${state.kind}`.trim(), state.text),
          el('span', '', runLabel(run)),
          el('span', 'pick-meta', dateFormat.format(new Date(run.created_at))),
          link,
        );
        return item;
      }),
    );
    if (runs.length === 0) ui.runList.append(el('li', 'pick-meta', 'まだ実行されていません。'));
    // 実行中のものがあれば、終わるまで自動で状況を更新する
    if (runs.some((run) => run.status !== 'completed')) runsTimer = setTimeout(renderRuns, 15_000);
    await renderTimerStatus(runs);
  } catch (error) {
    ui.runList.replaceChildren(
      el('li', 'pick-meta', `実行状況を読み込めませんでした: ${errorText(error)}`),
    );
  }
}

/** 自動更新タイマー（timer.yml）が動いているか、次の更新はいつごろか */
async function renderTimerStatus(updateRuns: WorkflowRun[]) {
  const target = $('timer-status');
  try {
    const timers = await githubClient().listWorkflowRuns(TIMER_WORKFLOW, 5);
    const active = timers.some((run) => run.status !== 'completed');
    const last = updateRuns[0] ? Date.parse(updateRuns[0].created_at) : undefined;
    const next = last ? `（次の更新は ${dateFormat.format(new Date(last + 60 * 60 * 1000))} ごろ）` : '';
    target.textContent = active
      ? `自動更新: 動作中${next}`
      : '自動更新: 停止中です。「今すぐ更新」を押すと、更新と一緒に自動更新も再開します。';
    target.className = `timer-status ${active ? 'ok' : 'error'}`;
  } catch {
    // タイマーの状況が読めなくても、ほかの表示は続ける
    target.textContent = '';
  }
}

/** 収集とサイトの更新を今すぐ実行する */
async function runUpdate() {
  const button = ui.runUpdate;
  button.disabled = true;
  setStatus(ui.runStatus, '実行を依頼しています…');
  try {
    const client = githubClient();
    const { defaultBranch } = await client.repository();
    await client.dispatchWorkflow(WORKFLOW, defaultBranch);
    setStatus(ui.runStatus, '更新を開始しました。2〜3分ほどでサイトに反映されます。', 'ok');
    // 実行が一覧に現れるまで少しかかる
    setTimeout(renderRuns, 4000);
  } catch (error) {
    setStatus(ui.runStatus, `実行できませんでした: ${errorText(error)}`, 'error');
  } finally {
    // 連打で何度も実行しないよう、少し待ってから押せるようにする
    setTimeout(() => (button.disabled = false), 5000);
  }
}

function setupRuns() {
  ui.runUpdate.addEventListener('click', runUpdate);
  $('refresh-runs').addEventListener('click', renderRuns);
}

// ===== GitHub との連携 =====

function setupConnection() {
  $('test-token').addEventListener('click', async () => {
    setStatus(ui.tokenStatus, '確認しています…');
    try {
      const { defaultBranch, canPush } = await githubClient().repository();
      if (canPush) {
        setStatus(ui.tokenStatus, `接続できました。保存先: ${defaultBranch} ブランチ`, 'ok');
        ui.tokenBadge.textContent = '接続OK';
        void renderRuns();
      } else {
        setStatus(ui.tokenStatus, '読み取りはできますが、書き込み権限がありません（Contents の Read and write が必要です）', 'error');
      }
    } catch (error) {
      setStatus(ui.tokenStatus, errorText(error), 'error');
    }
  });
}

// ===== 起動 =====

async function main() {
  // ログインしていなければログインページへ（ログイン中だけ管理画面を表示する）
  const session = requireSession();
  if (!session) return;
  token = session.token;
  watchSession(session);
  root.hidden = false;

  restoreOptions();
  setupConnection();
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
        `サイトが${hours}時間以上更新されていません。定期実行が止まっている可能性があります。下の「今すぐ更新」で更新できます。`,
      ),
    );
  }
  ui.repoName.textContent = `${data.repository.owner}/${data.repository.repo}`;
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
  ui.category.addEventListener('change', refresh);
  ui.sort.addEventListener('change', refresh);
  $('reselect').addEventListener('click', refresh);
  ui.length.addEventListener('change', renderPrompt);
  ui.points.addEventListener('change', renderPrompt);

  $('copy-prompt').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (!ui.prompt.value) return;
    try {
      await navigator.clipboard.writeText(ui.prompt.value);
      button.textContent = 'コピーしました';
    } catch {
      ui.prompt.select();
      button.textContent = '選択しました（Ctrl+C でコピー）';
    }
    setTimeout(() => (button.textContent = 'プロンプトをコピー'), 2500);
  });
  $('download-prompt').addEventListener('click', () => {
    if (ui.prompt.value) download(`summary-prompt-${stamp()}.txt`, ui.prompt.value, 'text/plain');
  });
  $('check').addEventListener('click', checkResponse);
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
    if (ui.response.value.trim()) checkResponse();
  } else {
    refresh();
  }
  renderPasteList();
  renderSavedList();
  renderSaveArea();
  setupRuns();
  setupBlocklist();
  renderSources();
  void renderRuns();
}

void main();
