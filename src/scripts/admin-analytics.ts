/**
 * 管理画面のアクセス解析（/admin/analytics/）。
 * アクセス解析のサーバー（analytics/ の Cloudflare Worker）から、ログイン中の GitHub のトークンを添えて集計を読む
 * （サーバーは、そのトークンでサイトのリポジトリに書き込めるかを GitHub に確かめてから答える）
 */
import { requireSession, watchSession } from './admin-common.ts';
import { isOptedOut, setOptOut } from './analytics.ts';
import { drawBarList, drawColumns, drawLines, formatNumber, type BarRow } from './charts.ts';

interface Row {
  key: string;
  count: number;
  uniq: number;
  sum: number;
}
type Totals = Record<string, { count: number; uniq: number; sum: number }>;
interface Article {
  aid: string;
  title: string;
  url: string;
  src: string;
  cat: string;
}
interface Stats {
  from: string;
  to: string;
  days: number;
  generatedAt: string;
  totals: Totals;
  previous: Totals;
  series: { label: string; views: number; visitors: number; clicks: number }[];
  top: Record<string, Row[]>;
  articles: Record<string, Article>;
}
interface Live {
  now: string;
  online: number;
  pages: { path: string; n: number }[];
  minutes: { t: number; views: number; clicks: number }[];
  recent: { ts: number; type: string; path: string; kind: string; aid: string; title: string; q: string; ref: string; country: string; dev: string }[];
  today: { visitors: number; views: number; visits: number; clicks: number };
  /** この週（月曜から）・この月の訪問者数（WAU・MAU。古いサーバーにはない） */
  period?: { week: number; month: number };
  /** 記事 ID → 記事の名前 */
  titles?: Record<string, string>;
}

const LIVE_INTERVAL = 15_000;
const STATS_INTERVAL = 5 * 60_000;
const PERIOD_KEY = 'admin.analytics.period';

const root = document.querySelector<HTMLElement>('[data-analytics-root]')!;
const endpoint = root.dataset.endpoint ?? '';
const names = JSON.parse(root.dataset.names ?? '{}') as { categories: Record<string, string>; sources: Record<string, string> };
const base = document.body.dataset.base ?? '';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let token = '';
/** 記事の名前（集計の応答に入っているものをためておき、リアルタイムの表示にも使う） */
const articles = new Map<string, Article>();

// ===== 表示の言葉 =====

