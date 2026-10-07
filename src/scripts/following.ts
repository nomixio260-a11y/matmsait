/**
 * 「フォロー中」のページ（/following/）: フォローしているジャンル・掲載元・キーワードの新着を一覧にし、
 * フォローの追加・削除と、通知（プッシュ通知）のオン・オフ・受け取り方を設定する
 */
import { isEmptyPrefs, matchFollow, withBase, type FollowMatch, type FollowPrefs, type UpdateEntry, type UpdatesFile } from '../lib/follow-core.ts';
import { suggestKeywords } from '../lib/search-core.ts';
import {
  PREFS_EVENT,
  loadFollow,
  loadFollowingState,
  loadMute,
  saveFollowingState,
  setFollow,
  type FollowKind,
} from './personal-store.ts';
import { countFollowNew, loadUpdates, moreButton, toast } from './personal.ts';
import {
  DEFAULT_NOTIFY,
  PushError,
  disablePush,
  enablePush,
  loadPushLocal,
  pushSupport,
  setNotifyOptions,
  syncPush,
  testPush,
  verifyPush,
  type NotifyOptions,
} from './push-client.ts';
import { syncSaveButtons } from './reader.ts';

interface PageData {
  categories: { slug: string; name: string; color: string }[];
  sources: { id: string; name: string; cat: string; host: string }[];
}

const root = document.querySelector<HTMLElement>('[data-following-page]')!;
const page = JSON.parse(root.dataset.page ?? '{}') as PageData;
const base = document.body.dataset.base ?? '';
const apiBase = document.body.dataset.analytics ?? '';
const categoryBySlug = new Map(page.categories.map((category) => [category.slug, category]));
const sourceById = new Map(page.sources.map((source) => [source.id, source]));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** このページを開く前に「フォロー中」を見た日時（これより後の記事に新着の印を付ける） */
const seenBefore = loadFollowingState().seenAt ?? 0;

// ===== フォローしているもの（チップ） =====

function labelOf(kind: FollowKind, value: string): string {
  if (kind === 'cat') return categoryBySlug.get(value)?.name ?? value;
  if (kind === 'src') return sourceById.get(value)?.name ?? value;
  return value;
}

const KIND_LABEL: Record<FollowKind, string> = { cat: 'ジャンル', src: '掲載元', word: 'キーワード' };

function followEntries(follow: FollowPrefs): { kind: FollowKind; value: string }[] {
  return [
    ...follow.cats.map((value) => ({ kind: 'cat' as const, value })),
    ...follow.srcs.map((value) => ({ kind: 'src' as const, value })),
    ...follow.words.map((value) => ({ kind: 'word' as const, value })),
  ];
}

function renderChips(): void {
  const follow = loadFollow();
  const list = $('follow-chips');
  const entries = followEntries(follow);
  list.replaceChildren(
    ...entries.map(({ kind, value }) => {
      const li = el('li', 'chip');
      const label = labelOf(kind, value);
      li.append(el('span', 'chip-kind', KIND_LABEL[kind]), el('span', 'chip-label', label));
      const remove = el('button', 'chip-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `「${label}」のフォローをやめる`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        setFollow(kind, value, false);
        toast(`「${label}」のフォローをやめました`, { label: '元に戻す', run: () => setFollow(kind, value, true) });
      });
      li.append(remove);
      return li;
    }),
  );
  $('follow-chips-empty').hidden = entries.length > 0;
}

// ===== 新着の一覧 =====

const PAGE = 100;
let shown = PAGE;
/** 絞り込み（ジャンル・掲載元・キーワードのどれか1つ。なければすべて） */
let filter: { kind: FollowKind; value: string } | undefined;
let updates: UpdatesFile | undefined;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const dayLabel = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (diff < MINUTE) return 'たった今';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < 24 * HOUR) return `${Math.floor(diff / HOUR)}時間前`;
  return timeFormat.format(new Date(iso));
}

function reasonLabel(match: FollowMatch): string {
  const { reason } = match;
  if (reason.kind === 'word') return `「${reason.value}」`;
  return labelOf(reason.kind, reason.value);
}

