/**
 * アクセス解析の接続先。ビルド時とスクリプト（scripts/popular.ts）で使う。
 * 公開しているサイト（Cloudflare Pages）では、サイトと同じドメインの /api（Pages の Functions）を使う。
 * 接続先は環境変数 PUBLIC_ANALYTICS_URL で指定する（公開のワークフローが Cloudflare に公開するときに /api を入れる。
 * 手元で analytics/ の Worker を wrangler dev で動かして試すときは http://127.0.0.1:8787）。指定がなければ計測しない
 */

/** よく読まれている記事（自動更新のたびにサーバーから取ってくる） */
export const POPULAR_PATH = 'data/popular.json';

/**
 * 接続先として正しいもの。サイトと同じドメインのパス（例: /api）か、
 * https（試験用の http://localhost・127.0.0.1 も可）のオリジン（パスなし）。正しくなければ空
 */
export function cleanEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.trim();
  if (text.startsWith('/')) return /^(\/[a-z0-9_-]+)+$/.test(text) ? text : '';
  try {
    const url = new URL(text);
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if ((url.protocol !== 'https:' && !local) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

/** アクセス解析の接続先（設定されていなければ空。空ならサイトは計測しない） */
export function analyticsEndpoint(override: string | undefined = process.env.PUBLIC_ANALYTICS_URL): string {
  return cleanEndpoint(override || process.env.PUBLIC_ANALYTICS_URL);
}

/** 接続先がほかのオリジンなら、そのオリジン（管理画面の CSP の接続先に加える。同じドメインのパスなら空） */
export function analyticsOrigin(endpoint: string): string {
  return endpoint.startsWith('/') ? '' : endpoint;
}
