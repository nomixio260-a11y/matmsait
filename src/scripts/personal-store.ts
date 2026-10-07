/**
 * 読者のブラウザにだけ保存する設定（フォロー・ミュート・表示・既読・通知の状態）。
 * サーバーには送らない（通知をオンにしたときだけ、フォローとミュートと受け取り方を通知のサーバーに送る）
 */
import { cleanFollow, cleanMute, emptyFollow, isEmptyPrefs, type FollowPrefs, type MutePrefs } from '../lib/follow-core.ts';

export const STORE_KEYS = {
  follow: 'matmsait:follow',
  mute: 'matmsait:mute',
  display: 'matmsait:display',
  read: 'matmsait:read',
  push: 'matmsait:push',
  following: 'matmsait:following',
  notice: 'matmsait:notice-dismissed',
} as const;

/** 設定が変わったときにページ内へ知らせるイベント（ほかのタブには storage イベントで伝わる） */
export const PREFS_EVENT = 'tp:prefs';

export function readStored<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): boolean {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 保存できない環境（プライベートブラウズなど）
    return false;
  }
}

const changed = (what: 'follow' | 'mute' | 'display' | 'read' | 'push') => window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { what } }));

// ===== フォロー・ミュート =====

export type FollowKind = 'cat' | 'src' | 'word';
const LIST: Record<FollowKind, keyof FollowPrefs> = { cat: 'cats', src: 'srcs', word: 'words' };

export function loadFollow(): FollowPrefs {
  return cleanFollow(readStored<unknown>(STORE_KEYS.follow, emptyFollow()));
}

export function loadMute(): MutePrefs {
  return cleanMute(readStored<unknown>(STORE_KEYS.mute, emptyFollow()));
}

export function saveFollow(follow: FollowPrefs): void {
  const clean = cleanFollow(follow);
  writeStored(STORE_KEYS.follow, clean);
  // はじめてフォローしたときは、その時点から後の記事を「新着」として数える
  const state = loadFollowingState();
  if (!state.seenAt && !isEmptyPrefs(clean)) saveFollowingState({ ...state, seenAt: Date.now() });
  changed('follow');
}

export function saveMute(mute: MutePrefs): void {
  writeStored(STORE_KEYS.mute, cleanMute(mute));
  changed('mute');
}

const sameWord = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

function has(list: string[], kind: FollowKind, value: string): boolean {
  return kind === 'word' ? list.some((entry) => sameWord(entry, value)) : list.includes(value);
}

export function isFollowing(kind: FollowKind, value: string): boolean {
  return has(loadFollow()[LIST[kind]], kind, value);
}

export function isMutedBy(kind: FollowKind, value: string): boolean {
  return has(loadMute()[LIST[kind]], kind, value);
}

function toggled(list: string[], kind: FollowKind, value: string, on: boolean): string[] {
  const rest = list.filter((entry) => (kind === 'word' ? !sameWord(entry, value) : entry !== value));
  return on ? [...rest, value] : rest;
}

/** フォローする・やめる。フォローした状態なら true */
export function setFollow(kind: FollowKind, value: string, on: boolean): boolean {
  const follow = loadFollow();
  saveFollow({ ...follow, [LIST[kind]]: toggled(follow[LIST[kind]], kind, value, on) });
  // フォローしたものは、ミュートしていれば外す
  if (on && isMutedBy(kind, value)) setMute(kind, value, false);
  return isFollowing(kind, value);
}

/** ミュートする・やめる。ミュートした状態なら true */
export function setMute(kind: FollowKind, value: string, on: boolean): boolean {
  const mute = loadMute();
  saveMute({ ...mute, [LIST[kind]]: toggled(mute[LIST[kind]], kind, value, on) });
  if (on && isFollowing(kind, value)) setFollow(kind, value, false);
  return isMutedBy(kind, value);
}

// ===== 「フォロー中」の新着の数え方 =====

export interface FollowingState {
  /** 「フォロー中」のページを最後に見た日時（これより後の記事を新着として数える） */
  seenAt?: number;
  /** ヘッダーに出す新着の数と、数えた日時・数えたときのビルド */
  count?: number;
  checkedAt?: number;
  builtAt?: string;
}

export function loadFollowingState(): FollowingState {
  const state = readStored<FollowingState>(STORE_KEYS.following, {});
  return typeof state === 'object' && state !== null ? state : {};
}

export function saveFollowingState(state: FollowingState): void {
  writeStored(STORE_KEYS.following, state);
}

// ===== 表示の設定 =====

export interface DisplayPrefs {
  /** 文字の大きさ */
  font: 'm' | 'l' | 'xl';
  /** 一覧に抜粋・要約を出す */
  excerpt: boolean;
  /** 読んだ記事: 印を付ける・一覧から隠す・何もしない */
  read: 'mark' | 'hide' | 'off';
}

export const DEFAULT_DISPLAY: DisplayPrefs = { font: 'm', excerpt: true, read: 'mark' };

export function loadDisplay(): DisplayPrefs {
  const stored = readStored<Partial<DisplayPrefs>>(STORE_KEYS.display, {});
  return {
    font: stored.font === 'l' || stored.font === 'xl' ? stored.font : 'm',
    excerpt: stored.excerpt !== false,
    read: stored.read === 'hide' || stored.read === 'off' ? stored.read : 'mark',
  };
}

/** 表示の設定をページに反映する（<html> の data-* 属性。最初の表示は BaseLayout の head のスクリプトが行う） */
export function applyDisplay(display: DisplayPrefs = loadDisplay()): void {
  const root = document.documentElement;
  if (display.font === 'm') delete root.dataset.font;
  else root.dataset.font = display.font;
  if (display.excerpt) delete root.dataset.excerpt;
  else root.dataset.excerpt = 'off';
  root.dataset.read = display.read;
}

export function saveDisplay(display: DisplayPrefs): void {
  writeStored(STORE_KEYS.display, display);
  applyDisplay(display);
  changed('display');
}

// ===== 既読 =====

/** 覚えておく既読の数（古いものから忘れる） */
const MAX_READ = 3000;

let readCache: string[] | undefined;

export function loadRead(): Set<string> {
  readCache ??= (() => {
    const list = readStored<unknown>(STORE_KEYS.read, []);
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)) : [];
  })();
  return new Set(readCache);
}

export function markRead(id: string, read = true): void {
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  const list = [...loadRead()].filter((entry) => entry !== id);
  readCache = read ? [id, ...list].slice(0, MAX_READ) : list;
  writeStored(STORE_KEYS.read, readCache);
  changed('read');
}

export function clearRead(): void {
  readCache = [];
  writeStored(STORE_KEYS.read, undefined);
  changed('read');
}

/** ほかのタブで変わったときに読み直す */
export function forgetReadCache(): void {
  readCache = undefined;
}
