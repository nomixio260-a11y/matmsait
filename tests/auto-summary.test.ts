import { describe, expect, it } from 'vitest';
import {
  AiError,
  DEFAULT_MODEL,
  estimateNeurons,
  focusOnTitle,
  parseAutoSummaryOptions,
  parseAutoSummaryState,
  pickCandidates,
  replyText,
  runAutoSummary,
  summarizeItem,
  workersAiClient,
  type AiClient,
  type AutoSummaryState,
  type ChatMessage,
} from '../scripts/lib/auto-summary.ts';
import type { HttpGetOptions, HttpResponse } from '../scripts/lib/http.ts';
import { autoSummaryStatus } from '../src/lib/auto-summary-state.ts';
import type { Item } from '../src/lib/types.ts';

const NOW = new Date('2026-10-09T03:00:00.000Z');

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: 'A社、新型スマホ「X1」を発表',
    url: `https://news.example.com/${id}`,
    excerpt: '',
    sourceId: 'fnn',
    category: 'tech',
    publishedAt: '2026-10-09T01:00:00.000Z',
    ...extra,
  };
}

const GOOD = {
  status: 'ok',
  summary: 'A社は10月9日、新型スマートフォン「X1」を11月14日に発売すると発表した。価格は9万8000円で、電池の持ちを前モデルより2割延ばした。',
  points: ['価格は9万8000円から', '発売は11月14日'],
  background: '',
  keywords: ['A社', 'X1'],
};
const answer = (id: string, entry: Record<string, unknown> = GOOD) => `\`\`\`json\n${JSON.stringify([{ id, ...entry }])}\n\`\`\``;

/** 決まった順に回答する AI（受け取った依頼を記録する） */
function fakeAi(replies: string[]): AiClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const ai = (async (messages: ChatMessage[]) => {
    calls.push(messages);
    const text = replies.shift();
    if (text === undefined) throw new Error('回答がありません');
    return { text, usage: { prompt_tokens: 10_000, completion_tokens: 500 } };
  }) as AiClient & { calls: ChatMessage[][] };
  ai.calls = calls;
  return ai;
}

const ARTICLE_TEXT = `メニュー ホーム ニュース\nA社、新型スマホ「X1」を発表\n${'A社は10月9日、新型スマートフォン「X1」を11月14日に発売すると発表した。価格は9万8000円。'.repeat(5)}`;

/** robots.txt はなし（404）、記事のページは本文のある HTML を返す */
function fakeGet(pages: Record<string, { status?: number; html?: string }> = {}) {
  const requested: string[] = [];
  const get = async (url: string, _options: HttpGetOptions): Promise<HttpResponse> => {
    requested.push(url);
    if (url.endsWith('/robots.txt')) return { url, status: 404, headers: {}, body: Buffer.from('') };
    const page = pages[url] ?? {};
    const html = page.html ?? `<html><body><article><p>${ARTICLE_TEXT.replace(/\n/g, '</p><p>')}</p></article></body></html>`;
    return { url, status: page.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) };
  };
  return { get, requested };
}

const state = (extra: Partial<AutoSummaryState> = {}): AutoSummaryState => ({ day: '2026-10-09', neurons: 0, saved: 0, attempts: [], ...extra });
const options = { perRun: 4, perDay: 60, model: DEFAULT_MODEL, neuronBudget: 8000 };

