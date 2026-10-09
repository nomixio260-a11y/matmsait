/**
 * 管理画面の「SNS 投稿」（/admin/social/）: 今すぐ Bluesky に投稿、最近の投稿（何を投稿したかを題名で）、
 * 次に投稿されうる内容（手で追加の投稿をするときの下書き）
 */
import type { ManualResult, PostedEntry, SocialRequest } from '../../scripts/lib/social.ts';
import type { Repository } from '../lib/github-commit.ts';
import { requireSession, watchSession } from './admin-common.ts';
import {
  $,
  POST_KINDS,
  dateFormat,
  el,
  errorText,
  externalLink,
  githubClient,
  loadAdminData,
  postPath,
  postTitle,
  setStatus,
  type AdminDataCommon,
  type GitHubClient,
} from './admin-shared.ts';

interface SocialDraft {
  /** 種類（急上昇・いま話題など） */
  kind: string;
  key: string;
  /** 投稿文（URL を含む） */
  text: string;
  url: string;
}

/** 投稿の記録（話題・要約の投稿には、サイトのビルドのときに題名が付く） */
interface PostedWithTitle extends PostedEntry {
  title?: string;
}

interface SocialData extends AdminDataCommon {
  social?: SocialDraft[];
  /** 自動投稿の記録（新しい順。サイトのビルドのときのもの） */
  socialLog?: PostedWithTitle[];
}

/** 自動投稿の記録のファイル（data/social.json）のうち、ここで使うもの */
interface SocialFile {
  posted?: PostedEntry[];
  manual?: ManualResult;
}

const root = document.querySelector<HTMLElement>('[data-admin]')!;
const base = root.dataset.base ?? '';
/** サイトのビルドのときの記録の題名（GitHub から読み直した最新の記録には題名がないため） */
const titles = new Map<string, string>();
/** 最近の投稿として出す件数（はじめは LOG_FIRST 件だけ出し、「もっと見る」で LOG_LIMIT 件まで） */
const LOG_LIMIT = 30;
const LOG_FIRST = 10;
let logExpanded = false;
let lastLog: PostedWithTitle[] = [];

/** 最近の投稿（いつ・何を・どこに。題名からサイトのページ、右に投稿そのもの） */
function renderSocialLog(log: PostedWithTitle[]): void {
  lastLog = log;
  const list = $('social-log');
  const more = $<HTMLButtonElement>('log-more');
  const total = Math.min(log.length, LOG_LIMIT);
  const shown = logExpanded ? total : Math.min(total, LOG_FIRST);
  $('log-count').textContent = log.length > 0 ? `${total}件` : '';
  more.hidden = shown >= total;
  more.textContent = `もっと見る（あと${total - shown}件）`;
  if (log.length === 0) {
    list.replaceChildren(el('li', 'pick-meta', 'まだ投稿していません（Secrets を登録すると、次の更新から投稿が始まります。深夜0〜7時は投稿しません）。'));
    return;
  }
  list.replaceChildren(
    ...log.slice(0, shown).map((entry) => {
      const [kind] = entry.key.split(':');
      const path = postPath(entry.key);
      const title = postTitle(entry.key, entry.title ?? titles.get(entry.key));
      const li = el('li', 'post-row');
      const head = el('span', 'post-head');
      head.append(el('span', 'badge', POST_KINDS[kind] ?? kind), el('time', 'post-time', dateFormat.format(new Date(entry.at))));
      const links = el('span', 'post-links');
      for (const [name, url] of Object.entries(entry.urls ?? {})) links.append(externalLink(`${name} で見る`, url));
      li.append(head, externalLink(title ?? `${base}${path}`, `${base}${path}`, 'post-title'), links);
      return li;
    }),
  );
}

// ===== 今すぐ投稿（管理画面から Bluesky に投稿する） =====

const SOCIAL_PATH = 'data/social.json';
const REQUEST_PATH = 'data/social-request.json';
/** 結果を確かめる間隔と、待つ時間の上限（記事の取り込み・サイトの更新・投稿で、ふだんは2〜3分） */
const POST_POLL_MS = 10_000;
const POST_WAIT_MS = 12 * 60_000;
/** 「今すぐ投稿」も含めた24時間の上限（scripts/lib/social.ts の SOCIAL_LIMITS.manualMaxPerDay と同じ） */
const MANUAL_MAX_PER_DAY = 50;

