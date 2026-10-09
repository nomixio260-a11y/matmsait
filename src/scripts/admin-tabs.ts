/**
 * 管理画面のページの中のタブ（[data-tabs] の中の [data-tab] のボタンと、[data-panel] の欄）。
 * - URL の #（#saved など）で開くタブを選び、選んだタブを # に残す（再読み込み・ほかのページからのリンクでも同じタブを開く）
 * - 以前のリンク（#sources-card など）は、欄の data-aliases で受ける
 * - 左のメニューのページの中へのリンク（記事の非表示・収集元の状況）を、そのタブのときに強調する
 * - ←→ Home End でタブを移る
 */
export function setupTabs(onSelect?: (name: string) => void): void {
  const list = document.querySelector<HTMLElement>('[data-tabs]');
  if (!list) return;
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-panel]')];
  const first = tabs[0]?.dataset.tab ?? '';
  const hashLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[data-nav-hash]')];
  const pageLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[aria-current="page"]:not([data-nav-hash])')];

  const resolve = (hash: string) => {
    const name = decodeURIComponent(hash.replace(/^#/, ''));
    if (!name) return undefined;
    return panels.find((panel) => panel.dataset.panel === name || (panel.dataset.aliases ?? '').split(' ').includes(name))?.dataset.panel;
  };

  const select = (name: string, { focus = false, keepHash = false } = {}) => {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    if (!keepHash) history.replaceState(history.state, '', name === first ? location.pathname + location.search : `#${name}`);
    const matched = hashLinks.filter((link) => link.dataset.navHash === name);
    for (const link of hashLinks) {
      if (matched.includes(link)) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const link of pageLinks) {
      if (matched.length > 0) link.removeAttribute('aria-current');
      else link.setAttribute('aria-current', 'page');
    }
    onSelect?.(name);
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.dataset.tab!));
    tab.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      select(tabs[next].dataset.tab!, { focus: true });
    });
  });
  window.addEventListener('hashchange', () => {
    const name = resolve(location.hash);
    if (!name) return;
    select(name, { keepHash: true });
    // 下まで読み進めたところでメニューから選んだときは、タブの位置まで戻す（ページの上の方にいるときは動かさない）
    if (list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: 'start' });
  });
  // 開いたときはスクロールしない（タブはページの上の方にあり、見出しが隠れないように）
  select(resolve(location.hash) ?? first, { keepHash: true });
}
