/**
 * 管理画面の各ページで共通の処理（要素を作る・状態の表示・管理画面用データの読み込み・GitHub への保存・
 * サイトの更新（GitHub Actions）の実行状況・アクセス解析と通知のサーバーへの問い合わせ）
 */
import { createGitHubClient, GitHubError, type Repository, type WorkflowRun } from '../lib/github-commit.ts';

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setStatus(target: HTMLElement, text: string, kind: 'ok' | 'error' | '' = ''): void {
  target.textContent = text;
  target.className = `status ${kind}`.trim();
}

/** エラーの説明。トークンが使えなくなったときは、設定し直す方法も伝える */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof GitHubError && error.status === 401
    ? `${message}。ログアウトして、ログインページの「保存したトークンを消してやり直す」から設定し直してください`
    : message;
}

export const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const numberFormat = new Intl.NumberFormat('ja-JP');

/** 管理画面用データ（/admin/data.json。サイトのビルドのときに作る）のうち、ここで使うもの */
export interface AdminArticleInfo {
  id: string;
  title: string;
  url: string;
  category: string;
  sourceId: string;
  publishedAt: string;
  site: string;
  coverage?: number;
  /** 同じ話題（同じ出来事を報じた記事のまとまり）のキー */
  topic?: string;
}

export interface AdminDataCommon {
  generatedAt: string;
  siteName: string;
  repository: Repository;
  categories: { slug: string; name: string }[];
  pending: AdminArticleInfo[];
  /** generator は AI が自動で作った要約のモデル、updatedAt は手直しした日時 */
  summarized: (AdminArticleInfo & { summary: string; summarizedAt: string; generator?: string; updatedAt?: string })[];
  counts?: { items: number; itemsToday: number; summaries: number; summariesToday: number; sources: number };
  sources?: { id: string; name: string; category: string; siteUrl: string; count: number; latest: string | null; okAt?: string | null; failures?: number; error?: string | null }[];
}

const base = document.body.dataset.base ?? '';