function itemRow(match: FollowMatch): HTMLLIElement {
  const { entry } = match;
  const category = categoryBySlug.get(entry.c);
  const source = sourceById.get(entry.s);
  const li = el('li', 'item');
  li.id = `a-${entry.i}`;
  li.dataset.id = entry.i;
  li.dataset.at = entry.d;
  li.dataset.src = entry.s;
  li.dataset.srcName = entry.n;
  li.dataset.cat = entry.c;
  if (category) li.dataset.catName = category.name;
  if (seenBefore && Date.parse(entry.d) > seenBefore) li.classList.add('is-unseen');

  const link = el('a', 'item-title', entry.t);
  const url = withBase(entry.u, `${base}/`);
  link.href = url;
  if (!entry.m) {
    link.target = '_blank';
    link.rel = 'noopener';
  }
  link.dataset.aid = entry.i;
  link.dataset.src = entry.s;
  link.dataset.cat = entry.c;
  li.append(link);

  const meta = el('div', 'item-meta');
  const site = el('span', 'item-site');
  if (source) {
    const icon = el('img');
    icon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(source.host)}&sz=32`;
    icon.alt = '';
    icon.width = 16;
    icon.height = 16;
    icon.loading = 'lazy';
    icon.decoding = 'async';
    icon.referrerPolicy = 'no-referrer';
    const sourceLink = el('a', undefined, entry.n);
    sourceLink.href = `${base}/source/${entry.s}/`;
    site.append(icon, sourceLink);
  } else {
    site.append(el('span', undefined, entry.n));
  }
  meta.append(site);
  if (category) {
    const cat = el('a', 'item-cat');
    cat.href = `${base}/category/${category.slug}/`;
    const dot = el('span', 'dot');
    dot.style.setProperty('--c', category.color);
    cat.append(dot, category.name);
    meta.append(cat);
  }
  const time = el('time', undefined, relativeTime(entry.d));
  time.dateTime = entry.d;
  time.dataset.rel = '';
  meta.append(time);
  if ((entry.k ?? 1) >= 2) {
    const coverage = el('a', 'coverage');
    coverage.href = `${base}/ranking/`;
    coverage.title = 'この話題を報じた掲載元の数';
    coverage.append(el('b', undefined, String(entry.k)), '社が報道');
    meta.append(coverage);
  }
  if (entry.m) meta.append(el('span', 'ai-badge', 'AI要約'));
  meta.append(el('span', 'follow-reason', reasonLabel(match)));

  const save = el('button', 'save-btn');
  save.type = 'button';
  save.dataset.save = JSON.stringify({ id: entry.i, title: entry.t, url, site: entry.n, at: entry.d });
  save.setAttribute('aria-pressed', 'false');
  save.setAttribute('aria-label', 'あとで読む');
  save.title = 'あとで読む';
  save.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"></path></svg>';
  meta.append(save, moreButton());
  li.append(meta);
  return li;
}

/** 絞り込みのボタン（すべて・フォローしているものごと。それぞれの件数つき） */
function renderFilter(entries: UpdateEntry[], follow: FollowPrefs, total: number): void {
  const box = $('follow-filter');
  const items = followEntries(follow);
  if (items.length < 2) {
    box.hidden = true;
    filter = undefined;
    return;
  }
  const mute = loadMute();
  const button = (label: string, count: number, target?: { kind: FollowKind; value: string }) => {
    const b = el('button', 'chip toggle-chip');
    b.type = 'button';
    const on = target ? filter?.kind === target.kind && filter.value === target.value : !filter;
    b.setAttribute('aria-pressed', String(on));
    b.append(label, el('span', 'chip-count', String(count)));
    b.addEventListener('click', () => {
      filter = target;
      shown = PAGE;
      renderList();
    });
    return b;
  };
  const single = (kind: FollowKind, value: string): FollowPrefs => ({ cats: kind === 'cat' ? [value] : [], srcs: kind === 'src' ? [value] : [], words: kind === 'word' ? [value] : [] });
  box.replaceChildren(
    button('すべて', total),
    ...items.map(({ kind, value }) => button(labelOf(kind, value), matchFollow(entries, single(kind, value), mute).length, { kind, value })),
  );
  // 絞り込んでいたものをフォローしなくなったら、すべてに戻す
  if (filter && !items.some((item) => item.kind === filter?.kind && item.value === filter.value)) filter = undefined;
  box.hidden = false;
}

function renderList(): void {
  const follow = loadFollow();
  const list = $('following-list');
  const empty = $('following-empty');
  const info = $('new-info');
  if (isEmptyPrefs(follow)) {
    list.replaceChildren();
    empty.hidden = false;
    $('follow-filter').hidden = true;
    $('following-more-wrap').hidden = true;
    info.textContent = '';
    return;
  }
  empty.hidden = true;
  if (!updates) {
    info.textContent = '読み込んでいます…';
    return;
  }
  const mute = loadMute();
  const all = matchFollow(updates.items, follow, mute);
  renderFilter(updates.items, follow, all.length);
  const matches = filter
    ? matchFollow(updates.items, { cats: filter.kind === 'cat' ? [filter.value] : [], srcs: filter.kind === 'src' ? [filter.value] : [], words: filter.kind === 'word' ? [filter.value] : [] }, mute)
    : all;
  const fresh = seenBefore ? all.filter(({ entry }) => Date.parse(entry.d) > seenBefore).length : 0;
  info.textContent = `36時間で${all.length}件${fresh > 0 ? `（前回から${fresh}件）` : ''}`;

  if (matches.length === 0) {
    const p = el('p', 'following-empty', 'この36時間に当てはまる新着はありません。フォローを増やすか、しばらくしてからご覧ください。');
    list.replaceChildren(p);
    $('following-more-wrap').hidden = true;
    return;
  }
  // 日付ごとにまとめる
  const groups: { key: string; label: string; rows: FollowMatch[] }[] = [];
  for (const match of matches.slice(0, shown)) {
    const date = new Date(match.entry.d);
    const key = dayKey.format(date);
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(match);
    else groups.push({ key, label: dayLabel.format(date), rows: [match] });
  }
  list.replaceChildren(
    ...groups.map((group) => {
      const section = el('section', 'day-group');
      const ul = el('ul', 'items');
      ul.append(...group.rows.map(itemRow));
      section.append(el('h3', 'day-head', group.label), ul);
      return section;
    }),
  );
  syncSaveButtons(list);
  $('following-more-wrap').hidden = matches.length <= shown;
}

/** 通知から開いたとき（#a-記事ID）は、その記事を見えるところに出して目立たせる */
function focusTarget(): void {
  const match = location.hash.match(/^#a-([0-9a-f]{16})$/);
  if (!match) return;
  const item = document.getElementById(`a-${match[1]}`);
  if (!item) return;
  item.classList.add('is-target');
  item.scrollIntoView({ block: 'center' });
  item.querySelector<HTMLElement>('.item-title')?.focus({ preventScroll: true });
}

// ===== フォローの追加 =====

function setupForms(): void {
  $('word-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $<HTMLInputElement>('word-input');
    const word = input.value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!word) return;
    if (Array.from(word).length > 30) {
      toast('キーワードは30文字までです');
      return;
    }
    setFollow('word', word, true);
    input.value = '';
    toast(`キーワード「${word}」をフォローしました`);
  });
  $('src-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const select = $<HTMLSelectElement>('src-select');
    if (!select.value) return;
    const name = sourceById.get(select.value)?.name ?? select.value;
    setFollow('src', select.value, true);
    select.value = '';
    toast(`掲載元「${name}」をフォローしました`);
  });
}

/** いま話題の言葉（新着の見出しによく出る言葉）を、キーワードの候補として出す */
function renderSuggestions(): void {
  if (!updates) return;
  const entries = updates.items.map((entry) => ({ t: entry.t, d: entry.d, s: entry.s }));
  const follow = loadFollow();
  const words = suggestKeywords(entries, Date.now(), { hours: 24, limit: 10, minCount: 3, minSources: 2 }).filter(
    (word) => !follow.words.some((w) => w.toLowerCase() === word.toLowerCase()),
  );
  const box = $('suggest-words');
  const list = $('suggest-word-list');
  list.replaceChildren(
    ...words.slice(0, 8).map((word) => {
      const button = el('button', 'chip toggle-chip', word);
      button.type = 'button';
      button.addEventListener('click', () => {
        setFollow('word', word, true);
        toast(`キーワード「${word}」をフォローしました`);
      });
      return button;
    }),
  );
  box.hidden = words.length === 0;
}

// ===== 通知 =====

const panel = $('notify-panel');
const status = $('notify-status');
const toggle = $<HTMLButtonElement>('notify-toggle');
const testButton = $<HTMLButtonElement>('notify-test');
let busy = false;

function readOptions(): NotifyOptions {
  const box = (name: string) => panel.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  return {
    follow: box('follow')?.checked ?? DEFAULT_NOTIFY.follow,
    hot: box('hot')?.checked ?? DEFAULT_NOTIFY.hot,
    news: box('news')?.checked ?? DEFAULT_NOTIFY.news,
    daily: panel.querySelector<HTMLInputElement>('input[name="timing"][value="daily"]')?.checked ?? false,
    quiet: box('quiet')?.checked ?? DEFAULT_NOTIFY.quiet,
  };
}

function writeOptions(options: NotifyOptions): void {
  const box = (name: string) => panel.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  for (const key of ['follow', 'hot', 'news', 'quiet'] as const) {
    const input = box(key);
    if (input) input.checked = options[key];
  }
  for (const radio of panel.querySelectorAll<HTMLInputElement>('input[name="timing"]')) radio.checked = radio.value === (options.daily ? 'daily' : 'now');
  // 1日1回なら夜は関係ない
  const quiet = box('quiet');
  if (quiet) quiet.disabled = options.daily;
}

function renderNotify(): void {
  const support = pushSupport(apiBase);
  if (support === 'no-server') {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const local = loadPushLocal();
  writeOptions(local.notify);
  status.classList.toggle('is-on', local.enabled);
  testButton.hidden = !local.enabled;
  toggle.disabled = busy || support === 'unsupported' || support === 'ios-install';
  toggle.textContent = local.enabled ? '通知をやめる' : '通知を受け取る';
  toggle.classList.toggle('primary', !local.enabled);
  const follows = followEntries(loadFollow()).length;
  if (support === 'unsupported') status.textContent = 'このブラウザは通知に対応していません。';
  else if (support === 'ios-install')
    status.textContent =
      'iPhone・iPad で通知を受け取るには、Safari の共有ボタン（□に↑）から「ホーム画面に追加」を選び、ホーム画面に追加したアイコンからこのページを開いて、通知をオンにしてください（iOS 16.4 以降）。';
  else if (support === 'denied' && !local.enabled)
    status.textContent = 'このサイトの通知がブロックされています。ブラウザのサイトの設定で通知を「許可」にしてから、もう一度お試しください。';
  else if (local.enabled)
    status.textContent = follows > 0 ? `通知はオンです。フォローしている${follows}件の新着などをお知らせします。` : '通知はオンです（まだ何もフォローしていません）。';
  else status.textContent = '通知はオフです。オンにすると、このサイトを開いていないときも、フォローしているものの新着をお知らせします。';
}

async function run(task: () => Promise<void>): Promise<void> {
  busy = true;
  renderNotify();
  try {
    await task();
  } catch (error) {
    toast(error instanceof PushError ? error.message : '通知の設定に失敗しました。しばらくしてからお試しください');
    console.error(error);
  } finally {
    busy = false;
    renderNotify();
  }
}

let optionsTimer: ReturnType<typeof setTimeout> | undefined;

function setupNotify(): void {
  renderNotify();
  if (panel.hidden) return;
  toggle.addEventListener('click', () =>
    run(async () => {
      if (loadPushLocal().enabled) {
        await disablePush(base, apiBase);
        toast('通知をやめました');
      } else {
        await enablePush(base, apiBase, readOptions());
        toast('通知をオンにしました。「テストの通知を送る」で届くか確かめられます');
      }
    }),
  );
  testButton.addEventListener('click', () =>
    run(async () => {
      await testPush(base, apiBase);
      toast('テストの通知を送りました。数秒で届きます');
    }),
  );
  panel.addEventListener('change', () => {
    const options = readOptions();
    writeOptions(options);
    const local = loadPushLocal();
    if (!local.enabled) {
      // オフのときは受け取り方だけ覚えておく（オンにしたときに使う）
      setNotifyOptions(options);
      return;
    }
    clearTimeout(optionsTimer);
    optionsTimer = setTimeout(() => {
      void run(async () => {
        await syncPush(base, apiBase, options);
        toast('通知の設定を保存しました');
      });
    }, 600);
  });
  // ブラウザの登録とサーバーの登録がそろっているかを確かめる（ずれていたら直す）
  if (loadPushLocal().enabled) void verifyPush(base, apiBase).then(renderNotify, () => undefined);
}

// ===== 起動 =====

function refresh(): void {
  renderChips();
  renderList();
  renderNotify();
}

setupForms();
setupNotify();
renderChips();
renderList();
$('following-more').addEventListener('click', () => {
  shown += PAGE;
  renderList();
});

loadUpdates().then((file) => {
  updates = file;
  if (!file) {
    $('new-info').textContent = '新着を読み込めませんでした';
    return;
  }
  renderList();
  renderSuggestions();
  focusTarget();
  // このページを見たので、ヘッダーの新着の数を0にする（印は、次に開くまでは付けたまま）
  saveFollowingState({ ...loadFollowingState(), seenAt: Date.now(), count: 0, checkedAt: Date.now(), builtAt: file.builtAt });
  void countFollowNew();
});

window.addEventListener(PREFS_EVENT, (event) => {
  const what = (event as CustomEvent<{ what: string }>).detail?.what;
  if (what === 'follow' || what === 'mute') {
    refresh();
    renderSuggestions();
  }
  if (what === 'push') renderNotify();
});
window.addEventListener('storage', (event) => {
  if (event.key === 'matmsait:follow' || event.key === 'matmsait:mute' || event.key === 'matmsait:push') refresh();
});