describe('設定・使用量・記録', () => {
  it('件数の設定（0 で止める）とモデル', () => {
    expect(parseAutoSummaryOptions({})).toEqual({ perRun: 4, perDay: 60, model: '@cf/qwen/qwen3-30b-a3b-fp8', neuronBudget: 8000 });
    expect(parseAutoSummaryOptions({ AUTO_SUMMARY_PER_RUN: '0', AUTO_SUMMARY_PER_DAY: '500', AUTO_SUMMARY_MODEL: '@cf/openai/gpt-oss-20b' })).toMatchObject({
      perRun: 0,
      perDay: 120,
      model: '@cf/openai/gpt-oss-20b',
    });
  });

  it('使ったニューロンを料金表から見積もる（分からなければ文字数から多めに）', () => {
    // Qwen3: 入力 4625・出力 30475（100万トークンあたり）
    expect(estimateNeurons(DEFAULT_MODEL, { prompt_tokens: 10_000, completion_tokens: 500 }, { input: 0, output: 0 })).toBe(62);
    expect(estimateNeurons('@cf/unknown/model', undefined, { input: 10_000, output: 500 })).toBe(750);
  });

  it('記録は UTC の日付が変わると使用量・保存数を数え直し、14日より前の記録を捨てる', () => {
    const text = JSON.stringify({
      day: '2026-10-08',
      neurons: 5000,
      saved: 40,
      attempts: [
        { id: 'old', at: '2026-09-20T00:00:00.000Z', result: 'saved' },
        { id: 'new', at: '2026-10-08T23:00:00.000Z', result: 'robots' },
      ],
    });
    const parsed = parseAutoSummaryState(text, NOW);
    expect([parsed.day, parsed.neurons, parsed.saved, parsed.attempts.map((attempt) => attempt.id)]).toEqual(['2026-10-09', 0, 0, ['new']]);
    expect(parseAutoSummaryState(JSON.stringify({ ...JSON.parse(text), day: '2026-10-09' }), NOW).neurons).toBe(5000);
    expect(parseAutoSummaryState('壊れた', NOW).attempts).toEqual([]);
  });

  it('無料枠を使い切った問題は日が変われば消し、権限の問題は残す', () => {
    const problem = (kind: string) => JSON.stringify({ day: '2026-10-08', neurons: 9000, saved: 50, attempts: [], problem: { at: '2026-10-08T20:00:00.000Z', kind, message: '…' } });
    expect(parseAutoSummaryState(problem('quota'), NOW).problem).toBeUndefined();
    expect(parseAutoSummaryState(problem('auth'), NOW).problem?.kind).toBe('auth');
  });

  it('管理画面には直近24時間の結果ごとの件数だけを渡す', () => {
    const status = autoSummaryStatus(
      state({
        saved: 2,
        neurons: 130,
        attempts: [
          { id: 'a', at: '2026-10-09T02:00:00.000Z', result: 'saved' },
          { id: 'b', at: '2026-10-09T02:00:00.000Z', result: 'robots' },
          { id: 'c', at: '2026-10-09T01:00:00.000Z', result: 'saved' },
          { id: 'd', at: '2026-10-07T01:00:00.000Z', result: 'blocked' },
        ],
      }),
      NOW,
    );
    expect(status).toMatchObject({ saved: 2, neurons: 130, freeNeurons: 10_000 });
    expect(status.recent).toEqual([
      { result: 'saved', label: '要約を保存', count: 2 },
      { result: 'robots', label: 'robots.txt で取得を断っている', count: 1 },
    ]);
  });
});

describe('要約する記事を選ぶ', () => {
  it('要約のないトピックを報じた媒体の多い順に、つぎに反応のよいジャンルの新しい記事。失敗した記事はしばらく選ばない', () => {
    const topics = [
      { coverage: 3, score: 50, latestAt: '2026-10-09T02:00:00.000Z', items: [item('t3a', { sourceId: 'ng' }), item('t3b')], summarized: false },
      { coverage: 5, score: 40, latestAt: '2026-10-09T02:00:00.000Z', items: [item('t5')], summarized: false },
      { coverage: 9, score: 90, latestAt: '2026-10-09T02:00:00.000Z', items: [item('done')], summarized: true },
      { coverage: 8, score: 80, latestAt: '2026-10-05T00:00:00.000Z', items: [item('stale')], summarized: false },
      { coverage: 4, score: 60, latestAt: '2026-10-09T02:00:00.000Z', items: [item('failed')], summarized: false },
    ];
    const items = [item('single'), item('sports', { category: 'sports' }), item('old', { publishedAt: '2026-10-07T00:00:00.000Z' }), ...topics.flatMap((t) => t.items)];
    const picked = pickCandidates({
      topics,
      items,
      isSummarized: (id) => id === 'done',
      // 掲載元が要約を禁じている記事は選ばない（同じトピックの別の記事を選ぶ）
      canSummarize: (candidate) => candidate.sourceId !== 'ng',
      attempts: [{ id: 'failed', at: '2026-10-08T00:00:00.000Z', result: 'robots' }],
      now: NOW,
      limit: 10,
      preferredCategories: ['tech'],
    });
    expect(picked.map((entry) => entry.id)).toEqual(['t5', 't3b', 'single']);
    expect(pickCandidates({ topics, items, isSummarized: () => false, canSummarize: () => true, attempts: [], now: NOW, limit: 0, preferredCategories: [] })).toEqual([]);
  });
});

