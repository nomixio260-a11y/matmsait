/**
 * 記事の本文の自動取得の依頼と結果（管理画面と収集の処理の両方で使う）。
 * - 依頼: 管理画面が data/text-requests.json に書く（AI が開けなかった記事など）
 * - 結果: 収集の処理（scripts/fetch-texts.ts）が data/texts.json に書く。本文は運営者の公開鍵で暗号化してある
 * - 公開鍵: 管理画面が data/text-keys.json に書く
 */
import type { EncryptedText, PublicTextKey } from './text-crypto.ts';

export const TEXT_REQUESTS_PATH = 'data/text-requests.json';
export const TEXTS_PATH = 'data/texts.json';
export const TEXT_KEYS_PATH = 'data/text-keys.json';

/** 依頼と結果を残す日数 */
export const TEXT_RETENTION_DAYS = 14;
/** 残しておく依頼の数の上限 */
export const TEXT_REQUEST_LIMIT = 100;
/** 登録しておく公開鍵の数の上限（端末ごとに鍵があるため、新しいものから） */
export const TEXT_KEY_LIMIT = 5;
/**
 * 本文の取り方の版。取り方を改善したら上げると、前の版で本文を取れなかった記事（本文なし・取得の失敗）を1回だけ取り直す
 * （2: 続きのページ・「全文を読む」の先・記事本体へのリンク・AMP 版・WordPress の API をたどる、本文の候補を比べて選ぶ、など）
 */
export const TEXT_FETCH_VERSION = 2;
/** 一時的な失敗（通信の失敗・サイトの一時的なエラー）を取り直すまでの時間と、試す回数の上限 */
export const TEXT_RETRY_AFTER_MS = 30 * 60 * 1000;
export const TEXT_MAX_TRIES = 3;

export interface TextRequest {
  id: string;
  url: string;
  sourceId: string;
  requestedAt: string;
}

export type TextStatus = 'ok' | 'robots' | 'ai-optout' | 'blocked' | 'not-found' | 'no-text' | 'error';

export interface TextResult {
  id: string;
  url: string;
  status: TextStatus;
  /** 取得できなかった理由の詳しい説明（HTTP の状態など） */
  detail?: string;
  fetchedAt: string;
  /** 本文の文字数（取得できたとき） */
  length?: number;
  /** 暗号化した本文（取得できたとき） */
  enc?: EncryptedText;
  /** 取り方の版（TEXT_FETCH_VERSION。ないものは 1） */
  v?: number;
  /** 同じ依頼を試した回数（一時的な失敗の取り直しを数える。ないものは 1） */
  tries?: number;
}

export interface TextsFile {
  updatedAt: string;
  items: TextResult[];
}

/** 結果の説明（管理画面に出す） */
export const TEXT_STATUS_LABELS: Record<TextStatus, string> = {
  ok: '本文を自動で取得しました',
  robots: 'サイトが robots.txt で自動取得を断っているため、取得しませんでした',
  'ai-optout': 'サイトが AI での利用を断っている（robots.txt・noai）ため、取得しませんでした',
  blocked: 'サイトが自動取得を拒否しました',
  'not-found': '記事のページが見つかりませんでした',
  'no-text': '本文を見つけられませんでした（動画・画像が中心のページ、JavaScript で本文を出すページなど）',
  error: '取得できませんでした',
};

const DAY = 24 * 60 * 60 * 1000;
const fresh = (at: string, now: number) => now - Date.parse(at) < TEXT_RETENTION_DAYS * DAY;

/** その結果の記事を、もう一度取りに行くか（依頼し直されたとき以外） */
export function shouldRetry(result: TextResult, now: number): boolean {
  // 取り方を改善したら、前の版で本文を取れなかった記事を1回だけ取り直す（拒否・ページなしは取り直さない）
  if ((result.status === 'no-text' || result.status === 'error') && (result.v ?? 1) < TEXT_FETCH_VERSION) return true;
  // 一時的な失敗は、時間を空けて何回か取り直す
  return result.status === 'error' && (result.tries ?? 1) < TEXT_MAX_TRIES && now - Date.parse(result.fetchedAt) >= TEXT_RETRY_AFTER_MS;
}

