/**
 * 管理画面の「ホーム」（/admin/）: 対応が必要なこと（更新が止まっている・自動要約の権限など）、きょうの数字（アクセス解析・記事・要約・通知）、
 * サイトの更新（自動更新・今すぐ更新・最近の実行）、SNS の最近の投稿（くわしくは「SNS 投稿」のページ）、お知らせ・提案
 */
import type { PostedEntry } from '../../scripts/lib/social.ts';
import type { EditorPick, Notice } from '../lib/editorial-core.ts';
import type { AutoSummaryStatus } from '../lib/auto-summary-state.ts';
import { requireSession, watchSession } from './admin-common.ts';
import {
  $,
  POST_KINDS,
  analyticsEndpoint,
  dateFormat,
  el,
  errorText,
  externalLink,
  githubClient,
  loadAdminData,
  numberFormat,
  postPath,
  postTitle,
  serverApi,
  setupConnectionCheck,
  setupRunsPanel,
  type AdminDataCommon,
} from './admin-shared.ts';

interface DashboardData extends AdminDataCommon {
  /** AI 整理（トピック整理）の候補 */
  topics?: { id: string; title: string; coverage: number; articles: unknown[]; noted?: unknown }[];
  notice?: Notice | null;
  picks?: (EditorPick & { article?: { title: string } })[];
  /** 自動投稿の記録（新しい順。サイトのビルドのときのもの。話題・要約の投稿には題名） */
  socialLog?: (PostedEntry & { title?: string })[];
  /** AI の自動要約の状況（まだ動いていなければ null） */
  autoSummary?: AutoSummaryStatus | null;
}

/** ホームに出す最近の投稿（くわしくは「SNS 投稿」のページ） */
function renderSocialMini(log: (PostedEntry & { title?: string })[]): void {
  const list = $('social-mini');
  if (log.length === 0) {
    list.replaceChildren(el('li', 'pick-meta', 'まだ投稿していません。'));
    return;
  }
  list.replaceChildren(
    ...log.slice(0, 3).map((entry) => {
      const [kind] = entry.key.split(':');
      const path = postPath(entry.key);
      const li = el('li');
      const meta = el('span', 'pick-meta', `${POST_KINDS[kind] ?? kind} ・ ${dateFormat.format(new Date(entry.at))}`);
      li.append(externalLink(postTitle(entry.key, entry.title) ?? `${base}${path}`, `${base}${path}`, 'mini-title'), meta);
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

function todoItems(todos: Todo[]): HTMLElement[] {
  return todos.map((todo) => {
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
        const link = el('a', '', `${todo.link.label} →`);
        link.href = todo.link.href;
        li.append(link);
      }
      return li;
  });
}

/** 対応が必要なこと（警告）と、お知らせ・提案（してもよいこと・掲載中のもの）に分けて出す */
function renderTodos(todos: Todo[]): void {
  const warn = todos.filter((todo) => todo.kind === 'warn');
  const rest = todos.filter((todo) => todo.kind !== 'warn').sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'info' ? -1 : 1));
  $('todo-count').textContent = warn.length > 0 ? `${warn.length}件` : 'なし';
  $('todo-count').className = `badge${warn.length > 0 ? ' warn' : ' ok'}`;
  $('todo-list').replaceChildren(...(warn.length > 0 ? todoItems(warn) : todoItems([{ kind: 'ok', text: '対応が必要なことはありません。' }])));
  $('info-list').replaceChildren(...(rest.length > 0 ? todoItems(rest) : [el('li', 'pick-meta', 'いまはありません。')]));
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
      link: { label: '収集元の状況', href: `${base}/admin/summaries/#sources` },
    });
  }
  const staleSources = sources.filter((source) => !failing.includes(source) && (!source.latest || now - Date.parse(source.latest) > SOURCE_STALE_DAYS * 86_400_000));
  if (staleSources.length > 0) {
    todos.push({
      kind: 'info',
      text: `${SOURCE_STALE_DAYS}日以上新しい記事がない収集元が${staleSources.length}件あります（更新の少ないサイトなら問題ありません）。`,
      details: staleSources.slice(0, 5).map((source) => source.name),
      link: { label: '収集元の状況', href: `${base}/admin/summaries/#sources` },
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
      text: `3媒体以上が報じたトピックのうち、AI要約がまだのものが${hotTopics.length}件あります。`,
      details: hotTopics.slice(0, 3).map((article) => `${shorten(article.title, 28)}（${article.coverage}媒体）`),
      link: { label: 'AI要約を作る', href: `${base}/admin/summaries/` },
    });
  }
  // 多くの媒体が報じたトピックで、AI 整理（各メディアの視点）がまだのもの
  const unnoted = (data.topics ?? []).filter((topic) => topic.coverage >= 4 && topic.articles.length >= 2 && !topic.noted);
  if (unnoted.length > 0) {
    todos.push({
      kind: 'info',
      text: `4媒体以上が報じたトピックのうち、AI 整理（各メディアの視点）がまだのものが${unnoted.length}件あります。`,
      details: unnoted.slice(0, 3).map((topic) => `${shorten(topic.title, 28)}（${topic.coverage}媒体）`),
      link: { label: 'トピック整理', href: `${base}/admin/topics/` },
    });
  }
  // AI の自動要約（無料枠を使い切ったのは翌日に戻るので出さない）
  const problem = data.autoSummary?.problem;
  if (problem && problem.kind !== 'quota') {
    todos.push({
      kind: 'warn',
      text:
        problem.kind === 'auth'
          ? 'AI の自動要約が止まっています。Workers AI のトークンを作り、GitHub の Secrets に CLOUDFLARE_AI_TOKEN として登録してください（README の「AI の自動要約」）。'
          : `AI の自動要約がうまく動いていません: ${shorten(problem.message, 80)}`,
      link: { label: '自動要約の状況', href: `${base}/admin/summaries/#auto` },
    });
  }
  const automatic = data.summarized.filter((record) => record.generator && !record.updatedAt && now - Date.parse(record.summarizedAt) < 24 * 3_600_000);
  if (automatic.length > 0) {
    todos.push({
      kind: 'ok',
      text: `AI が直近24時間に${automatic.length}件の要約を自動で作りました。時間のあるときに記事と見比べてください。`,
      details: automatic.slice(0, 3).map((record) => shorten(record.title, 28)),
      link: { label: '自動で作った要約', href: `${base}/admin/summaries/#saved` },
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
    todos.push({ kind: 'info', text: 'ピックアップ（編集部のおすすめ）がありません。', link: { label: 'ピックアップを選ぶ', href: `${base}/admin/content/#picks` } });
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
  renderSocialMini(data.socialLog ?? []);

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
