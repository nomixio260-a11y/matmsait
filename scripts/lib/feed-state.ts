/**
 * 収集元ごとの取得の状態（data/feeds.json）。
 * - 前回の ETag / Last-Modified を覚えておき、変わっていなければ本文を受け取らない（条件付きリクエスト）
 * - 連続で失敗した回数と最後のエラーを残し、管理画面の「収集元の状況」で確認できるようにする
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FeedState {
  /** 前回の応答の ETag */
  etag?: string;
  /** 前回の応答の Last-Modified */
  lastModified?: string;
  /** 最後に取得できた日時（変更なし＝304 を含む） */
  okAt?: string;
  /** 最後に本文を受け取った日時（200） */
  fetchedAt?: string;
  /** 連続で失敗している回数（成功すると 0 に戻る） */
  failures: number;
  /** 最後に失敗した日時とエラー（成功しても、次に失敗するまで残す） */
  failedAt?: string;
  error?: string;
  /** 最後に本文を受け取ったときの記事数 */
  count?: number;
}

export type FeedStates = Record<string, FeedState>;

/** 本文を受け取らずに済ませるのは、最後に本文を受け取ってからこの時間まで（サーバーの不具合に備えて時々は全部取る） */
export const FULL_FETCH_AFTER_MS = 12 * 60 * 60 * 1000;

export function readFeedStates(path: string): FeedStates {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as FeedStates) : {};
  } catch {
    return {};
  }
}

/** 収集元の ID 順に並べて書き出す（差分が見やすいように） */
export function writeFeedStates(path: string, states: FeedStates): void {
  const sorted = Object.fromEntries(Object.entries(states).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** ブラウザが再読み込みのときに送るのと同じ、条件付きリクエストのヘッダー */
export function conditionalHeaders(state: FeedState | undefined, now: Date): [string, string][] {
  if (!state?.fetchedAt || now.getTime() - Date.parse(state.fetchedAt) > FULL_FETCH_AFTER_MS) return [];
  return [
    ...(state.etag ? ([['If-None-Match', state.etag]] as [string, string][]) : []),
    ...(state.lastModified ? ([['If-Modified-Since', state.lastModified]] as [string, string][]) : []),
  ];
}

export interface FetchOutcome {
  /** 304（前回から変わっていない） */
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  count?: number;
}

export function recordSuccess(previous: FeedState | undefined, outcome: FetchOutcome, now: Date): FeedState {
  const at = now.toISOString();
  if (outcome.notModified) {
    return { ...previous, okAt: at, failures: 0 };
  }
  const { etag: _etag, lastModified: _lastModified, ...rest } = previous ?? { failures: 0 };
  return {
    ...rest,
    ...(outcome.etag ? { etag: outcome.etag } : {}),
    ...(outcome.lastModified ? { lastModified: outcome.lastModified } : {}),
    okAt: at,
    fetchedAt: at,
    failures: 0,
    count: outcome.count,
  };
}

export function recordFailure(previous: FeedState | undefined, error: string, now: Date): FeedState {
  return { ...previous, failures: (previous?.failures ?? 0) + 1, failedAt: now.toISOString(), error };
}
