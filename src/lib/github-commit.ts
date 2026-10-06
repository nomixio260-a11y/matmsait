/**
 * GitHub API でファイルをまとめて1つのコミットにする（管理画面から要約を保存するため）。
 * 毎時の自動更新が同じブランチにコミットしていても、最新の状態を読み直して再試行する。
 */

export interface Repository {
  owner: string;
  repo: string;
}

export interface FileChange {
  path: string;
  content: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** トークンに必要な権限の名前（エラーの説明に使う） */
type Permission = 'Contents' | 'Actions';

function describe(status: number, body: string, permission: Permission = 'Contents'): string {
  let message = '';
  try {
    message = (JSON.parse(body) as { message?: string }).message ?? '';
  } catch {
    message = body.slice(0, 200);
  }
  switch (status) {
    case 401:
      return 'トークンが無効か、有効期限が切れています';
    case 403:
      return /rate limit/i.test(message)
        ? 'GitHub API の利用回数の上限に達しました。しばらく待ってから再度お試しください'
        : `このトークンには権限がありません（${permission} の Read and write が必要です）`;
    case 404:
      return 'リポジトリが見つからないか、トークンにアクセス権がありません';
    default:
      return `GitHub API エラー（HTTP ${status}）${message ? `: ${message}` : ''}`;
  }
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function createGitHubClient(token: string, { owner, repo }: Repository, fetchImpl: typeof fetch = fetch) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function api(
    path: string,
    init: RequestInit & { accept?: string; permission?: Permission } = {},
  ): Promise<Response> {
    const { accept, headers, permission, ...rest } = init;
    const res = await fetchImpl(`${base}${path}`, {
      ...rest,
      headers: {
        Accept: accept ?? 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    });
    if (!res.ok) throw new GitHubError(describe(res.status, await res.text(), permission), res.status);
    return res;
  }

  async function json<T>(path: string, init?: RequestInit & { permission?: Permission }): Promise<T> {
    return (await (await api(path, init)).json()) as T;
  }

  /** 既定ブランチ、トークンで書き込めるか、非公開リポジトリかを調べる */
  async function repository(): Promise<{ defaultBranch: string; canPush: boolean; isPrivate: boolean }> {
    const data = await json<{ default_branch: string; private?: boolean; permissions?: { push?: boolean } }>('');
    return { defaultBranch: data.default_branch, canPush: data.permissions?.push === true, isPrivate: data.private === true };
  }

  /** あるコミット時点のファイルの中身。存在しなければ null */
  async function readFile(path: string, ref: string): Promise<string | null> {
    try {
      const res = await api(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
        accept: 'application/vnd.github.raw+json',
      });
      return await res.text();
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * ブランチの最新状態を読み、update が返したファイルで1つのコミットを作る。
   * 途中で他のコミットが入ったら（fast-forward できなければ）読み直してやり直す。
   */
  async function commitFiles(
    branch: string,
    message: string,
    update: (read: (path: string) => Promise<string | null>) => Promise<FileChange[]>,
    maxAttempts = 3,
  ): Promise<{ sha: string; changed: boolean }> {
    const refPath = `/git/refs/heads/${encodePath(branch)}`;
    for (let attempt = 1; ; attempt++) {
      const head = await json<{ object: { sha: string } }>(`/git/ref/heads/${encodePath(branch)}`);
      const headSha = head.object.sha;
      const commit = await json<{ tree: { sha: string } }>(`/git/commits/${headSha}`);
      const files = await update((path) => readFile(path, headSha));
      if (files.length === 0) return { sha: headSha, changed: false };

      const tree = await json<{ sha: string }>('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          base_tree: commit.tree.sha,
          tree: files.map(({ path, content }) => ({ path, mode: '100644', type: 'blob', content })),
        }),
      });
      const created = await json<{ sha: string }>('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
      });
      try {
        await api(refPath, { method: 'PATCH', body: JSON.stringify({ sha: created.sha, force: false }) });
        return { sha: created.sha, changed: true };
      } catch (error) {
        // 422: その間に別のコミットが入った（fast-forward できない）
        if (error instanceof GitHubError && error.status === 422 && attempt < maxAttempts) continue;
        throw error;
      }
    }
  }

  /** ワークフローを手動で実行する（workflow_dispatch。トークンに Actions の Read and write が必要） */
  async function dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string> = {}): Promise<void> {
    await api(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs }),
      permission: 'Actions',
    });
  }

  /** ワークフローの最近の実行（新しい順）。branch を指定するとそのブランチの実行だけ */
  async function listWorkflowRuns(workflow: string, perPage = 5, branch?: string): Promise<WorkflowRun[]> {
    const query = `per_page=${perPage}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
    const data = await json<{ workflow_runs: WorkflowRun[] }>(
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`,
      { permission: 'Actions' },
    );
    return data.workflow_runs.map(({ id, event, status, conclusion, created_at, updated_at, html_url, triggering_actor }) => ({
      id,
      event,
      status,
      conclusion,
      created_at,
      updated_at,
      html_url,
      ...(triggering_actor?.login ? { triggering_actor: { login: triggering_actor.login } } : {}),
    }));
  }

  return { repository, readFile, commitFiles, dispatchWorkflow, listWorkflowRuns };
}

export interface WorkflowRun {
  id: number;
  /** schedule / workflow_dispatch / push など */
  event: string;
  /** queued / in_progress / completed など */
  status: string;
  /** success / failure / cancelled など（完了前は null） */
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  /** 実行のきっかけを作ったユーザー（自動更新タイマーなら github-actions[bot]） */
  triggering_actor?: { login: string };
}