const PAGE_NAMES: Record<string, string> = {
  '/': 'トップ',
  '/latest/': '新着記事',
  '/ranking/': '話題のニュース',
  '/popular/': 'よく読まれている記事',
  '/summaries/': 'AI要約の一覧',
  '/daily/': '日別まとめ',
  '/search/': '検索',
  '/saved/': 'あとで読む',
  '/about/': '運営者情報',
  '/privacy/': 'プライバシーポリシー',
  '/contact/': 'お問い合わせ',
  '/editorial/': '編集方針',
  '/sources/': '掲載元一覧',
};
const CHANNELS: Record<string, string> = {
  direct: '直接（ブックマーク・URL の入力など）',
  search: '検索エンジン',
  social: 'SNS',
  ai: 'AI チャット',
  other: 'ほかのサイト',
};
const DEVICES: Record<string, string> = { m: 'スマホ', t: 'タブレット', d: 'パソコン' };
const OSES: Record<string, string> = {
  ios: 'iPhone・iPad',
  android: 'Android',
  windows: 'Windows',
  macos: 'Mac',
  chromeos: 'ChromeOS',
  linux: 'Linux',
  other: 'その他',
};
const BROWSERS: Record<string, string> = {
  chrome: 'Chrome',
  safari: 'Safari',
  edge: 'Edge',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
  opera: 'Opera',
  line: 'LINE のアプリ内',
  'in-app': 'SNS のアプリ内',
  other: 'その他',
};
const DEPTH_ORDER = ['1', '2', '3', '4-5', '6-9', '10+'];
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['ja'], { type: 'region' });
  } catch {
    return undefined;
  }
})();
const countryName = (code: string) => {
  if (code === 'T1') return 'Tor';
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX') return '不明';
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

function pageLabel(path: string): string {
  if (PAGE_NAMES[path]) return PAGE_NAMES[path];
  let match = path.match(/^\/category\/([^/]+)\/(?:(\d+)\/)?$/);
  if (match) return `カテゴリ: ${names.categories[match[1]] ?? match[1]}${match[2] ? `（${match[2]}ページ目）` : ''}`;
  match = path.match(/^\/source\/([^/]+)\/(?:(\d+)\/)?$/);
  if (match) return `掲載元: ${names.sources[match[1]] ?? match[1]}${match[2] ? `（${match[2]}ページ目）` : ''}`;
  match = path.match(/^\/summary\/([0-9a-f]{16})\/$/);
  if (match) return `要約: ${articles.get(match[1])?.title ?? match[1]}`;
  match = path.match(/^\/daily\/\d{4}-(\d{2})-(\d{2})\/$/);
  if (match) return `日別まとめ: ${Number(match[1])}/${Number(match[2])}`;
  match = path.match(/^\/(latest|summaries)\/(\d+)\/$/);
  if (match) return `${PAGE_NAMES[`/${match[1]}/`]}（${match[2]}ページ目）`;
  return path;
}

const percent = (value: number | undefined) =>
  value === undefined ? '-' : value === 0 ? '0%' : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '-';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}秒`;
  return `${Math.floor(rounded / 60)}分${String(rounded % 60).padStart(2, '0')}秒`;
}
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(id: string, message: string, error = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle('error', error);
}

// ===== サーバーとの通信 =====

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${endpoint}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (res.status === 401) throw new Error('GitHub のトークンを確認できませんでした。ログインし直してください');
  if (!res.ok) throw new Error(`アクセス解析のサーバーが応答しません（HTTP ${res.status}）`);
  return (await res.json()) as T;
}

const errorText = (error: unknown) =>
  error instanceof TypeError ? 'アクセス解析のサーバーに接続できませんでした' : error instanceof Error ? error.message : String(error);

// ===== 期間 =====

const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => jstDay(Date.parse(`${day}T00:00:00+09:00`) + days * 86_400_000);

function rangeOf(period: string): { from: string; to: string } {
  const today = jstDay(Date.now());
  if (period === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  const days = Number(period);
  if (Number.isInteger(days) && days > 1) return { from: addDays(today, -(days - 1)), to: today };
  return { from: today, to: today };
}

const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

let period = (() => {
  try {
    return localStorage.getItem(PERIOD_KEY) ?? 'today';
  } catch {
    return 'today';
  }
})();

// ===== 主な数字（前の期間と比べる） =====

interface Tile {
  label: string;
  /** 値の書き方（人数・回数・割合・時間） */
  format: (value: number | undefined) => string;
  current?: number;
  previous?: number;
  /** 増えるのが良いか（直帰は減るのが良い） */
  upIsGood: boolean;
  /** 割合なら差をポイントで出す */
  ratio?: boolean;
}

function renderKpis(stats: Stats) {
  const t = stats.totals;
  const p = stats.previous;
  const get = (totals: Totals, metric: string, field: 'count' | 'uniq' | 'sum') => totals[metric]?.[field] ?? 0;
  const ratio = (a: number, b: number) => (b > 0 ? a / b : undefined);
  const perView = (totals: Totals) => ratio(get(totals, 'time', 'sum'), get(totals, 'view', 'count'));
  const returning = stats.top['visit.ret'] ?? [];
  const returningShare = ratio(
    returning.find((row) => row.key === '1')?.uniq ?? 0,
    returning.reduce((sum, row) => sum + row.uniq, 0),
  );
  const people = (value: number | undefined) => (value === undefined ? '-' : `${formatNumber(value)}人`);
  const times = (value: number | undefined) => (value === undefined ? '-' : `${formatNumber(value)}回`);
  const count = (metric: string, field: 'count' | 'uniq', format: Tile['format'], label: string): Tile => ({
    label,
    format,
    current: get(t, metric, field),
    previous: get(p, metric, field),
    upIsGood: true,
  });
  const tiles: Tile[] = [
    count('all', 'uniq', people, '訪問者数'),
    count('view', 'count', times, '閲覧数'),
    count('visit', 'count', times, 'サイトに来た回数'),
    count('click', 'count', times, '記事を開いた回数'),
    {
      label: '記事を開いた人の割合',
      format: percent,
      current: ratio(get(t, 'click', 'uniq'), get(t, 'view', 'uniq')),
      previous: ratio(get(p, 'click', 'uniq'), get(p, 'view', 'uniq')),
      upIsGood: true,
      ratio: true,
    },
    { label: '1ページの閲覧時間', format: duration, current: perView(t), previous: perView(p), upIsGood: true },
    {
      label: '1ページで離れた人',
      format: percent,
      current: ratio(get(t, 'bounce', 'uniq'), get(t, 'view', 'uniq')),
      previous: ratio(get(p, 'bounce', 'uniq'), get(p, 'view', 'uniq')),
      upIsGood: false,
      ratio: true,
    },
    { label: '前にも来た人の訪問', format: percent, current: returningShare, upIsGood: true },
  ];
  const today = stats.from === stats.to && stats.to === jstDay(Date.now());
  $('kpis').replaceChildren(
    ...tiles.map((tile) => {
      const box = el('div', 'kpi');
      box.append(el('p', 'kpi-label', tile.label), el('p', 'kpi-value', tile.format(tile.current)));
      const delta = el('p', 'kpi-delta');
      if (tile.current !== undefined && tile.previous !== undefined && tile.previous > 0) {
        if (today) {
          // 今日は途中までなので、増減ではなく昨日の値を並べる
          delta.textContent = `昨日: ${tile.format(tile.previous)}`;
        } else {
          const diff = tile.ratio ? (tile.current - tile.previous) * 100 : ((tile.current - tile.previous) / tile.previous) * 100;
          const up = diff > 0;
          const mark = el('span', diff === 0 ? '' : up === tile.upIsGood ? 'good' : 'bad');
          mark.textContent = `${diff === 0 ? '±' : up ? '▲' : '▼'}${Math.abs(diff).toFixed(tile.ratio || Math.abs(diff) < 10 ? 1 : 0)}${tile.ratio ? 'ポイント' : '%'}`;
          delta.append('前の期間より ', mark);
        }
      } else if (tile.current !== undefined && tile.previous !== undefined) {
        delta.textContent = '前の期間の記録なし';
      }
      box.append(delta);
      return box;
    }),
  );
}

// ===== 推移・時間帯 =====

function table(headers: string[], rows: (string | number)[][]): HTMLTableElement {
  const element = el('table');
  const head = el('tr');
  for (const header of headers) head.append(el('th', undefined, header));
  element.append(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) tr.append(el('td', undefined, typeof cell === 'number' ? formatNumber(cell) : cell));
    element.append(tr);
  }
  return element;
}

let lastStats: Stats | undefined;

function renderTrend(stats: Stats) {
  const hourly = stats.from === stats.to;
  let series = stats.series;
  // 今日の分は、まだ来ていない時間を出さない
  if (hourly && stats.to === jstDay(Date.now())) series = series.slice(0, new Date(Date.now() + 9 * 3_600_000).getUTCHours() + 1);
  const labels = series.map((point) => (hourly ? point.label : shortDay(point.label)));
  const every = hourly ? 6 : Math.max(1, Math.ceil(series.length / 6));
  drawLines(
    $('trend'),
    labels,
    [
      { name: '閲覧数', values: series.map((point) => point.views), series: 'series-1' },
      { name: '訪問者数', values: series.map((point) => point.visitors), series: 'series-2' },
    ],
    {
      ariaLabel: `${hourly ? '時間' : '日'}ごとの閲覧数と訪問者数の推移（表で見るで数値を確認できます）`,
      unit: '',
      tick: (index) => (index % every === 0 || index === series.length - 1 ? labels[index] : undefined),
    },
  );
  $('trend-table').replaceChildren(
    table(
      [hourly ? '時間' : '日付', '閲覧数', '訪問者数', ...(hourly ? [] : ['記事を開いた回数'])],
      series.map((point) => [point.label, point.views, point.visitors, ...(hourly ? [] : [point.clicks])]),
    ),
  );

  const hours = new Map((stats.top['view.hour'] ?? []).map((row) => [row.key, row]));
  const columns = Array.from({ length: 24 }, (_, hour) => {
    const row = hours.get(String(hour).padStart(2, '0'));
    return { label: `${hour}時台`, value: row?.count ?? 0, extra: [{ value: `${formatNumber(row?.uniq ?? 0)}人`, label: '訪問者' }] };
  });
  drawColumns($('hours'), columns, {
    ariaLabel: '時間帯ごとの閲覧数（日本時間。表で見るで数値を確認できます）',
    unit: '回',
    labelMax: true,
    tick: (index) => (index % 3 === 0 ? `${index}時` : undefined),
  });
  $('hours-table').replaceChildren(table(['時間帯', '閲覧数', '訪問者'], columns.map((column, hour) => [column.label, column.value, hours.get(String(hour).padStart(2, '0'))?.uniq ?? 0])));
}

// ===== 一覧 =====

/** 上位だけ表示し、「もっと見る」で増やす */
function drawList(id: string, rows: BarRow[], empty: string, first = 10) {
  const container = $(id);
  let shown = first;
  const render = () => {
    const box = el('div');
    drawBarList(box, rows.slice(0, shown), empty);
    container.replaceChildren(box);
    if (rows.length > shown) {
      const more = el('button', 'ghost small more-rows', `もっと見る（全${rows.length}件）`);
      more.type = 'button';
      more.addEventListener('click', () => {
        shown = rows.length;
        render();
      });
      container.append(more);
    }
  };
  render();
}

const rowsOf = (stats: Stats, metric: string) => stats.top[metric] ?? [];

function renderLists(stats: Stats) {
  for (const [id, article] of Object.entries(stats.articles)) articles.set(id, article);
  const countBy = (metric: string) => new Map(rowsOf(stats, metric).map((row) => [row.key, row]));
  const clicks = countBy('click.aid');
  const views = countBy('view.aid');
  const saves = countBy('save.aid');

  const articleRow = (row: Row, unit: string): BarRow => {
    const info = articles.get(row.key);
    const summaryViews = views.get(row.key)?.count ?? 0;
    const parts = [
      clicks.get(row.key) ? `開いた ${formatNumber(clicks.get(row.key)!.count)}回` : '',
      summaryViews ? `要約ページ ${formatNumber(summaryViews)}回` : '',
      saves.get(row.key) ? `保存 ${formatNumber(saves.get(row.key)!.count)}回` : '',
      info?.src ? (names.sources[info.src] ?? info.src) : '',
    ].filter(Boolean);
    return {
      label: info?.title || `（記事名の記録なし: ${row.key}）`,
      // 要約ページが読まれている記事は要約ページへ、それ以外は元の記事へ
      href: summaryViews > 0 ? `${base}/summary/${row.key}/` : info?.url,
      external: summaryViews === 0,
      badge: summaryViews > 0 ? '要約あり' : undefined,
      value: unit === '人' ? row.uniq : row.count,
      display: unit === '人' ? `${formatNumber(row.uniq)}人` : `${formatNumber(row.count)}回`,
      sub: parts.join(' ・ '),
    };
  };
  drawList('list-articles', rowsOf(stats, 'art.aid').map((row) => articleRow(row, '人')), 'まだ記録がありません。', 15);
  drawList('list-saved', rowsOf(stats, 'save.aid').map((row) => articleRow(row, '回')), 'まだ保存されていません。');

  const times = countBy('time.path');
  drawList(
    'list-pages',
    rowsOf(stats, 'view.path').map((row) => ({
      label: pageLabel(row.key),
      href: `${base}${row.key}`,
      value: row.count,
      display: `${formatNumber(row.count)}回`,
      sub: `${formatNumber(row.uniq)}人 ・ 1回あたり ${duration((times.get(row.key)?.sum ?? 0) / Math.max(1, row.count))}`,
    })),
    'まだ記録がありません。',
  );

  const visits = rowsOf(stats, 'visit.channel');
  const visitTotal = visits.reduce((sum, row) => sum + row.count, 0);
  drawList(
    'list-channels',
    visits.map((row) => ({
      label: CHANNELS[row.key] ?? row.key,
      value: row.count,
      display: `${formatNumber(row.count)}回（${percent(row.count / Math.max(1, visitTotal))}）`,
    })),
    'まだ記録がありません。',
  );
  drawList(
    'list-refs',
    rowsOf(stats, 'visit.ref').map((row) => ({
      label: row.key,
      href: row.key.includes('.') ? `https://${row.key}/` : undefined,
      external: true,
      value: row.count,
      display: `${formatNumber(row.count)}回`,
    })),
    'ほかのサイトから来た記録はまだありません。',
  );
  drawList(
    'list-landing',
    rowsOf(stats, 'visit.path').map((row) => ({ label: pageLabel(row.key), href: `${base}${row.key}`, value: row.count, display: `${formatNumber(row.count)}回` })),
    'まだ記録がありません。',
  );
  drawList(
    'list-search',
    rowsOf(stats, 'search.q').map((row) => ({
      label: row.key,
      href: `${base}/search/?q=${encodeURIComponent(row.key)}`,
      value: row.count,
      display: `${formatNumber(row.count)}回`,
      sub: row.sum > 0 ? `0件 ${formatNumber(row.sum)}回` : undefined,
    })),
    'まだ検索されていません。',
  );

  const catClicks = countBy('click.cat');
  const catViews = rowsOf(stats, 'view.cat');
  const cats = new Set([...catViews.map((row) => row.key), ...catClicks.keys()]);
  drawList(
    'list-cats',
    [...cats]
      .map((key) => {
        const viewCount = catViews.find((row) => row.key === key)?.count ?? 0;
        const clickCount = catClicks.get(key)?.count ?? 0;
        return {
          label: names.categories[key] ?? key,
          href: `${base}/category/${key}/`,
          value: viewCount + clickCount,
          display: `${formatNumber(viewCount + clickCount)}回`,
          sub: `ページの閲覧 ${formatNumber(viewCount)}回 ・ 記事を開いた ${formatNumber(clickCount)}回`,
        };
      })
      .sort((a, b) => b.value - a.value),
    'まだ記録がありません。',
  );
  drawList(
    'list-sources',
    rowsOf(stats, 'click.src').map((row) => ({
      label: names.sources[row.key] ?? row.key,
      href: `${base}/source/${row.key}/`,
      value: row.count,
      display: `${formatNumber(row.count)}回`,
      sub: `${formatNumber(row.uniq)}人`,
    })),
    'まだ記録がありません。',
  );

  const depth = rowsOf(stats, 'depth');
  drawList(
    'list-depth',
    DEPTH_ORDER.flatMap((key) => {
      const row = depth.find((entry) => entry.key === key);
      return row ? [{ label: `${key}ページ`, value: row.uniq, display: `${formatNumber(row.uniq)}人` }] : [];
    }),
    'まだ記録がありません。',
    DEPTH_ORDER.length,
  );
  const people = (metric: string, labels: Record<string, string> | ((key: string) => string)) =>
    rowsOf(stats, metric).map((row) => ({
      label: typeof labels === 'function' ? labels(row.key) : (labels[row.key] ?? row.key),
      value: row.uniq,
      display: `${formatNumber(row.uniq)}人`,
    }));
  drawList('list-devices', people('view.dev', DEVICES), 'まだ記録がありません。');
  drawList('list-os', people('view.os', OSES), 'まだ記録がありません。', 5);
  drawList('list-browsers', people('view.br', BROWSERS), 'まだ記録がありません。', 5);
  drawList('list-countries', people('view.country', countryName), 'まだ記録がありません。');
}