function parseJson<T>(text: string | null): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const newRequestId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** 「今すぐ投稿」の結果の説明 */
function manualMessage(manual: ManualResult): { text: string; kind: 'ok' | 'error' | '' } {
  switch (manual.result) {
    case 'posted':
      return { text: `Bluesky に投稿しました（${dateFormat.format(new Date(manual.at))}）。`, kind: 'ok' };
    case 'none':
      return {
        text: 'いま投稿できる新しい話題がありませんでした（まだ投稿していない急上昇・いま話題・AI 要約がなく、「いま話題のニュース」のまとめもこの時間帯に投稿済みか、話題が足りませんでした。同じ話題は二度投稿しません）。',
        kind: '',
      };
    case 'no-credentials':
      return { text: 'Bluesky のアプリパスワードが GitHub の Secrets（BLUESKY_APP_PASSWORD）に登録されていないため、投稿できませんでした。', kind: 'error' };
    case 'limit':
      return { text: `24時間の投稿数の上限（${MANUAL_MAX_PER_DAY}件）に達しているため、投稿しませんでした。`, kind: 'error' };
    case 'expired':
      return { text: '依頼から時間がたっていたため、投稿しませんでした。もう一度押してください。', kind: 'error' };
    default: {
      const error = manual.error ?? '原因が分かりません';
      const hint = /HTTP 401|AuthenticationRequired/.test(error) ? '（Bluesky にログインできませんでした。アプリパスワードが正しいか、Bluesky の設定で削除していないかを確かめてください）' : '';
      return { text: `投稿に失敗しました: ${error}${hint}`, kind: 'error' };
    }
  }
}

/** 「今すぐ Bluesky に投稿」のボタン（投稿の依頼を GitHub に保存すると、サイトの更新が始まり、そのあとに投稿される） */
function setupPostNow(options: { client: () => GitHubClient; repository: Repository; onState: (state: SocialFile) => void }): { check(): Promise<void> } {
  const button = $<HTMLButtonElement>('post-now');
  const status = $('post-now-status');
  const links = $<HTMLUListElement>('post-now-links');
  const github = `https://github.com/${options.repository.owner}/${options.repository.repo}`;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const showLinks = (items: HTMLElement[]) => {
    links.replaceChildren(...items);
    links.hidden = items.length === 0;
  };
  const linkItem = (...nodes: (Node | string)[]) => {
    const li = el('li');
    li.append(...nodes);
    return li;
  };
  const actionsItem = () => linkItem(externalLink('実行状況（GitHub）', `${github}/actions`));

  function showResult(manual: ManualResult): void {
    const message = manualMessage(manual);
    setStatus(status, message.text, message.kind);
    const items = (manual.posts ?? []).map((post) => {
      const [kind] = post.key.split(':');
      const path = postPath(post.key);
      const nodes: (Node | string)[] = [el('span', 'badge', POST_KINDS[kind] ?? kind), ' '];
      for (const [name, url] of Object.entries(post.urls ?? {})) nodes.push(externalLink(`${name} で見る`, url), ' ');
      nodes.push(externalLink('サイトのページ', `${base}${path}`));
      return linkItem(...nodes);
    });
    if (manual.result === 'no-credentials') items.push(linkItem(externalLink('Secrets に BLUESKY_APP_PASSWORD を登録する（GitHub）', `${github}/settings/secrets/actions/new`)));
    if (manual.result === 'failed') items.push(actionsItem());
    showLinks(items);
  }

  /** 依頼の結果が data/social.json に記録されるまで待つ */
  function wait(request: SocialRequest, branch: string): void {
    clearTimeout(timer);
    button.disabled = true;
    showLinks([]);
    const started = Date.parse(request.at);
    const tick = async () => {
      let state: SocialFile | undefined;
      try {
        state = parseJson<SocialFile>(await options.client().readFile(SOCIAL_PATH, branch, { fresh: true }));
      } catch {
        // 一時的に読めなくても待ち続ける
      }
      if (state) options.onState(state);
      if (state?.manual?.id === request.id) {
        showResult(state.manual);
        button.disabled = false;
        return;
      }
      const elapsed = Date.now() - started;
      if (elapsed > POST_WAIT_MS) {
        setStatus(status, '投稿の結果がまだ記録されていません。サイトの更新に時間がかかっているか、失敗している可能性があります。', 'error');
        showLinks([actionsItem()]);
        button.disabled = false;
        return;
      }
      setStatus(status, `投稿の準備をしています（${Math.max(0, Math.round(elapsed / 1000))}秒）。最新の記事を取り込み、サイトを更新してから投稿します…`);
      timer = setTimeout(() => void tick(), POST_POLL_MS);
    };
    void tick();
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    showLinks([]);
    setStatus(status, '投稿を依頼しています…');
    try {
      const client = options.client();
      const { defaultBranch } = await client.repository();
      const request: SocialRequest = { id: newRequestId(), at: new Date().toISOString() };
      // この保存（push）で、サイトの更新（update.yml）が始まる。更新のあとの通知の処理が依頼を見て投稿し、結果を記録する
      await client.commitFiles(defaultBranch, 'SNS に今すぐ投稿（管理画面から）', async () => [{ path: REQUEST_PATH, content: `${JSON.stringify(request)}\n` }]);
      wait(request, defaultBranch);
    } catch (error) {
      setStatus(status, `依頼できませんでした: ${errorText(error)}`, 'error');
      button.disabled = false;
    }
  });

  /** ページを開いたとき: いまの投稿の記録を読み、処理中の依頼があれば結果を待つ */
  async function check(): Promise<void> {
    try {
      const client = options.client();
      const { defaultBranch } = await client.repository();
      const [stateText, requestText] = await Promise.all([
        client.readFile(SOCIAL_PATH, defaultBranch, { fresh: true }),
        client.readFile(REQUEST_PATH, defaultBranch, { fresh: true }),
      ]);
      const state = parseJson<SocialFile>(stateText);
      if (state) options.onState(state);
      const request = parseJson<SocialRequest>(requestText);
      if (!request?.id || request.id === state?.manual?.id) return;
      const age = Date.now() - Date.parse(request.at);
      if (age < POST_WAIT_MS) wait(request, defaultBranch);
      else if (age < 24 * 3_600_000) {
        setStatus(
          status,
          `${dateFormat.format(new Date(request.at))} の「今すぐ投稿」の依頼が処理されていません（サイトの更新が失敗している可能性があります。30分以上たった依頼は投稿しません）。`,
          'error',
        );
        showLinks([actionsItem()]);
      }
    } catch {
      // 読めなくても、サイトのビルドのときの記録を表示したままにする
    }
  }
  return { check };
}