/** まだ結果がない（または依頼し直された・取り直す）依頼。古い順 */
export function pendingRequests(requests: TextRequest[], results: TextResult[], now: number): TextRequest[] {
  const latest = new Map(results.map((result) => [result.id, result]));
  return requests
    .filter((request) => fresh(request.requestedAt, now))
    .filter((request) => {
      const result = latest.get(request.id);
      return !result || result.fetchedAt < request.requestedAt || shouldRetry(result, now);
    })
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** 依頼を足す（同じ記事は新しい依頼の日時にし、古い依頼と多すぎる依頼は外す） */
export function mergeTextRequests(current: TextRequest[], additions: TextRequest[], now: number): TextRequest[] {
  const byId = new Map(current.map((request) => [request.id, request]));
  for (const request of additions) {
    const existing = byId.get(request.id);
    if (!existing || existing.requestedAt < request.requestedAt) byId.set(request.id, request);
  }
  return [...byId.values()]
    .filter((request) => fresh(request.requestedAt, now))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, TEXT_REQUEST_LIMIT);
}

/** 結果をまとめる（同じ記事は新しく取得した方を残す）。古い結果と、要らなくなった記事（keep が false）の結果は外す */
export function mergeTextResults(
  lists: TextResult[][],
  { now, keep = () => true }: { now: number; keep?: (id: string) => boolean },
): TextResult[] {
  const byId = new Map<string, TextResult>();
  for (const list of lists) {
    for (const result of list) {
      const existing = byId.get(result.id);
      if (!existing || existing.fetchedAt < result.fetchedAt) byId.set(result.id, result);
    }
  }
  return [...byId.values()]
    .filter((result) => fresh(result.fetchedAt, now) && keep(result.id))
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

/** 公開鍵を足す（同じ鍵は1つにし、新しいものから上限まで） */
export function mergeTextKeys(current: PublicTextKey[], key: PublicTextKey): PublicTextKey[] {
  return [key, ...current.filter((existing) => existing.kid !== key.kid)]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, TEXT_KEY_LIMIT);
}

/** JSON のファイルを読む（ない・壊れているときは既定値） */
export function parseJsonList<T>(text: string | undefined, pick: (data: unknown) => T[]): T[] {
  if (!text) return [];
  try {
    return pick(JSON.parse(text));
  } catch {
    return [];
  }
}

export const pickRequests = (data: unknown): TextRequest[] =>
  Array.isArray(data)
    ? data.filter(
        (entry): entry is TextRequest =>
          !!entry && typeof entry.id === 'string' && typeof entry.url === 'string' && typeof entry.requestedAt === 'string',
      )
    : [];

export const pickResults = (data: unknown): TextResult[] => {
  const items = (data as Partial<TextsFile> | null)?.items;
  return Array.isArray(items)
    ? items.filter((entry): entry is TextResult => !!entry && typeof entry.id === 'string' && typeof entry.status === 'string')
    : [];
};

export const pickKeys = (data: unknown): PublicTextKey[] =>
  Array.isArray(data)
    ? data.filter((entry): entry is PublicTextKey => !!entry && typeof entry.kid === 'string' && typeof entry.publicKey === 'string')
    : [];

/** ファイルに書く形（1件1行で、差分が見やすいように） */
export function serializeLines(items: unknown[]): string {
  return items.length === 0 ? '[]\n' : `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
}

export function serializeTextsFile(file: TextsFile): string {
  return `{"updatedAt":${JSON.stringify(file.updatedAt)},"items":${serializeLines(file.items).trimEnd()}}\n`;
}
