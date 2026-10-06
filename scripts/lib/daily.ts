import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jstDateKey } from '../../src/lib/dates.ts';
import { clusterTopics } from '../../src/lib/related.ts';
import type { DailySnapshot, Item } from '../../src/lib/types.ts';

const DAY = 24 * 60 * 60 * 1000;
/** 話題度の高い順に選ぶ件数 */
const TOP_ITEMS = 40;
/** カテゴリごとに最低限入れる件数（話題が重なりにくいカテゴリの記事も載るように） */
const PER_CATEGORY = 5;

export interface SnapshotOptions {
  /** AI 要約のある記事か（同じ話題度なら要約のある記事を先に並べる） */
  hasSummary?: (id: string) => boolean;
}

/** 以前の版が保存していた項目（はてなブックマーク数）を外す */
function withoutLegacyFields(item: Item & { hatebu?: number }): Item {
  if (!('hatebu' in item)) return item;
  const { hatebu: _, ...rest } = item;
  return rest;
}

/**
 * その日の記事から「話題の記事」を選んだスナップショットを作る。
 * 多くの掲載元が報じた話題（coverage）→ AI 要約のある記事 → 新しい記事 の順に選び、カテゴリごとにも数件ずつ入れる。
 * 前回のスナップショットも候補に含めるので、古い記事が items.json から消えても内容は保たれる。
 */
export function buildSnapshot(
  date: string,
  dayItems: Item[],
  previous: DailySnapshot | undefined,
  now: Date,
  { hasSummary = () => false }: SnapshotOptions = {},
): DailySnapshot {
  const byId = new Map<string, Item>();
  for (const raw of [...(previous?.items ?? []), ...dayItems]) {
    const item = withoutLegacyFields(raw);
    const coverage = Math.max(byId.get(item.id)?.coverage ?? 0, item.coverage ?? 0);
    const { coverage: _, ...rest } = item;
    byId.set(item.id, coverage >= 2 ? { ...rest, coverage } : rest);
  }
  const byInterest = (a: Item, b: Item) =>
    (b.coverage ?? 1) - (a.coverage ?? 1) ||
    Number(hasSummary(b.id)) - Number(hasSummary(a.id)) ||
    b.publishedAt.localeCompare(a.publishedAt) ||
    a.id.localeCompare(b.id);
  const candidates = [...byId.values()].sort(byInterest);

  const selected = new Map(candidates.slice(0, TOP_ITEMS).map((item) => [item.id, item]));
  const perCategory = new Map<string, number>();
  for (const item of selected.values()) perCategory.set(item.category, (perCategory.get(item.category) ?? 0) + 1);
  for (const item of candidates) {
    const count = perCategory.get(item.category) ?? 0;
    if (selected.has(item.id) || count >= PER_CATEGORY) continue;
    selected.set(item.id, item);
    perCategory.set(item.category, count + 1);
  }

  const counts: Record<string, number> = { ...previous?.counts };
  const current = new Map<string, number>();
  for (const item of dayItems) current.set(item.category, (current.get(item.category) ?? 0) + 1);
  for (const [category, count] of current) counts[category] = Math.max(counts[category] ?? 0, count);

  return {
    date,
    updatedAt: now.toISOString(),
    total: Math.max(previous?.total ?? 0, dayItems.length),
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    items: [...selected.values()].sort(byInterest),
  };
}

/** updatedAt 以外が同じか */
function sameContent(a: DailySnapshot, b: DailySnapshot): boolean {
  const strip = ({ updatedAt: _, ...rest }: DailySnapshot) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

export function serializeSnapshot(snapshot: DailySnapshot): string {
  const { items, ...meta } = snapshot;
  const head = JSON.stringify(meta).slice(0, -1);
  return items.length === 0
    ? `${head},"items":[]}\n`
    : `${head},"items":[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]}\n`;
}

export function readSnapshot(path: string): DailySnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DailySnapshot;
  } catch {
    return undefined;
  }
}

export interface UpdateOptions extends SnapshotOptions {
  /** 何日分を更新するか（日本時間の今日から） */
  days?: number;
  /** 日別まとめに残してよい記事か（sources.yaml から外した掲載元の記事を、過去のまとめからも外すため） */
  keep?: (item: Item) => boolean;
}

/**
 * 直近 days 日分（日本時間）のスナップショットを更新する。内容が変わった日付を返す。
 * 同じ話題を報じる掲載元は後から増えるので、当日だけでなく数日分を更新する。
 */
export function updateDailySnapshots(
  items: Item[],
  dir: string,
  now: Date,
  { days = 3, keep = () => true, hasSummary }: UpdateOptions = {},
): string[] {
  // 話題度は、まとめる日の前後の記事も含めて数える
  const recent = items.filter((item) => Date.parse(item.publishedAt) >= now.getTime() - (days + 2) * DAY);
  const coverage = new Map<string, number>();
  for (const cluster of clusterTopics(recent)) {
    if (cluster.coverage < 2) continue;
    for (const item of cluster.items) coverage.set(item.id, cluster.coverage);
  }
  const byDate = new Map<string, Item[]>();
  for (const item of items) {
    const date = jstDateKey(item.publishedAt);
    const value = coverage.get(item.id);
    const withCoverage = value ? { ...item, coverage: value } : item;
    byDate.set(date, [...(byDate.get(date) ?? []), withCoverage]);
  }
  mkdirSync(dir, { recursive: true });

  const changed: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = jstDateKey(new Date(now.getTime() - offset * DAY));
    const dayItems = byDate.get(date);
    if (!dayItems?.length) continue;
    const path = join(dir, `${date}.json`);
    const previous = readSnapshot(path);
    const kept = previous ? { ...previous, items: previous.items.filter(keep) } : undefined;
    const next = buildSnapshot(date, dayItems, kept, now, { hasSummary });
    if (previous && sameContent(previous, next)) continue;
    writeFileSync(path, serializeSnapshot(next));
    changed.push(date);
  }
  return changed;
}

/**
 * 保存済みのすべての日別まとめから、残してはいけない記事（外した掲載元の記事など）と以前の版の項目を取り除く。
 * 書き換えた日付を返す
 */
export function pruneDailySnapshots(dir: string, keep: (item: Item) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const changed: string[] = [];
  for (const file of readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()) {
    const path = join(dir, file);
    const snapshot = readSnapshot(path);
    if (!snapshot) continue;
    const items = snapshot.items.map(withoutLegacyFields).filter(keep);
    const next = { ...snapshot, items };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) continue;
    writeFileSync(path, serializeSnapshot(next));
    changed.push(snapshot.date);
  }
  return changed;
}
