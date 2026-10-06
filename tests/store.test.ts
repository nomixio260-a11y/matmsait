import { describe, expect, it } from 'vitest';
import { collapseSameTitle, mergeItems, pruneItems, serializeItems, titleKey } from '../scripts/lib/store.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, publishedAt: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    excerpt: '',
    sourceId: 's',
    category: 'news',
    publishedAt,
    ...extra,
  };
}

describe('mergeItems', () => {
  it('同じIDは既存側を残して重複させない', () => {
    const merged = mergeItems(
      [item('a', '2026-01-01T00:00:00.000Z', { title: '既存' })],
      [item('a', '2026-01-02T00:00:00.000Z', { title: '新規' }), item('b', '2026-01-02T00:00:00.000Z')],
    );
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
    expect(merged[0].title).toBe('既存');
  });

  it('同じ記事を2回マージしても件数は増えない', () => {
    const items = [item('a', '2026-01-01T00:00:00.000Z')];
    expect(mergeItems(mergeItems([], items), items)).toHaveLength(1);
  });

  it('集約元経由の記事は配信元のフィードの情報で置き換え、はてブ数は引き継ぐ', () => {
    const isAggregator = (id: string) => id === 'hatena';
    const viaHatena = item('a', '2026-01-02T00:00:00.000Z', { sourceId: 'hatena', category: 'life', hatebu: 120 });
    const direct = item('a', '2026-01-01T09:00:00.000Z', { sourceId: 'publisher', category: 'tech', excerpt: '本文' });
    const [merged] = mergeItems([viaHatena], [direct], isAggregator);
    expect(merged).toMatchObject({ sourceId: 'publisher', category: 'tech', excerpt: '本文', hatebu: 120 });
    expect(merged.publishedAt).toBe('2026-01-01T09:00:00.000Z');
  });

  it('配信元の記事を集約元の記事で上書きしない', () => {
    const isAggregator = (id: string) => id === 'hatena';
    const direct = item('a', '2026-01-01T00:00:00.000Z', { sourceId: 'publisher' });
    const viaHatena = item('a', '2026-01-02T00:00:00.000Z', { sourceId: 'hatena', excerpt: '抜粋' });
    const [merged] = mergeItems([direct], [viaHatena], isAggregator);
    expect(merged.sourceId).toBe('publisher');
    expect(merged.excerpt).toBe('抜粋');
  });
});

describe('titleKey', () => {
  it('配信元の付け足しと記号を除いて比べる', () => {
    const direct = titleKey('ミスターマックス、最大173万人分の会員情報流出 不正アクセスで');
    expect(direct).toBeDefined();
    expect(titleKey('ミスターマックス、最大173万人分の会員情報流出 不正アクセスで（ITmedia NEWS） - Yahoo!ニュース')).toBe(direct);
    expect(titleKey('ランサム集団キリンの中心メンバー、大阪で拘束 識者「活発に攻撃」：朝日新聞')).toBe(
      titleKey('ランサム集団キリンの中心メンバー、大阪で拘束 識者「活発に攻撃」'),
    );
    expect(titleKey('【サッカーＵ２１】表彰式でまさかの事態…優勝の韓国の国旗掲揚されず - スポーツ報知')).toBe(
      titleKey('【サッカーU21】表彰式でまさかの事態…優勝の韓国の国旗掲揚されず（スポーツ報知） - Yahoo!ニュース'),
    );
  });

  it('短い見出しは比べない', () => {
    expect(titleKey('試合結果のお知らせ')).toBeUndefined();
    expect(titleKey('糸と鎧 - 第２話 勇敢な解呪師 | ヤンマガWeb')).toBeUndefined();
  });
});

