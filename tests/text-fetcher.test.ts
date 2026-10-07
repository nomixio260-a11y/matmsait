import { describe, expect, it } from 'vitest';
import { decryptText, generateTextKeyPair } from '../src/lib/text-crypto.ts';
import type { HttpGetOptions, HttpResponse } from '../scripts/lib/http.ts';
import { fetchTexts } from '../scripts/lib/text-fetcher.ts';

const para = (n: number) => `これは記事の${n}段落目です。新製品の価格は3万9800円で、11月12日に発売されます。性能は従来モデルより約2割向上しました。`;
const articleHtml = (extra = '') =>
  `<html><head>${extra}</head><body><h1>見出し</h1><article>${[1, 2, 3, 4, 5, 6].map((n) => `<p>${para(n)}</p>`).join('')}</article></body></html>`;

function fakeSite(pages: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>) {
  const calls: { url: string; options: HttpGetOptions }[] = [];
  const get = async (url: string, options: HttpGetOptions): Promise<HttpResponse> => {
    calls.push({ url, options });
    const page = pages[url] ?? { status: 404, body: 'not found' };
    return {
      url,
      status: page.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...page.headers },
      body: Buffer.from(page.body ?? ''),
    };
  };
  return { get, calls };
}

describe('fetchTexts', async () => {
  const key = await generateTextKeyPair();
  const now = new Date();
  const request = (id: string, url: string) => ({ id, url, sourceId: 's', requestedAt: new Date(now.getTime() - 1000).toISOString() });

  it('ブラウザと同じ通信で取得し（ボットの名前は名乗らない）、本文を運営者の鍵で暗号化する', async () => {
    const { get, calls } = fakeSite({
      'https://ok.example.jp/robots.txt': { body: 'User-agent: *\nDisallow: /private/\n\nUser-agent: OtherBot\nDisallow: /' },
      'https://ok.example.jp/news/1': { body: articleHtml() },
    });
    const [result] = await fetchTexts({
      requests: [request('a', 'https://ok.example.jp/news/1')],
      results: [],
      keys: [key],
      now,
      get,
      wait: async () => {},
    });
    expect(result.status).toBe('ok');
    expect(await decryptText(result.enc!, key)).toContain(para(2));
    // ページを開くときのブラウザのヘッダー（httpGet の既定）で送り、User-Agent などを差し替えない
    expect(calls.map((call) => call.url)).toEqual(['https://ok.example.jp/robots.txt', 'https://ok.example.jp/news/1']);
    expect(calls.every((call) => call.options.kind === 'document' && !call.options.headers?.length)).toBe(true);
  });

  it('robots.txt・AI での利用の拒否・noai・アクセスの拒否・本文なしを守って取得しない', async () => {
    const { get, calls } = fakeSite({
      'https://robots.example.jp/robots.txt': { body: 'User-agent: *\nDisallow: /' },
      'https://ai.example.jp/robots.txt': { body: 'User-agent: GPTBot\nDisallow: /' },
      'https://noai.example.jp/robots.txt': { status: 404 },
      'https://noai.example.jp/1': { body: articleHtml('<meta name="robots" content="noai">') },
      'https://blocked.example.jp/robots.txt': { status: 404 },
      'https://blocked.example.jp/1': { status: 403, body: 'Forbidden' },
      'https://short.example.jp/robots.txt': { status: 404 },
      'https://short.example.jp/1': { body: '<html><body><div id="app"></div></body></html>' },
      'https://down.example.jp/robots.txt': { status: 503 },
    });
    const results = await fetchTexts({
      requests: [
        request('robots', 'https://robots.example.jp/1'),
        request('ai', 'https://ai.example.jp/1'),
        request('noai', 'https://noai.example.jp/1'),
        request('blocked', 'https://blocked.example.jp/1'),
        request('short', 'https://short.example.jp/1'),
        request('down', 'https://down.example.jp/1'),
      ],
      results: [],
      keys: [key],
      now,
      get,
      wait: async () => {},
    });
    const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(status).toEqual({ robots: 'robots', ai: 'ai-optout', noai: 'ai-optout', blocked: 'blocked', short: 'no-text', down: 'error' });
    // robots.txt で断られたページ・robots.txt を読めないサイトのページは取りに行かない
    expect(calls.map((call) => call.url)).not.toContain('https://robots.example.jp/1');
    expect(calls.map((call) => call.url)).not.toContain('https://ai.example.jp/1');
    expect(calls.map((call) => call.url)).not.toContain('https://down.example.jp/1');
    // 拒否されても再試行しない
    expect(calls.filter((call) => call.url === 'https://blocked.example.jp/1')).toHaveLength(1);
    expect(results.every((r) => !r.enc)).toBe(true);
  });

  it('公開鍵がなければ、依頼があっても取得しない', async () => {
    const { get, calls } = fakeSite({});
    const results = await fetchTexts({
      requests: [request('a', 'https://ok.example.jp/1')],
      results: [],
      keys: [],
      now,
      get,
    });
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });
});
