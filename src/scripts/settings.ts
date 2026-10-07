/**
 * 「表示の設定」のページ（/settings/）: 文字の大きさ・抜粋・既読の表示・画面の色、表示しない設定（ミュート）、
 * このブラウザに保存しているものの書き出し・読み込み・消去
 */
import { cleanFollow, cleanMute, type MutePrefs } from '../lib/follow-core.ts';
import { isOptedOut, setOptOut } from './analytics.ts';
import {
  DEFAULT_DISPLAY,
  PREFS_EVENT,
  STORE_KEYS,
  clearRead,
  loadDisplay,
  loadFollow,
  loadMute,
  loadRead,
  saveDisplay,
  saveFollow,
  saveMute,
  setMute,
  writeStored,
  type DisplayPrefs,
  type FollowKind,
} from './personal-store.ts';
import { toast } from './personal.ts';
import { loadPushLocal, disablePush } from './push-client.ts';
import { cleanSavedList, loadSaved, storeSaved } from './reader.ts';

interface PageData {
  categories: { slug: string; name: string }[];
  sources: { id: string; name: string; cat: string }[];
}

const root = document.querySelector<HTMLElement>('[data-settings-page]')!;
const page = JSON.parse(root.dataset.page ?? '{}') as PageData;
const base = document.body.dataset.base ?? '';
const apiBase = document.body.dataset.analytics ?? '';
const categoryName = new Map(page.categories.map((category) => [category.slug, category.name]));
const sourceName = new Map(page.sources.map((source) => [source.id, source.name]));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// ===== 表示 =====

const form = $<HTMLFormElement>('display-form');

function currentTheme(): string {
  try {
    const theme = localStorage.getItem('theme');
    return theme === 'light' || theme === 'dark' ? theme : '';
  } catch {
    return '';
  }
}

function renderDisplay(): void {
  const display = loadDisplay();
  const set = (name: string, value: string) => {
    for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) input.checked = input.value === value;
  };
  set('font', display.font);
  set('read', display.read);
  set('theme', currentTheme());
  const excerpt = form.querySelector<HTMLInputElement>('input[name="excerpt"]');
  if (excerpt) excerpt.checked = display.excerpt;
}

form.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === 'theme') {
    // ヘッダーの切り替えボタンと同じ保存場所（BaseLayout の head で最初に反映する）
    const root = document.documentElement;
    try {
      if (target.value) localStorage.setItem('theme', target.value);
      else localStorage.removeItem('theme');
    } catch {
      // 保存できない環境でも、このページの表示は変える
    }
    if (target.value) root.dataset.theme = target.value;
    else delete root.dataset.theme;
    return;
  }
  const value = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
  const display: DisplayPrefs = {
    font: (value('font') as DisplayPrefs['font']) ?? DEFAULT_DISPLAY.font,
    excerpt: form.querySelector<HTMLInputElement>('input[name="excerpt"]')?.checked ?? true,
    read: (value('read') as DisplayPrefs['read']) ?? DEFAULT_DISPLAY.read,
  };
  saveDisplay(display);
  toast('表示の設定を保存しました');
});

// ===== 表示しない（ミュート） =====

const KIND_LABEL: Record<FollowKind, string> = { cat: 'ジャンル', src: '掲載元', word: 'キーワード' };

function labelOf(kind: FollowKind, value: string): string {
  if (kind === 'cat') return categoryName.get(value) ?? value;
  if (kind === 'src') return sourceName.get(value) ?? value;
  return value;
}

function muteEntries(mute: MutePrefs): { kind: FollowKind; value: string }[] {
  return [
    ...mute.cats.map((value) => ({ kind: 'cat' as const, value })),
    ...mute.srcs.map((value) => ({ kind: 'src' as const, value })),
    ...mute.words.map((value) => ({ kind: 'word' as const, value })),
  ];
}

function renderMute(): void {
  const mute = loadMute();
  const entries = muteEntries(mute);
  $('mute-chips').replaceChildren(
    ...entries.map(({ kind, value }) => {
      const li = el('li', 'chip');
      const label = labelOf(kind, value);
      li.append(el('span', 'chip-kind', KIND_LABEL[kind]), el('span', 'chip-label', label));
      const remove = el('button', 'chip-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `「${label}」を表示するようにする`);
      remove.addEventListener('click', () => {
        setMute(kind, value, false);
        toast(`「${label}」を表示するようにしました`, { label: '元に戻す', run: () => setMute(kind, value, true) });
      });
      li.append(remove);
      return li;
    }),
  );
  $('mute-chips-empty').hidden = entries.length > 0;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mute]')) {
    button.setAttribute('aria-pressed', String(mute.cats.includes(button.dataset.mute ?? '')));
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mute]')) {
  button.addEventListener('click', () => {
    const slug = button.dataset.mute ?? '';
    const on = !loadMute().cats.includes(slug);
    setMute('cat', slug, on);
    toast(on ? `ジャンル「${labelOf('cat', slug)}」を一覧に出さないようにしました` : `ジャンル「${labelOf('cat', slug)}」を表示するようにしました`);
  });
}

