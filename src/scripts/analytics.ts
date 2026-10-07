/**
 * アクセス解析（見たページ・開いた記事などを、運営者のアクセス解析のサーバー（analytics/）に送る）。
 * - Cookie は使わず、このために新しくブラウザに保存するものもない（「前にも来たか」は「あとで読む」と同じ訪問の記録を読むだけ）
 * - 送るのは、見たページ・開いた記事・検索した言葉と件数・あとで読むへの保存・閲覧時間・端末の種類（スマホ・タブレット・パソコン）・
 *   サイトの外から来たときの参照元（ホスト名だけ）。サーバーは IP アドレスを保存しない
 * - 「追跡しないで」の設定（Do Not Track・Global Privacy Control）のブラウザ、自動操作のブラウザ、
 *   管理画面で除外したブラウザ（管理画面にログインしたブラウザは自動で除外）からは送らない
 * - 表示中のページは1分ごとに合図を送り、「いま見ている人数」を数えてもらう（ページの [data-live-count] に表示する）
 */

/** このブラウザを数えないか（'1': 数えない、'0': 数える（自分で選んだ）、なし: 数える） */
export const OPTOUT_KEY = 'matmsait:analytics-optout';
const PING_INTERVAL = 60_000;
/** 前の閲覧からこれだけ空いたら、新しい訪問とみなす（「あとで読む」の新着の印と同じ） */
const SESSION_GAP = 30 * 60_000;
/** 操作がないままこれだけたったら、表示中でも合図を送らない（開いたまま離れた人を「見ている人」に数えない） */
const IDLE_LIMIT = 10 * 60_000;
/** 検索の言葉は、入力が止まってから送る */
const SEARCH_DELAY = 2000;

export function isOptedOut(): boolean {
  try {
    return localStorage.getItem(OPTOUT_KEY) === '1';
  } catch {
    return false;
  }
}

/** このブラウザを数えるかを選ぶ（管理画面から） */
export function setOptOut(optOut: boolean): void {
  try {
    localStorage.setItem(OPTOUT_KEY, optOut ? '1' : '0');
  } catch {
    // 保存できない環境では選べない
  }
}

/** 管理画面にログインしたとき: まだ選んでいなければ、このブラウザを数えないようにする */
export function optOutByDefault(): void {
  try {
    if (localStorage.getItem(OPTOUT_KEY) === null) localStorage.setItem(OPTOUT_KEY, '1');
  } catch {
    // 保存できない環境では何もしない
  }
}

/** ページの種類（サイトのベースパスを除いたパスから決める） */
export function pageKind(path: string): { kind: string; cat?: string; src?: string } {
  if (path === '/') return { kind: 'home' };
  const [first, second] = path.split('/').filter(Boolean);
  switch (first) {
    case 'category':
      return { kind: 'category', cat: second };
    case 'source':
      return { kind: 'source', src: second };
    case 'summary':
    case 'summaries':
    case 'latest':
    case 'ranking':
    case 'popular':
    case 'daily':
    case 'search':
    case 'saved':
    case 'following':
      return { kind: first };
    case 'settings':
    case 'about':
    case 'privacy':
    case 'contact':
    case 'editorial':
    case 'sources':
      return { kind: 'info' };
    default:
      return { kind: 'other' };
  }
}

