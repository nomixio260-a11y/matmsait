/**
 * 管理画面の「ピックアップ・お知らせ」（/admin/content/）:
 * - ピックアップ: 記事を探して選び、運営者のひとことと期限を付けて data/picks.json に保存する（トップページに出る）
 * - お知らせ: サイトの上部に出す短いお知らせを data/notice.json に保存する（通知でも送れる）
 */
import {
  COMMENT_MAX,
  NOTICE_MAX,
  NOTICE_PATH,
  PICKS_MAX,
  PICKS_PATH,
  cleanLink,
  cleanNotice,
  noticeId,
  serializeNotice,
  serializePicks,
  type EditorPick,
  type Notice,
  type NoticeLevel,
} from '../lib/editorial-core.ts';
import { normalizeText } from '../lib/search-core.ts';
import { requireSession, watchSession } from './admin-common.ts';
import {
  $,
  actionsLink,
  analyticsEndpoint,
  dateFormat,
  el,
  errorText,
  githubClient,
  loadAdminData,
  serverApi,
  setStatus,
  type AdminArticleInfo,
  type AdminDataCommon,
} from './admin-shared.ts';

interface ContentData extends AdminDataCommon {
  notice?: Notice | null;
  picks?: (EditorPick & { article?: AdminArticleInfo; summarized?: boolean })[];
}

const root = document.querySelector<HTMLElement>('[data-admin]')!;
let data: ContentData;
let token = '';

const client = () => githubClient(token, data.repository);

/** GitHub に1つのファイルを保存する（既定のブランチに1つのコミット） */
async function saveFile(path: string, content: string, message: string): Promise<boolean> {
  const github = client();
  const { defaultBranch } = await github.repository();
  const result = await github.commitFiles(defaultBranch, message, async () => [{ path, content }]);
  return result.changed;
}

const shorten = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text);
const DAY = 86_400_000;

// ===== ピックアップ =====

interface EditablePick extends EditorPick {
  article?: AdminArticleInfo;
}

let picks: EditablePick[] = [];
let picksDirty = false;
/** 記事 ID → 記事（探すのに使う。要約待ちの記事と要約済みの記事） */
const articles = new Map<string, AdminArticleInfo & { summarized?: boolean }>();

function markDirty(): void {
  picksDirty = true;
  $<HTMLButtonElement>('save-picks').disabled = false;
  $('picks-dirty').textContent = '保存していない変更があります';
}

function categoryName(slug: string): string {
  return data.categories.find((category) => category.slug === slug)?.name ?? slug;
}

function articleMeta(article: AdminArticleInfo): string {
  return [article.site, categoryName(article.category), dateFormat.format(new Date(article.publishedAt)), article.coverage ? `${article.coverage}社が報道` : '']
    .filter(Boolean)
    .join(' ・ ');
}