describe('collapseSameTitle', () => {
  const title = 'ミスターマックス、最大173万人分の会員情報流出 不正アクセスで';
  const isAggregator = (id: string) => id === 'hatena';

  it('見出しが同じ記事は配信元のものを残し、はてブ数は多い方を引き継ぐ', () => {
    const yahoo = item('y', '2026-01-01T03:00:00.000Z', { title: `${title}（ITmedia NEWS） - Yahoo!ニュース`, sourceId: 'hatena', hatebu: 40 });
    const direct = item('d', '2026-01-01T04:00:00.000Z', { title, sourceId: 'itmedia', hatebu: 27 });
    const other = item('o', '2026-01-01T05:00:00.000Z', { title: 'まったく別のニュースの見出しがここに入ります' });
    const result = collapseSameTitle([yahoo, direct, other], isAggregator);
    expect(result.map((i) => i.id).sort()).toEqual(['d', 'o']);
    expect(result.find((i) => i.id === 'd')?.hatebu).toBe(40);
  });

  it('要約のある記事を優先し、なければ先に公開された記事を残す', () => {
    const first = item('first', '2026-01-01T00:00:00.000Z', { title, sourceId: 'hatena' });
    const second = item('second', '2026-01-01T01:00:00.000Z', { title, sourceId: 'hatena' });
    expect(collapseSameTitle([second, first], isAggregator).map((i) => i.id)).toEqual(['first']);
    expect(collapseSameTitle([second, first], isAggregator, (id) => id === 'second').map((i) => i.id)).toEqual(['second']);
  });

  it('転載サイト（Yahoo!ニュースなど）より元の配信元の記事を残す', () => {
    const yahoo = item('y', '2026-01-01T00:00:00.000Z', { title, sourceId: 'hatena', url: 'https://news.yahoo.co.jp/articles/abc' });
    const original = item('o', '2026-01-01T06:00:00.000Z', { title, sourceId: 'hatena', url: 'https://hochi.news/articles/1.html' });
    expect(collapseSameTitle([yahoo, original], isAggregator).map((i) => i.id)).toEqual(['o']);
  });

  it('日数が離れていれば同じ見出しでも別の記事として残す', () => {
    const week1 = item('w1', '2026-01-01T00:00:00.000Z', { title });
    const week2 = item('w2', '2026-01-08T00:00:00.000Z', { title });
    expect(collapseSameTitle([week1, week2])).toHaveLength(2);
  });

  it('mergeItems でもまとめる', () => {
    const yahoo = item('y', '2026-01-01T03:00:00.000Z', { title: `${title} - Yahoo!ニュース`, sourceId: 'hatena' });
    const direct = item('d', '2026-01-01T04:00:00.000Z', { title, sourceId: 'itmedia' });
    expect(mergeItems([yahoo], [direct], isAggregator).map((i) => i.id)).toEqual(['d']);
  });
});

describe('pruneItems', () => {
  const now = new Date('2026-02-01T00:00:00Z');

  it('新着順に並べ、期限切れを削除する', () => {
    const result = pruneItems(
      [
        item('old', '2025-12-01T00:00:00.000Z'),
        item('mid', '2026-01-20T00:00:00.000Z'),
        item('new', '2026-01-31T00:00:00.000Z'),
      ],
      { now, maxAgeDays: 30 },
    );
    expect(result.map((i) => i.id)).toEqual(['new', 'mid']);
  });

  it('上限件数で切り詰める', () => {
    const items = Array.from({ length: 5 }, (_, n) => item(`i${n}`, `2026-01-2${n}T00:00:00.000Z`));
    expect(pruneItems(items, { now, maxItems: 2 }).map((i) => i.id)).toEqual(['i4', 'i3']);
  });
});

describe('serializeItems', () => {
  it('1記事1行で書き出し、そのまま読み戻せる', () => {
    const items = [item('a', '2026-01-01T00:00:00.000Z'), item('b', '2026-01-02T00:00:00.000Z', { hatebu: 3 })];
    const text = serializeItems(items);
    expect(text.split('\n')).toHaveLength(5);
    expect(JSON.parse(text)).toEqual(items);
    expect(JSON.parse(serializeItems([]))).toEqual([]);
  });
});