/** 参照元のホスト名（先頭の www. は除く）。utm_source があればそちらを使う */
export function referrerLabel(referrer: string, search: string, ownHost: string): string | undefined {
  let host = '';
  try {
    host = referrer ? new URL(referrer).hostname.toLowerCase() : '';
  } catch {
    host = '';
  }
  // サイトの中を移動してきたときは入口ではない
  if (host && host === ownHost) return undefined;
  const utm = (new URLSearchParams(search).get('utm_source') ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return utm || host.replace(/^www\./, '');
}

interface Payload {
  t: 'view' | 'click' | 'search' | 'save' | 'time' | 'ping';
  p?: string;
  k?: string;
  a?: string;
  s?: string;
  c?: string;
  r?: string;
  q?: string;
  n?: number;
  d?: string;
  ret?: number;
  l?: number;
  ti?: string;
  u?: string;
}

function canTrack(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.webdriver || nav.globalPrivacyControl === true || nav.doNotTrack === '1') return false;
  if (isOptedOut()) return false;
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

/** 端末の種類（m: スマホ・t: タブレット・d: パソコン） */
function device(): string {
  if (!matchMedia('(pointer: coarse)').matches) return 'd';
  return Math.min(screen.width, screen.height) >= 600 ? 't' : 'm';
}

/** 記事のリンクの見出し（「元記事」のリンクなどは、近くの見出しから） */
function titleFor(link: HTMLAnchorElement): string {
  const own = link.classList.contains('item-title') ? link : link.querySelector('.others-title');
  const title = own ?? link.closest('.item, .topic, article, li')?.querySelector('.item-title, h1');
  return (title?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * このページを開く前の訪問の記録（「あとで読む」の新着の印のための記録。src/scripts/reader.ts の visitInfo）。
 * lastView は前にこのサイトのページを見た日時、returning は前の訪問があるか、available は記録を読めたか
 */
export interface VisitInfo {
  lastView?: number;
  returning: boolean;
  available: boolean;
}

/** このページがサイトの外から来た最初のページ（入口）か（前の閲覧から30分以内なら同じ訪問の続き） */
export function isLanding(visit: VisitInfo, referrerIsOwnSite: boolean, now: number): boolean {
  if (!visit.available) return !referrerIsOwnSite;
  return visit.lastView === undefined || now - visit.lastView > SESSION_GAP;
}

export function startAnalytics(endpoint: string, visit: VisitInfo = { returning: false, available: false }): void {
  if (!canTrack()) return;
  // 先読み（プリレンダー）されたページは、実際に表示されてから数える
  if ((document as Document & { prerendering?: boolean }).prerendering) {
    document.addEventListener('prerenderingchange', () => startAnalytics(endpoint, visit), { once: true });
    return;
  }
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const path = (location.pathname.startsWith(`${base}/`) ? location.pathname.slice(base.length) : location.pathname) || '/';
  const { kind, cat, src } = pageKind(path);
  const url = `${endpoint}/collect`;

  /** イベントを送る（離れるときは sendBeacon で）。いま見ている人数が返ってくればそれを返す */
  const send = async (payload: Payload, beacon = false): Promise<number | undefined> => {
    const body = JSON.stringify(payload);
    if (beacon && typeof navigator.sendBeacon === 'function') {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return undefined;
      } catch {
        // 送れなければ fetch で送る
      }
    }
    try {
      const res = await fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } });
      if (res.status !== 200) return undefined;
      const data = (await res.json()) as { online?: unknown };
      return typeof data.online === 'number' ? data.online : undefined;
    } catch {
      return undefined;
    }
  };

  const showOnline = (online: number | undefined) => {
    if (online === undefined) return;
    for (const element of document.querySelectorAll<HTMLElement>('[data-live-count]')) {
      element.textContent = `いま${online}人が閲覧中`;
      element.hidden = online < Number(element.dataset.min ?? 2);
    }
  };

  const view = (landing: boolean) => {
    const article = document.querySelector<HTMLElement>('[data-article-view]');
    const payload: Payload = {
      t: 'view',
      p: path,
      k: kind,
      c: article?.dataset.cat ?? cat,
      s: article?.dataset.src ?? src,
      a: article?.dataset.aid,
      ti: article?.dataset.title,
      u: article?.dataset.url,
      d: device(),
    };
    const ref = referrerLabel(document.referrer, location.search, location.hostname);
    if (landing && isLanding(visit, ref === undefined, Date.now())) Object.assign(payload, { l: 1, r: ref ?? '', ret: visit.returning ? 1 : 0 });
    void send(payload).then(showOnline);
  };

  // ===== 閲覧時間（表示している間だけ数え、隠れたときと離れるときに送る） =====
  let visibleSince = document.visibilityState === 'visible' ? performance.now() : 0;
  let pendingMs = 0;
  let lastActive = Date.now();
  const flushTime = () => {
    if (visibleSince) pendingMs += performance.now() - visibleSince;
    visibleSince = document.visibilityState === 'visible' ? performance.now() : 0;
    const seconds = Math.round(pendingMs / 1000);
    if (seconds >= 1) {
      send({ t: 'time', p: path, n: Math.min(seconds, 1800) }, true);
      pendingMs = 0;
    }
  };

  // ===== サイト内検索（入力が止まってから、同じ言葉は1回だけ） =====
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSearch: { q: string; n: number } | undefined;
  const sentQueries = new Set<string>();
  const flushSearch = () => {
    clearTimeout(searchTimer);
    if (!pendingSearch) return;
    const { q, n } = pendingSearch;
    pendingSearch = undefined;
    const key = q.trim().toLowerCase();
    if (!key || sentQueries.has(key)) return;
    sentQueries.add(key);
    send({ t: 'search', p: path, k: kind, q: key, n }, true);
  };
  document.addEventListener('tp:search', (event) => {
    const detail = (event as CustomEvent<{ q?: unknown; n?: unknown }>).detail;
    if (typeof detail?.q !== 'string' || typeof detail.n !== 'number') return;
    pendingSearch = { q: detail.q, n: detail.n };
    clearTimeout(searchTimer);
    searchTimer = setTimeout(flushSearch, SEARCH_DELAY);
  });

  // ===== 記事を開いた（クリック・中クリック） =====
  const onClick = (event: MouseEvent) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-aid]') : null;
    if (!link?.dataset.aid) return;
    const payload: Payload = { t: 'click', p: path, k: kind, a: link.dataset.aid, s: link.dataset.src, c: link.dataset.cat };
    // 外部の記事なら、管理画面で記事名を出せるよう見出しと URL も送る（要約ページは開いたときに送る）
    if (link.host !== location.host) Object.assign(payload, { u: link.href, ti: titleFor(link) });
    send(payload, true);
  };
  document.addEventListener('click', onClick, { capture: true });
  document.addEventListener('auxclick', onClick, { capture: true });

  // ===== あとで読むに保存した =====
  document.addEventListener('tp:save', (event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id !== 'string') return;
    const container = event.target instanceof Element ? event.target.closest('.item, .topic, li') : null;
    const link = container?.querySelector<HTMLAnchorElement>('a[data-aid]');
    const payload: Payload = { t: 'save', p: path, k: kind, a: id, s: link?.dataset.src, c: link?.dataset.cat };
    if (link && link.host !== location.host) Object.assign(payload, { u: link.href, ti: titleFor(link) });
    send(payload, true);
  });

  for (const type of ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const) {
    window.addEventListener(type, () => (lastActive = Date.now()), { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushTime();
      flushSearch();
    } else {
      visibleSince = performance.now();
      lastActive = Date.now();
    }
  });
  window.addEventListener('pagehide', () => {
    flushTime();
    flushSearch();
  });
  // 「戻る」で表示し直したページも閲覧として数える
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    visibleSince = document.visibilityState === 'visible' ? performance.now() : 0;
    view(false);
  });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || Date.now() - lastActive > IDLE_LIMIT) return;
    void send({ t: 'ping', p: path }).then(showOnline);
  }, PING_INTERVAL);

  view(true);
}
