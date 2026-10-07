import { describe, expect, it } from 'vitest';
import {
  SOCIAL_LIMITS,
  blueskyPostUrl,
  blueskyRichText,
  displayUrl,
  fitsBluesky,
  graphemeLength,
  hotPost,
  mastodonLength,
  nowPost,
  pendingRequest,
  planPosts,
  platformAllows,
  platformLimit,
  reachedDailyLimit,
  recordManual,
  recordPost,
  risingPost,
  summaryPost,
  withUtm,
  type PlanContext,
  type SocialState,
  type SocialSummary,
  type SocialTopic,
} from '../scripts/lib/social.ts';
import type { DailySnapshot, Item } from '../src/lib/types.ts';

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: `記事${id}のタイトル`,
    url: `https://example.com/${id}`,
    excerpt: '抜粋',
    sourceId: 's',
    category: 'news',
    publishedAt: '2026-10-06T10:00:00.000Z',
    ...extra,
  };
}

function topic(id: string, extra: Partial<SocialTopic> = {}): SocialTopic {
  return { id, title: `話題${id}の見出し`, coverage: 3, score: 40, gained: 0, latestAt: '2026-10-06T10:00:00.000Z', ...extra };
}

function summary(id: string, extra: Partial<SocialSummary> = {}): SocialSummary {
  return { id, title: `要約${id}の見出し`, lead: `${id}は新製品を発表した。`, path: `/summary/${id}/`, ...extra };
}

function context(now: Date, extra: Partial<PlanContext> = {}): PlanContext {
  return {
    now,
    snapshots: [],
    hot: [],
    rising: [],
    important: [],
    ai: [],
    weekly: [],
    summaries: [],
    pageUrl: (path) => `https://example.com/site${path}`,
    siteName: 'テスト',
    ...extra,
  };
}

const empty: SocialState = { posted: [] };
/** 2026-10-06 は火曜日。日本時間の時刻で作る */
const at = (jst: string, date = '2026-10-06') => new Date(`${date}T${jst}:00+09:00`);

describe('文字数の数え方', () => {
  it('Bluesky は書記素、Mastodon は URL を23文字として数える', () => {
    expect(graphemeLength('👨‍👩‍👧あ')).toBe(2);
    expect(mastodonLength('a https://example.com/long/url')).toBe(2 + 23);
  });
});

describe('リンク（流入元つき）と Bluesky の本文', () => {
  it('utm を付ける（# は残す）・表示用の短いリンク', () => {
    expect(withUtm('https://example.com/ranking/#today', 'bluesky', 'morning')).toBe(
      'https://example.com/ranking/?utm_source=bluesky&utm_medium=social&utm_campaign=morning#today',
    );
    expect(displayUrl('https://topiatsume.pages.dev/topic/0123456789abcdef/')).toBe('topiatsume.pages.dev/topic/0123…');
    expect(displayUrl('https://topiatsume.pages.dev/')).toBe('topiatsume.pages.dev');
  });

  it('URL を短い表示にして、そこに流入元つきのリンクを付ける。ハッシュタグもタグにする（位置は UTF-8 のバイト単位）', () => {
    const rich = blueskyRichText('話題 ▶ https://topiatsume.pages.dev/rising/\n#ニュース #AI', 'rising');
    expect(rich.text).toBe('話題 ▶ topiatsume.pages.dev/rising\n#ニュース #AI');
    const bytes = new TextEncoder().encode(rich.text);
    const slice = (f: (typeof rich.facets)[number]) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));
    expect(rich.facets.map(slice)).toEqual(['topiatsume.pages.dev/rising', '#ニュース', '#AI']);
    expect(rich.facets[0].features[0]).toEqual({
      $type: 'app.bsky.richtext.facet#link',
      uri: 'https://topiatsume.pages.dev/rising/?utm_source=bluesky&utm_medium=social&utm_campaign=rising',
    });
    expect(rich.facets[1].features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'ニュース' });
  });

  it('文字数の上限に収まるように見出しを縮める（Bluesky は短くしたリンクで数える）', () => {
    const long = topic('long', { coverage: 5, gained: 3, title: 'と'.repeat(400), hashtags: ['AI', '生成AI'] });
    for (const post of [hotPost(long, context(new Date())), risingPost(long, context(new Date()))]) {
      const text = post.compose(fitsBluesky);
      expect(graphemeLength(blueskyRichText(text, post.kind).text)).toBeLessThanOrEqual(300);
      expect(text).toContain('https://example.com/site/topic/long/');
      expect(text).toContain('#ニュース #AI #生成AI');
    }
    const ten = summaryPost(summary('abc', { lead: 'あ'.repeat(500), hashtags: ['MLB'] }), context(new Date())).compose(fitsBluesky);
    expect(fitsBluesky(ten)).toBe(true);
    expect(ten).toContain('⏱ 10秒でわかるニュース');
    expect(ten).toContain('#ニュース #MLB');
  });
});