/** SNS の投稿の下書き（Bluesky の投稿画面を開くリンクと、コピーのボタン） */
function renderDrafts(drafts: SocialDraft[]): void {
  const list = $('social-drafts');
  $('drafts-count').textContent = `${drafts.length}件`;
  if (drafts.length === 0) {
    list.replaceChildren(el('li', 'pick-meta', 'いまは投稿に向いた話題がありません（急上昇・多くのメディアが報じた話題が出ると、ここに候補が出ます）。'));
    return;
  }
  list.replaceChildren(
    ...drafts.map((draft) => {
      const li = el('li', 'draft');
      const head = el('div', 'draft-head');
      head.append(el('span', 'badge', draft.kind));
      const text = el('p', 'draft-text', draft.text);
      const actions = el('div', 'actions');
      const copy = el('button', 'ghost small', 'コピー');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(draft.text);
          copy.textContent = 'コピーしました';
        } catch {
          copy.textContent = 'コピーできませんでした';
        }
        setTimeout(() => (copy.textContent = 'コピー'), 2000);
      });
      actions.append(externalLink('Bluesky で投稿', `https://bsky.app/intent/compose?text=${encodeURIComponent(draft.text)}`, 'draft-link'), copy);
      li.append(head, text, actions);
      return li;
    }),
  );
}

async function main(): Promise<void> {
  const session = requireSession();
  if (!session) return;
  watchSession(session);
  root.hidden = false;

  let data: SocialData;
  try {
    data = await loadAdminData<SocialData>();
  } catch (error) {
    $('data-info').textContent = `管理画面のデータを読み込めませんでした（${errorText(error)}）`;
    return;
  }
  $('data-info').textContent = `サイトの最終更新: ${dateFormat.format(new Date(data.generatedAt))}`;
  for (const entry of data.socialLog ?? []) if (entry.title) titles.set(entry.key, entry.title);
  $('log-more').addEventListener('click', () => {
    logExpanded = true;
    renderSocialLog(lastLog);
  });
  renderSocialLog(data.socialLog ?? []);
  renderDrafts(data.social ?? []);
  // 最近の投稿は GitHub の最新の記録で表示し直す（サイトのビルドのあとに投稿したものも出す）
  const postNow = setupPostNow({
    client: () => githubClient(session.token, data.repository),
    repository: data.repository,
    onState: (state) => renderSocialLog(Array.isArray(state.posted) ? state.posted.slice(-LOG_LIMIT).reverse() : []),
  });
  void postNow.check();
}

void main();
