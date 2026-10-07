/**
 * 読者向けの便利な機能（すべてのページで動く。設定はこのブラウザにだけ保存し、サーバーには送らない）
 * - 既読: 開いた記事に印を付ける（表示の設定で「一覧から隠す」「印を付けない」も選べる）
 * - ミュート: 表示しない掲載元・キーワード・ジャンルの記事を一覧から隠す
 * - フォロー: [data-follow] のボタン（ジャンル・掲載元・キーワード）と、記事ごとのメニュー（…）
 * - ヘッダーの「フォロー中」の新着の数（updates.json を読んで数える）
 * - お知らせの「閉じる」、ページの先頭に戻るボタン
 */
import { isEmptyPrefs, matchFollow, parseUpdates, preparePrefs, isMuted, type UpdatesFile } from '../lib/follow-core.ts';
import { normalizeText } from '../lib/search-core.ts';
import {
  PREFS_EVENT,
  STORE_KEYS,
  applyDisplay,
  forgetReadCache,
  isFollowing,
  isMutedBy,
  loadDisplay,
  loadFollow,
  loadFollowingState,
  loadMute,
  loadRead,
  markRead,
  readStored,
  saveFollowingState,
  setFollow,
  setMute,
  writeStored,
  type FollowKind,
} from './personal-store.ts';
import { loadPushLocal, syncPush } from './push-client.ts';

const base = document.body.dataset.base ?? '';
const apiBase = document.body.dataset.analytics ?? '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// ===== お知らせ（画面の下に出る短い知らせ） =====

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 画面の下に短い知らせを出す（元に戻す・リンクを付けられる） */
export function toast(message: string, action?: { label: string; run?: () => void; href?: string }): void {
  let box = document.querySelector<HTMLElement>('.toast');
  if (!box) {
    box = el('div', 'toast');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const text = el('span', 'toast-text', message);
  box.replaceChildren(text);
  if (action?.href) {
    const link = el('a', 'toast-action', action.label);
    link.href = action.href;
    box.append(link);
  } else if (action?.run) {
    const button = el('button', 'toast-action', action.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      action.run?.();
      box?.classList.remove('is-shown');
    });
    box.append(button);
  }
  box.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box?.classList.remove('is-shown'), 6000);
}

// ===== 既読 =====

/** 一覧の記事に既読の印を付ける */
function applyRead(root: ParentNode = document): void {
  const read = loadRead();
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a.item-title[data-aid]')) {
    const on = read.has(link.dataset.aid ?? '');
    link.classList.toggle('is-read', on);
    link.closest('.item')?.classList.toggle('is-read', on);
  }
}

function setupRead(): void {
  // 記事を開いたら既読にする（見出し・元記事のリンク。中クリックで開いたときも）
  const onOpen = (event: MouseEvent) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[data-aid]');
    const id = link?.dataset.aid;
    if (!id) return;
    markRead(id);
    const title = link.closest('.item, .topic, li')?.querySelector<HTMLElement>('a.item-title');
    title?.classList.add('is-read');
  };
  document.addEventListener('click', onOpen, true);
  document.addEventListener('auxclick', onOpen, true);
  // 要約のページを開いたら、その記事は既読
  const article = document.querySelector<HTMLElement>('[data-article-view]');
  if (article?.dataset.aid) markRead(article.dataset.aid);
}

// ===== ミュート =====

/** 一時的にミュートを解いて表示している */
let revealed = false;

function applyMute(): void {
  const scope = document.querySelector<HTMLElement>('[data-scope-src], [data-scope-cat]');
  const scopeSrc = scope?.dataset.scopeSrc;
  const scopeCat = scope?.dataset.scopeCat;
  const mute = loadMute();
  // 掲載元・ジャンルのページでは、そのページの掲載元・ジャンルのミュートは効かせない（自分で開いたページなので）
  const effective = {
    cats: scopeSrc ? [] : mute.cats.filter((cat) => cat !== scopeCat),
    srcs: mute.srcs.filter((src) => src !== scopeSrc),
    words: mute.words,
  };
  const prepared = preparePrefs(effective);
  const follow = preparePrefs(loadFollow());
  let hidden = 0;
  for (const item of document.querySelectorAll<HTMLElement>('.item[data-src]')) {
    const title = item.querySelector('.item-title')?.textContent ?? '';
    const muted = !revealed && !isEmptyPrefs(effective) && isMuted({ t: title, c: item.dataset.cat ?? '', s: item.dataset.src ?? '' }, prepared, follow, normalizeText(title));
    item.classList.toggle('is-muted', muted);
    if (muted) hidden++;
  }
  // 記事がすべて隠れた日付の見出しも隠す
  for (const group of document.querySelectorAll<HTMLElement>('.day-group')) {
    const items = group.querySelectorAll('.item');
    group.classList.toggle('is-muted', items.length > 0 && group.querySelectorAll('.item:not(.is-muted)').length === 0);
  }
  renderMuteNote(hidden, scopeSrc && mute.srcs.includes(scopeSrc) ? { kind: 'src', value: scopeSrc } : scopeCat && mute.cats.includes(scopeCat) ? { kind: 'cat', value: scopeCat } : undefined);
}

