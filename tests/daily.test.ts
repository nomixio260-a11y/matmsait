import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, serializeSnapshot, updateDailySnapshots } from '../scripts/lib/daily.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    excerpt: '',
    sourceId: 's',
    category: 'news',
    publishedAt: '2026-10-06T03:00:00.000Z',
    ...extra,
  };
}

const now = new Date('2026-10-06T05:00:00.000Z'); // 14:00 JST

describe('buildSnapshot', () => {
  it('はてブ数の多い順に並べ、はてブが付かないカテゴリの記事も各カテゴリ5件まで入れる', () => {
    const items = [
      ...Array.from({ length: 45 }, (_, n) => item(`hot${n}`, { hatebu: 100 + n })),
      ...Array.from({ length: 7 }, (_, n) => item(`sports${n}`, { category: 'sports' })),
    ];
    const snapshot = buildSnapshot('2026-10-06', items, undefined, now);
    expect(snapshot.items[0].id).toBe('hot44');
    expect(snapshot.items.filter((i) => i.category === 'news')).toHaveLength(40);
    expect(snapshot.items.filter((i) => i.category === 'sports')).toHaveLength(5);
    expect(snapshot.total).toBe(52);
    expect(snapshot.counts).toEqual({ news: 45, sports: 7 });
  });

  it('前回のスナップショットの記事も残し、はてブ数と件数は大きい方を採る', () => {
    const previous = buildSnapshot('2026-10-06', [item('old', { hatebu: 50 }), item('a', { hatebu: 10 })], undefined, now);
    const next = buildSnapshot('2026-10-06', [item('a', { hatebu: 5 })], previous, now);
    expect(next.items.map((i) => [i.id, i.hatebu])).toEqual([
      ['old', 50],
      ['a', 10],
    ]);
    expect(next.total).toBe(2);
  });
});

describe('updateDailySnapshots', () => {
  it('直近数日分を日本時間の日付ごとに保存し、内容が変わらなければ書き換えない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-'));
    const items = [
      item('today', { publishedAt: '2026-10-05T16:00:00.000Z', hatebu: 3 }), // 10/6 01:00 JST
      item('yesterday', { publishedAt: '2026-10-05T14:00:00.000Z' }), // 10/5 23:00 JST
      item('old', { publishedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(updateDailySnapshots(items, dir, now)).toEqual(['2026-10-06', '2026-10-05']);
    const saved = JSON.parse(readFileSync(join(dir, '2026-10-06.json'), 'utf8'));
    expect(saved.items.map((i: Item) => i.id)).toEqual(['today']);
    expect(updateDailySnapshots(items, dir, new Date(now.getTime() + 60_000))).toEqual([]);
  });

  it('保存形式はそのまま JSON として読める', () => {
    const snapshot = buildSnapshot('2026-10-06', [item('a', { hatebu: 1 })], undefined, now);
    const dir = mkdtempSync(join(tmpdir(), 'daily-'));
    writeFileSync(join(dir, 'x.json'), serializeSnapshot(snapshot));
    expect(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8'))).toEqual(snapshot);
    expect(JSON.parse(serializeSnapshot({ ...snapshot, items: [] })).items).toEqual([]);
  });
});