describe('本文と回答の扱い', () => {
  it('Workers AI の回答から文章を取り出す（考えた過程は除く）', () => {
    expect(replyText({ response: '答え' })).toBe('答え');
    expect(replyText({ choices: [{ message: { content: '<think>考え中</think>\n```json\n[]\n```' } }] })).toBe('```json\n[]\n```');
    expect(replyText({ choices: [{ message: { content: '途中までの考え</think>答え' } }] })).toBe('答え');
    expect(replyText({ choices: [{ message: { content: null }, text: '答え' }] })).toBe('答え');
    expect(replyText(undefined)).toBe('');
  });

  it('本文は見出しの位置から使い、見出しの記事と一致しない本文（メニューだけ・広告）は使わない', () => {
    expect(focusOnTitle(ARTICLE_TEXT, 'A社、新型スマホ「X1」を発表 - 例ニュース')?.startsWith('A社、新型スマホ「X1」を発表')).toBe(true);
    expect(focusOnTitle('ホーム ニュース ランキング 広告 ミリ秒の世界を制するヘッドセット', 'A社、新型スマホ「X1」を発表')).toBeUndefined();
    // 見出しの飾りの言葉が本文にない長い見出しでも、中身の言葉が本文にあれば使う（くるまのニュースなど）
    const body =
      '大島町や八丈町など伊豆諸島の8町村は、品川区にある東京運輸支局の管轄区域に含まれているため、品川ナンバーになります。都心から離れた有人島でも同じナンバーになる理由は、明治時代に島の事務が東京に移されたことにあります。';
    expect(focusOnTitle(body, '“伊豆諸島”なのに「品川ナンバー」!? 都心から離れた島も“大都会と同じプレート”！ 意外な理由とは？')).toBe(body);
  });
});

describe('1件の要約', () => {
  it('本文入りのプロンプトで頼み、決まりに合う回答を使う（考えるモードは止める）', async () => {
    const ai = fakeAi([answer('a')]);
    const outcome = await summarizeItem(item('a'), ARTICLE_TEXT, '例ニュース', ai, DEFAULT_MODEL, 'テスト');
    expect(outcome).toMatchObject({ result: 'saved', entry: { id: 'a', summary: GOOD.summary } });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0][1].content).toContain('記事の本文');
    expect(ai.calls[0][1].content).toMatch(/\/no_think$/);
  });

  it('推測などの注意があれば1回だけ直してもらい、直らなければ保存しない', async () => {
    const guess = { ...GOOD, summary: `${GOOD.summary}市場を大きく変えるだろう。` };
    const fixed = fakeAi([answer('a', guess), answer('a')]);
    expect(await summarizeItem(item('a'), ARTICLE_TEXT, '例', fixed, DEFAULT_MODEL, 'テスト')).toMatchObject({ result: 'saved' });
    // 2回目は同じ会話の続き（最初の回答と、直してほしい点）
    expect(fixed.calls[1].map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(fixed.calls[1][3].content).toContain('推測の言い方');
    const stubborn = fakeAi([answer('a', guess), answer('a', guess)]);
    expect(await summarizeItem(item('a'), ARTICLE_TEXT, '例', stubborn, DEFAULT_MODEL, 'テスト')).toMatchObject({ result: 'quality' });
  });

  it('本文を要約できないという回答・見出しと関係のない要約・形の崩れた回答は保存しない', async () => {
    const unavailable = fakeAi([answer('a', { status: 'unavailable', summary: '', points: [], background: '', keywords: [] })]);
    expect(await summarizeItem(item('a'), ARTICLE_TEXT, '例', unavailable, DEFAULT_MODEL, 'テスト')).toMatchObject({ result: 'unavailable' });
    const unrelated = fakeAi([
      answer('a', { ...GOOD, summary: 'Razerは新しいゲーミングヘッドセットを発売した。価格は2万9800円で、遅延を減らした。', points: ['価格は2万9800円'], keywords: ['Razer'] }),
    ]);
    expect(await summarizeItem(item('a'), ARTICLE_TEXT, '例', unrelated, DEFAULT_MODEL, 'テスト')).toMatchObject({ result: 'invalid' });
    expect(await summarizeItem(item('a'), ARTICLE_TEXT, '例', fakeAi(['すみません']), DEFAULT_MODEL, 'テスト')).toMatchObject({ result: 'invalid' });
  });
});

