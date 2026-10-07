/**
 * アクセス解析のサーバー（analytics/ の Cloudflare Worker）の接続先。ビルド時とスクリプト（scripts/popular.ts）で使う。
 * 接続先は PUBLIC_ANALYTICS_URL（環境変数）、なければ data/analytics.json（アクセス解析の公開のワークフローが書く）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** アクセス解析のサーバーの接続先（公開のワークフローが書く） */
export const ANALYTICS_PATH = 'data/analytics.json';
/** よく読まれている記事（自動更新のたびにサーバーから取ってくる） */
export const POPULAR_PATH = 'data/popular.json';

/** 接続先として正しい URL のオリジン（https か、試験用の http://localhost・127.0.0.1。パスなし）。正しくなければ空 */
export function cleanEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if ((url.protocol !== 'https:' && !local) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

let cached: string | undefined;

/** アクセス解析のサーバーの接続先（設定されていなければ空。空ならサイトは計測しない） */
export function analyticsEndpoint(override: string | undefined = process.env.PUBLIC_ANALYTICS_URL): string {
  const fromEnv = cleanEndpoint(override || process.env.PUBLIC_ANALYTICS_URL);
  if (fromEnv) return fromEnv;
  if (cached === undefined) {
    const path = resolve(process.cwd(), ANALYTICS_PATH);
    try {
      cached = existsSync(path) ? cleanEndpoint((JSON.parse(readFileSync(path, 'utf8')) as { endpoint?: unknown }).endpoint) : '';
    } catch {
      cached = '';
    }
  }
  return cached;
}
