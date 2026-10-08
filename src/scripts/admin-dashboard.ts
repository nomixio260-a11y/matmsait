/**
 * 管理画面の「概要」（/admin/）: サイトの状態（最終更新・自動更新・最近の実行）、きょうの数字（アクセス解析・記事・要約・通知）、
 * やること（更新が止まっている・取得できていない収集元・要約のない話題の記事・お知らせとピックアップの期限など）、
 * SNS（Bluesky）の自動投稿（最近の投稿・「今すぐ投稿」・下書き）
 */
import type { ManualResult, PostedEntry, SocialRequest } from '../../scripts/lib/social.ts';
import type { Repository } from '../lib/github-commit.ts';
import type { EditorPick, Notice } from '../lib/editorial-core.ts';
import { requireSession, watchSession } from './admin-common.ts';
import {
  $,
  analyticsEndpoint,
  dateFormat,
  el,
  errorText,
  githubClient,
  loadAdminData,
  numberFormat,
  serverApi,
  setStatus,
  setupConnectionCheck,
  setupRunsPanel,
  type AdminDataCommon,
  type GitHubClient,
} from './admin-shared.ts';

interface SocialDraft {
  /** 種類（急上昇・いま話題など） */
  kind: string;
  key: string;
  /** 投稿文（URL を含む。X の文字数に収めてある） */
  text: string;
  url: string;
}

interface DashboardData extends AdminDataCommon {
  /** AI 整理（トピック整理）の候補 */
  topics?: { id: string; title: string; coverage: number; articles: unknown[]; noted?: unknown }[];
  notice?: Notice | null;
  picks?: (EditorPick & { article?: { title: string } })[];
  social?: SocialDraft[];
  /** 自動投稿の記録（新しい順。サイトのビルドのときのもの） */
  socialLog?: PostedEntry[];
}

/** 自動投稿の記録のファイル（data/social.json）のうち、ここで使うもの */
interface SocialFile {
  posted?: PostedEntry[];
  manual?: ManualResult;
}

const POST_KINDS: Record<string, string> = {
  digest: '今日のまとめ',
  morning: '今日の注目ニュース',
  ai: 'AIニュース',
  weekly: '今週のランキング',
  rising: '急上昇',
  hot: 'いま話題',
  summary: '10秒でわかるニュース',
  now: 'いま話題のまとめ',
};

/** 投稿のリンク先（サイトのページ） */
function postPath(key: string): string {
  const [kind, id] = key.split(':');
  switch (kind) {
    case 'rising':
    case 'hot':
      return `/topic/${id}/`;
    case 'digest':
      return `/daily/${id}/`;
    case 'ai':
      return '/tag/ai/';
    case 'summary':
      return `/summary/${id}/`;
    case 'now':
      return '/';
    default:
      return '/ranking/';
  }
}