/** 隠した記事の数と、表示する・設定へのリンク */
function renderMuteNote(hidden: number, scopeMuted?: { kind: FollowKind; value: string }): void {
  const main = document.getElementById('main');
  if (!main) return;
  let note = main.querySelector<HTMLElement>('.mute-note');
  if (hidden === 0 && !scopeMuted && !revealed) {
    note?.remove();
    return;
  }
  if (!note) {
    note = el('p', 'mute-note');
    note.setAttribute('role', 'status');
    // ページの見出しの下（見出しがなければパンくずの下・本文の先頭）に出す
    const head = main.querySelector('.page-head') ?? main.querySelector('.intro') ?? main.querySelector('.breadcrumbs');
    if (head) head.after(note);
    else main.prepend(note);
  }
  note.replaceChildren();
  if (scopeMuted) {
    note.append(scopeMuted.kind === 'src' ? 'この掲載元は「表示しない」に設定しています（このページでは表示しています）。' : 'このジャンルは「表示しない」に設定しています（このページでは表示しています）。');
    const undo = el('button', 'link-button', '表示しない設定をやめる');
    undo.type = 'button';
    undo.addEventListener('click', () => {
      setMute(scopeMuted.kind, scopeMuted.value, false);
      toast('表示しない設定をやめました');
    });
    note.append(undo);
  }
  if (hidden > 0 || revealed) {
    if (scopeMuted) note.append(el('br'));
    note.append(revealed ? '表示しない設定の記事も表示しています。' : `表示しない設定（ミュート）の記事を${hidden}件隠しています。`);
    const toggle = el('button', 'link-button', revealed ? '隠す' : '表示する');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      revealed = !revealed;
      applyMute();
    });
    note.append(toggle);
  }
  const settings = el('a', 'link-button', '設定');
  settings.href = `${base}/settings/#mute`;
  note.append(settings);
}

// ===== フォローのボタン =====

interface FollowTarget {
  kind: FollowKind;
  value: string;
  /** 表示名 */
  label: string;
}

function parseTarget(text: string | undefined): FollowTarget | undefined {
  try {
    const data = JSON.parse(text ?? '') as FollowTarget;
    return (data.kind === 'cat' || data.kind === 'src' || data.kind === 'word') && typeof data.value === 'string' && data.value ? data : undefined;
  } catch {
    return undefined;
  }
}

const kindName = (kind: FollowKind) => (kind === 'cat' ? 'ジャンル' : kind === 'src' ? '掲載元' : 'キーワード');

/** フォローのボタンの表示を、いまの設定に合わせる */
export function syncFollowButtons(root: ParentNode = document): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-follow]')) {
    const target = parseTarget(button.dataset.follow);
    if (!target) continue;
    const on = isFollowing(target.kind, target.value);
    button.dataset.on = String(on);
    // 文字の変わるボタン（「フォローする」⇔「フォロー中」）は文字で、ジャンルの切り替えなどは押した状態で伝える
    const label = button.querySelector('.follow-label');
    if (label) label.textContent = on ? 'フォロー中' : 'フォローする';
    else button.setAttribute('aria-pressed', String(on));
    button.title = on ? `${target.label}のフォローをやめる` : `${target.label}をフォローして、新着を「フォロー中」にまとめる`;
  }
}

function followChanged(target: FollowTarget, on: boolean): void {
  if (on) {
    toast(`${kindName(target.kind)}「${target.label}」をフォローしました`, { label: 'フォロー中を見る', href: `${base}/following/` });
  } else {
    toast(`「${target.label}」のフォローをやめました`, { label: '元に戻す', run: () => setFollow(target.kind, target.value, true) });
  }
}

function setupFollowButtons(): void {
  document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>('[data-follow]');
    if (!button) return;
    const target = parseTarget(button.dataset.follow);
    if (!target) return;
    event.preventDefault();
    const on = setFollow(target.kind, target.value, !isFollowing(target.kind, target.value));
    followChanged(target, on);
  });
  syncFollowButtons();
}

// ===== 記事ごとのメニュー（…） =====

let menu: HTMLElement | undefined;
let menuButton: HTMLButtonElement | undefined;

function closeMenu(focusButton = false): void {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menuButton?.setAttribute('aria-expanded', 'false');
  if (focusButton) menuButton?.focus();
  menuButton = undefined;
}

