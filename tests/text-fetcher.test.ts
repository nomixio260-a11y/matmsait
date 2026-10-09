import { describe, expect, it } from 'vitest';
import { TEXT_FETCH_VERSION } from '../src/lib/article-texts.ts';
import { decryptText, generateTextKeyPair } from '../src/lib/text-crypto.ts';
import type { HttpGetOptions, HttpResponse } from '../scripts/lib/http.ts';
import { parseRobots } from '../scripts/lib/robots.ts';
import { fetchArticleText, fetchTexts } from '../scripts/lib/text-fetcher.ts';

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

  it('一時的に失敗した記事は時間をあけて取り直し、試した回数と取り方の版を記録する', async () => {
    const { get } = fakeSite({
      'https://retry.example.jp/robots.txt': { status: 404 },
      'https://retry.example.jp/1': { status: 500, body: 'error' },
    });
    const req = { ...request('r', 'https://retry.example.jp/1'), requestedAt: new Date(now.getTime() - 3 * 3600e3).toISOString() };
    const previous = { id: 'r', url: req.url, status: 'error' as const, fetchedAt: new Date(now.getTime() - 3600e3).toISOString(), v: TEXT_FETCH_VERSION };
    const [result] = await fetchTexts({ requests: [req], results: [previous], keys: [key], now, get, wait: async () => {} });
    expect(result).toMatchObject({ id: 'r', status: 'error', detail: 'HTTP 500', tries: 2, v: TEXT_FETCH_VERSION });
  });

  it('時間の上限を過ぎたら新しい記事は取りに行かず、次の実行に回す', async () => {
    const { get, calls } = fakeSite({});
    const logs: string[] = [];
    const results = await fetchTexts({
      requests: [request('a', 'https://ok.example.jp/1'), request('b', 'https://other.example.jp/1')],
      results: [],
      keys: [key],
      now,
      get,
      wait: async () => {},
      budgetMs: 0,
      log: (message) => logs.push(message),
    });
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('残りの2件は次の実行で取得します');
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

describe('fetchArticleText（記事の続き・全文のページ・記事本体のページをたどる）', () => {
  const noWait = async () => {};
  /** 転送（redirect）も、本物の httpGet と同じく followRedirect に聞いてから進む */
  function site(pages: Record<string, { status?: number; body?: string; headers?: Record<string, string>; redirect?: string }>) {
    const calls: { url: string; options: HttpGetOptions }[] = [];
    const get = async (url: string, options: HttpGetOptions): Promise<HttpResponse> => {
      let current = url;
      for (;;) {
        calls.push({ url: current, options });
        const page = pages[current] ?? { status: 404, body: 'not found' };
        if (page.redirect) {
          const next = new URL(page.redirect, current);
          if (options.followRedirect && !(await options.followRedirect(next))) {
            return { url: current, status: 302, headers: { location: next.toString() }, body: Buffer.from('') };
          }
          current = next.toString();
          continue;
        }
        return {
          url: current,
          status: page.status ?? 200,
          headers: { 'content-type': 'text/html; charset=utf-8', ...page.headers },
          body: Buffer.from(page.body ?? ''),
        };
      }
    };
    return { get, calls };
  }
  const page = (paragraphs: number[], extra = '') =>
    `<html><body><h1>見出し</h1><article>${paragraphs.map((n) => `<p>${para(n)}</p>`).join('')}${extra}</article></body></html>`;
  const allowAll: Parameters<typeof fetchArticleText>[1] = [];

  it('2ページ目以降をたどって本文をつなげ、移る前のページを Referer で送る', async () => {
    const { get, calls } = site({
      'https://e.jp/a/1': { body: page([1, 2, 3], '<a href="/a/1/2">2</a><a href="/a/1/3">3</a>') },
      'https://e.jp/a/1/2': { body: page([4, 5, 6], '<a href="/a/1/3">3</a>') },
      'https://e.jp/a/1/3': { body: page([7, 8, 9]) },
    });
    const result = await fetchArticleText('https://e.jp/a/1', allowAll, get, { wait: noWait });
    expect(result).toMatchObject({ status: 'ok', pages: 3 });
    const text = result.status === 'ok' ? result.text : '';
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => text.includes(para(n)))).toBe(true);
    expect(calls.map((call) => [call.url, call.options.referer])).toEqual([
      ['https://e.jp/a/1', undefined],
      ['https://e.jp/a/1/2', 'https://e.jp/a/1'],
      ['https://e.jp/a/1/3', 'https://e.jp/a/1/2'],
    ]);
  });

  it('「つづきを読む」の先の全文のページを使う', async () => {
    const { get } = site({
      'https://e.jp/a/2': { body: page([1], '<a href="?all=1">つづきを読む</a>') },
      'https://e.jp/a/2?all=1': { body: page([1, 2, 3, 4, 5]) },
    });
    const result = await fetchArticleText('https://e.jp/a/2', allowAll, get, { wait: noWait });
    expect(result.status === 'ok' && result.text.includes(para(5))).toBe(true);
  });

  it('本文が短ければ、記事本体へのリンク → AMP 版 → WordPress の API の順に試す', async () => {
    const title = '新しい制度の開始について（お知らせ）';
    const stub = site({
      'https://e.jp/notice/1': { body: `<html><body><h1>お知らせ</h1><a href="/policy/new">${title}</a></body></html>` },
      'https://e.jp/policy/new': { body: page([1, 2, 3, 4, 5]) },
    });
    expect((await fetchArticleText('https://e.jp/notice/1', allowAll, stub.get, { title, wait: noWait })).status).toBe('ok');

    const amp = site({
      'https://e.jp/a/3': { body: '<html><head><link rel="amphtml" href="/a/3/amp"></head><body><div id="app"></div></body></html>' },
      'https://e.jp/a/3/amp': { body: page([1, 2, 3, 4, 5]) },
    });
    expect((await fetchArticleText('https://e.jp/a/3', allowAll, amp.get, { wait: noWait })).status).toBe('ok');

    const wp = site({
      'https://e.jp/a/4': {
        body: `<html><head><link rel="alternate" type="application/json" href="https://e.jp/wp-json/wp/v2/posts/4"></head><body><h1>見出し</h1><p>${para(1)}</p></body></html>`,
      },
      'https://e.jp/wp-json/wp/v2/posts/4': {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: { rendered: [1, 2, 3, 4, 5].map((n) => `<p>${para(n)}</p>`).join(''), protected: false } }),
      },
    });
    const result = await fetchArticleText('https://e.jp/a/4', allowAll, wp.get, { wait: noWait });
    expect(result.status === 'ok' && result.text.includes(para(5))).toBe(true);
  });

  it('たどる先のページも robots.txt で確かめ、続きのページで noai なら記事ごと使わない', async () => {
    const { get, calls } = site({
      'https://e.jp/a/5': { body: page([1, 2, 3, 4], '<a href="/a/5/2">2</a>') },
      'https://e.jp/a/5/2': { body: page([5, 6]) },
    });
    const robots = parseRobots('User-agent: *\nDisallow: /a/5/2');
    const result = await fetchArticleText('https://e.jp/a/5', robots, get, { wait: noWait });
    expect(result).toMatchObject({ status: 'ok' });
    expect(calls.map((call) => call.url)).toEqual(['https://e.jp/a/5']);

    const noai = site({
      'https://e.jp/a/6': { body: page([1, 2, 3, 4], '<a href="/a/6/2">2</a>') },
      'https://e.jp/a/6/2': { body: page([5, 6]).replace('<html>', '<html><head><meta name="robots" content="noai"></head>') },
    });
    expect(await fetchArticleText('https://e.jp/a/6', allowAll, noai.get, { wait: noWait })).toMatchObject({ status: 'ai-optout' });
  });

  it('別のサイトへ転送されたら、そのサイトの robots.txt を確かめてから進む', async () => {
    const refused = site({
      'https://click.example.jp/r/1': { redirect: 'https://news.example.com/a/1' },
      'https://news.example.com/robots.txt': { body: 'User-agent: GPTBot\nDisallow: /' },
      'https://news.example.com/a/1': { body: page([1, 2, 3, 4]) },
    });
    expect(await fetchArticleText('https://click.example.jp/r/1', allowAll, refused.get, { wait: noWait })).toMatchObject({ status: 'ai-optout' });
    expect(refused.calls.map((call) => call.url)).not.toContain('https://news.example.com/a/1');

    const allowed = site({
      'https://click.example.jp/r/2': { redirect: 'https://news.example.com/a/2' },
      'https://news.example.com/robots.txt': { body: 'User-agent: *\nDisallow: /private/' },
      'https://news.example.com/a/2': { body: page([1, 2, 3, 4], '<a href="/a/2/2">2</a>') },
      'https://news.example.com/a/2/2': { body: page([5, 6]) },
    });
    const result = await fetchArticleText('https://click.example.jp/r/2', allowAll, allowed.get, { wait: noWait });
    // 転送先のサイトの中の続きのページもたどる
    expect(result).toMatchObject({ status: 'ok', pages: 2 });
  });

  it('一時的なエラー（502）は1回だけやり直し、拒否（503）はやり直さない', async () => {
    let tries = 0;
    const flaky = async (url: string): Promise<HttpResponse> => {
      tries++;
      return { url, status: tries === 1 ? 502 : 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page([1, 2, 3, 4])) };
    };
    expect(await fetchArticleText('https://e.jp/a/7', allowAll, flaky, { wait: noWait })).toMatchObject({ status: 'ok' });
    expect(tries).toBe(2);

    const busy = site({ 'https://e.jp/a/8': { status: 503 } });
    expect(await fetchArticleText('https://e.jp/a/8', allowAll, busy.get, { wait: noWait })).toMatchObject({ status: 'blocked' });
    expect(busy.calls).toHaveLength(1);
  });

  it('時間の上限を過ぎていれば、続きのページはたどらずに、そこまでの本文を使う', async () => {
    const { get, calls } = site({
      'https://e.jp/a/9': { body: page([1, 2, 3, 4], '<a href="/a/9/2">2</a>') },
      'https://e.jp/a/9/2': { body: page([5, 6]) },
    });
    const result = await fetchArticleText('https://e.jp/a/9', allowAll, get, { wait: noWait, deadline: Date.now() - 1 });
    expect(result).toMatchObject({ status: 'ok' });
    expect(calls.map((call) => call.url)).toEqual(['https://e.jp/a/9']);
  });

  it('本文がなければ、動画・画像が中心のページかを理由に添える', async () => {
    const { get } = site({
      'https://e.jp/v/1': { body: '<html><head><meta property="og:type" content="video.other"></head><body><h1>会見</h1><p>会見の動画です。</p></body></html>' },
    });
    const result = await fetchArticleText('https://e.jp/v/1', allowAll, get, { wait: noWait });
    expect(result.status).toBe('no-text');
    expect(result.status !== 'ok' && result.detail).toMatch(/^動画が中心のページ/);
  });
});