describe('まとめて実行', () => {
  const run = (overrides: Partial<Parameters<typeof runAutoSummary>[0]> = {}) =>
    runAutoSummary({
      candidates: [item('a'), item('b'), item('c')],
      state: state(),
      options,
      now: NOW,
      siteName: 'テスト',
      siteOf: () => '例ニュース',
      ai: fakeAi([answer('a'), answer('b'), answer('c')]),
      get: fakeGet().get,
      ...overrides,
    });

  it('本文を取得して要約し、保存する要約と記録を返す', async () => {
    const { entries, state: next } = await run();
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(entries[0]).toEqual({ id: 'a', ...GOOD });
    expect(next.saved).toBe(3);
    expect(next.neurons).toBe(62 * 3);
    expect(next.attempts.map((attempt) => attempt.result)).toEqual(['saved', 'saved', 'saved']);
    expect(next.lastRun).toMatchObject({ saved: 3, tried: 3 });
  });

  it('本文を取れない記事は AI に頼まずに記録し、次の記事に進む。AI に頼むのは1回の上限まで', async () => {
    const { get } = fakeGet({ 'https://news.example.com/a': { status: 403 } });
    const ai = fakeAi([answer('b')]);
    const { entries, state: next } = await run({ get, ai, options: { ...options, perRun: 1 } });
    expect(entries.map((entry) => entry.id)).toEqual(['b']);
    expect(next.attempts.map((attempt) => `${attempt.id}:${attempt.result}`)).toEqual(['a:blocked', 'b:saved']);
    expect(ai.calls).toHaveLength(1);
  });

  it('1日の件数・使用量の見積もりの上限で止める', async () => {
    expect((await run({ state: state({ saved: 60 }) })).entries).toEqual([]);
    const near = await run({ state: state({ neurons: 7900 }) });
    expect(near.entries).toEqual([]);
    expect(near.state.lastRun?.message).toContain('上限');
  });

  it('権限がない・無料枠を使い切ったときは、その記事を試したことにせず止めて、管理画面に出す問題として残す', async () => {
    const denied: AiClient = async () => {
      throw new AiError('Workers AI を使う権限がありません（HTTP 403）', 'auth');
    };
    const { entries, state: next } = await run({ ai: denied });
    expect(entries).toEqual([]);
    expect(next.attempts).toEqual([]);
    expect(next.problem?.message).toContain('権限がありません');
    // そのほかの失敗は、その記事だけ記録して続ける
    let calls = 0;
    const flaky: AiClient = async () => {
      calls += 1;
      if (calls === 1) throw new AiError('Workers AI がエラーを返しました（HTTP 500）', 'other');
      return { text: answer(calls === 2 ? 'b' : 'c') };
    };
    const after = await run({ ai: flaky, state: state({ problem: { at: '2026-10-09T02:00:00.000Z', kind: 'auth', message: '…' } }) });
    expect(after.state.attempts.map((attempt) => attempt.result)).toEqual(['ai-error', 'saved', 'saved']);
    // 要約を保存できたら問題は消える
    expect(after.state.problem).toBeUndefined();
    expect(next.problem?.kind).toBe('auth');
  });

  it('1件も保存できず AI への依頼が続けて失敗したときは、管理画面に出す問題として残す', async () => {
    const broken: AiClient = async () => {
      throw new AiError('Workers AI がエラーを返しました（HTTP 400: No such model）', 'other');
    };
    const { entries, state: next } = await run({ ai: broken });
    expect(entries).toEqual([]);
    expect(next.attempts.map((attempt) => attempt.result)).toEqual(['ai-error', 'ai-error', 'ai-error']);
    expect(next.problem).toMatchObject({ kind: 'other' });
    expect(next.problem?.message).toContain('No such model');
  });
});

describe('Workers AI の API', () => {
  const client = (status: number, body: unknown) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { ai: workersAiClient({ accountId: 'acc', token: 'tok', model: DEFAULT_MODEL, fetchImpl }), requests };
  };

  it('アカウントとモデルの URL にトークンで頼み、文章と使った量を返す', async () => {
    const { ai, requests } = client(200, { success: true, result: { choices: [{ message: { content: '答え' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } });
    expect(await ai([{ role: 'user', content: 'こんにちは' }])).toEqual({ text: '答え', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    expect(requests[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/qwen/qwen3-30b-a3b-fp8');
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({ messages: [{ role: 'user', content: 'こんにちは' }], max_tokens: 2048 });
  });

  it('権限がない・無料枠を使い切った・そのほかの失敗を見分ける', async () => {
    await expect(client(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }).ai([])).rejects.toMatchObject({ kind: 'auth' });
    await expect(client(429, { success: false, errors: [{ code: 3036, message: 'limit' }] }).ai([])).rejects.toMatchObject({ kind: 'quota' });
    await expect(client(500, { success: false, errors: [{ code: 1, message: 'boom' }] }).ai([])).rejects.toMatchObject({ kind: 'other' });
  });
});