$('mute-word-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('mute-word-input');
  const word = input.value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!word) return;
  setMute('word', word, true);
  input.value = '';
  toast(`見出しに「${word}」が入った記事を表示しないようにしました`);
});

$('mute-src-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const select = $<HTMLSelectElement>('mute-src-select');
  if (!select.value) return;
  setMute('src', select.value, true);
  toast(`「${labelOf('src', select.value)}」の記事を表示しないようにしました`);
  select.value = '';
});

// ===== このブラウザに保存しているもの =====

function renderData(): void {
  const follow = loadFollow();
  const mute = loadMute();
  const rows = [
    `フォロー: ${follow.cats.length + follow.srcs.length + follow.words.length}件`,
    `表示しない設定: ${mute.cats.length + mute.srcs.length + mute.words.length}件`,
    `あとで読む: ${loadSaved().length}件`,
    `既読の記録: ${loadRead().size}件`,
    `通知: ${loadPushLocal().enabled ? 'オン' : 'オフ'}`,
  ];
  $('data-summary').replaceChildren(...rows.map((row) => el('li', undefined, row)));
}

const EXPORT_APP = 'topiatsume';

$('export').addEventListener('click', () => {
  const data = {
    app: EXPORT_APP,
    version: 1,
    exportedAt: new Date().toISOString(),
    follow: loadFollow(),
    mute: loadMute(),
    display: loadDisplay(),
    saved: loadSaved(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `topiatsume-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

$('import').addEventListener('click', () => $<HTMLInputElement>('import-file').click());
$<HTMLInputElement>('import-file').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast('ファイルが大きすぎます');
    return;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await file.text()) as Record<string, unknown>;
  } catch {
    toast('ファイルを読めませんでした（書き出したファイルを選んでください）');
    return;
  }
  if (data.app !== EXPORT_APP) {
    toast('このサイトの設定のファイルではありません');
    return;
  }
  saveFollow(cleanFollow(data.follow));
  saveMute(cleanMute(data.mute));
  if (typeof data.display === 'object' && data.display !== null) {
    const display = data.display as Partial<DisplayPrefs>;
    saveDisplay({
      font: display.font === 'l' || display.font === 'xl' ? display.font : 'm',
      excerpt: display.excerpt !== false,
      read: display.read === 'hide' || display.read === 'off' ? display.read : 'mark',
    });
  }
  // 「あとで読む」は、いまの保存に足す（同じ記事は1つに）
  const current = loadSaved();
  const ids = new Set(current.map((item) => item.id));
  storeSaved([...current, ...cleanSavedList(data.saved).filter((item) => !ids.has(item.id))]);
  renderAll();
  toast('設定を読み込みました');
});

$('clear-read').addEventListener('click', () => {
  clearRead();
  renderData();
  toast('既読の記録を消しました');
});

$('clear-all').addEventListener('click', async () => {
  if (!confirm('フォロー・表示しない設定・表示の設定・あとで読む・既読の記録など、このサイトの設定をすべて消します。よろしいですか？')) return;
  if (loadPushLocal().enabled && apiBase) await disablePush(base, apiBase).catch(() => undefined);
  for (const key of Object.values(STORE_KEYS)) writeStored(key, undefined);
  try {
    for (const key of ['matmsait:saved', 'matmsait:visit', 'matmsait:install', 'theme']) localStorage.removeItem(key);
  } catch {
    // 保存できない環境
  }
  location.reload();
});

// アクセス解析（設定されているサイトだけ）
if (apiBase) {
  const box = $('analytics-optout');
  const check = $<HTMLInputElement>('optout-check');
  box.hidden = false;
  check.checked = isOptedOut();
  check.addEventListener('change', () => {
    setOptOut(check.checked);
    toast(check.checked ? 'このブラウザの閲覧を数えないようにしました' : 'このブラウザの閲覧も数えるようにしました');
  });
}

function renderAll(): void {
  renderDisplay();
  renderMute();
  renderData();
}

renderAll();
window.addEventListener(PREFS_EVENT, renderAll);
window.addEventListener('storage', renderAll);
