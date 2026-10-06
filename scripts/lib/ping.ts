/** 検索エンジン・フィード購読者への更新通知（IndexNow / WebSub） */
import { WEBSUB_HUB } from '../../src/lib/websub.ts';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/**
 * IndexNow に送る内容を作る。鍵ファイルはサイトのベースURL直下に置いているので、
 * サブディレクトリ（GitHub Pages のプロジェクトサイト）でも配下のURLを送信できる。
 */
export function indexNowPayload(baseUrl: string, key: string, paths: string[]): IndexNowPayload {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    host: new URL(base).host,
    key,
    keyLocation: `${base}/${key}.txt`,
    urlList: [...new Set(paths.map((path) => `${base}${path}`))],
  };
}

/** Bing などへ更新を知らせる。成功なら HTTP ステータスを返す */
export async function submitIndexNow(payload: IndexNowPayload): Promise<number> {
  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`IndexNow: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  return res.status;
}

/** WebSub ハブにフィードの更新を知らせる（フィードリーダーへすぐ届く） */
export async function publishWebSub(feedUrl: string): Promise<void> {
  const res = await fetch(WEBSUB_HUB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': feedUrl }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 204 && res.status !== 200) throw new Error(`WebSub: HTTP ${res.status} (${feedUrl})`);
}
