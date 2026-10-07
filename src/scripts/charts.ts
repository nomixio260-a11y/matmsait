/**
 * 管理画面のアクセス解析で使う小さなグラフ（外部のライブラリを使わず SVG で描く。管理画面の CSP で外部のスクリプトを読めないため）。
 * - 縦棒（分ごと・時間帯）: 棒ごとにポインター・キーボードで値を表示
 * - 折れ線（推移）: 縦線で日時を合わせ、すべての系列の値を表示。凡例と、線の端の値
 * - 横棒の一覧（人気の記事・ページなど）: 文字の一覧に棒を添える
 * 色はページの CSS の --series-1・--series-2（ライト・ダークで値を変える）。文字は文字の色のまま
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const formatNumber = (value: number) => value.toLocaleString('ja-JP');

/** 目盛り（0 から始まる、きりのよい刻み。数は整数なので刻みは1以上） */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: ticks, step: 1 };
  const rough = max / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power);
  return { max: Math.ceil(max / step) * step, step };
}

interface TooltipRow {
  value: string;
  label: string;
  /** 系列の色のクラス（線の印を付ける） */
  series?: string;
}

/** グラフの上に出す説明（1つのグラフに1つ。中身は textContent で作る） */
function createTooltip(container: HTMLElement) {
  const tip = html('div', 'chart-tip');
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  container.append(tip);
  return {
    show(x: number, title: string, rows: TooltipRow[]) {
      const head = html('div', 'chart-tip-title', title);
      tip.replaceChildren(
        head,
        ...rows.map((row) => {
          const line = html('div', 'chart-tip-row');
          if (row.series) line.append(html('span', `chart-key ${row.series}`));
          line.append(html('strong', undefined, row.value), html('span', undefined, row.label));
          return line;
        }),
      );
      tip.hidden = false;
      // グラフの中に収まる位置へ
      const width = tip.offsetWidth;
      const left = Math.min(Math.max(0, x - width / 2), container.clientWidth - width);
      tip.style.left = `${left}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

export interface Column {
  label: string;
  value: number;
  /** 説明に足す行 */
  extra?: TooltipRow[];
}

export interface ColumnOptions {
  ariaLabel: string;
  height?: number;
  /** 下の目盛りに出す文字（出さない位置は undefined） */
  tick?: (index: number) => string | undefined;
  /** 値の単位（説明に出す） */
  unit: string;
  /** いちばん大きい棒に値を添える */
  labelMax?: boolean;
}

/** 縦棒のグラフ */
export function drawColumns(container: HTMLElement, columns: Column[], options: ColumnOptions): void {
  container.replaceChildren();
  container.classList.add('chart');
  const width = Math.max(240, container.clientWidth);
  const height = options.height ?? 150;
  const pad = { top: 18, right: 8, bottom: 22, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;
  const top = Math.max(0, ...columns.map((column) => column.value));
  const scale = niceScale(top);
  const y = (value: number) => baseline - (value / scale.max) * plotH;
  const band = plotW / Math.max(1, columns.length);
  const barW = Math.min(24, Math.max(2, band - 2));

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.ariaLabel, tabindex: 0 });
  for (let value = 0; value <= scale.max; value += scale.step) {
    root.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: 'chart-grid' }));
    const label = svg('text', { x: pad.left - 6, y: y(value) + 4, class: 'chart-axis', 'text-anchor': 'end' });
    label.textContent = formatNumber(value);
    root.append(label);
  }
  const maxIndex = columns.findIndex((column) => column.value === top && top > 0);
  const marks: SVGPathElement[] = [];
  columns.forEach((column, index) => {
    const x0 = pad.left + index * band + (band - barW) / 2;
    const h = baseline - y(column.value);
    const mark = svg('path', { class: 'chart-col series-1' });
    if (h > 0) {
      // 先端だけ角を丸め、根元は四角のまま
      const r = Math.min(4, barW / 2, h);
      const y0 = baseline - h;
      mark.setAttribute(
        'd',
        `M${x0},${baseline}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + barW - r}Q${x0 + barW},${y0} ${x0 + barW},${y0 + r}V${baseline}Z`,
      );
    }
    marks.push(mark);
    root.append(mark);
    const tick = options.tick?.(index);
    if (tick) {
      const text = svg('text', { x: pad.left + index * band + band / 2, y: height - 6, class: 'chart-axis', 'text-anchor': 'middle' });
      text.textContent = tick;
      root.append(text);
    }
    if (options.labelMax && index === maxIndex) {
      const text = svg('text', { x: pad.left + index * band + band / 2, y: y(column.value) - 5, class: 'chart-value', 'text-anchor': 'middle' });
      text.textContent = formatNumber(column.value);
      root.append(text);
    }
  });
  root.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: baseline, y2: baseline, class: 'chart-baseline' }));
  container.append(root);

  // 棒の幅いっぱい（隙間も含む）を当たりにして、近い棒の値を出す
  const tooltip = createTooltip(container);
  let active = -1;
  const select = (index: number) => {
    if (active >= 0) marks[active]?.classList.remove('is-active');
    active = Math.max(0, Math.min(columns.length - 1, index));
    marks[active]?.classList.add('is-active');
    const column = columns[active];
    tooltip.show(pad.left + active * band + band / 2, column.label, [
      { value: `${formatNumber(column.value)}${options.unit}`, label: '', series: 'series-1' },
      ...(column.extra ?? []),
    ]);
  };
  const clear = () => {
    if (active >= 0) marks[active]?.classList.remove('is-active');
    active = -1;
    tooltip.hide();
  };
  root.addEventListener('pointermove', (event) => {
    const x = event.clientX - root.getBoundingClientRect().left;
    if (x < pad.left || x > width - pad.right) return clear();
    select(Math.floor((x - pad.left) / band));
  });
  root.addEventListener('pointerleave', clear);
  root.addEventListener('focus', () => select(active >= 0 ? active : columns.length - 1));
  root.addEventListener('blur', clear);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      select(active + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
}

export interface Series {
  name: string;
  values: number[];
  /** 色のクラス（series-1・series-2） */
  series: string;
}

export interface LineOptions {
  ariaLabel: string;
  height?: number;
  tick?: (index: number) => string | undefined;
  unit: string;
}

/** 折れ線のグラフ（縦軸は1つ。凡例を上に置き、線の端に最後の値を添える） */
export function drawLines(container: HTMLElement, labels: string[], series: Series[], options: LineOptions): void {
  container.replaceChildren();
  container.classList.add('chart');
  const legend = html('div', 'chart-legend');
  for (const entry of series) {
    const item = html('span', 'chart-legend-item');
    item.append(html('span', `chart-key ${entry.series}`), document.createTextNode(entry.name));
    legend.append(item);
  }
  container.append(legend);

  const width = Math.max(260, container.clientWidth);
  const height = options.height ?? 220;
  const pad = { top: 14, right: 52, bottom: 24, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;
  const top = Math.max(0, ...series.flatMap((entry) => entry.values));
  const scale = niceScale(top);
  const count = labels.length;
  const x = (index: number) => pad.left + (count <= 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const y = (value: number) => baseline - (value / scale.max) * plotH;

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.ariaLabel, tabindex: 0 });
  for (let value = 0; value <= scale.max; value += scale.step) {
    root.append(svg('line', { x1: pad.left, x2: pad.left + plotW, y1: y(value), y2: y(value), class: 'chart-grid' }));
    const label = svg('text', { x: pad.left - 6, y: y(value) + 4, class: 'chart-axis', 'text-anchor': 'end' });
    label.textContent = formatNumber(value);
    root.append(label);
  }
  root.append(svg('line', { x1: pad.left, x2: pad.left + plotW, y1: baseline, y2: baseline, class: 'chart-baseline' }));
  labels.forEach((_, index) => {
    const tick = options.tick?.(index);
    if (!tick) return;
    const text = svg('text', { x: x(index), y: height - 6, class: 'chart-axis', 'text-anchor': 'middle' });
    text.textContent = tick;
    root.append(text);
  });

  const crosshair = svg('line', { x1: 0, x2: 0, y1: pad.top, y2: baseline, class: 'chart-crosshair', visibility: 'hidden' });
  root.append(crosshair);
  const endY: number[] = [];
  const dots: SVGCircleElement[] = [];
  for (const entry of series) {
    const points = entry.values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
    root.append(svg('polyline', { points, class: `chart-line ${entry.series}` }));
    const last = entry.values.length - 1;
    if (last >= 0) {
      root.append(svg('circle', { cx: x(last), cy: y(entry.values[last]), r: 4, class: `chart-dot ${entry.series}` }));
      endY.push(y(entry.values[last]));
    }
    const dot = svg('circle', { cx: 0, cy: 0, r: 4, class: `chart-dot ${entry.series}`, visibility: 'hidden' });
    dots.push(dot);
  }
  // 線の端の値（ほかの線の端と重なるときは出さず、凡例と説明に任せる）
  series.forEach((entry, index) => {
    const last = entry.values.length - 1;
    if (last < 0) return;
    const clash = endY.some((other, j) => j !== index && Math.abs(other - endY[index]) < 14);
    if (clash) return;
    const text = svg('text', { x: x(last) + 8, y: endY[index] + 4, class: 'chart-value' });
    text.textContent = formatNumber(entry.values[last]);
    root.append(text);
  });
  root.append(...dots);
  container.append(root);

  const tooltip = createTooltip(container);
  let active = -1;
  const select = (index: number) => {
    active = Math.max(0, Math.min(count - 1, index));
    const cx = x(active);
    crosshair.setAttribute('x1', String(cx));
    crosshair.setAttribute('x2', String(cx));
    crosshair.setAttribute('visibility', 'visible');
    series.forEach((entry, i) => {
      dots[i].setAttribute('cx', String(cx));
      dots[i].setAttribute('cy', String(y(entry.values[active] ?? 0)));
      dots[i].setAttribute('visibility', 'visible');
    });
    tooltip.show(
      cx,
      labels[active],
      series.map((entry) => ({ value: `${formatNumber(entry.values[active] ?? 0)}${options.unit}`, label: entry.name, series: entry.series })),
    );
  };
  const clear = () => {
    active = -1;
    crosshair.setAttribute('visibility', 'hidden');
    for (const dot of dots) dot.setAttribute('visibility', 'hidden');
    tooltip.hide();
  };
  root.addEventListener('pointermove', (event) => {
    const px = event.clientX - root.getBoundingClientRect().left;
    if (px < pad.left - 10 || px > pad.left + plotW + 10) return clear();
    select(count <= 1 ? 0 : Math.round(((px - pad.left) / plotW) * (count - 1)));
  });
  root.addEventListener('pointerleave', clear);
  root.addEventListener('focus', () => select(active >= 0 ? active : count - 1));
  root.addEventListener('blur', clear);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      select(active + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
}

export interface BarRow {
  /** 項目名（リンクにするときは href） */
  label: string;
  href?: string;
  /** 外部のリンクか（別のタブで開く） */
  external?: boolean;
  value: number;
  /** 値の表示（なければ数をそのまま） */
  display?: string;
  /** 項目名の下に出す補足 */
  sub?: string;
  /** 項目名の前に出す小さな印（「要約あり」など） */
  badge?: string;
}

/** 横棒の一覧（棒の長さは一覧の最大値に対する割合） */
export function drawBarList(container: HTMLElement, rows: BarRow[], empty: string): void {
  if (rows.length === 0) {
    container.replaceChildren(html('p', 'chart-empty', empty));
    return;
  }
  const max = Math.max(1, ...rows.map((row) => row.value));
  const list = html('ol', 'bar-list');
  for (const row of rows) {
    const item = html('li');
    const head = html('div', 'bar-head');
    const label = html('span', 'bar-label');
    if (row.badge) label.append(html('span', 'bar-badge', row.badge));
    if (row.href) {
      const link = html('a', undefined, row.label);
      link.href = row.href;
      if (row.external) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      label.append(link);
    } else {
      label.append(document.createTextNode(row.label));
    }
    head.append(label, html('span', 'bar-value', row.display ?? formatNumber(row.value)));
    const track = html('div', 'bar-track');
    const fill = html('span', 'bar-fill series-1');
    fill.style.width = `${Math.max(1, (row.value / max) * 100)}%`;
    track.append(fill);
    item.append(head, track);
    if (row.sub) item.append(html('div', 'bar-sub', row.sub));
    list.append(item);
  }
  container.replaceChildren(list);
}
