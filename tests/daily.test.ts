import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, pruneDailySnapshots, serializeSnapshot, updateDailySnapshots } from '../scripts/lib/daily.ts';
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
  it('多くの掲載元が報じた話題の順に並べ、話題の重ならないカテゴリの記事も各カテゴリ5件まで入れる', () => {
    const items = [
      ...Array.from({ length: 45 }, (_, n) => item(`hot${n}`, { coverage: 2 + (n % 5) })),
      ...Array.from({ length: 7 }, (_, n) => item(`sports${n}`, { category: 'sports' })),
    ];
    const snapshot = buildSnapshot('2026-10-06', items, undefined, now);
    expect(snapshot.items[0].coverage).toBe(6);
    expect(snapshot.items.filter((i) => i.category === 'news')).toHaveLength(40);
    expect(snapshot.items.filter((i) => i.category === 'sports')).toHaveLength(5);
    expect(snapshot.total).toBe(52);
    expect(snapshot.counts).toEqual({ news: 45, sports: 7 });
  });

  it('話題度が同じなら AI 要約のある記事を先に並べる', () => {
    const items = [item('plain', { publishedAt: '2026-10-06T04:00:00.000Z' }), item('summarized')];
    const snapshot = buildSnapshot('2026-10-06', items, undefined, now, { hasSummary: (id) => id === 'summarized' });
    expect(snapshot.items.map((i) => i.id)).toEqual(['summarized', 'plain']);
  });

  it('前回のスナップショットの記事も残し、話題度と件数は大きい方を採る。以前の版のはてブ数は外す', () => {
    const legacy = { ...item('old'), hatebu: 50 } as Item;
    const previous = buildSnapshot('2026-10-06', [item('a', { coverage: 3 })], undefined, now);
    const next = buildSnapshot('2026-10-06', [item('a', { coverage: 2 })], { ...previous, items: [...previous.items, legacy] }, now);
    expect(next.items.map((i) => [i.id, i.coverage])).toEqual([
      ['a', 3],
      ['old', undefined],
    ]);
    expect('hatebu' in next.items[1]).toBe(false);
    expect(next.total).toBe(1);
  });
});

describe('updateDailySnapshots', () => {
  it('直近数日分を日本時間の日付ごとに保存し、内容が変わらなければ書き換えない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-'));
    const items = [
      item('today', { publishedAt: '2026-10-05T16:00:00.000Z' }), // 10/6 01:00 JST
      item('yesterday', { publishedAt: '2026-10-05T14:00:00.000Z' }), // 10/5 23:00 JST
      item('old', { publishedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(updateDailySnapshots(items, dir, now)).toEqual(['2026-10-06', '2026-10-05']);
    const saved = JSON.parse(readFileSync(join(dir, '2026-10-06.json'), 'utf8'));
    expect(saved.items.map((i: Item) => i.id)).toEqual(['today']);
    expect(updateDailySnapshots(items, dir, new Date(now.getTime() + 60_000))).toEqual([]);
  });

  it('別々の掲載元が報じた同じ話題には報じた掲載元の数を付け、keep で外した記事は前回の分からも消す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-'));
    const noise = Array.from({ length: 30 }, (_, n) => item(`n${n}`, { title: `関係のない見出し${n}番目のニュース`, sourceId: `s${n % 5}` }));
    const story = [
      item('a', { title: 'Googleドキュメント、Markdownにネイティブ対応 直接編集可能に', sourceId: 'impress-watch' }),
      item('b', { title: 'Googleドキュメント、ドライブでMarkdownファイルを変換なしで表示、編集可能に', sourceId: 'gihyo' }),
    ];
    updateDailySnapshots([...story, item('gone', { sourceId: 'removed' }), ...noise], dir, now);
    updateDailySnapshots([...story, ...noise], dir, now, { keep: (i) => i.sourceId !== 'removed' });
    const saved = JSON.parse(readFileSync(join(dir, '2026-10-06.json'), 'utf8'));
    expect(saved.items.slice(0, 2).map((i: Item) => [i.id, i.coverage]).sort()).toEqual([
      ['a', 2],
      ['b', 2],
    ]);
    expect(saved.items.some((i: Item) => i.id === 'gone')).toBe(false);
  });

  it('保存形式はそのまま JSON として読める', () => {
    const snapshot = buildSnapshot('2026-10-06', [item('a', { coverage: 2 })], undefined, now);
    const dir = mkdtempSync(join(tmpdir(), 'daily-'));
    writeFileSync(join(dir, 'x.json'), serializeSnapshot(snapshot));
    expect(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8'))).toEqual(snapshot);
    expect(JSON.parse(serializeSnapshot({ ...snapshot, items: [] })).items).toEqual([]);
  });
});

describe('pruneDailySnapshots', () => {
  it('保存済みのまとめから、残さない記事と以前の版のはてブ数を取り除く', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-'));
    const snapshot = buildSnapshot('2026-10-05', [item('keep'), item('drop', { sourceId: 'removed' })], undefined, now);
    const legacy = { ...snapshot, items: snapshot.items.map((i) => ({ ...i, hatebu: 10 })) };
    writeFileSync(join(dir, '2026-10-05.json'), serializeSnapshot(legacy as typeof snapshot));
    expect(pruneDailySnapshots(dir, (i) => i.sourceId !== 'removed')).toEqual(['2026-10-05']);
    const saved = JSON.parse(readFileSync(join(dir, '2026-10-05.json'), 'utf8'));
    expect(saved.items).toEqual([item('keep')]);
    expect(pruneDailySnapshots(dir, (i) => i.sourceId !== 'removed')).toEqual([]);
  });
});
