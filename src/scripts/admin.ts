// 管理画面（/admin/）: 要約待ちの記事を選んでプロンプトを作り、AI の回答を検証して GitHub に保存する
import { createGitHubClient, type Repository } from '../lib/github-commit.ts';
import {
  buildSummaryPrompt,
  extractJson,
  groupByFile,
  mergeSummaryRecords,
  normalizeEntries,
  parseSummaryFile,
  serializeSummaryFile,
  toSummaryRecord,
  validateEntries,
  type AcceptedSummary,
  type SummaryLength,
  type ValidationResult,
} from '../lib/summary-core.ts';
import type { Item, SummaryRecord } from '../lib/types.ts';

interface AdminArticle extends Item {
  site: string;
}

interface AdminSummary extends AdminArticle {
  summary: string;
  points: string[];
  summarizedAt: string;
}

interface AdminData {
  generatedAt: string;
  siteName: string;
  repository: Repository;
  categories: { slug: string; name: string }[];
  pending: AdminArticle[];
  summarized: AdminSummary[];
}

const KEYS = {
  token: 'admin.githubToken',
  saved: 'admin.savedIds',
  deleted: 'admin.deletedIds',
  options: 'admin.options',
};
/** 保存・削除した記事を、サイトに反映されるまで一覧から隠しておく時間 */
const HIDE_FOR = 6 * 60 * 60 * 1000;
const LIST_LIMIT = 300;

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
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 同上
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

// ===== 画面の要素 =====

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = document.querySelector<HTMLElement>('[data-admin]')!;
const base = root.dataset.base ?? '';

const ui = {
  dataInfo: $('data-info'),
  token: $<HTMLInputElement>('token'),
  remember: $<HTMLInputElement>('remember'),
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
let token = '';

const categoryName = (slug: string) => data?.categories.find((c) => c.slug === slug)?.name ?? slug;

function articleMeta(article: AdminArticle): string {
  return [
    article.site,
    categoryName(article.category),
    dateFormat.format(new Date(article.publishedAt)),
    article.hatebu ? `${article.hatebu} users` : '',
  ]
    .filter(Boolean)
    .join(' ・ ');
}

/** 要約待ちの記事（保存直後でまだサイトに反映されていないものは除く） */
function pendingArticles(): AdminArticle[] {
  if (!data) return [];
  const saved = readMarks(KEYS.saved);
  const deleted = readMarks(KEYS.deleted);
  // 削除した要約はサイトに反映されるまで pending に入っていないので、ここで戻す
  const restored = data.summarized.filter((article) => deleted.has(article.id));
  const category = ui.category.value;
  const list = [...data.pending, ...restored].filter(
    (article) => !saved.has(article.id) && (!category || article.category === category),
  );
  return ui.sort.value === 'latest'
    ? list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    : list.sort((a, b) => (b.hatebu ?? 0) - (a.hatebu ?? 0) || b.publishedAt.localeCompare(a.publishedAt));
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
  for (const article of pendingArticles().slice(0, Number(ui.count.value))) selected.add(article.id);
}

function renderPickList() {
  const list = pendingArticles();
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
      label.append(box, el('span', 'pick-title', article.title), el('span', 'pick-meta', articleMeta(article)));
      item.append(label);
      return item;
    }),
  );
  if (list.length === 0) ui.pickList.append(el('li', 'pick-meta', '要約待ちの記事はありません。'));
  renderCounter(list.length);
}

function renderCounter(total: number) {
  const shown = Math.min(total, LIST_LIMIT);
  ui.counter.textContent = `要約待ち ${total}件${total > shown ? `（上位${shown}件を表示）` : ''} ・ 選択中 ${selected.size}件`;
}

// ===== 2. プロンプト =====

function renderPrompt() {
  if (!data) return;
  batch = pendingArticles().filter((article) => selected.has(article.id));
  if (batch.length === 0) {
    ui.prompt.value = '';
    ui.promptInfo.textContent = '記事を選ぶとプロンプトが表示されます';
    return;
  }
  ui.prompt.value = buildSummaryPrompt(
    batch.map(({ id, title, url, site, excerpt }) => ({ id, title, url, site, excerpt })),
    { siteName: data.siteName, length: ui.length.value as SummaryLength, points: ui.points.checked },
  );
  ui.promptInfo.textContent = `${batch.length}件 ・ ${ui.prompt.value.length.toLocaleString()}字`;
  saveOptions();
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
    ui.checkResult.append(el('p', 'status error', error instanceof Error ? error.message : String(error)));
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
  renderSaveArea();
}