function renderPicks(): void {
  const list = $('pick-edit-list');
  const now = Date.now();
  list.replaceChildren(
    ...picks.map((pick, index) => {
      const li = el('li', 'pick-edit');
      const expired = Date.parse(pick.until) <= now;
      li.classList.toggle('expired', expired);
      const head = el('div', 'pick-head');
      const title = el('a', 'pick-title', pick.article?.title ?? `（記事 ${pick.id}。一覧から消えた記事は、サイトには出ません）`);
      if (pick.article) {
        title.href = pick.article.url;
        title.target = '_blank';
        title.rel = 'noopener';
      }
      const order = el('span', 'badge', String(index + 1));
      head.append(order, title);
      li.append(head);
      if (pick.article) li.append(el('div', 'pick-meta', articleMeta(pick.article)));

      const comment = el('textarea');
      comment.rows = 2;
      comment.maxLength = COMMENT_MAX;
      comment.placeholder = '編集部のひとこと（任意。例: 「この発表で何が変わるのか、要点がよくまとまっています」）';
      comment.value = pick.comment;
      comment.setAttribute('aria-label', `「${shorten(pick.article?.title ?? pick.id, 20)}」へのひとこと`);
      comment.addEventListener('input', () => {
        pick.comment = comment.value.slice(0, COMMENT_MAX);
        count.textContent = `${Array.from(comment.value).length}/${COMMENT_MAX}`;
        markDirty();
      });
      li.append(comment);

      const controls = el('div', 'pick-controls');
      const count = el('span', 'pick-meta', `${Array.from(pick.comment).length}/${COMMENT_MAX}`);
      const until = el('span', expired ? 'note warn' : 'pick-meta', expired ? '期限切れ（サイトには出ません）' : `${dateFormat.format(new Date(pick.until))} まで`);
      const extend = el('select');
      extend.setAttribute('aria-label', '期限を変える');
      extend.append(el('option', '', '期限を変える'));
      for (const days of [1, 3, 7, 14]) {
        const option = el('option', '', `今から${days}日`);
        option.value = String(days);
        extend.append(option);
      }
      extend.addEventListener('change', () => {
        if (!extend.value) return;
        pick.until = new Date(Date.now() + Number(extend.value) * DAY).toISOString();
        markDirty();
        renderPicks();
      });
      const up = el('button', 'small ghost', '↑');
      up.type = 'button';
      up.disabled = index === 0;
      up.setAttribute('aria-label', '上へ');
      up.addEventListener('click', () => move(index, -1));
      const down = el('button', 'small ghost', '↓');
      down.type = 'button';
      down.disabled = index === picks.length - 1;
      down.setAttribute('aria-label', '下へ');
      down.addEventListener('click', () => move(index, 1));
      const remove = el('button', 'small danger', '外す');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        picks.splice(index, 1);
        markDirty();
        renderPicks();
        renderResults();
      });
      controls.append(count, until, extend, up, down, remove);
      li.append(controls);
      return li;
    }),
  );
  $('picks-empty').hidden = picks.length > 0;
}

function move(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= picks.length) return;
  [picks[index], picks[target]] = [picks[target], picks[index]];
  markDirty();
  renderPicks();
}

function renderResults(): void {
  const query = normalizeText($<HTMLInputElement>('pick-search').value.trim());
  const picked = new Set(picks.map((pick) => pick.id));
  let candidates = [...articles.values()].filter((article) => !picked.has(article.id));
  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    candidates = candidates.filter((article) => {
      const title = normalizeText(article.title);
      return terms.every((term) => title.includes(term));
    });
    candidates.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  } else {
    // 何も入れていなければ、多くのメディアが報じた新しい話題（同じ話題は、要約のある記事か最初の1件だけ）
    const topics = new Set<string>();
    candidates = candidates
      .filter((article) => (article.coverage ?? 1) >= 2 && Date.now() - Date.parse(article.publishedAt) < 2 * DAY)
      .sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0) || Number(Boolean(b.summarized)) - Number(Boolean(a.summarized)) || b.publishedAt.localeCompare(a.publishedAt))
      .filter((article) => {
        const key = article.topic ?? article.id;
        if (topics.has(key)) return false;
        topics.add(key);
        return true;
      });
  }
  const list = $('pick-results');
  list.replaceChildren(
    ...candidates.slice(0, 30).map((article) => {
      const li = el('li');
      const text = el('div', 'result-text');
      const title = el('a', 'pick-title', article.title);
      title.href = article.url;
      title.target = '_blank';
      title.rel = 'noopener';
      text.append(title, el('div', 'pick-meta', `${articleMeta(article)}${article.summarized ? ' ・ AI要約あり' : ''}`));
      const add = el('button', 'small', '追加');
      add.type = 'button';
      add.disabled = picks.length >= PICKS_MAX;
      add.title = picks.length >= PICKS_MAX ? `ピックアップは${PICKS_MAX}件までです` : 'ピックアップに追加する';
      add.addEventListener('click', () => {
        if (picks.length >= PICKS_MAX) return;
        const now = Date.now();
        picks.push({ id: article.id, comment: '', at: new Date(now).toISOString(), until: new Date(now + 3 * DAY).toISOString(), article });
        markDirty();
        renderPicks();
        renderResults();
        // 追加した記事のひとことの欄へ
        $('pick-edit-list').querySelector<HTMLTextAreaElement>('.pick-edit:last-child textarea')?.focus();
      });
      li.append(text, add);
      return li;
    }),
  );
  if (candidates.length === 0 && query) list.append(el('li', 'pick-meta', '見つかりませんでした（探せるのは、管理画面のデータにある新しい記事と要約済みの記事です）。'));
}