describe('planPosts', () => {
  const snapshot: DailySnapshot = {
    date: '2026-10-06',
    updatedAt: '2026-10-06T12:00:00.000Z',
    total: 10,
    counts: { news: 10 },
    items: [item('a', { coverage: 4 }), item('b', { coverage: 3 }), item('c')],
  };

  it('21時（日本時間）以降に1日1回だけ日別まとめを投稿する', () => {
    expect(planPosts(empty, context(at('20:30'), { snapshots: [snapshot] }))).toEqual([]);
    const [post] = planPosts(empty, context(at('21:10'), { snapshots: [snapshot] }));
    expect(post.key).toBe('digest:2026-10-06');
    expect(post.compose(() => true)).toContain('https://example.com/site/daily/2026-10-06/');
    const state = recordPost(empty, post, at('21:10'));
    expect(state.lastDigest).toBe('2026-10-06');
    expect(planPosts(state, context(at('22:10'), { snapshots: [snapshot] }))).toEqual([]);
  });

  it('深夜（0〜7時）は何も投稿しない', () => {
    const rising = [topic('r', { gained: 3, coverage: 5 })];
    expect(planPosts(empty, context(at('03:00'), { rising }))).toEqual([]);
    expect(planPosts(empty, context(at('07:05'), { rising })).map((post) => post.key)).toEqual(['rising:r']);
  });

  it('朝は今日の注目ニュース、昼は AI ニュースのまとめを1日1回', () => {
    const important = [topic('i1'), topic('i2'), topic('i3')];
    const ai = [topic('a1'), topic('a2')];
    const [morning] = planPosts(empty, context(at('08:00'), { important, ai }));
    expect(morning.key).toBe('morning:2026-10-06');
    expect(morning.compose(() => true)).toContain('https://example.com/site/ranking/#today');
    expect(planPosts(recordPost(empty, morning, at('08:00')), context(at('09:00'), { important }))).toEqual([]);
    const [noon] = planPosts(empty, context(at('12:30'), { important, ai }));
    expect(noon.key).toBe('ai:2026-10-06');
    expect(noon.compose(() => true)).toContain('/tag/ai/');
    expect(noon.compose(() => true)).toContain('#AI #生成AI');
    // 件数が足りなければ投稿しない
    expect(planPosts(empty, context(at('12:30'), { ai: [topic('a1')] }))).toEqual([]);
  });

  it('日曜の夕方に今週のランキングを投稿する（ほかの曜日はしない）', () => {
    const weekly = [topic('w1', { coverage: 9 }), topic('w2', { coverage: 7 }), topic('w3', { coverage: 5 })];
    const sunday = at('19:00', '2026-10-11');
    const [post] = planPosts(empty, context(sunday, { weekly }));
    expect(post.key).toBe('weekly:2026-10-11');
    expect(post.compose(() => true)).toContain('/weekly/');
    expect(planPosts(empty, context(at('19:00'), { weekly }))).toEqual([]);
  });

  it('急上昇（3時間で2社以上・計3社以上）を話題のページへのリンクで投稿し、同じ話題は二度投稿しない', () => {
    const rising = [topic('small', { gained: 1, coverage: 3 }), topic('up', { gained: 2, coverage: 3 })];
    const [post] = planPosts(empty, context(at('11:00'), { rising }));
    expect(post.key).toBe('rising:up');
    expect(post.compose(() => true)).toContain('https://example.com/site/topic/up/');
    const state = recordPost(empty, post, at('11:00'));
    // 間隔をあける（60分）
    const hot = [topic('hot', { coverage: 5, score: 70, latestAt: at('10:30').toISOString() })];
    expect(planPosts(state, context(at('11:40'), { rising, hot }))).toEqual([]);
    expect(planPosts(state, context(at('12:05'), { rising, hot })).map((entry) => entry.key)).toEqual(['hot:hot']);
    // 急上昇で投稿した話題は、いま話題としても投稿しない
    expect(planPosts(state, context(at('12:05'), { hot: [topic('up', { coverage: 6, score: 80, latestAt: at('12:00').toISOString() })] }))).toEqual([]);
  });

  it('急上昇・いま話題がなければ、10秒でわかるニュース（AI 要約）を投稿する。同じ話題を投稿済みなら投稿しない', () => {
    const state = recordPost(empty, risingPost(topic('t1', { gained: 2 }), context(at('09:00'))), at('09:00'));
    const summaries = [summary('s1', { topicId: 't1' }), summary('s2', { path: '/topic/t2/', topicId: 't2' })];
    const [post] = planPosts(state, context(at('10:30'), { summaries }));
    expect(post.key).toBe('summary:s2');
    expect(post.compose(() => true)).toContain('https://example.com/site/topic/t2/');
    expect(post.link.title).toBe('要約s2の見出し【AI要約】');
    // 10秒でわかるニュースで投稿した話題は、あとで急上昇・いま話題になっても投稿しない
    const after = recordPost(state, post, at('10:30'));
    const hot = [topic('t2', { coverage: 6, score: 80, latestAt: at('11:00').toISOString() })];
    expect(planPosts(after, context(at('11:40'), { summaries, hot, rising: [topic('t2', { gained: 3, coverage: 6 })] }))).toEqual([]);
  });

  it('いま話題は、報じたメディアが多くスコアの高い新しい話題だけ', () => {
    const hot = [
      topic('few', { coverage: 3, score: 90, latestAt: at('14:00').toISOString() }),
      topic('low', { coverage: 6, score: 30, latestAt: at('14:00').toISOString() }),
      topic('old', { coverage: 9, score: 90, latestAt: at('01:00').toISOString() }),
    ];
    expect(planPosts(empty, context(at('15:00'), { hot }))).toEqual([]);
  });

  it('1日の投稿数と、種類ごとの上限を守る', () => {
    const now = at('16:00');
    const rising = [topic('up', { gained: 3, coverage: 4 })];
    const full = Array.from({ length: SOCIAL_LIMITS.maxPerDay }, (_, n) => ({ key: `digest:x${n}`, at: at('10:00').toISOString() }));
    expect(planPosts({ posted: full }, context(now, { rising }))).toEqual([]);
    const risingDone = Array.from({ length: SOCIAL_LIMITS.maxRisingPerDay }, (_, n) => ({ key: `rising:r${n}`, at: at('08:00').toISOString() }));
    // 急上昇が上限なら、次の種類（10秒でわかるニュース）に回る
    expect(planPosts({ posted: risingDone }, context(now, { rising, summaries: [summary('s')] })).map((post) => post.key)).toEqual(['summary:s']);
  });
});