function externalLink(text: string, href: string, className = ''): HTMLAnchorElement {
  const link = el('a', className, text);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

/** 自動投稿の記録（いつ・何を・どのサービスに。リンクはサイトのページと、投稿そのもの） */
function renderSocialLog(log: PostedEntry[]): void {
  const list = $('social-log');
  if (log.length === 0) {
    list.replaceChildren(el('li', 'pick-meta', 'まだ投稿していません（Secrets を登録すると、次の更新から投稿が始まります。深夜0〜7時は投稿しません）。'));
    return;
  }
  list.replaceChildren(
    ...log.slice(0, 15).map((entry) => {
      const [kind] = entry.key.split(':');
      const li = el('li', 'draft');
      const head = el('div', 'draft-head');
      head.append(el('span', 'badge', POST_KINDS[kind] ?? kind), ` ${dateFormat.format(new Date(entry.at))}`);
      if (entry.platforms?.length) head.append(el('span', 'pick-meta', `（${entry.platforms.join('・')}）`));
      li.append(head);
      const path = postPath(entry.key);
      li.append(externalLink(`${base}${path}`, `${base}${path}`, 'pick-meta'));
      for (const [name, url] of Object.entries(entry.urls ?? {})) li.append(' ', externalLink(`${name} で見る`, url, 'pick-meta'));
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
      const open = (label: string, link: string) => {
        const anchor = el('a', 'draft-link', label);
        anchor.href = link;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        return anchor;
      };
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
      actions.append(open('Bluesky で投稿', `https://bsky.app/intent/compose?text=${encodeURIComponent(draft.text)}`), copy);
      li.append(head, text, actions);
      return li;
    }),
  );
}

interface Live {
  online: number;
  today: { visitors: number; views: number; visits: number; clicks: number };
  /** この週（月曜から）・この月の訪問者数（WAU・MAU） */
  period?: { week: number; month: number };
}

interface PushStats {
  subscribers: number;
  last?: { at: number; items: number; fresh: number; hot: number } | null;
  log?: { kind: string; done: number; sent: number }[];
}

const root = document.querySelector<HTMLElement>('[data-admin]')!;
const base = root.dataset.base ?? '';
/** この時間以上サイトが更新されていなければ知らせる */
const STALE_HOURS = 3;
/** 取得の失敗がこの回数続いたら知らせる */
const SOURCE_FAILURE_ALERT = 3;
/** 収集元の最新記事がこれより古ければ、フィードが止まっている可能性を知らせる */
const SOURCE_STALE_DAYS = 3;

type TodoKind = 'warn' | 'info' | 'ok';
interface Todo {
  kind: TodoKind;
  text: string;
  link?: { label: string; href: string };
  details?: string[];
}

function renderTodos(todos: Todo[]): void {
  const order: Record<TodoKind, number> = { warn: 0, info: 1, ok: 2 };
  const list = $('todo-list');
  const shown = todos.length > 0 ? [...todos].sort((a, b) => order[a.kind] - order[b.kind]) : [{ kind: 'ok' as const, text: '対応が必要なことはありません。' }];
  list.replaceChildren(
    ...shown.map((todo) => {
      const li = el('li', todo.kind);
      const text = el('span', 'todo-text', todo.text);
      if (todo.details?.length) {
        const sub = el('span', 'pick-meta');
        sub.style.display = 'block';
        sub.textContent = todo.details.join(' ／ ');
        text.append(sub);
      }
      li.append(text);
      if (todo.link) {
        const link = el('a', '', todo.link.label);
        link.href = todo.link.href;
        li.append(link);
      }
      return li;
    }),
  );
}

function stat(label: string, value: string, sub?: string): HTMLElement {
  const box = el('div', 'stat');
  box.append(el('p', 'stat-label', label), el('p', 'stat-value', value));
  if (sub) box.append(el('p', 'stat-sub', sub));
  return box;
}

const shorten = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text);

