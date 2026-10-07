import { describe, expect, it } from 'vitest';
import { handle, type FrontEnv } from '../analytics/src/front.ts';

const SITE = 'https://topiatsume.pages.dev';

/** Durable Object のまね（届いたリクエストを記録して、決まった応答を返す） */
function fakeEnv(allowed = 'http://localhost:4321') {
  const received: Request[] = [];
  const env: FrontEnv = {
    ALLOWED_ORIGINS: allowed,
    ANALYTICS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          received.push(request);
          return new Response('{"online":1}', { headers: { 'Content-Type': 'application/json' } });
        },
      }),
    },
  };
  return { env, received };
}

const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(`${SITE}${path}`, init);

describe('アクセス解析の入口（Pages Functions の /api と Worker で共通）', () => {
  it('サイトと同じドメインのページからの計測を、/api を外して Durable Object へ渡す', async () => {
    const { env, received } = fakeEnv();
    const req = request('/api/collect', {
      method: 'POST',
      body: '{"t":"view","p":"/"}',
      headers: { Origin: SITE, 'User-Agent': 'Mozilla/5.0 test browser agent', 'CF-Connecting-IP': '203.0.113.9' },
    });
    Object.defineProperty(req, 'cf', { value: { country: 'JP' } });
    const res = await handle(req, env, '/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: 1 });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(new URL(received[0].url).pathname).toBe('/collect');
    expect(received[0].headers.get('x-ip')).toBe('203.0.113.9');
    expect(received[0].headers.get('x-country')).toBe('JP');
    expect(received[0].headers.get('x-ua')).toBe('Mozilla/5.0 test browser agent');
    expect(received[0].headers.get('authorization')).toBeNull();
    expect(await received[0].text()).toBe('{"t":"view","p":"/"}');
  });

  it('同じドメインの GET（Origin なし）は Sec-Fetch-Site で見分け、運営者のトークンを渡す', async () => {
    const { env, received } = fakeEnv();
    const ok = await handle(
      request('/api/admin/stats?from=2026-10-07&to=2026-10-07', { headers: { 'Sec-Fetch-Site': 'same-origin', Authorization: 'Bearer abc' } }),
      env,
      '/api',
    );
    expect(ok.status).toBe(200);
    expect(new URL(received[0].url).pathname + new URL(received[0].url).search).toBe('/admin/stats?from=2026-10-07&to=2026-10-07');
    expect(received[0].headers.get('authorization')).toBe('Bearer abc');
    const crossSite = await handle(request('/api/admin/stats', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), env, '/api');
    expect(crossSite.status).toBe(403);
    expect(received).toHaveLength(1);
  });

  it('ほかのサイトからは受け付けず、許可したオリジン（手元の試験）からは受け付ける', async () => {
    const { env } = fakeEnv();
    const post = (origin: string) => request('/api/collect', { method: 'POST', body: '{}', headers: { Origin: origin } });
    expect((await handle(post('https://evil.example'), env, '/api')).status).toBe(403);
    const local = await handle(post('http://localhost:4321'), env, '/api');
    expect(local.status).toBe(200);
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4321');
  });

  it('人気の記事は、どこからでも読める（サイトのビルドが読む）', async () => {
    const { env } = fakeEnv();
    const res = await handle(request('/api/popular'), env, '/api');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('事前確認（OPTIONS）・ない API・違う使い方・大きすぎる内容', async () => {
    const { env, received } = fakeEnv();
    const preflight = await handle(request('/api/admin/live', { method: 'OPTIONS', headers: { Origin: 'http://localhost:4321' } }), env, '/api');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect((await handle(request('/api/admin/live', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env, '/api')).status).toBe(403);
    expect((await handle(request('/api/unknown'), env, '/api')).status).toBe(404);
    expect((await handle(request('/api/collect', { headers: { Origin: SITE } }), env, '/api')).status).toBe(405);
    const big = request('/api/collect', { method: 'POST', body: 'x'.repeat(5000), headers: { Origin: SITE } });
    expect((await handle(big, env, '/api')).status).toBe(413);
    expect(received).toHaveLength(0);
    // Worker として直接使うとき（/api なし）
    expect((await handle(new Request('http://127.0.0.1:8787/popular'), env)).status).toBe(200);
  });
});
