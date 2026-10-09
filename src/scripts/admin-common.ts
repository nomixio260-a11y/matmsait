/**
 * 管理画面の共通処理（ログインページと管理画面の両方で読み込む）
 * - ほかのサイトの枠（iframe）の中では表示しない（見えない枠でボタンを押させる攻撃を防ぐ）
 * - 表示テーマ（サイトで選んだライト／ダーク）を反映する
 * - ログイン中の状態の確認、操作がないときの自動ログアウト
 */
import { IDLE_TIMEOUT, currentSession, endSession, touchSession, type Session } from '../lib/admin-auth.ts';

if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('管理画面はほかのサイトの中では表示できません');
}

try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // 保存できない環境ではシステムの設定のまま
}

// スマホの「メニュー」: 項目を押したとき・メニューの外を押したとき・Esc で閉じる（同じページの中へのリンクでは移動しないため）
for (const menu of document.querySelectorAll<HTMLDetailsElement>('.admin-menu')) {
  for (const link of menu.querySelectorAll('a')) link.addEventListener('click', () => (menu.open = false));
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
}

/** サイトのベースパス（/matmsait など）。各ページの <body data-base> に入れている */
export const base = document.body.dataset.base ?? '';

export const loginUrl = (next?: string, reason?: string) => {
  const params = new URLSearchParams();
  if (next) params.set('next', next);
  if (reason) params.set('reason', reason);
  const query = params.toString();
  return `${base}/admin/login/${query ? `?${query}` : ''}`;
};

/** ログインしていなければログインページへ移る。ログイン中ならその状態を返す */
export function requireSession(): Session | undefined {
  const session = currentSession(sessionStorage, Date.now());
  if (!session) {
    location.replace(loginUrl(location.pathname + location.search));
    return undefined;
  }
  return session;
}

/** ログアウトしてログインページへ */
export function logout(reason?: string): void {
  endSession(sessionStorage);
  location.replace(loginUrl(undefined, reason));
}

/**
 * 操作があるたびにログインの期限を延ばし、操作がないまま時間がたったら自動でログアウトする。
 * 表示中のログイン名とログアウトボタンも用意する
 */
export function watchSession(session: Session): void {
  for (const label of document.querySelectorAll<HTMLElement>('[data-admin-login]')) {
    label.textContent = session.login || 'ログイン中';
  }
  for (const box of document.querySelectorAll<HTMLElement>('[data-admin-user]')) box.hidden = false;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-logout]')) {
    button.addEventListener('click', () => logout('logout'));
  }
  let last = 0;
  const touch = () => {
    const now = Date.now();
    // 毎回書き込まないよう、15秒に1回だけ記録する
    if (now - last < 15_000) return;
    last = now;
    if (!touchSession(sessionStorage, now)) logout('timeout');
  };
  for (const type of ['pointerdown', 'keydown', 'scroll'] as const) {
    window.addEventListener(type, touch, { passive: true });
  }
  setInterval(() => {
    if (!currentSession(sessionStorage, Date.now())) logout('timeout');
  }, Math.min(60_000, IDLE_TIMEOUT / 10));
}