export async function loadAdminData<T extends AdminDataCommon>(): Promise<T> {
  const res = await fetch(`${base}/admin/data.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

export function githubClient(token: string, repository: Repository): GitHubClient {
  return createGitHubClient(token, repository);
}

/** GitHub の Actions の画面へのリンク（保存のあとの案内に使う） */
export function actionsLink(repository: Repository): HTMLAnchorElement {
  const link = el('a', '', '実行状況（GitHub）');
  link.href = `https://github.com/${repository.owner}/${repository.repo}/actions`;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

// ===== アクセス解析・通知のサーバー（サイトの /api） =====

/** アクセス解析・通知のサーバーの場所（設定されていなければ空） */
export const analyticsEndpoint = document.body.dataset.analytics ?? '';

export async function serverApi<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${analyticsEndpoint}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (res.status === 401) throw new Error('GitHub のトークンを確認できませんでした。ログインし直してください');
  if (!res.ok) {
    const message = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
    throw new Error(message || `サーバーが応答しません（HTTP ${res.status}）`);
  }
  return data as T;
}

// ===== サイトの更新（GitHub Actions のワークフロー） =====

export const UPDATE_WORKFLOW = 'update.yml';
const TIMER_WORKFLOW = 'timer.yml';
const RUN_EVENTS: Record<string, string> = {
  schedule: '定期更新',
  workflow_dispatch: '手動実行',
  push: '変更の反映',
};

/** 自動更新タイマーが実行したもの（Actions のトークンで実行される） */
const runLabel = (run: WorkflowRun) =>
  run.event === 'workflow_dispatch' && run.triggering_actor?.login === 'github-actions[bot]' ? '自動更新' : (RUN_EVENTS[run.event] ?? run.event);

export function runState(run: WorkflowRun): { text: string; kind: 'ok' | 'error' | 'active' | '' } {
  if (run.status !== 'completed') {
    return { text: ['queued', 'pending', 'waiting', 'requested'].includes(run.status) ? '待機中' : '実行中', kind: 'active' };
  }
  switch (run.conclusion) {
    case 'success':
      return { text: '成功', kind: 'ok' };
    case 'cancelled':
      return { text: 'キャンセル', kind: '' };
    case 'skipped':
      return { text: 'スキップ', kind: '' };
    default:
      return { text: '失敗', kind: 'error' };
  }
}

export interface RunsPanel {
  render(): Promise<WorkflowRun[]>;
}

/** 最近の実行・自動更新タイマーの状況・「今すぐ更新」のボタン */
export function setupRunsPanel(options: {
  client: () => GitHubClient;
  list: HTMLUListElement;
  timer: HTMLElement;
  button: HTMLButtonElement;
  status: HTMLElement;
  refresh?: HTMLButtonElement;
  onRuns?: (runs: WorkflowRun[]) => void;
}): RunsPanel {
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function renderTimer(updateRuns: WorkflowRun[]) {
    try {
      const timers = await options.client().listWorkflowRuns(TIMER_WORKFLOW, 5);
      const active = timers.some((run) => run.status !== 'completed');
      const last = updateRuns[0] ? Date.parse(updateRuns[0].created_at) : undefined;
      const next = last ? `（次の更新は ${dateFormat.format(new Date(last + 60 * 60 * 1000))} ごろ）` : '';
      options.timer.textContent = active ? `自動更新: 動作中${next}` : '自動更新: 停止中です。「今すぐ更新」を押すと、更新と一緒に自動更新も再開します。';
      options.timer.className = `timer-status ${active ? 'ok' : 'error'}`;
    } catch {
      // タイマーの状況が読めなくても、ほかの表示は続ける
      options.timer.textContent = '';
    }
  }

  async function render(): Promise<WorkflowRun[]> {
    clearTimeout(timer);
    try {
      const runs = await options.client().listWorkflowRuns(UPDATE_WORKFLOW, 6);
      options.list.replaceChildren(
        ...runs.map((run) => {
          const state = runState(run);
          const link = el('a', '', '詳細');
          link.href = run.html_url;
          link.target = '_blank';
          link.rel = 'noopener';
          const item = el('li');
          item.append(el('span', `run-state ${state.kind}`.trim(), state.text), el('span', '', runLabel(run)), el('span', 'pick-meta', dateFormat.format(new Date(run.created_at))), link);
          return item;
        }),
      );
      if (runs.length === 0) options.list.append(el('li', 'pick-meta', 'まだ実行されていません。'));
      // 実行中のものがあれば、終わるまで自動で状況を更新する
      if (runs.some((run) => run.status !== 'completed')) timer = setTimeout(() => void render(), 15_000);
      options.onRuns?.(runs);
      await renderTimer(runs);
      return runs;
    } catch (error) {
      options.list.replaceChildren(el('li', 'pick-meta', `実行状況を読み込めませんでした: ${errorText(error)}`));
      return [];
    }
  }

  options.button.addEventListener('click', async () => {
    options.button.disabled = true;
    setStatus(options.status, '実行を依頼しています…');
    try {
      const client = options.client();
      const { defaultBranch } = await client.repository();
      await client.dispatchWorkflow(UPDATE_WORKFLOW, defaultBranch);
      setStatus(options.status, '更新を開始しました。2〜3分ほどでサイトに反映されます。', 'ok');
      // 実行が一覧に現れるまで少しかかる
      setTimeout(() => void render(), 4000);
    } catch (error) {
      setStatus(options.status, `実行できませんでした: ${errorText(error)}`, 'error');
    } finally {
      // 連打で何度も実行しないよう、少し待ってから押せるようにする
      setTimeout(() => (options.button.disabled = false), 5000);
    }
  });
  options.refresh?.addEventListener('click', () => void render());
  return { render };
}

/** 「接続を確認」のボタン（トークンでリポジトリに書き込めるか） */
export function setupConnectionCheck(options: { button: HTMLButtonElement; status: HTMLElement; badge: HTMLElement; client: () => GitHubClient; onOk?: () => void }): void {
  options.button.addEventListener('click', async () => {
    setStatus(options.status, '確認しています…');
    try {
      const { defaultBranch, canPush } = await options.client().repository();
      if (canPush) {
        setStatus(options.status, `接続できました。保存先: ${defaultBranch} ブランチ`, 'ok');
        options.badge.textContent = '接続OK';
        options.onOk?.();
      } else {
        setStatus(options.status, '読み取りはできますが、書き込み権限がありません（Contents の Read and write が必要です）', 'error');
      }
    } catch (error) {
      setStatus(options.status, errorText(error), 'error');
    }
  });
}