// ===== 4. 保存（GitHub に1つのコミットとして保存） =====

function githubClient() {
  if (!data) throw new Error('記事データを読み込めていません');
  if (!token) throw new Error('先に「GitHub との連携」でトークンを設定してください');
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
  } catch (error) {
    setStatus(ui.saveStatus, `保存できませんでした: ${error instanceof Error ? error.message : error}`, 'error');
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

function renderSavedList() {
  if (!data) return;
  const deleted = readMarks(KEYS.deleted);
  const list = data.summarized.filter((record) => !deleted.has(record.id));
  ui.savedCount.textContent = `${list.length}件`;
  const checked = new Set<string>();
  const sync = () => {
    ui.deleteSelected.disabled = checked.size === 0;
    ui.deleteSelected.textContent = checked.size > 0 ? `選んだ${checked.size}件の要約を削除` : '選んだ要約を削除';
  };
  ui.savedList.replaceChildren(
    ...list.map((record) => {
      const item = el('li');
      const label = el('label');
      const box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        if (box.checked) checked.add(record.id);
        else checked.delete(record.id);
        sync();
      });
      label.append(
        box,
        el('span', 'pick-title', record.title),
        el('span', 'pick-meta', `${articleMeta(record)} ・ 要約 ${dateFormat.format(new Date(record.summarizedAt))}`),
        el('span', 'pick-summary', record.summary),
      );
      item.append(label);
      return item;
    }),
  );
  if (list.length === 0) ui.savedList.append(el('li', 'pick-meta', '保存済みの要約はまだありません。'));
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
      setStatus(ui.deleteStatus, `削除できませんでした: ${error instanceof Error ? error.message : error}`, 'error');
      sync();
    }
  };
}

// ===== トークン =====

function renderTokenBadge(text?: string, ok = false) {
  ui.tokenBadge.textContent = text ?? (token ? '設定済み' : '未設定');
  ui.tokenBadge.className = `badge${ok ? ' ok' : ''}`;
}

function setupToken() {
  const remembered = storage.get(KEYS.token);
  if (remembered) {
    token = remembered;
    ui.token.value = remembered;
    ui.remember.checked = true;
  } else {
    ($('settings') as HTMLDetailsElement).open = true;
  }
  renderTokenBadge();

  ui.token.addEventListener('input', () => {
    token = ui.token.value.trim();
    if (ui.remember.checked && token) storage.set(KEYS.token, token);
    renderTokenBadge();
  });
  ui.remember.addEventListener('change', () => {
    if (ui.remember.checked && token) storage.set(KEYS.token, token);
    else storage.remove(KEYS.token);
  });
  $('forget-token').addEventListener('click', () => {
    token = '';
    ui.token.value = '';
    ui.remember.checked = false;
    storage.remove(KEYS.token);
    renderTokenBadge();
    setStatus(ui.tokenStatus, 'トークンを消しました。');
  });
  $('test-token').addEventListener('click', async () => {
    setStatus(ui.tokenStatus, '確認しています…');
    try {
      const { defaultBranch, canPush } = await githubClient().repository();
      if (canPush) {
        setStatus(ui.tokenStatus, `接続できました。保存先: ${defaultBranch} ブランチ`, 'ok');
        renderTokenBadge('接続OK', true);
      } else {
        setStatus(ui.tokenStatus, '読み取りはできますが、書き込み権限がありません（Contents の Read and write が必要です）', 'error');
      }
    } catch (error) {
      setStatus(ui.tokenStatus, error instanceof Error ? error.message : String(error), 'error');
    }
  });
}

// ===== 起動 =====

async function main() {
  restoreOptions();
  setupToken();
  try {
    const res = await fetch(`${base}/admin/data.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as AdminData;
  } catch (error) {
    ui.dataInfo.textContent = `記事データを読み込めませんでした（${error instanceof Error ? error.message : error}）`;
    return;
  }
  ui.dataInfo.textContent = `記事データ: ${dateFormat.format(new Date(data.generatedAt))} 時点（要約待ち ${data.pending.length}件 ・ 要約済み ${data.summarized.length}件）`;
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
  $('clear-response').addEventListener('click', () => {
    ui.response.value = '';
    validation = undefined;
    ui.checkResult.replaceChildren();
    renderSaveArea();
  });
  ui.save.addEventListener('click', saveSummaries);
  ui.downloadJson.addEventListener('click', downloadRecords);

  refresh();
  renderSavedList();
  renderSaveArea();
}

void main();