async function savePicks(): Promise<void> {
  const button = $<HTMLButtonElement>('save-picks');
  const status = $('picks-status');
  button.disabled = true;
  setStatus(status, '保存しています…');
  try {
    const content = serializePicks(picks.map(({ id, comment, at, until }) => ({ id, comment: comment.trim(), at, until })));
    const changed = await saveFile(PICKS_PATH, content, `ピックアップを更新（${picks.length}件）`);
    picksDirty = false;
    $('picks-dirty').textContent = '';
    setStatus(status, changed ? '保存しました。2〜3分ほどでサイトに反映されます。' : '変更はありませんでした。', 'ok');
    if (changed) status.append(' ', actionsLink(data.repository));
  } catch (error) {
    button.disabled = false;
    setStatus(status, `保存できませんでした: ${errorText(error)}`, 'error');
  }
}

function setupPicks(): void {
  for (const article of [...data.pending, ...data.summarized.map((record) => ({ ...record, summarized: true }))]) articles.set(article.id, article);
  picks = (data.picks ?? []).map((pick) => ({ id: pick.id, comment: pick.comment, at: pick.at, until: pick.until, article: pick.article ?? articles.get(pick.id) }));
  renderPicks();
  renderResults();
  let timer: ReturnType<typeof setTimeout> | undefined;
  $('pick-search').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(renderResults, 150);
  });
  $('save-picks').addEventListener('click', () => void savePicks());
  window.addEventListener('beforeunload', (event) => {
    if (picksDirty) event.preventDefault();
  });
}

// ===== お知らせ =====

const pad = (n: number) => String(n).padStart(2, '0');
/** datetime-local の値（このブラウザの時刻） */
function localValue(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function level(): NoticeLevel {
  return document.querySelector<HTMLInputElement>('input[name="notice-level"]:checked')?.value === 'important' ? 'important' : 'info';
}

function renderPreview(): void {
  const text = $<HTMLTextAreaElement>('notice-text').value.trim();
  $('notice-count').textContent = `${Array.from(text).length}/${NOTICE_MAX}`;
  $('preview-text').textContent = text || '（本文を入れると、ここに見え方が出ます）';
  $('preview-label').textContent = level() === 'important' ? '重要' : 'お知らせ';
  document.querySelector('.preview')?.classList.toggle('important', level() === 'important');
}

function renderCurrent(): void {
  const notice = data.notice;
  const current = $('notice-current');
  const now = Date.now();
  if (!notice) {
    current.textContent = 'いまはお知らせを出していません。';
    $('notice-remove').hidden = true;
    return;
  }
  const start = Date.parse(notice.start);
  const end = Date.parse(notice.end);
  const state = now < start ? `${dateFormat.format(new Date(start))} から掲載します` : now < end ? `掲載中（${dateFormat.format(new Date(end))} まで）` : '掲載期間が終わりました';
  current.textContent = `保存しているお知らせ: ${state}`;
  $('notice-remove').hidden = now >= end;
}

function fillForm(notice: Notice | null | undefined): void {
  const now = Date.now();
  const active = notice && Date.parse(notice.end) > now;
  $<HTMLTextAreaElement>('notice-text').value = active ? notice.text : '';
  $<HTMLInputElement>('notice-url').value = active ? (notice.url ?? '') : '';
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="notice-level"]')) radio.checked = radio.value === (active ? notice.level : 'info');
  const start = active ? Date.parse(notice.start) : now;
  const end = active ? Date.parse(notice.end) : now + 7 * DAY;
  $<HTMLInputElement>('notice-start').value = localValue(start);
  $<HTMLInputElement>('notice-end').value = localValue(end);
  renderPreview();
}

