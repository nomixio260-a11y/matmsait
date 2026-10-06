import { describe, expect, it } from 'vitest';
import {
  graphemeLength,
  hotPost,
  MAX_HOT_PER_DAY,
  mastodonLength,
  oauthSignature,
  planPosts,
  recordPost,
  richTextFacets,
  xLength,
  type PlanContext,
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

function context(now: Date, items: Item[] = [], snapshots: DailySnapshot[] = []): PlanContext {
  return { now, items, snapshots, pageUrl: (path) => `https://example.com/site${path}`, siteName: 'テスト' };
}

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

  it('21時（日本時間）以降に1日1回だけ日別まとめを投稿する', () => {
    const before = new Date('2026-10-06T11:30:00.000Z'); // 20:30 JST
    const after = new Date('2026-10-06T12:10:00.000Z'); // 21:10 JST
    expect(planPosts({ posted: [] }, context(before, [], [snapshot]))).toEqual([]);
    const [post] = planPosts({ posted: [] }, context(after, [], [snapshot]));
    expect(post.key).toBe('digest:2026-10-06');
    expect(post.compose(() => true)).toContain('https://example.com/site/daily/2026-10-06/');
    const state = recordPost({ posted: [] }, post, after);
    expect(state.lastDigest).toBe('2026-10-06');
    expect(planPosts(state, context(after, [], [snapshot]))).toEqual([]);
  });

  it('多くの掲載元が報じた直近の話題を投稿し、同じ記事は二度投稿しない', () => {
    const now = new Date('2026-10-06T11:00:00.000Z');
    const items = [
      item('low', { coverage: 2 }),
      item('hot', { coverage: 4 }),
      item('old', { coverage: 9, publishedAt: '2026-10-01T00:00:00.000Z' }),
    ];
    const [post] = planPosts({ posted: [] }, context(now, items));
    expect(post.key).toBe('hot:hot');
    expect(planPosts(recordPost({ posted: [] }, post, now), context(now, items))).toEqual([]);
  });

  it('1日の投稿数の上限を守る', () => {
    const now = new Date('2026-10-06T11:00:00.000Z');
    const posted = Array.from({ length: MAX_HOT_PER_DAY }, (_, n) => ({ key: `hot:x${n}`, at: now.toISOString() }));
    expect(planPosts({ posted }, context(now, [item('hot', { coverage: 5 })]))).toEqual([]);
  });

  it('文字数の上限に収まるようにタイトルを縮める', () => {
    const long = item('long', { coverage: 5, title: 'と'.repeat(200) });
    const text = hotPost(long, context(new Date())).compose((t) => xLength(t) <= 280);
    expect(xLength(text)).toBeLessThanOrEqual(280);
    expect(text).toContain(long.url);
  });
});