// ===== 期間の集計 =====

let statsSequence = 0;
async function loadStats() {
  const { from, to } = rangeOf(period);
  $('range').textContent = from === to ? `${shortDay(from)}（日本時間）` : `${shortDay(from)}〜${shortDay(to)}（日本時間）`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#period button')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === period));
  }
  const current = ++statsSequence;
  $('stats').classList.add('loading');
  try {
    const stats = await api<Stats>(`/admin/stats?from=${from}&to=${to}`);
    if (current !== statsSequence) return;
    lastStats = stats;
    renderKpis(stats);
    renderLists(stats);
    renderTrend(stats);
    setStatus('stats-status', '');
    $('refresh').title = `${dateTime.format(new Date(stats.generatedAt))} 時点`;
  } catch (error) {
    if (current === statsSequence) setStatus('stats-status', `集計を読み込めませんでした: ${errorText(error)}`, true);
  } finally {
    if (current === statsSequence) $('stats').classList.remove('loading');
  }
}

// ===== リアルタイム =====

const KIND_WORDS: Record<string, string> = { view: '閲覧', click: '記事を開いた', search: '検索', save: 'あとで読むに保存' };

function renderLive(live: Live) {
  for (const [aid, title] of Object.entries(live.titles ?? {})) {
    if (!articles.has(aid)) articles.set(aid, { aid, title, url: '', src: '', cat: '' });
  }
  $('live-online').textContent = `${formatNumber(live.online)}人`;
  $('live-today').textContent =
    `今日: 訪問者 ${formatNumber(live.today.visitors)}人 ・ 閲覧 ${formatNumber(live.today.views)}回 ・ 記事を開いた ${formatNumber(live.today.clicks)}回` +
    (live.period ? ` ／ この週の訪問者 ${formatNumber(live.period.week)}人 ・ この月 ${formatNumber(live.period.month)}人` : '');
  const last = live.minutes.length - 1;
  drawColumns(
    $('live-minutes'),
    live.minutes.map((minute) => ({
      label: shortTime.format(new Date(minute.t)),
      value: minute.views,
      extra: [{ value: `${formatNumber(minute.clicks)}回`, label: '記事を開いた' }],
    })),
    {
      ariaLabel: '直近30分の1分ごとの閲覧数',
      unit: '回',
      height: 120,
      tick: (index) => (index === last ? 'いま' : (last - index) % 10 === 0 ? `${last - index}分前` : undefined),
    },
  );
  drawBarList(
    $('live-pages'),
    live.pages.map((page) => ({ label: pageLabel(page.path), href: `${base}${page.path}`, value: page.n, display: `${formatNumber(page.n)}人` })),
    'いま見ている人はいません。',
  );
  const feed = live.recent.filter((event) => event.type !== 'time').slice(0, 30);
  $('live-recent').replaceChildren(
    ...(feed.length === 0
      ? [el('li', undefined, 'まだ記録がありません。')]
      : feed.map((event) => {
          const item = el('li');
          const time = el('time', undefined, timeFormat.format(new Date(event.ts)));
          time.dateTime = new Date(event.ts).toISOString();
          const what = el('span', 'what');
          const title = event.title || articles.get(event.aid)?.title || '';
          const subject =
            event.type === 'view'
              ? pageLabel(event.path)
              : event.type === 'search'
                ? `「${event.q}」`
                : title || event.aid;
          what.append(`${KIND_WORDS[event.type] ?? event.type}: ${subject}`);
          const meta = [event.ref ? `${event.ref} から` : '', DEVICES[event.dev] ?? '', event.country ? countryName(event.country) : '']
            .filter(Boolean)
            .join(' ・ ');
          if (meta) what.append(el('span', 'meta', ` （${meta}）`));
          item.append(time, what);
          return item;
        })),
  );
}

