/**
 * 運営者が管理画面から載せるもの（サイトのビルドと管理画面で共通）
 * - お知らせ（data/notice.json）: サイトの上部に出す短いお知らせ（掲載期間つき）
 * - ピックアップ（data/picks.json）: 編集部のおすすめ記事と、運営者のひとこと（トップページに出す）
 */

export const NOTICE_PATH = 'data/notice.json';
export const PICKS_PATH = 'data/picks.json';

export type NoticeLevel = 'info' | 'important';

export interface Notice {
  /** 閉じたことを覚えておくための番号（内容を変えるたびに変わる） */
  id: string;
  /** 本文（120文字まで） */
  text: string;
  /** 詳しくはこちら（サイト内のパスか https の URL） */
  url?: string;
  level: NoticeLevel;
  /** 掲載期間（ISO 8601） */
  start: string;
  end: string;
  updatedAt: string;
}

export interface EditorPick {
  /** 記事 ID */
  id: string;
  /** 運営者のひとこと（200文字まで。空でもよい） */
  comment: string;
  /** 選んだ日時 */
  at: string;
  /** この日時まで載せる */
  until: string;
}

export const NOTICE_MAX = 120;
export const COMMENT_MAX = 200;
export const PICKS_MAX = 10;

const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
/** 制御文字を除き、前後の空白を取る */
const cleanText = (value: unknown, max: number) =>
  typeof value === 'string'
    ? Array.from(value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim())
        .slice(0, max)
        .join('')
    : '';

/** お知らせのリンク先として使える URL（サイト内のパスか https）。使えなければ空 */
export function cleanLink(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (/^\/(?!\/)[^\s\\]*$/.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

/** お知らせを確かめる（正しくなければ undefined） */
export function cleanNotice(value: unknown): Notice | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const text = cleanText(v.text, NOTICE_MAX);
  if (!text || !isDate(v.start) || !isDate(v.end) || Date.parse(v.end) <= Date.parse(v.start)) return undefined;
  const url = cleanLink(v.url);
  return {
    id: typeof v.id === 'string' && /^[a-z0-9-]{1,40}$/.test(v.id) ? v.id : 'notice',
    text,
    ...(url ? { url } : {}),
    level: v.level === 'important' ? 'important' : 'info',
    start: new Date(v.start).toISOString(),
    end: new Date(v.end).toISOString(),
    updatedAt: isDate(v.updatedAt) ? new Date(v.updatedAt).toISOString() : new Date(v.start).toISOString(),
  };
}

export function parseNotice(text: string | null | undefined): Notice | undefined {
  if (!text) return undefined;
  try {
    return cleanNotice(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** いま載せるお知らせ（掲載期間のうちだけ） */
export function activeNotice(notice: Notice | undefined, now: number): Notice | undefined {
  return notice && Date.parse(notice.start) <= now && now < Date.parse(notice.end) ? notice : undefined;
}

export function serializeNotice(notice: Notice): string {
  return `${JSON.stringify(notice, null, 2)}\n`;
}

/** 内容から、お知らせの番号を作る（内容を変えると、閉じた人にもまた出る） */
export function noticeId(notice: Omit<Notice, 'id'>): string {
  let hash = 0;
  for (const char of `${notice.text}|${notice.url ?? ''}|${notice.level}|${notice.start}`) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `n${(hash >>> 0).toString(36)}`;
}

/** ピックアップを確かめる（形の正しいもの・同じ記事は1つ・上限まで） */
export function cleanPicks(value: unknown): EditorPick[] {
  if (!Array.isArray(value)) return [];
  const out: EditorPick[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const v = entry as Record<string, unknown>;
    if (typeof v.id !== 'string' || !/^[0-9a-f]{16}$/.test(v.id) || ids.has(v.id) || !isDate(v.at) || !isDate(v.until)) continue;
    ids.add(v.id);
    out.push({ id: v.id, comment: cleanText(v.comment, COMMENT_MAX), at: new Date(v.at).toISOString(), until: new Date(v.until).toISOString() });
    if (out.length >= PICKS_MAX) break;
  }
  return out;
}

export function parsePicks(text: string | null | undefined): EditorPick[] {
  if (!text) return [];
  try {
    return cleanPicks(JSON.parse(text));
  } catch {
    return [];
  }
}

/** いま載せるピックアップ（期限が過ぎていないもの。並びは運営者が決めた順） */
export function activePicks(picks: EditorPick[], now: number): EditorPick[] {
  return picks.filter((pick) => Date.parse(pick.until) > now);
}

export function serializePicks(picks: EditorPick[]): string {
  return `${JSON.stringify(cleanPicks(picks), null, 2)}\n`;
}
