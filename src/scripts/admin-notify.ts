/**
 * 管理画面の「通知」（/admin/notify/）: 通知の登録の状況（登録者・受け取り方・よくフォローされているもの）、
 * 運営からのお知らせを送る、送った記録
 */
import { drawBarList } from './charts.ts';
import { requireSession, watchSession } from './admin-common.ts';
import { $, analyticsEndpoint, dateFormat, el, errorText, numberFormat, serverApi, setStatus } from './admin-shared.ts';

interface PushStats {
  subscribers: number;
  modes: { follow: number; hot: number; news: number; daily: number; quiet: number };
  cats: { key: string; n: number }[];
  srcs: { key: string; n: number }[];
  words: { key: string; n: number }[];
  log: { id: number; kind: string; title: string; items: number; targets: number; sent: number; failed: number; removed: number; done: number }[];
  last: { at: number; items: number; fresh: number; hot: number } | null;
  pending: { kind: string; id: number; targets: number; sent: number }[];
}

const root = document.querySelector<HTMLElement>('[data-admin]')!;
const names = JSON.parse(root.dataset.names ?? '{}') as { categories: Record<string, string>; sources: Record<string, string> };
let token = '';

const KIND_LABEL: Record<string, string> = { check: 'フォローの新着・話題', news: 'お知らせ', test: 'テスト' };

function stat(label: string, value: number, sub?: string): HTMLElement {
  const box = el('div', 'stat');
  box.append(el('p', 'stat-label', label), el('p', 'stat-value', numberFormat.format(value)));
  if (sub) box.append(el('p', 'stat-sub', sub));
  return box;
}

function render(stats: PushStats): void {
  const share = (n: number) => (stats.subscribers > 0 ? `${Math.round((n / stats.subscribers) * 100)}%` : '');
  $('stats').replaceChildren(
    stat('通知の登録者', stats.subscribers),
    stat('フォローの新着を受け取る', stats.modes.follow, share(stats.modes.follow)),
    stat('話題を受け取る', stats.modes.hot, share(stats.modes.hot)),
    stat('お知らせを受け取る', stats.modes.news, share(stats.modes.news)),
    stat('1日1回にまとめる', stats.modes.daily, share(stats.modes.daily)),
    stat('夜は送らない', stats.modes.quiet, share(stats.modes.quiet)),
  );
  const last = stats.last;
  $('last-check').textContent = last
    ? `最後の新着の確認: ${dateFormat.format(new Date(last.at))}（はじめて見た記事 ${last.fresh}件・新しい話題 ${last.hot}件）${stats.pending.length > 0 ? ' ・ いま送っています' : ''}`
    : 'まだ新着の確認をしていません（サイトの更新のあとに行います）。';

  const rows = (list: { key: string; n: number }[], label: (key: string) => string) =>
    list.slice(0, 10).map((entry) => ({ label: label(entry.key), value: entry.n, display: `${numberFormat.format(entry.n)}人` }));
  drawBarList($('follow-cats'), rows(stats.cats, (key) => names.categories[key] ?? key), 'まだありません。');
  drawBarList($('follow-srcs'), rows(stats.srcs, (key) => names.sources[key] ?? key), 'まだありません。');
  drawBarList($('follow-words'), rows(stats.words, (key) => key), 'まだありません。');

  const body = $('log-body');
  body.replaceChildren(
    ...stats.log.map((entry) => {
      const tr = el('tr');
      const cells: [string, string?][] = [
        [dateFormat.format(new Date(entry.done))],
        [KIND_LABEL[entry.kind] ?? entry.kind],
        [entry.title],
        [numberFormat.format(entry.sent), 'num'],
        [numberFormat.format(entry.failed), 'num'],
        [numberFormat.format(entry.removed), 'num'],
      ];
      for (const [text, className] of cells) tr.append(el('td', className, text));
      return tr;
    }),
  );
  if (stats.log.length === 0) {
    const tr = el('tr');
    const td = el('td', 'pick-meta', 'まだ送っていません。');
    td.colSpan = 6;
    tr.append(td);
    body.append(tr);
  }
}

async function load(): Promise<void> {
  try {
    const stats = await serverApi<PushStats>(token, '/admin/push');
    render(stats);
    $('data-info').textContent = `${dateFormat.format(new Date())} 時点`;
  } catch (error) {
    $('data-info').textContent = `通知のサーバーから読み込めませんでした（${errorText(error)}）`;
  }
}

function renderPreview(): void {
  const title = $<HTMLInputElement>('send-title-input').value.trim();
  const body = $<HTMLTextAreaElement>('send-body').value.trim();
  $('title-count').textContent = `${Array.from(title).length}/60`;
  $('body-count').textContent = `${Array.from(body).length}/200`;
  $('preview-title').textContent = title || '（タイトル）';
  $('preview-body').textContent = body;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  $('night-warning').hidden = !(hour >= 23 || hour < 7);
}

function setupSend(): void {
  const form = $<HTMLFormElement>('send-form');
  for (const id of ['send-title-input', 'send-body']) $(id).addEventListener('input', renderPreview);
  renderPreview();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $<HTMLInputElement>('send-title-input').value.trim();
    const body = $<HTMLTextAreaElement>('send-body').value.trim();
    const url = $<HTMLInputElement>('send-url').value.trim() || '/';
    const cat = $<HTMLSelectElement>('send-target').value;
    const status = $('send-status');
    if (!title) {
      setStatus(status, 'タイトルを入れてください', 'error');
      return;
    }
    if (!/^\/(?!\/)[^\s\\]*$/.test(url)) {
      setStatus(status, '開くページは、/ から始まるサイト内のパスにしてください', 'error');
      return;
    }
    const target = cat ? `${names.categories[cat] ?? cat}をフォローしている人` : 'お知らせを受け取る人全員';
    if (!confirm(`「${title}」を${target}に通知で送ります。よろしいですか？（取り消せません）`)) return;
    const button = $<HTMLButtonElement>('send-button');
    button.disabled = true;
    setStatus(status, '送っています…');
    try {
      await serverApi(token, '/admin/push/send', { title, body, url, cat });
      setStatus(status, '送り始めました。数分で全員に届きます（届いた数は「送った記録」に出ます）。', 'ok');
      form.reset();
      $<HTMLInputElement>('send-url').value = '/';
      renderPreview();
      setTimeout(() => void load(), 5000);
    } catch (error) {
      setStatus(status, `送れませんでした: ${errorText(error)}`, 'error');
    } finally {
      setTimeout(() => (button.disabled = false), 3000);
    }
  });
}

async function main(): Promise<void> {
  const session = requireSession();
  if (!session) return;
  token = session.token;
  watchSession(session);
  root.hidden = false;
  if (!analyticsEndpoint) {
    $('setup-card').hidden = false;
    for (const card of document.querySelectorAll<HTMLElement>('[data-needs-server]')) card.hidden = true;
    $('data-info').textContent = '';
    return;
  }
  setupSend();
  $('refresh').addEventListener('click', () => void load());
  await load();
}

void main();