async function loadLive() {
  try {
    renderLive(await api<Live>('/admin/live'));
    setStatus('live-status', '');
  } catch (error) {
    setStatus('live-status', `リアルタイムの情報を読み込めませんでした: ${errorText(error)}`, true);
  }
}

// ===== このブラウザを数えるか =====

function renderOptOut() {
  const out = isOptedOut();
  $('optout-status').textContent = out
    ? 'このブラウザのアクセスは数えていません（管理画面にログインしたブラウザは、自分の閲覧で数字が増えないよう自動で除外します）。'
    : 'このブラウザのアクセスも数えています。';
  $('optout-toggle').textContent = out ? 'このブラウザも数える' : 'このブラウザを数えない';
}

// ===== 起動 =====

function main() {
  const session = requireSession();
  if (!session) return;
  token = session.token;
  watchSession(session);
  root.hidden = false;
  if (!endpoint) return;

  renderOptOut();
  $('optout-toggle').addEventListener('click', () => {
    setOptOut(!isOptedOut());
    renderOptOut();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('#period button')) {
    button.addEventListener('click', () => {
      period = button.dataset.period ?? 'today';
      try {
        localStorage.setItem(PERIOD_KEY, period);
      } catch {
        // 保存できなくても切り替えは効く
      }
      void loadStats();
    });
  }
  $('refresh').addEventListener('click', () => {
    void loadStats();
    void loadLive();
  });

  void loadLive();
  void loadStats();
  // 表示している間だけ、リアルタイムは15秒ごと、今日を含む集計は5分ごとに読み直す
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadLive();
  }, LIVE_INTERVAL);
  setInterval(() => {
    if (document.visibilityState === 'visible' && rangeOf(period).to === jstDay(Date.now())) void loadStats();
  }, STATS_INTERVAL);
  // 画面の幅が変わったらグラフを描き直す
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastWidth = root.clientWidth;
  new ResizeObserver(() => {
    if (root.clientWidth === lastWidth) return;
    lastWidth = root.clientWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastStats) renderTrend(lastStats);
      void loadLive();
    }, 200);
  }).observe(root);
}

main();