/** 記事・要約・収集元・お知らせ・ピックアップから分かる「やること」 */
function dataTodos(data: DashboardData, now: number): Todo[] {
  const todos: Todo[] = [];
  const hours = Math.floor((now - Date.parse(data.generatedAt)) / 3_600_000);
  if (hours >= STALE_HOURS) {
    todos.push({ kind: 'warn', text: `サイトが${hours}時間以上更新されていません。自動更新が止まっている可能性があります。`, link: { label: '今すぐ更新', href: '#update' } });
  }
  const sources = data.sources ?? [];
  const failing = sources.filter((source) => (source.failures ?? 0) >= SOURCE_FAILURE_ALERT);
  if (failing.length > 0) {
    todos.push({
      kind: 'warn',
      text: `記事を取得できていない収集元が${failing.length}件あります。`,
      details: failing.slice(0, 5).map((source) => source.name),
      link: { label: '収集元の状況', href: `${base}/admin/summaries/#sources-card` },
    });
  }
  const staleSources = sources.filter((source) => !failing.includes(source) && (!source.latest || now - Date.parse(source.latest) > SOURCE_STALE_DAYS * 86_400_000));
  if (staleSources.length > 0) {
    todos.push({
      kind: 'info',
      text: `${SOURCE_STALE_DAYS}日以上新しい記事がない収集元が${staleSources.length}件あります（更新の少ないサイトなら問題ありません）。`,
      details: staleSources.slice(0, 5).map((source) => source.name),
      link: { label: '収集元の状況', href: `${base}/admin/summaries/#sources-card` },
    });
  }
  // 多くのメディアが報じた話題で、要約がまだの記事
  // （同じ話題の記事は1つに数える。どれかの記事に要約があれば、その話題は済み）
  const summarizedTopics = new Set(data.summarized.flatMap((record) => (record.topic ? [record.topic] : [])));
  const hot = data.pending.filter((article) => (article.coverage ?? 1) >= 3).sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0));
  const topics = new Set<string>();
  const hotTopics = hot.filter((article) => {
    const key = article.topic ?? article.id;
    if (topics.has(key) || summarizedTopics.has(key)) return false;
    topics.add(key);
    return true;
  });
  if (hotTopics.length > 0) {
    todos.push({
      kind: 'info',
      text: `3媒体以上が報じたトピックで、AI要約がまだのものがあります（${hotTopics.length}件）。要約を載せると、検索や SNS から読まれやすくなります。`,
      details: hotTopics.slice(0, 3).map((article) => `${shorten(article.title, 28)}（${article.coverage}媒体）`),
      link: { label: 'AI要約を作る', href: `${base}/admin/summaries/` },
    });
  }
  // 多くの媒体が報じたトピックで、AI 整理（各メディアの視点）がまだのもの
  const unnoted = (data.topics ?? []).filter((topic) => topic.coverage >= 4 && topic.articles.length >= 2 && !topic.noted);
  if (unnoted.length > 0) {
    todos.push({
      kind: 'info',
      text: `4媒体以上が報じたトピックで、AI 整理（各メディアの視点）がまだのものがあります（${unnoted.length}件）。各媒体の報じ方の違いは、このサイトにしかない内容になります。`,
      details: unnoted.slice(0, 3).map((topic) => `${shorten(topic.title, 28)}（${topic.coverage}媒体）`),
      link: { label: 'トピック整理', href: `${base}/admin/topics/` },
    });
  }
  if (data.counts && data.counts.summariesToday === 0) {
    todos.push({ kind: 'info', text: 'きょうはまだ AI 要約を作っていません。', link: { label: 'AI要約を作る', href: `${base}/admin/summaries/` } });
  }
  // お知らせ
  const notice = data.notice;
  if (notice) {
    const end = Date.parse(notice.end);
    const start = Date.parse(notice.start);
    if (start <= now && now < end) {
      todos.push({ kind: 'ok', text: `お知らせを掲載中です（${dateFormat.format(new Date(end))} まで）: ${shorten(notice.text, 30)}`, link: { label: '変更する', href: `${base}/admin/content/#notice` } });
    } else if (start > now) {
      todos.push({ kind: 'info', text: `お知らせは ${dateFormat.format(new Date(start))} から掲載されます: ${shorten(notice.text, 30)}`, link: { label: '変更する', href: `${base}/admin/content/#notice` } });
    }
  }
  // ピックアップ
  const picks = data.picks ?? [];
  const active = picks.filter((pick) => Date.parse(pick.until) > now);
  if (active.length === 0) {
    todos.push({ kind: 'info', text: 'ピックアップ（編集部のおすすめ）がありません。トップページで、ひとこと付きで記事を紹介できます。', link: { label: 'ピックアップを選ぶ', href: `${base}/admin/content/#picks` } });
  } else {
    const soon = active.filter((pick) => Date.parse(pick.until) - now < 24 * 3_600_000);
    todos.push({
      kind: 'ok',
      text: `ピックアップを${active.length}件掲載中です${soon.length > 0 ? `（${soon.length}件は24時間以内に期限が切れます）` : ''}。`,
      link: { label: '変更する', href: `${base}/admin/content/#picks` },
    });
  }
  return todos;
}