describe('管理画面の「今すぐ投稿」', () => {
  const hot = [
    topic('h1', { coverage: 6, score: 80, latestAt: at('10:00').toISOString() }),
    topic('h2', { coverage: 5, score: 70, latestAt: at('09:00').toISOString() }),
    topic('h3', { coverage: 4, score: 60, latestAt: at('08:00').toISOString() }),
  ];

  it('深夜・間隔・種類ごとの上限を待たずに、まだ投稿していない話題を1件投稿する', () => {
    // 深夜でも投稿する
    expect(planPosts(empty, context(at('03:00'), { hot }), { manual: true }).map((post) => post.key)).toEqual(['hot:h1']);
    // 10分前に投稿していても（いつもは1時間あける）、急上昇から順に選ぶ
    const state = recordPost(empty, hotPost(hot[0], context(at('10:00'))), at('10:00'));
    const rising = [topic('r1', { gained: 2, coverage: 3 })];
    expect(planPosts(state, context(at('10:10'), { hot, rising }))).toEqual([]);
    expect(planPosts(state, context(at('10:10'), { hot, rising }), { manual: true }).map((post) => post.key)).toEqual(['rising:r1']);
    // 種類ごとの1日の上限に達していても投稿する
    const full: SocialState = { posted: Array.from({ length: SOCIAL_LIMITS.maxHotPerDay }, (_, n) => ({ key: `hot:x${n}`, at: at('08:00').toISOString() })) };
    expect(planPosts(full, context(at('09:30'), { hot }), { manual: true }).map((post) => post.key)).toEqual(['hot:h1']);
  });

  it('新しい話題がなければ「いま話題のニュース」のまとめ（同じ時間帯は1回まで）', () => {
    const state: SocialState = { posted: hot.map((entry) => ({ key: `hot:${entry.id}`, at: at('06:00').toISOString() })) };
    const [post] = planPosts(state, context(at('14:20'), { hot }), { manual: true });
    expect(post.key).toBe('now:2026-10-06T14');
    const text = post.compose(fitsBluesky);
    expect(text).toContain('【いま話題のニュース】10/6 14時');
    expect(text).toContain('1. 話題h1の見出し（6媒体）');
    expect(text).toContain('https://example.com/site/');
    expect(post.link.title).toBe('いま話題のニュース｜テスト');
    const after = recordPost(state, post, at('14:20'));
    expect(planPosts(after, context(at('14:50'), { hot }), { manual: true })).toEqual([]);
    expect(planPosts(after, context(at('15:05'), { hot }), { manual: true }).map((entry) => entry.key)).toEqual(['now:2026-10-06T15']);
    // まとめは3件以上の話題があるときだけ
    expect(nowPost(hot.slice(0, 2), at('14:20'), context(at('14:20')))).toBeUndefined();
    // 「今すぐ投稿」のまとめのあとは、いつもの自動投稿も1時間あける
    expect(planPosts(after, context(at('15:00'), { rising: [topic('r9', { gained: 3, coverage: 4 })] }))).toEqual([]);
  });

  it('24時間の上限は「今すぐ投稿」では広げる（誤って何度も押したときの歯止めは残す）', () => {
    const posts = (count: number): SocialState => ({ posted: Array.from({ length: count }, (_, n) => ({ key: `digest:x${n}`, at: at('09:00').toISOString(), platforms: ['Bluesky'] })) });
    const twelve = posts(SOCIAL_LIMITS.maxPerDay);
    expect(reachedDailyLimit(twelve, at('10:00'))).toBe(true);
    expect(reachedDailyLimit(twelve, at('10:00'), true)).toBe(false);
    expect(planPosts(twelve, context(at('10:00'), { hot }), { manual: true }).map((post) => post.key)).toEqual(['hot:h1']);
    expect(platformAllows('Bluesky', twelve, at('10:00'))).toBe(false);
    expect(platformAllows('Bluesky', twelve, at('10:00'), platformLimit(true))).toBe(true);
    const max = posts(SOCIAL_LIMITS.manualMaxPerDay);
    expect(reachedDailyLimit(max, at('10:00'), true)).toBe(true);
    expect(planPosts(max, context(at('10:00'), { hot }), { manual: true })).toEqual([]);
  });

  it('依頼は ID で照らし合わせ、処理済み・古すぎる依頼は投稿しない', () => {
    const now = at('12:00');
    const request = { id: 'req-1', at: at('11:58').toISOString() };
    expect(pendingRequest(empty, undefined, now)).toBeUndefined();
    expect(pendingRequest(empty, request, now)).toEqual({ request, expired: false });
    // 30分より古い依頼は投稿しない（更新が遅れたときに、思わぬ時間に投稿しないように）
    expect(pendingRequest(empty, { id: 'recent', at: at('11:31').toISOString() }, now)?.expired).toBe(false);
    expect(pendingRequest(empty, { id: 'old', at: at('11:29').toISOString() }, now)?.expired).toBe(true);
    expect(pendingRequest(empty, { id: 'bad', at: 'いつか' }, now)?.expired).toBe(true);
    const done = recordManual(empty, request, now, { result: 'none' });
    expect(done.manual).toEqual({ id: 'req-1', requestedAt: request.at, at: now.toISOString(), result: 'none' });
    expect(pendingRequest(done, request, now)).toBeUndefined();
    // 投稿を記録しても「今すぐ投稿」の結果は残る。投稿のページの URL も残す
    const posted = recordPost(done, hotPost(hot[0], context(now)), now, ['Bluesky'], { Bluesky: 'https://bsky.app/profile/a.bsky.social/post/3abc' });
    expect(posted.manual?.id).toBe('req-1');
    expect(posted.posted.at(-1)).toEqual({ key: 'hot:h1', at: now.toISOString(), platforms: ['Bluesky'], urls: { Bluesky: 'https://bsky.app/profile/a.bsky.social/post/3abc' } });
  });

  it('Bluesky の投稿の URI から、アプリで開ける URL を作る', () => {
    expect(blueskyPostUrl('at://did:plc:abc/app.bsky.feed.post/3mxbz5nmwsm2u', 'topiatsume.bsky.social')).toBe(
      'https://bsky.app/profile/topiatsume.bsky.social/post/3mxbz5nmwsm2u',
    );
    expect(blueskyPostUrl(undefined, 'x')).toBeUndefined();
  });
});

describe('サービスごとの上限', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');

  it('24時間・30日の上限を、投稿できたサービスごとに数える', () => {
    const state: SocialState = {
      posted: [
        { key: 'a', at: '2026-10-06T00:00:00.000Z', platforms: ['Bluesky'] },
        { key: 'b', at: '2026-09-20T00:00:00.000Z', platforms: ['Bluesky'] },
      ],
    };
    expect(platformAllows('Bluesky', state, now)).toBe(true);
    expect(platformAllows('Bluesky', state, now, { daily: 1, monthly: 10 })).toBe(false);
    expect(platformAllows('Bluesky', state, now, { daily: 5, monthly: 2 })).toBe(false);
    expect(platformAllows('Mastodon', state, now, { daily: 1, monthly: 1 })).toBe(true);
  });
});
