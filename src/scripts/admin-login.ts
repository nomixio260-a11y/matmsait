/**
 * 管理画面のログインページ
 * - 初回: GitHub のトークンを確かめ（このリポジトリに書き込めるか）、自動で取得した本文を読むための鍵を作り、
 *   トークンと鍵をパスワードで暗号化して保存してログイン
 * - 2回目から: パスワードでトークンと鍵を取り出し、トークンがまだ使えるかを確かめてログイン
 *   （以前の版で保存した、鍵のない保存内容には、ここで鍵を足して保存し直す）
 */
import {
  LEGACY_TOKEN_KEY,
  clearFailures,
  createVault,
  currentSession,
  deleteVault,
  loadVault,
  lockRemaining,
  openVault,
  passwordProblem,
  recordFailure,
  saveVault,
  startSession,
} from '../lib/admin-auth.ts';
import { createGitHubClient, GitHubError } from '../lib/github-commit.ts';
import { generateTextKeyPair, type TextKeyPair } from '../lib/text-crypto.ts';
import { base } from './admin-common.ts';

const root = document.querySelector<HTMLElement>('[data-login]')!;
const repository = { owner: root.dataset.owner ?? '', repo: root.dataset.repo ?? '' };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const notice = $('login-notice');
const loginCard = $('login-form-card');
const setupCard = $('setup-card');

function setStatus(target: HTMLElement, text: string, kind: 'ok' | 'error' | '' = '') {
  target.textContent = text;
  target.className = `status ${kind}`.trim();
}

/** ログイン後に開くページ（管理画面の中だけ。ほかのサイトへは移らない） */
function nextUrl(): string {
  const next = new URLSearchParams(location.search).get('next') ?? '';
  return next.startsWith(`${base}/admin/`) && !next.startsWith(`${base}/admin/login`) && !next.includes('//')
    ? next
    : `${base}/admin/`;
}

/** トークンでこのリポジトリに書き込めるかを確かめ、GitHub のユーザー名を返す */
async function verifyToken(token: string): Promise<string> {
  const client = createGitHubClient(token, repository);
  const { canPush } = await client.repository();
  if (!canPush) throw new Error('このトークンにはリポジトリへの書き込み権限がありません（Contents の Read and write が必要です）');
  try {
    return (await client.user()).login;
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  if (error instanceof GitHubError && error.status === 401) {
    return 'GitHub のトークンが無効です（期限切れ・削除済みの可能性があります）。トークンを作り直して設定し直してください。';
  }
  return error instanceof Error ? error.message : String(error);
}

function showNotice(text: string, kind: '' | 'error' = '') {
  notice.textContent = text;
  notice.className = `notice ${kind}`.trim();
  notice.hidden = false;
}

function finish(token: string, login: string, textKey: TextKeyPair) {
  clearFailures(localStorage);
  startSession(sessionStorage, token, login, Date.now(), textKey);
  location.replace(nextUrl());
}

// ===== 2回目から: パスワードでログイン =====

function showLogin() {
  setupCard.hidden = true;
  loginCard.hidden = false;
  const form = $<HTMLFormElement>('login-form');
  const password = $<HTMLInputElement>('login-password');
  const status = $('login-status');
  const button = form.querySelector('button')!;
  password.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const wait = lockRemaining(localStorage, Date.now());
    if (wait > 0) {
      setStatus(status, `パスワードを続けて間違えたため、${Math.ceil(wait / 1000)}秒後にもう一度お試しください。`, 'error');
      return;
    }
    const vault = loadVault(localStorage);
    if (!vault) {
      location.reload();
      return;
    }
    button.disabled = true;
    setStatus(status, '確認しています…');
    let secrets: Awaited<ReturnType<typeof openVault>>;
    try {
      secrets = await openVault(vault, password.value);
    } catch {
      const failures = recordFailure(localStorage, Date.now());
      const locked = failures.lockedUntil > Date.now();
      setStatus(
        status,
        locked
          ? `パスワードが違います。続けて間違えたため、${Math.ceil((failures.lockedUntil - Date.now()) / 1000)}秒間はログインできません。`
          : 'パスワードが違います。',
        'error',
      );
      password.select();
      button.disabled = false;
      return;
    }
    try {
      const login = await verifyToken(secrets.token);
      let { textKey } = secrets;
      if (!textKey) {
        // 以前の版で保存した内容には本文を読む鍵がないので、作って保存し直す
        setStatus(status, '自動で取得した本文を読むための鍵を作っています…');
        textKey = await generateTextKeyPair();
        saveVault(localStorage, await createVault({ token: secrets.token, textKey }, password.value, { login: login || vault.login }));
      }
      finish(secrets.token, login || vault.login || '', textKey);
    } catch (error) {
      setStatus(status, describe(error), 'error');
      button.disabled = false;
    }
  });

  $('reset-vault').addEventListener('click', () => {
    if (!confirm('このブラウザに保存したトークンを消して、最初の設定からやり直しますか？')) return;
    deleteVault(localStorage);
    clearFailures(localStorage);
    location.replace(`${base}/admin/login/`);
  });
}

// ===== 初回: トークンとパスワードを設定 =====

function showSetup() {
  loginCard.hidden = true;
  setupCard.hidden = false;
  const form = $<HTMLFormElement>('setup-form');
  const tokenInput = $<HTMLInputElement>('setup-token');
  const password = $<HTMLInputElement>('setup-password');
  const confirmInput = $<HTMLInputElement>('setup-confirm');
  const status = $('setup-status');
  const button = form.querySelector('button')!;

  // 以前の版で暗号化せずに保存したトークンがあれば入れておく（設定が終わると消える）
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) {
      tokenInput.value = legacy;
      $('legacy-note').hidden = false;
      password.focus();
    } else {
      tokenInput.focus();
    }
  } catch {
    tokenInput.focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = tokenInput.value.trim();
    const problem = passwordProblem(password.value, confirmInput.value);
    if (!token) {
      setStatus(status, 'トークンを入力してください。', 'error');
      return;
    }
    if (problem) {
      setStatus(status, problem, 'error');
      return;
    }
    button.disabled = true;
    setStatus(status, 'GitHub に接続して確認しています…');
    try {
      const login = await verifyToken(token);
      setStatus(status, 'トークンと、自動で取得した本文を読むための鍵を暗号化して保存しています…');
      const textKey = await generateTextKeyPair();
      saveVault(localStorage, await createVault({ token, textKey }, password.value, { login }));
      finish(token, login, textKey);
    } catch (error) {
      setStatus(status, describe(error), 'error');
      button.disabled = false;
    }
  });
}

// ===== 起動 =====

const reason = new URLSearchParams(location.search).get('reason');
if (reason === 'timeout') showNotice('しばらく操作がなかったため、ログアウトしました。もう一度ログインしてください。');
if (reason === 'logout') showNotice('ログアウトしました。');

if (currentSession(sessionStorage, Date.now())) {
  location.replace(nextUrl());
} else if (loadVault(localStorage)) {
  showLogin();
} else {
  showSetup();
}