async function main(): Promise<void> {
  const session = requireSession();
  if (!session) return;
  watchSession(session);
  root.hidden = false;
  const now = Date.now();

  let data: DashboardData;
  try {
    data = await loadAdminData<DashboardData>();
  } catch (error) {
    $('data-info').textContent = `管理画面のデータを読み込めませんでした（${errorText(error)}）`;
    renderTodos([{ kind: 'warn', text: '管理画面のデータを読み込めませんでした。ページを読み込み直してください。' }]);
    return;
  }
  $('data-info').textContent = `サイトの最終更新: ${dateFormat.format(new Date(data.generatedAt))}`;
  $('repo-name').textContent = `${data.repository.owner}/${data.repository.repo}`;
  const client = () => githubClient(session.token, data.repository);

  const todos = dataTodos(data, now);
  renderTodos(todos);
  renderDrafts(data.social ?? []);
  renderSocialLog(data.socialLog ?? []);
  // 最近の投稿は GitHub の最新の記録で表示し直す（サイトのビルドのあとに投稿したものも出す）
  const postNow = setupPostNow({
    client,
    repository: data.repository,
    onState: (state) => renderSocialLog(Array.isArray(state.posted) ? state.posted.slice(-30).reverse() : []),
  });
  void postNow.check();

  // 数字（記事・要約は管理画面用データから、アクセスと通知はサーバーから）
  const stats = $('stats');
  const counts = data.counts;
  const boxes: HTMLElement[] = [];
  const statsNote = $('stats-note');
  let live: Live | undefined;
  let push: PushStats | undefined;
  if (analyticsEndpoint) {
    const [liveResult, pushResult] = await Promise.allSettled([serverApi<Live>(session.token, '/admin/live'), serverApi<PushStats>(session.token, '/admin/push')]);
    if (liveResult.status === 'fulfilled') live = liveResult.value;
    if (pushResult.status === 'fulfilled') push = pushResult.value;
    if (liveResult.status === 'rejected') statsNote.textContent = `アクセス解析を読み込めませんでした（${errorText(liveResult.reason)}）`;
  } else {
    $('analytics-link').hidden = true;
    statsNote.textContent = 'アクセス解析と通知は、サイトを Cloudflare に公開しているときに使えます。';
  }
  if (live) {
    boxes.push(
      stat('いま見ている人', numberFormat.format(live.online)),
      stat('きょうの訪問者', numberFormat.format(live.today.visitors), `訪問 ${numberFormat.format(live.today.visits)}回`),
      stat('きょうの閲覧数', numberFormat.format(live.today.views)),
      stat('記事のクリック', numberFormat.format(live.today.clicks)),
    );
    if (live.period) {
      boxes.push(
        stat('この週の訪問者（WAU）', numberFormat.format(live.period.week), '月曜から'),
        stat('この月の訪問者（MAU）', numberFormat.format(live.period.month), '1日から'),
      );
    }
  }
  if (counts) {
    boxes.push(
      stat('掲載中の記事', numberFormat.format(counts.items), `きょう +${numberFormat.format(counts.itemsToday)}`),
      stat('AI要約', numberFormat.format(counts.summaries), `きょう +${numberFormat.format(counts.summariesToday)}`),
    );
  }
  if (push) {
    const lastSent = push.log?.find((entry) => entry.sent > 0);
    boxes.push(stat('通知の登録者', numberFormat.format(push.subscribers), lastSent ? `最後に送った: ${dateFormat.format(new Date(lastSent.done))}` : undefined));
  }
  if (counts) {
    const failing = (data.sources ?? []).filter((source) => (source.failures ?? 0) >= SOURCE_FAILURE_ALERT).length;
    boxes.push(stat('収集元', numberFormat.format(counts.sources), failing > 0 ? `取得できていない ${failing}件` : 'すべて取得できています'));
  }
  stats.replaceChildren(...boxes);

  // 通知の新着の確認が止まっていないか（毎時のサイトの更新のあとに行う）
  if (push?.last && now - push.last.at > STALE_HOURS * 3_600_000 && push.subscribers > 0) {
    todos.push({ kind: 'warn', text: `通知の新着の確認が${Math.floor((now - push.last.at) / 3_600_000)}時間行われていません（サイトの更新が止まっている可能性があります）。`, link: { label: '今すぐ更新', href: '#update' } });
    renderTodos(todos);
  }

  const runs = setupRunsPanel({
    client,
    list: $<HTMLUListElement>('run-list'),
    timer: $('timer-status'),
    button: $<HTMLButtonElement>('run-update'),
    status: $('run-status'),
    refresh: $<HTMLButtonElement>('refresh-runs'),
    onRuns: (list) => {
      // 直近の更新が失敗していたら知らせる
      const latest = list.find((run) => run.status === 'completed');
      if (latest && latest.conclusion === 'failure' && !todos.some((todo) => todo.text.startsWith('直近の'))) {
        todos.push({ kind: 'warn', text: `直近のサイトの更新（${dateFormat.format(new Date(latest.created_at))}）が失敗しています。`, link: { label: '詳細', href: latest.html_url } });
        renderTodos(todos);
      }
    },
  });
  setupConnectionCheck({
    button: $<HTMLButtonElement>('test-token'),
    status: $('token-status'),
    badge: $('token-badge'),
    client,
    onOk: () => void runs.render(),
  });
  void runs.render();
}

void main();
