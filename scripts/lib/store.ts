import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Item } from '../../src/lib/types.ts';

export interface PruneOptions {
  now: Date;
  maxAgeDays?: number;
  maxItems?: number;
}

/** 見出しが同じでも別の記事とみなす間隔（定期連載などで同じ見出しが続くことがあるため） */
const SAME_TITLE_WINDOW = 3 * 24 * 60 * 60 * 1000;
/** これより短い見出しは、同じでも別の記事のことが多いので比べない（「試合記録」など） */
const MIN_TITLE_KEY_LENGTH = 12;

/**
 * 見出しを比べるためのキー。「 - Yahoo!ニュース」「：朝日新聞」「（ITmedia NEWS）」のような
 * 配信元の付け足しと、記号・空白を除く。短すぎる見出しは undefined（比べない）
 */
export function titleKey(title: string): string | undefined {
  const main = title
    .normalize('NFKC')
    .split(/\s+[-–—]\s+|\s*\|\s*/)[0]
    .replace(/\s*:[^:]{1,12}$/, '')
    .replace(/\s*\([^()]{1,30}\)$/, '');
  const key = main.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  return Array.from(key).length >= MIN_TITLE_KEY_LENGTH ? key : undefined;
}

/** 他社の記事を転載しているニュースサイト（同じ見出しなら元の配信元を残す） */
const REPOST_HOSTS = [
  'news.yahoo.co.jp',
  'news.goo.ne.jp',
  'news.livedoor.com',
  'news.biglobe.ne.jp',
  'news.nifty.com',
  'news.line.me',
  'topics.smt.docomo.ne.jp',
  'article.auone.net',
  'nordot.app',
  'www.msn.com',
];

const isRepost = (url: string) => {
  try {
    return REPOST_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * URL は違うが見出しが同じ記事（Yahoo!ニュースへの転載、スマホ版 URL など）を1つにまとめる。
 * 残すのは 要約がある記事 → 配信元のフィードの記事 → 転載サイトでない記事 → 先に公開された記事 の順。
 * はてブ数は多い方を引き継ぐ
 */
export function collapseSameTitle(
  items: Item[],
  isAggregator: (sourceId: string) => boolean = () => false,
  isPreferred: (id: string) => boolean = () => false,
): Item[] {
  const rank = (item: Item) => [
    isPreferred(item.id) ? 0 : 1,
    isAggregator(item.sourceId) ? 1 : 0,
    isRepost(item.url) ? 1 : 0,
  ];
  const better = (a: Item, b: Item) => {
    const [ra, rb] = [rank(a), rank(b)];
    return (
      ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id)
    );
  };
  const groups = new Map<string, Item[]>();
  const result: Item[] = [];
  for (const item of items) {
    const key = titleKey(item.title);
    if (key) groups.set(key, [...(groups.get(key) ?? []), item]);
    else result.push(item);
  }
  for (const group of groups.values()) {
    // 公開日時の近いものどうしだけをまとめる
    const sorted = group.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    let cluster: Item[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const kept = { ...[...cluster].sort(better)[0] };
      const hatebu = Math.max(...cluster.map((item) => item.hatebu ?? 0));
      if (hatebu > 0) kept.hatebu = hatebu;
      kept.excerpt ||= cluster.find((item) => item.excerpt)?.excerpt ?? '';
      result.push(kept);
      cluster = [];
    };
    for (const item of sorted) {
      if (cluster.length > 0 && Date.parse(item.publishedAt) - Date.parse(cluster[0].publishedAt) > SAME_TITLE_WINDOW) flush();
      cluster.push(item);
    }
    flush();
  }
  return result;
}

/**
 * 記事をIDで重複排除しながらマージする。
 * 基本は先に取得した方を残すが、はてブ等の集約元経由の記事を配信元自身のフィードで取得できた場合は
 * 配信元の情報（カテゴリ・公開日時・抜粋）に置き換える。
 * そのあと、URL が違っても見出しが同じ記事を1つにまとめる。
 */
export function mergeItems(
  existing: Item[],
  incoming: Item[],
  isAggregator: (sourceId: string) => boolean = () => false,
  isPreferred: (id: string) => boolean = () => false,
): Item[] {
  const byId = new Map<string, Item>();
  for (const item of [...existing, ...incoming]) {
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      continue;
    }
    const preferNew = isAggregator(prev.sourceId) && !isAggregator(item.sourceId);
    const [kept, other] = preferNew ? [item, prev] : [prev, item];
    const merged: Item = { ...kept, excerpt: kept.excerpt || other.excerpt };
    const hatebu = Math.max(kept.hatebu ?? 0, other.hatebu ?? 0);
    if (hatebu > 0) merged.hatebu = hatebu;
    byId.set(item.id, merged);
  }
  return collapseSameTitle([...byId.values()], isAggregator, isPreferred);
}

/** 新着順に並べ、古すぎる記事と上限超過分を削除する */
export function pruneItems(
  items: Item[],
  { now, maxAgeDays = 30, maxItems = 3000 }: PruneOptions,
): Item[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => new Date(item.publishedAt).getTime() >= cutoff)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, maxItems);
}

/** 1記事1行のJSONにする（ファイルを小さく保ちつつ、git の差分も記事単位で見やすくする） */
export function serializeItems(items: Item[]): string {
  return items.length === 0 ? '[]\n' : `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
}

/** items.json を読む。無い・壊れている場合は空配列 */
export function readItemsFile(path: string): Item[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(data) ? (data as Item[]) : [];
  } catch (error) {
    console.warn(`${path} を読み込めないため空として扱います: ${error}`);
    return [];
  }
}

export function writeItemsFile(path: string, items: Item[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeItems(items));
}
