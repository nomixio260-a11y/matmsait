/**
 * 閲覧者のブラウザにだけ保存する機能（保存した内容はサーバーに送らない）
 * - あとで読む: 記事を保存して /saved/ で読み返せる
 * - 前回の訪問以降の新着: 前回見に来たときより後に追加された記事に印を付け、トップページに件数を出す
 * アクセス解析（src/scripts/analytics.ts）は訪問の記録を、前にも来たか・同じ訪問の続きかの判定にだけ使う（日時そのものは送らない）
 */

const SAVED_KEY = 'matmsait:saved';
const VISIT_KEY = 'matmsait:visit';
/** これより間が空いたら「新しい訪問」とみなす（同じ訪問の中ではページを移っても印が消えないように） */
const SESSION_GAP = 30 * 60 * 1000;
const MAX_SAVED = 300;

export interface SavedItem {
  id: string;
  title: string;
  /** 開く URL（要約ページか元記事） */
  url: string;
  /** 掲載元の名前 */
  site: string;
  /** 記事の公開日時 */
  at: string;
  /** 保存した日時 */
  savedAt: string;
}

interface Visit {
  /** 前回の訪問の最後の閲覧日時（この訪問のあいだは変えない） */
  previous?: number;
  /** 最後に閲覧した日時 */
  last?: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境（プライベートブラウズなど）では何もしない
  }
}

const isSavedItem = (value: unknown): value is SavedItem =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SavedItem).id === 'string' &&
  typeof (value as SavedItem).title === 'string' &&
  typeof (value as SavedItem).url === 'string' &&
  /^(https?:\/\/|\/)/.test((value as SavedItem).url);

/** 形の正しい「あとで読む」だけを残す（設定のファイルを読み込むときにも使う） */
export function cleanSavedList(list: unknown): SavedItem[] {
  return Array.isArray(list) ? list.filter(isSavedItem) : [];
}

export function loadSaved(): SavedItem[] {
  return cleanSavedList(readJson<unknown>(SAVED_KEY, []));
}

export function storeSaved(list: SavedItem[]): void {
  writeJson(SAVED_KEY, list.slice(0, MAX_SAVED));
  syncSavedCount();
}

/** 保存していなければ保存し、保存していれば外す。保存した状態なら true */
export function toggleSaved(item: Omit<SavedItem, 'savedAt'>): boolean {
  const list = loadSaved();
  const exists = list.some((saved) => saved.id === item.id);
  storeSaved(exists ? list.filter((saved) => saved.id !== item.id) : [{ ...item, savedAt: new Date().toISOString() }, ...list]);
  return !exists;
}

/** ヘッダーの「あとで読む」の件数 */
function syncSavedCount(): void {
  const count = loadSaved().length;
  for (const badge of document.querySelectorAll<HTMLElement>('[data-saved-count]')) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  }
}

/** このページを開く前の訪問の記録（アクセス解析で、同じ訪問の続きか・前にも来た人かを見分けるのに使う） */
let visitBefore: { lastView?: number; returning: boolean; available: boolean } = { returning: false, available: false };

export function visitInfo(): { lastView?: number; returning: boolean; available: boolean } {
  return visitBefore;
}

function storageAvailable(): boolean {
  try {
    localStorage.getItem(VISIT_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 今回の訪問を記録し、前回の訪問の日時を返す（初めての訪問なら undefined） */
export function recordVisit(now: number): number | undefined {
  const visit = readJson<Visit>(VISIT_KEY, {});
  let previous = visit.previous;
  if (!visit.last) previous = undefined;
  else if (now - visit.last > SESSION_GAP) previous = visit.last;
  visitBefore = { lastView: visit.last, returning: previous !== undefined, available: storageAvailable() };
  writeJson(VISIT_KEY, { previous, last: now } satisfies Visit);
  return previous;
}

function parseSaveData(button: HTMLButtonElement): Omit<SavedItem, 'savedAt'> | undefined {
  try {
    return JSON.parse(button.dataset.save ?? '') as Omit<SavedItem, 'savedAt'>;
  } catch {
    return undefined;
  }
}

function syncSaveButton(button: HTMLButtonElement, on: boolean): void {
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'あとで読むから外す' : 'あとで読む');
  button.title = on ? 'あとで読むから外す' : 'あとで読む';
}

/** 「あとで読む」のボタンの表示を、保存した記事に合わせる（後から加えた一覧のボタンにも使う） */
export function syncSaveButtons(root: ParentNode = document): void {
  const saved = new Set(loadSaved().map((item) => item.id));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-save]')) {
    const data = parseSaveData(button);
    if (data) syncSaveButton(button, saved.has(data.id));
  }
}

function setupSaveButtons(): void {
  // 後から加わる一覧（フォロー中のページなど）のボタンも扱えるよう、ページ全体で受ける
  document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>('[data-save]');
    const data = button && parseSaveData(button);
    if (!button || !data) return;
    event.preventDefault();
    event.stopPropagation();
    const on = toggleSaved(data);
    syncSaveButton(button, on);
    // アクセス解析に「あとで読む」に保存したことを知らせる（外したときは知らせない）
    if (on) button.dispatchEvent(new CustomEvent('tp:save', { bubbles: true, detail: { id: data.id } }));
  });
  syncSaveButtons();
  syncSavedCount();
}

const relative = (ms: number) => {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return '少し前';
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
};

function markUnseen(): void {
  const now = Date.now();
  const previous = recordVisit(now);
  if (!previous) return;
  let count = 0;
  const seen = new Set<string>();
  for (const item of document.querySelectorAll<HTMLElement>('.item[data-at]')) {
    const at = Date.parse(item.dataset.at ?? '');
    if (Number.isNaN(at) || at <= previous || at > now) continue;
    item.classList.add('is-unseen');
    const id = item.dataset.id ?? '';
    if (!seen.has(id)) {
      seen.add(id);
      count++;
    }
  }
  const banner = document.querySelector<HTMLElement>('[data-since-banner]');
  if (banner && count > 0) {
    banner.textContent = `前回の訪問（${relative(now - previous)}）のあとに追加された記事: このページに${count}件（青い印の記事）`;
    banner.hidden = false;
  }
}

setupSaveButtons();
markUnseen();
