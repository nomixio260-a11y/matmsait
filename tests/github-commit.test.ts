import { describe, expect, it } from 'vitest';
import { createGitHubClient, GitHubError } from '../src/lib/github-commit.ts';

interface Call {
  method: string;
  url: string;
  body?: unknown;
  accept?: string;
}

/** GitHub API のふりをする fetch。PATCH（ブランチ更新）を何回目で成功させるかを指定できる */
function fakeGitHub({ patchFailures = 0, files = {} as Record<string, string> } = {}) {
  const calls: Call[] = [];
  let head = 'head-1';
  let patchCount = 0;
  const respond = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, accept: headers.Accept });
    const path = url.replace('https://api.github.com/repos/owner/repo', '');
    if (path === '') return respond(200, { default_branch: 'main', permissions: { push: true } });
    if (path === '/git/ref/heads/main') return respond(200, { object: { sha: head } });
    if (path.startsWith('/git/commits/')) return respond(200, { tree: { sha: `tree-of-${path.split('/').pop()}` } });
    if (path.startsWith('/contents/')) {
      const file = decodeURIComponent(path.slice('/contents/'.length).split('?')[0]);
      return file in files ? respond(200, files[file]) : respond(404, { message: 'Not Found' });
    }
    if (path === '/git/trees') return respond(201, { sha: 'new-tree' });
    if (path === '/git/commits') return respond(201, { sha: `commit-on-${(JSON.parse(String(init.body)) as { parents: string[] }).parents[0]}` });
    if (path === '/git/refs/heads/main') {
      patchCount++;
      if (patchCount <= patchFailures) {
        head = `head-${patchCount + 1}`; // その間に別のコミットが入った
        return respond(422, { message: 'Update is not a fast forward' });
      }
      return respond(200, {});
    }
    return respond(500, 'unexpected');
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createGitHubClient', () => {
  it('既定ブランチと書き込み権限を調べる', async () => {
    const { fetchImpl } = fakeGitHub();
    const client = createGitHubClient('token', { owner: 'owner', repo: 'repo' }, fetchImpl);
    expect(await client.repository()).toEqual({ defaultBranch: 'main', canPush: true });
  });

  it('最新のファイルを読み、1つのコミットにまとめてブランチを進める', async () => {
    const { fetchImpl, calls } = fakeGitHub({ files: { 'data/summaries/2026-10.json': '[]\n' } });
    const client = createGitHubClient('token', { owner: 'owner', repo: 'repo' }, fetchImpl);
    const seen: (string | null)[] = [];
    const result = await client.commitFiles('main', '要約を追加', async (read) => {
      seen.push(await read('data/summaries/2026-10.json'), await read('data/summaries/2026-09.json'));
      return [{ path: 'data/summaries/2026-10.json', content: '[\n{"id":"a"}\n]\n' }];
    });
    expect(seen).toEqual(['[]\n', null]);
    expect(result).toEqual({ sha: 'commit-on-head-1', changed: true });
    const tree = calls.find((call) => call.url.endsWith('/git/trees'))!;
    expect(tree.body).toMatchObject({ base_tree: 'tree-of-head-1', tree: [{ path: 'data/summaries/2026-10.json', mode: '100644' }] });
    const raw = calls.find((call) => call.url.includes('/contents/'))!;
    expect(raw.accept).toBe('application/vnd.github.raw+json');
    expect(raw.url).toContain('ref=head-1');
  });

  it('途中で他のコミットが入ったら、最新の状態を読み直してやり直す', async () => {
    const { fetchImpl, calls } = fakeGitHub({ patchFailures: 1 });
    const client = createGitHubClient('token', { owner: 'owner', repo: 'repo' }, fetchImpl);
    let reads = 0;
    const result = await client.commitFiles('main', 'm', async () => {
      reads++;
      return [{ path: 'a.json', content: '[]' }];
    });
    expect(reads).toBe(2);
    expect(result.sha).toBe('commit-on-head-2');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
  });

  it('変更がなければコミットしない', async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const client = createGitHubClient('token', { owner: 'owner', repo: 'repo' }, fetchImpl);
    expect(await client.commitFiles('main', 'm', async () => [])).toEqual({ sha: 'head-1', changed: false });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('認証エラーは分かりやすいメッセージにする', async () => {
    const fetchImpl = (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch;
    const client = createGitHubClient('bad', { owner: 'owner', repo: 'repo' }, fetchImpl);
    await expect(client.repository()).rejects.toThrow(GitHubError);
    await expect(client.repository()).rejects.toThrow('トークンが無効');
  });
});