function readForm(): Notice | undefined {
  const text = $<HTMLTextAreaElement>('notice-text').value.trim();
  const urlText = $<HTMLInputElement>('notice-url').value.trim();
  const url = cleanLink(urlText);
  const start = new Date($<HTMLInputElement>('notice-start').value);
  const end = new Date($<HTMLInputElement>('notice-end').value);
  const status = $('notice-status');
  if (!text) {
    setStatus(status, '本文を入れてください', 'error');
    return undefined;
  }
  if (urlText && !url) {
    setStatus(status, 'リンクは、/ から始まるサイト内のページか、https の URL にしてください', 'error');
    return undefined;
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    setStatus(status, '掲載の終了は、開始より後にしてください', 'error');
    return undefined;
  }
  const draft = { text, ...(url ? { url } : {}), level: level(), start: start.toISOString(), end: end.toISOString(), updatedAt: new Date().toISOString() };
  return cleanNotice({ ...draft, id: noticeId(draft) });
}

async function saveNotice(notice: Notice, message: string): Promise<boolean> {
  const status = $('notice-status');
  setStatus(status, '保存しています…');
  try {
    const changed = await saveFile(NOTICE_PATH, serializeNotice(notice), message);
    data.notice = notice;
    renderCurrent();
    setStatus(status, changed ? '保存しました。2〜3分ほどでサイトに反映されます。' : '変更はありませんでした。', 'ok');
    if (changed) status.append(' ', actionsLink(data.repository));
    return true;
  } catch (error) {
    setStatus(status, `保存できませんでした: ${errorText(error)}`, 'error');
    return false;
  }
}

function setupNotice(): void {
  fillForm(data.notice);
  renderCurrent();
  if (analyticsEndpoint) $('notice-push-row').hidden = false;
  $('notice-text').addEventListener('input', renderPreview);
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="notice-level"]')) radio.addEventListener('change', renderPreview);
  // 期間を選んだら、開始から終了を決める
  $('notice-days').addEventListener('change', () => {
    const start = new Date($<HTMLInputElement>('notice-start').value);
    if (!Number.isNaN(start.getTime())) $<HTMLInputElement>('notice-end').value = localValue(start.getTime() + Number($<HTMLSelectElement>('notice-days').value) * DAY);
  });
  $('notice-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const notice = readForm();
    if (!notice) return;
    const button = $<HTMLButtonElement>('notice-save');
    button.disabled = true;
    const saved = await saveNotice(notice, `お知らせを更新: ${shorten(notice.text, 30)}`);
    button.disabled = false;
    if (saved && $<HTMLInputElement>('notice-push').checked && analyticsEndpoint) {
      try {
        const result = await serverApi<{ subscribers?: number }>(token, '/admin/push/send', {
          title: notice.level === 'important' ? '重要なお知らせ' : 'お知らせ',
          body: notice.text,
          url: notice.url?.startsWith('/') ? notice.url : '/',
        });
        $('notice-status').append(` 通知を送り始めました（登録者 ${result.subscribers ?? 0}人のうち、お知らせを受け取る人へ）。`);
        $<HTMLInputElement>('notice-push').checked = false;
      } catch (error) {
        $('notice-status').append(` 通知は送れませんでした: ${errorText(error)}`);
      }
    }
  });
  $('notice-remove').addEventListener('click', async () => {
    const notice = data.notice;
    if (!notice || !confirm('お知らせの掲載をやめますか？（掲載の終了をいまにします）')) return;
    const now = new Date();
    const start = Date.parse(notice.start) < now.getTime() ? notice.start : new Date(now.getTime() - 60_000).toISOString();
    await saveNotice({ ...notice, start, end: now.toISOString(), updatedAt: now.toISOString() }, 'お知らせの掲載をやめる');
    fillForm(undefined);
  });
}

// ===== 起動 =====

async function main(): Promise<void> {
  const session = requireSession();
  if (!session) return;
  token = session.token;
  watchSession(session);
  root.hidden = false;
  try {
    data = await loadAdminData<ContentData>();
  } catch (error) {
    $('data-info').textContent = `管理画面のデータを読み込めませんでした（${errorText(error)}）`;
    return;
  }
  $('data-info').textContent = `サイトの最終更新: ${dateFormat.format(new Date(data.generatedAt))}（ここに出ている内容は、そのときに保存されていたものです）`;
  setupPicks();
  setupNotice();
  // ページ内のリンク（#picks・#notice）で開いたとき
  if (/^#[a-z-]+$/.test(location.hash)) document.querySelector(location.hash)?.scrollIntoView();
}

void main();
