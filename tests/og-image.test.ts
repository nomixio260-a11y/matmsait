import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cardOptions, dailyCard, monthDay, summaryCard, topicCard, topicImagePath } from '../src/lib/og-cards.ts';
import { OG_HEIGHT, OG_WIDTH, renderCardPng, renderCardSvg, titleFontSize } from '../src/lib/og-image.ts';
import type { TopicView } from '../src/lib/topics.ts';
import type { DailySnapshot, SummaryRecord } from '../src/lib/types.ts';

const options = { host: 'topiatsume.pages.dev', tagline: 'ニュースを「記事」ではなく「話題」で読む。', siteName: 'トピあつめ' };

describe('共有画像のカード（描画）', () => {
  it('見出しが短いほど大きな文字にする（補足があれば少し小さく）', () => {
    expect(titleFontSize('短い見出し', false)).toBe(72);
    expect(titleFontSize('短い見出し', true)).toBe(64);
    expect(titleFontSize('あ'.repeat(60), false)).toBe(48);
  });

  it('1200×630 の PNG を作る（見出しのカード・見出しを並べたカード）', async () => {
    for (const card of [
      { kind: 'headline', label: { text: 'AI要約', tone: 'accent' }, title: 'ノーベル化学賞に硤合憲三氏', sub: '1文目。', chips: ['サイエンス', '6媒体が報道'] },
      { kind: 'list', heading: '10月8日の話題ニュース TOP5', items: ['一', '二', '三'] },
    ] as const) {
      const png = await renderCardPng(card, options);
      const meta = await sharp(png).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', OG_WIDTH, OG_HEIGHT]);
      // 1枚が大きすぎない（Bluesky の画像は1MBまで）
      expect(png.length).toBeLessThan(300 * 1024);
    }
  }, 30_000);

  it('文字は図形に変えるので、表示する側にフォントは要らない', async () => {
    const svg = await renderCardSvg({ kind: 'headline', title: 'テスト' }, options);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<text');
  });
});

describe('共有画像のカード（中身）', () => {
  it('ドメインはサイトの URL から', () => {
    expect(cardOptions('https://topiatsume.pages.dev/topic/x/').host).toBe('topiatsume.pages.dev');
    expect(cardOptions(undefined).host).toBe('');
    expect(monthDay('2026-10-08')).toBe('10/8');
    expect(topicImagePath('abc')).toBe('/og/topic/abc.png');
  });

  it('要約のページ: 「AI要約」・見出し（サイト名は除く）・1文目・ジャンルと掲載元', () => {
    const record = {
      id: 'x',
      title: 'ノーベル化学賞に硤合憲三氏 - FNNプライムオンライン',
      url: 'https://www.fnn.jp/articles/1',
      excerpt: '',
      sourceId: 'fnn',
      category: 'science',
      publishedAt: '2026-10-08T00:00:00.000Z',
      summary: 'スウェーデン王立科学アカデミーは10月8日、ノーベル化学賞を硤合憲三氏に授与すると発表した。授賞理由は不斉自己触媒反応の発見。',
      summarizedAt: '2026-10-08T01:00:00.000Z',
    } as SummaryRecord;
    expect(summaryCard(record)).toEqual({
      kind: 'headline',
      label: { text: 'AI要約', tone: 'accent' },
      title: 'ノーベル化学賞に硤合憲三氏',
      sub: 'スウェーデン王立科学アカデミーは10月8日、ノーベル化学賞を硤合憲三氏に授与すると発表した。',
      chips: ['サイエンス', 'FNNプライムオンライン'],
    });
  });

  it('話題のページ: 「N媒体が報道」・見出し・AI 要約の1文目（あれば）・ジャンル', () => {
    const view = {
      id: 't',
      coverage: 5,
      categories: ['tech'],
      lead: { title: 'A社が新型スマホを発表 | Bニュース' },
      summaries: [],
    } as unknown as TopicView;
    expect(topicCard(view)).toEqual({
      kind: 'headline',
      label: { text: '5媒体が報道', tone: 'heat' },
      title: 'A社が新型スマホを発表',
      chips: ['テクノロジー', '各社の報道を比較'],
    });
  });

  it('日別まとめのページ: その日の上位5件', () => {
    const snapshot = {
      date: '2026-10-08',
      updatedAt: '',
      total: 0,
      counts: {},
      items: ['一', '二', '三', '四', '五', '六'].map((title) => ({ title })),
    } as unknown as DailySnapshot;
    expect(dailyCard(snapshot)).toEqual({
      kind: 'list',
      label: { text: '10/8', tone: 'accent' },
      heading: '10月8日の話題ニュース TOP5',
      items: ['一', '二', '三', '四', '五'],
    });
  });
});
