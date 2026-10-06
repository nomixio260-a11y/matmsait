import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jstDateKey } from '../../src/lib/dates.ts';
import type { DailySnapshot, Item } from '../../src/lib/types.ts';

const DAY = 24 * 60 * 60 * 1000;
/** はてブ数の上位から選ぶ件数 */
const TOP_ITEMS = 40;
/** カテゴリごとに最低限入れる件数（はてブが付きにくいカテゴリも載るように） */
const PER_CATEGORY = 5;

const byPopularity = (a: Item, b: Item) =>
  (b.hatebu ?? 0) - (a.hatebu ?? 0) || b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id);

/**
 * その日の記事から「話題の記事」を選んだスナップショットを作る。
 * 前回のスナップショットも候補に含めるので、古い記事が items.json から消えても内容は保たれる。
 */
export function buildSnapshot(
  date: string,
  dayItems: Item[],
  previous: DailySnapshot | undefined,
  now: Date,
): DailySnapshot {
  const byId = new Map<string, Item>();
  for (const item of [...(previous?.items ?? []), ...dayItems]) {
    const hatebu = Math.max(byId.get(item.id)?.hatebu ?? 0, item.hatebu ?? 0);
    const { hatebu: _, ...rest } = item;
    byId.set(item.id, hatebu > 0 ? { ...rest, hatebu } : rest);
  }
  const candidates = [...byId.values()].sort(byPopularity);

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
    items: [...selected.values()].sort(byPopularity),
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

/**
 * 直近 days 日分（日本時間）のスナップショットを更新する。内容が変わった日付を返す。
 * はてブ数は記事の公開後しばらく増え続けるので、当日だけでなく数日分を更新する。
 */
export function updateDailySnapshots(items: Item[], dir: string, now: Date, days = 3): string[] {
  const byDate = new Map<string, Item[]>();
  for (const item of items) {
    const date = jstDateKey(item.publishedAt);
    byDate.set(date, [...(byDate.get(date) ?? []), item]);
  }
  mkdirSync(dir, { recursive: true });

  const changed: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = jstDateKey(new Date(now.getTime() - offset * DAY));
    const dayItems = byDate.get(date);
    if (!dayItems?.length) continue;
    const path = join(dir, `${date}.json`);
    const previous = readSnapshot(path);
    const next = buildSnapshot(date, dayItems, previous, now);
    if (previous && sameContent(previous, next)) continue;
    writeFileSync(path, serializeSnapshot(next));
    changed.push(date);
  }
  return changed;
}
