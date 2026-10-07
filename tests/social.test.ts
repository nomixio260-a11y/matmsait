import { describe, expect, it } from 'vitest';
import {
  SOCIAL_LIMITS,
  graphemeLength,
  hotPost,
  mastodonLength,
  oauthSignature,
  planPosts,
  platformAllows,
  platformLimit,
  recordPost,
  richTextFacets,
  risingPost,
  xLength,
  type PlanContext,
  type SocialState,
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

function context(now: Date, extra: Partial<PlanContext> = {}): PlanContext {
  return {
    now,
    snapshots: [],
    hot: [],
    rising: [],
    important: [],
    ai: [],
    pageUrl: (path) => `https://example.com/site${path}`,
    siteName: 'テスト',
    ...extra,
  };
}

const empty: SocialState = { posted: [] };

describe('文字数の数え方', () => {
  it('X は日本語を2、URLを23として数える', () => {
    expect(xLength('abc')).toBe(3);
    expect(xLength('あいう')).toBe(6);
    expect(xLength('見て https://example.com/very/long/path?with=query')).toBe(4 + 1 + 23);
  });

  it('Bluesky は書記素、Mastodon は URL を23文字として数える', () => {
    expect(graphemeLength('👨‍👩‍👧あ')).toBe(2);
    expect(mastodonLength('a https://example.com/long/url')).toBe(2 + 23);
  });
});

describe('oauthSignature', () => {
  it('X 公式ドキュメントの例と同じ署名になる', () => {
    const signature = oauthSignature(
      'POST',
      'https://api.twitter.com/1.1/statuses/update.json',
      {
        status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
        include_entities: 'true',
        oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
        oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: '1318622958',
        oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        oauth_version: '1.0',
      },
      'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    );
    expect(signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });
});

describe('richTextFacets', () => {
  it('URL とハッシュタグの位置を UTF-8 のバイト単位で返す', () => {
    const text = '話題 https://example.com/a\n#ニュース';
    const facets = richTextFacets(text);
    const bytes = new TextEncoder().encode(text);
    const slice = (f: (typeof facets)[number]) =>
      new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));
    expect(facets.map(slice)).toEqual(['https://example.com/a', '#ニュース']);
    expect(facets[1].features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'ニュース' });
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
  const at = (jst: string) => new Date(`2026-10-06T${jst}:00+09:00`);

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

  it('朝は今日の重要ニュース、昼は AI ニュースのまとめを1日1回', () => {
    const important = [topic('i1'), topic('i2'), topic('i3')];
    const ai = [topic('a1'), topic('a2')];
    const [morning] = planPosts(empty, context(at('08:00'), { important, ai }));
    expect(morning.key).toBe('morning:2026-10-06');
    expect(morning.compose(() => true)).toContain('https://example.com/site/ranking/#today');
    expect(planPosts(recordPost(empty, morning, at('08:00')), context(at('09:00'), { important }))).toEqual([]);
    const [noon] = planPosts(empty, context(at('12:30'), { important, ai }));
    expect(noon.key).toBe('ai:2026-10-06');
    expect(noon.compose(() => true)).toContain('/tag/ai/');
    // 件数が足りなければ投稿しない
    expect(planPosts(empty, context(at('12:30'), { ai: [topic('a1')] }))).toEqual([]);
  });

  it('急上昇（3時間で2社以上・計3社以上）を話題のページへのリンクで投稿し、同じ話題は二度投稿しない', () => {
    const rising = [topic('small', { gained: 1, coverage: 3 }), topic('up', { gained: 2, coverage: 3 })];
    const [post] = planPosts(empty, context(at('11:00'), { rising }));
    expect(post.key).toBe('rising:up');
    expect(post.compose(() => true)).toContain('https://example.com/site/topic/up/');
    const state = recordPost(empty, post, at('11:00'));
    // 間隔をあける（90分）
    const hot = [topic('hot', { coverage: 5, score: 70, latestAt: at('10:30').toISOString() })];
    expect(planPosts(state, context(at('12:00'), { rising, hot }))).toEqual([]);
    expect(planPosts(state, context(at('12:40'), { rising, hot })).map((entry) => entry.key)).toEqual(['hot:hot']);
    // 急上昇で投稿した話題は、いま話題としても投稿しない
    expect(planPosts(state, context(at('12:40'), { hot: [topic('up', { coverage: 6, score: 80, latestAt: at('12:00').toISOString() })] }))).toEqual([]);
  });

  it('いま話題は、報じたメディアが多くスコアの高い新しい話題だけ', () => {
    const now = at('15:00');
    const hot = [
      topic('few', { coverage: 3, score: 90, latestAt: at('14:00').toISOString() }),
      topic('low', { coverage: 6, score: 30, latestAt: at('14:00').toISOString() }),
      topic('old', { coverage: 9, score: 90, latestAt: at('01:00').toISOString() }),
    ];
    expect(planPosts(empty, context(now, { hot }))).toEqual([]);
  });

  it('1日の投稿数の上限を守る', () => {
    const now = at('16:00');
    const posted = Array.from({ length: SOCIAL_LIMITS.maxPerDay }, (_, n) => ({ key: `digest:x${n}`, at: at('10:00').toISOString() }));
    expect(planPosts({ posted }, context(now, { rising: [topic('up', { gained: 3, coverage: 4 })] }))).toEqual([]);
    const rising = Array.from({ length: SOCIAL_LIMITS.maxRisingPerDay }, (_, n) => ({ key: `rising:r${n}`, at: at('08:00').toISOString() }));
    expect(planPosts({ posted: rising }, context(now, { rising: [topic('up', { gained: 3, coverage: 4 })] }))).toEqual([]);
  });

  it('文字数の上限に収まるようにタイトルを縮める', () => {
    const long = topic('long', { coverage: 5, gained: 3, title: 'と'.repeat(200) });
    for (const post of [hotPost(long, context(new Date())), risingPost(long, context(new Date()))]) {
      const text = post.compose((t) => xLength(t) <= 280);
      expect(xLength(text)).toBeLessThanOrEqual(280);
      expect(text).toContain('https://example.com/site/topic/long/');
    }
  });
});

describe('サービスごとの上限', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const post = (key: string) => ({ key, compose: () => '', link: { url: '', title: '', description: '' } });

  it('X は投稿に料金がかかるので、既定では夜のまとめを1日1件だけ', () => {
    const limit = platformLimit('X', {});
    expect(limit).toEqual({ daily: 1, monthly: 31, types: ['digest'] });
    expect(platformAllows('X', post('digest:2026-10-06'), empty, now, limit)).toBe(true);
    expect(platformAllows('X', post('rising:abc'), empty, now, limit)).toBe(false);
    const state: SocialState = { posted: [{ key: 'digest:2026-10-05', at: '2026-10-06T00:00:00.000Z', platforms: ['X', 'Bluesky'] }] };
    expect(platformAllows('X', post('digest:2026-10-06'), state, now, limit)).toBe(false);
    expect(platformAllows('Bluesky', post('rising:abc'), state, now, platformLimit('Bluesky', {}))).toBe(true);
  });

  it('X の上限と種類は環境変数で変えられる', () => {
    expect(platformLimit('X', { X_DAILY_LIMIT: '3', X_MONTHLY_LIMIT: '60', X_POST_TYPES: 'digest, rising' })).toEqual({
      daily: 3,
      monthly: 60,
      types: ['digest', 'rising'],
    });
    expect(platformLimit('X', { X_POST_TYPES: 'all', X_DAILY_LIMIT: 'abc' })).toEqual({ daily: 1, monthly: 31, types: undefined });
    const monthly = { daily: 5, monthly: 2 };
    const state: SocialState = {
      posted: [
        { key: 'a', at: '2026-09-20T00:00:00.000Z', platforms: ['X'] },
        { key: 'b', at: '2026-09-25T00:00:00.000Z', platforms: ['X'] },
      ],
    };
    expect(platformAllows('X', post('hot:x'), state, now, monthly)).toBe(false);
  });
});