function menuItem(label: string, run: () => void): HTMLButtonElement {
  const button = el('button', 'item-menu-entry', label);
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.tabIndex = -1;
  button.addEventListener('click', () => {
    closeMenu(true);
    run();
  });
  return button;
}

function openMenu(button: HTMLButtonElement): void {
  const item = button.closest<HTMLElement>('.item');
  if (!item) return;
  const id = item.dataset.id ?? '';
  const src = item.dataset.src ?? '';
  const srcName = item.dataset.srcName || src;
  const cat = item.dataset.cat ?? '';
  const catName = item.dataset.catName || cat;
  if (!menu) {
    menu = el('div', 'item-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.addEventListener('keydown', (event) => {
      const entries = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      const index = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
        entries[next]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        entries[event.key === 'Home' ? 0 : entries.length - 1]?.focus();
      } else if (event.key === 'Tab') {
        closeMenu();
      }
    });
    // ページの区画（main）の中に置く（読み上げで迷わないように）
    (document.getElementById('main') ?? document.body).append(menu);
  }
  const entries: HTMLButtonElement[] = [];
  if (src) {
    const following = isFollowing('src', src);
    entries.push(
      menuItem(following ? `${srcName}のフォローをやめる` : `${srcName}をフォロー`, () =>
        followChanged({ kind: 'src', value: src, label: srcName }, setFollow('src', src, !following)),
      ),
    );
  }
  if (cat) {
    const following = isFollowing('cat', cat);
    entries.push(
      menuItem(following ? `${catName}のフォローをやめる` : `${catName}をフォロー`, () =>
        followChanged({ kind: 'cat', value: cat, label: catName }, setFollow('cat', cat, !following)),
      ),
    );
  }
  if (src) {
    const muted = isMutedBy('src', src);
    entries.push(
      menuItem(muted ? `${srcName}の記事を表示する` : `${srcName}の記事を表示しない`, () => {
        setMute('src', src, !muted);
        if (muted) toast(`${srcName}の記事を表示するようにしました`);
        else toast(`${srcName}の記事を表示しないようにしました`, { label: '元に戻す', run: () => setMute('src', src, false) });
      }),
    );
  }
  if (id) {
    const read = loadRead().has(id);
    entries.push(menuItem(read ? '未読に戻す' : '既読にする', () => markRead(id, !read)));
  }
  menu.replaceChildren(...entries);
  menu.hidden = false;
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton = button;
  button.setAttribute('aria-expanded', 'true');
  // ボタンの下（画面の下に近ければ上）に出す（画面に固定して出し、スクロールしたら閉じる）
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.right - width, document.documentElement.clientWidth - width - 8));
  const below = rect.bottom + 4 + height <= window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, below ? rect.bottom + 4 : rect.top - height - 4)}px`;
  entries[0]?.focus();
}

/** 記事ごとのメニュー（…）のボタン（後から作る一覧で使う。サーバーで作る一覧は ItemRow.astro） */
export function moreButton(): HTMLButtonElement {
  const button = el('button', 'more-btn');
  button.type = 'button';
  button.dataset.itemMenu = '';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'この記事のメニュー');
  button.title = 'フォロー・表示しない・既読';
  button.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';
  return button;
}

function setupItemMenu(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const button = target?.closest?.<HTMLButtonElement>('[data-item-menu]');
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      if (menuButton === button) closeMenu();
      else openMenu(button);
      return;
    }
    if (menu && !menu.hidden && !menu.contains(target)) closeMenu();
  });
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('scroll', () => closeMenu(), { passive: true });
}

// ===== ヘッダーの「フォロー中」の新着の数 =====


let updatesPromise: Promise<UpdatesFile | undefined> | undefined;

/** updates.json（直近の新着記事。読めなければ undefined） */
export function loadUpdates(): Promise<UpdatesFile | undefined> {
  updatesPromise ??= fetch(`${base}/updates.json`)
    .then(async (res) => (res.ok ? parseUpdates(await res.text()) : undefined))
    .catch(() => undefined);
  return updatesPromise;
}

function showFollowCount(count: number): void {
  for (const badge of document.querySelectorAll<HTMLElement>('[data-follow-count]')) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  }
  // 読み上げでは件数の意味も伝える（見た目の数字は読み上げない）
  for (const label of document.querySelectorAll<HTMLElement>('[data-follow-label]')) {
    label.textContent = count > 0 ? `フォロー中（新着${count}件）` : 'フォロー中';
  }
}

/** フォローに当てはまる、前に「フォロー中」を見たあとの新着の数 */
export async function countFollowNew(force = false): Promise<void> {
  const follow = loadFollow();
  if (isEmptyPrefs(follow)) {
    showFollowCount(0);
    return;
  }
  const state = loadFollowingState();
  // 新着の一覧（updates.json）はサイトの更新のたびに変わるので、同じ更新のうちは数え直さない
  if (!force && state.builtAt && state.builtAt === document.body.dataset.built && typeof state.count === 'number') {
    showFollowCount(state.count);
    return;
  }
  const updates = await loadUpdates();
  if (!updates) return;
  const seenAt = state.seenAt ?? Date.now();
  const count = matchFollow(updates.items, follow, loadMute()).filter(({ entry }) => Date.parse(entry.d) > seenAt).length;
  saveFollowingState({ ...loadFollowingState(), count, checkedAt: Date.now(), builtAt: updates.builtAt });
  showFollowCount(count);
}

// ===== お知らせの「閉じる」 =====

function setupNotice(): void {
  const notice = document.querySelector<HTMLElement>('[data-notice]');
  if (!notice) return;
  const id = notice.dataset.notice ?? '';
  const end = Date.parse(notice.dataset.end ?? '');
  // 掲載期間が終わっていたら（サイトの更新の前でも）出さない
  if (readStored<string>(STORE_KEYS.notice, '') === id || (!Number.isNaN(end) && end < Date.now())) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.querySelector('[data-notice-close]')?.addEventListener('click', () => {
    writeStored(STORE_KEYS.notice, id);
    notice.hidden = true;
  });
}

// ===== ページの先頭に戻る =====

function setupBackToTop(): void {
  const button = el('button', 'to-top');
  button.type = 'button';
  button.setAttribute('aria-label', 'ページの先頭に戻る');
  button.title = 'ページの先頭に戻る';
  button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.hidden = true;
  button.addEventListener('click', () => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    document.querySelector<HTMLElement>('.skip-link')?.focus({ preventScroll: true });
  });
  document.body.append(button);
  let ticking = false;
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        button.hidden = window.scrollY < window.innerHeight * 2;
        ticking = false;
      });
    },
    { passive: true },
  );
}

// ===== 起動 =====

let applyTimer: ReturnType<typeof setTimeout> | undefined;

/** 後から加わった記事（検索結果・フォロー中の一覧）にも、既読・ミュート・フォローの表示を反映する */
function watchNewItems(): void {
  const main = document.getElementById('main');
  if (!main) return;
  new MutationObserver((records) => {
    if (!records.some((record) => [...record.addedNodes].some((node) => node instanceof HTMLElement && (node.matches('.item, .day-group, [data-follow]') || node.querySelector('.item, [data-follow]'))))) return;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyRead();
      applyMute();
      syncFollowButtons();
    }, 30);
  }).observe(main, { childList: true, subtree: true });
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;

/** フォロー・ミュートが変わったら、通知のサーバーの設定も新しくする（通知をオンにしているときだけ。続けて変えたらまとめて送る） */
function schedulePushSync(): void {
  if (!loadPushLocal().enabled || !apiBase) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    syncPush(base, apiBase).catch(() => toast('通知の設定を保存できませんでした。「フォロー中」のページで通知の設定を確かめてください'));
  }, 1500);
}

applyDisplay(loadDisplay());
setupRead();
applyRead();
applyMute();
setupFollowButtons();
setupItemMenu();
setupNotice();
setupBackToTop();
watchNewItems();
// 「フォロー中」のページは自分で数えて表示する
if (!document.querySelector('[data-following-page]')) void countFollowNew();

window.addEventListener(PREFS_EVENT, (event) => {
  const what = (event as CustomEvent<{ what: string }>).detail?.what;
  if (what === 'read') applyRead();
  if (what === 'follow' || what === 'mute') {
    applyMute();
    syncFollowButtons();
    if (!document.querySelector('[data-following-page]')) void countFollowNew(true);
    schedulePushSync();
  }
});

// ほかのタブで設定が変わったとき
window.addEventListener('storage', (event) => {
  if (event.key === STORE_KEYS.read) {
    forgetReadCache();
    applyRead();
  } else if (event.key === STORE_KEYS.follow || event.key === STORE_KEYS.mute) {
    applyMute();
    syncFollowButtons();
    void countFollowNew(true);
  } else if (event.key === STORE_KEYS.display) {
    applyDisplay(loadDisplay());
  }
});

// 通知をオンにしている人は、1日に1回、サーバーの設定をこのブラウザの設定にそろえる（購読が作り直されたときなどのため）
if (apiBase && loadPushLocal().enabled && Date.now() - (loadPushLocal().syncedAt ?? 0) > 24 * 60 * 60_000) {
  setTimeout(() => void syncPush(base, apiBase).catch(() => undefined), 3000);
}
