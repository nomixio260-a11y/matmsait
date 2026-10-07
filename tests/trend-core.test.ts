import { describe, expect, it } from 'vitest';
import type { TopicCluster } from '../src/lib/related.ts';
import { HOUR, analyzeTopic, heatAt, heatOf, prepareVocabulary, reportsOf, scoreOf } from '../src/lib/topic-core.ts';
import {
  appearedTopics,
  buildDayTrend,
  burstWithin,
  coolingTopics,
  dayWordTrends,
  emergingPairs,
  genreChanges,
  isCompleteDay,
  isDayTrend,
  peakWithin,
  sameDayTrend,
  summarizeWeek,
  wordShifts,
  type DayTopic,
  type DayTrend,
  type WordedEntry,
} from '../src/lib/trend-core.ts';
import type { Item } from '../src/lib/types.ts';

/** 日本時間の「2026-10-07 09:00」を ISO 8601 にする */
const jst = (text: string) => new Date(`${text.replace(' ', 'T')}:00+09:00`).toISOString();
const time = (text: string) => Date.parse(jst(text));

function item(id: string, sourceId: string, at: string, category = 'tech', title = `見出し${id}`): Item {
  return { id, title, url: `https://example.com/${id}`, excerpt: '', sourceId, category, publishedAt: jst(at) };
}

function cluster(items: Item[]): TopicCluster {
  const sorted = [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return {
    items: sorted,
    coverage: new Set(items.map((entry) => entry.sourceId)).size,
    firstAt: sorted[sorted.length - 1].publishedAt,
    latestAt: sorted[0].publishedAt,
  };
}

function day(date: string, overrides: Partial<DayTrend> = {}): DayTrend {
  return {
    date,
    updatedAt: `${date}T12:00:00.000Z`,
    until: new Date(Date.parse(`${date}T00:00:00+09:00`) + 24 * HOUR).toISOString(),
    articles: 0,
    media: 0,
    topics: 0,
    genres: {},
    words: {},
    top: [],
    ...overrides,
  };
}

function dayTopic(id: string, overrides: Partial<DayTopic> = {}): DayTopic {
  return {
    id,
    title: `見出し${id}`,
    url: `https://example.com/${id}`,
    sourceId: 's1',
    category: 'tech',
    firstAt: jst('2026-10-07 09:00'),
    coverage: 2,
    added: 2,
    peak: 30,
    burst: 2,
    ...overrides,
  };
}

describe('その日の話題度の最大と広がる速さ', () => {
  const reports = reportsOf([
    item('a', 's1', '2026-10-06 23:30'),
    item('b', 's2', '2026-10-07 01:00'),
    item('c', 's3', '2026-10-07 02:00'),
    item('d', 's4', '2026-10-07 20:00'),
  ]);
  const from = time('2026-10-07 00:00');
  const until = time('2026-10-08 00:00');

  it('話題度の最大は、その日の報道の時刻（と日の始まり）の話題度から選ぶ', () => {
    const candidates = [from, time('2026-10-07 01:00'), time('2026-10-07 02:00'), time('2026-10-07 20:00')].map((at) => scoreOf(heatAt(reports, at)));
    expect(peakWithin(reports, from, until)).toBe(Math.max(...candidates));
    // 前の日の報道しかない時間帯は、その日の始まりの値
    expect(peakWithin(reports.slice(0, 1), from, until)).toBe(scoreOf(heatAt(reports.slice(0, 1), from)));
    expect(peakWithin([], from, until)).toBe(0);
  });

  it('3時間で新しく報じた媒体の数の最大（前の日の報道も3時間の中なら数える）', () => {
    // 2:00 の時点で、23:30・1:00・2:00 の3媒体
    expect(burstWithin(reports, from, until)).toBe(3);
    // ちょうど3時間前の報道は数えない
    const edge = reportsOf([item('a', 's1', '2026-10-07 01:00'), item('b', 's2', '2026-10-07 04:00')]);
    expect(burstWithin(edge, from, until)).toBe(1);
    // その日の報道がなければ0
    expect(burstWithin(reports, time('2026-10-08 00:00'), time('2026-10-09 00:00'))).toBe(0);
  });
});

describe('日ごとの集計', () => {
  const items = [
    item('a1', 's1', '2026-10-06 23:30', 'tech', 'ソニーが新製品'),
    item('a2', 's2', '2026-10-07 01:00', 'tech', 'ソニーの新製品を発表'),
    item('a3', 's3', '2026-10-07 02:00', 'tech', 'ソニー、新製品'),
    item('a4', 's4', '2026-10-08 03:00', 'tech', 'ソニー新製品の評判'),
    item('b1', 's1', '2026-10-07 12:00', 'sports', 'ドジャースの山本由伸が快投'),
    item('b2', 's5', '2026-10-07 13:00', 'sports', '山本由伸が10奪三振'),
    item('c1', 's6', '2026-10-07 15:00', 'economy', '山本由伸の経済効果'),
    item('d1', 's1', '2026-10-08 01:00', 'tech', '別の話題'),
  ];
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const pick = (...ids: string[]) => ids.map((id) => byId.get(id)!);
  const clusters = [cluster(pick('a1', 'a2', 'a3', 'a4')), cluster(pick('b1', 'b2')), cluster(pick('c1')), cluster(pick('d1'))];
  const vocabulary = prepareVocabulary(['山本由伸', 'ドジャース', 'ソニー', '発表']);

  it('過ぎた日は、その日の終わりまでを数える', () => {
    const trend = buildDayTrend('2026-10-07', items, clusters, vocabulary, new Date(jst('2026-10-08 05:00')));
    expect(trend).toMatchObject({ date: '2026-10-07', until: jst('2026-10-08 00:00'), articles: 5, media: 5, topics: 2 });
    expect(trend.genres).toEqual({
      economy: { articles: 1, topics: 0, heat: 0 },
      sports: { articles: 2, topics: 1, heat: expect.any(Number) },
      tech: { articles: 2, topics: 1, heat: expect.any(Number) },
    });
    // 次の日の報道（a4）は、その日の熱さに入れない
    const techReports = reportsOf(pick('a1', 'a2', 'a3'));
    expect(trend.genres.tech.heat).toBeCloseTo(heatOf(techReports, time('2026-10-08 00:00')), 2);
    // 1件しかない言葉（ドジャース）と、注目ワードにしない言葉（発表）は残さない
    expect(trend.words).toEqual({ 山本由伸: { articles: 3, media: 3 }, ソニー: { articles: 2, media: 2 } });
    expect(Object.keys(trend.words)).toEqual(['山本由伸', 'ソニー']);
    const sony = trend.top.find((topic) => topic.id === 'a1');
    expect(sony).toEqual({
      id: 'a1',
      title: 'ソニーが新製品',
      url: 'https://example.com/a1',
      sourceId: 's1',
      category: 'tech',
      firstAt: jst('2026-10-06 23:30'),
      coverage: 3,
      added: 2,
      peak: peakWithin(techReports, time('2026-10-07 00:00'), time('2026-10-08 00:00')),
      burst: 3,
    });
    expect(trend.top.find((topic) => topic.id === 'b1')).toMatchObject({ coverage: 2, added: 2, burst: 2, category: 'sports' });
    expect(trend.top).toHaveLength(2);
    expect(isCompleteDay(trend)).toBe(true);
  });

  it('今日の分は、いまの時点までを数える', () => {
    const trend = buildDayTrend('2026-10-07', items, clusters, vocabulary, new Date(jst('2026-10-07 13:30')));
    expect(trend.until).toBe(jst('2026-10-07 13:30'));
    // 15:00 の記事（c1）はまだ数えない
    expect(trend.articles).toBe(4);
    expect(trend.words).toEqual({ 山本由伸: { articles: 2, media: 2 }, ソニー: { articles: 2, media: 2 } });
    expect(isCompleteDay(trend)).toBe(false);
  });

  it('更新日時だけが違う集計は同じとみなす', () => {
    const a = buildDayTrend('2026-10-07', items, clusters, vocabulary, new Date(jst('2026-10-08 05:00')));
    const b = buildDayTrend('2026-10-07', items, clusters, vocabulary, new Date(jst('2026-10-08 06:00')));
    expect(a.updatedAt).not.toBe(b.updatedAt);
    expect(sameDayTrend(a, b)).toBe(true);
    expect(sameDayTrend(a, { ...b, articles: 6 })).toBe(false);
  });

  it('ファイルの形を確かめる', () => {
    expect(isDayTrend(day('2026-10-07'))).toBe(true);
    expect(isDayTrend({ date: '2026-10-07' })).toBe(false);
    expect(isDayTrend(null)).toBe(false);
    expect(isDayTrend({ ...day('2026-10-07'), date: '10/7' })).toBe(false);
  });
});

describe('日ごとの集計を比べる', () => {
  it('ジャンルの変化（前の日がなければ比べない）', () => {
    const today = day('2026-10-07', { genres: { tech: { articles: 10, topics: 4, heat: 5 }, sports: { articles: 3, topics: 1, heat: 1 } } });
    const yesterday = day('2026-10-06', { genres: { tech: { articles: 8, topics: 2, heat: 3 }, news: { articles: 5, topics: 2, heat: 2 } } });
    const changes = genreChanges(today, yesterday);
    expect(changes.map((change) => change.category)).toEqual(['tech', 'sports', 'news']);
    expect(changes[0]).toEqual({ category: 'tech', today: { articles: 10, topics: 4, heat: 5 }, previous: { articles: 8, topics: 2, heat: 3 } });
    expect(changes[2]).toEqual({ category: 'news', today: { articles: 0, topics: 0, heat: 0 }, previous: { articles: 5, topics: 2, heat: 2 } });
    expect(genreChanges(today, undefined)[0].previous).toBeUndefined();
  });

  it('その日の注目ワード: 前の日々の1日あたりと比べ、増え方の大きい順', () => {
    const today = day('2026-10-07', {
      words: {
        山本由伸: { articles: 6, media: 4 },
        ドジャース: { articles: 5, media: 3 },
        INZONE: { articles: 4, media: 2 },
        'INZONE H9 II': { articles: 4, media: 2 },
        ソニー: { articles: 2, media: 2 },
        一媒体: { articles: 5, media: 1 },
      },
    });
    const before = [
      day('2026-10-06', { words: { ドジャース: { articles: 10, media: 5 } } }),
      day('2026-10-05', { words: { ドジャース: { articles: 8, media: 4 } } }),
      // その日より後の集計は比べない
      day('2026-10-08', { words: { 山本由伸: { articles: 20, media: 5 } } }),
    ];
    const words = dayWordTrends(today, before);
    expect(words.map((word) => word.word)).toEqual(['山本由伸', 'INZONE H9 II', 'ドジャース']);
    expect(words[0]).toEqual({ word: '山本由伸', articles: 6, media: 4, baseline: 0, baselineDays: 2 });
    expect(words[2].baseline).toBe(9);
    // 前の日の集計がなければ、その日の数の順
    const alone = dayWordTrends(today, []);
    expect(alone.map((word) => word.word)).toEqual(['山本由伸', 'ドジャース', 'INZONE H9 II']);
    expect(alone[0].baseline).toBeUndefined();
  });

  it('週間のまとめ: 7日分を合わせ、前の7日分と比べる', () => {
    const trends = [
      day('2026-10-07', {
        articles: 100,
        topics: 20,
        genres: { tech: { articles: 60, topics: 12, heat: 6 } },
        words: { 山本由伸: { articles: 5, media: 3 }, INZONE: { articles: 2, media: 2 } },
        top: [dayTopic('x', { coverage: 8, added: 3, peak: 70, burst: 3 })],
      }),
      day('2026-10-06', {
        articles: 80,
        topics: 10,
        genres: { tech: { articles: 40, topics: 6, heat: 3 }, sports: { articles: 20, topics: 3, heat: 2 } },
        words: { 山本由伸: { articles: 4, media: 2 }, 'INZONE H9 II': { articles: 3, media: 2 } },
        top: [dayTopic('x', { coverage: 5, added: 5, peak: 60, burst: 4 }), dayTopic('y', { coverage: 3, peak: 65 })],
      }),
      // 前の週
      day('2026-09-30', { articles: 50, topics: 6, genres: { tech: { articles: 30, topics: 4, heat: 2 } }, words: { 山本由伸: { articles: 2, media: 2 } } }),
      // 8日以上前でも14日より前は使わない
      day('2026-09-20', { articles: 999, topics: 99 }),
    ];
    const week = summarizeWeek(trends, '2026-10-07');
    expect(week.dates).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(week.days.map((entry) => entry.date)).toEqual(['2026-10-06', '2026-10-07']);
    expect(week.previousDays.map((entry) => entry.date)).toEqual(['2026-09-30']);
    expect(week.articles).toBe(180);
    expect(week.topicsPerDay).toBe(15);
    expect(week.previous).toEqual({ articles: 50, topicsPerDay: 6, days: 1 });
    // 同じトピックは1つにまとめ、いちばん大きい数字を使う（増えた媒体の数は足す）
    expect(week.topics.map((topic) => topic.id)).toEqual(['x', 'y']);
    expect(week.topics[0]).toMatchObject({ coverage: 8, added: 8, peak: 70, burst: 4 });
    expect(week.words).toEqual([
      { word: '山本由伸', articles: 9, previous: 2 },
      { word: 'INZONE H9 II', articles: 3, previous: 0 },
    ]);
    expect(week.genres).toEqual([
      { category: 'tech', articles: 100, topics: 18, previous: { articles: 30, topics: 4 } },
      { category: 'sports', articles: 20, topics: 3, previous: { articles: 0, topics: 0 } },
    ]);
    // 今日の途中の分は、1日あたりの平均に入れない
    const partial = summarizeWeek([{ ...trends[0], until: jst('2026-10-07 09:00') }, ...trends.slice(1)], '2026-10-07');
    expect(partial.topicsPerDay).toBe(10);
    expect(partial.articles).toBe(180);
    // 前の週の集計がなければ比べない
    const first = summarizeWeek(trends.slice(0, 2), '2026-10-07');
    expect(first.previous).toBeUndefined();
    expect(first.words[0].previous).toBeUndefined();
    expect(first.genres[0].previous).toBeUndefined();
  });
});

describe('いまの変化', () => {
  const NOW = time('2026-10-07 21:00');
  const words = (...labels: string[]) => prepareVocabulary(labels);
  const entry = (id: string, labels: string[], sourceId: string, hoursAgo: number): WordedEntry => ({
    id,
    words: words(...labels),
    sourceId,
    publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  });

  it('言葉の見出しの数を、直近24時間とその前の24時間で比べる', () => {
    const shifts = wordShifts(
      [
        entry('1', ['日銀', '利上げ'], 's1', 1),
        entry('2', ['日銀'], 's2', 2),
        entry('3', ['日銀'], 's2', 3),
        entry('4', ['日銀'], 's1', 30),
        entry('5', ['大谷翔平'], 's1', 30),
        entry('6', ['大谷翔平'], 's2', 40),
        // 48時間より前と、いまより後は数えない
        entry('7', ['大谷翔平'], 's1', 50),
        entry('8', ['日銀'], 's1', -1),
      ],
      NOW,
    );
    const byWord = new Map(shifts.map((shift) => [shift.word, shift]));
    expect(byWord.get('日銀')).toEqual({ word: '日銀', recent: 3, previous: 1, sources: 2 });
    expect(byWord.get('大谷翔平')).toEqual({ word: '大谷翔平', recent: 0, previous: 2, sources: 0 });
    expect(byWord.get('利上げ')).toEqual({ word: '利上げ', recent: 1, previous: 0, sources: 1 });
  });

  it('一緒に出始めた言葉: 前からある言葉どうしで、それまで一緒に出てこなかった組', () => {
    const pairs = emergingPairs(
      [
        // それまでの7日間: それぞれ単独で出ていた言葉と、すでに一緒に出ていた組
        entry('o1', ['AI'], 's1', 48),
        entry('o2', ['半導体'], 's2', 72),
        entry('o3', ['Apple', 'カメラ'], 's1', 30),
        entry('o4', ['Google'], 's3', 30),
        entry('o5', ['INZONE'], 's3', 30),
        // 直近24時間
        entry('n1', ['AI', '半導体'], 's1', 2),
        entry('n2', ['AI', '半導体'], 's2', 1),
        entry('n3', ['Apple', 'カメラ'], 's3', 2),
        entry('n4', ['Apple', 'カメラ'], 's4', 3),
        // 前は出ていなかった言葉との組は数えない
        entry('n5', ['AI', '新製品X'], 's1', 2),
        entry('n6', ['AI', '新製品X'], 's2', 3),
        // 1媒体だけの組・片方がもう片方を含む組は数えない
        entry('n7', ['AI', 'Google'], 's1', 2),
        entry('n8', ['AI', 'Google'], 's1', 3),
        entry('n9', ['INZONE', 'INZONE H9'], 's1', 2),
        entry('n10', ['INZONE', 'INZONE H9'], 's2', 3),
      ],
      NOW,
    );
    expect(pairs).toEqual([{ a: 'AI', b: '半導体', count: 2, sources: 2, ids: ['n2', 'n1'] }]);
  });

  const stats = (id: string, at: string[]) =>
    analyzeTopic(
      cluster(at.map((when, index) => item(`${id}${index}`, `s${index}`, when))),
      NOW,
    );

  it('話題が落ち着いたトピック: 24時間前には話題度が高く、新しい報道が止まって半分以下に下がった', () => {
    const many = (at: string, count: number) => Array.from({ length: count }, () => at);
    const quiet = stats('q', many('2026-10-06 20:00', 8));
    const active = stats('a', [...many('2026-10-06 20:00', 6), '2026-10-07 18:00', '2026-10-07 19:00']);
    const small = stats('s', ['2026-10-06 20:00', '2026-10-06 20:30']);
    const cooling = coolingTopics([small, active, quiet], NOW);
    expect(cooling.map((entry) => entry.topic.id)).toEqual(['q0']);
    expect(cooling[0].before).toBeGreaterThanOrEqual(40);
    expect(cooling[0].after).toBeLessThanOrEqual(cooling[0].before / 2);
    expect(cooling[0].lastAt).toBe(time('2026-10-06 20:00'));
  });

  it('新しく登場したトピック: 最初の報道が24時間以内で、3媒体以上', () => {
    const fresh = stats('f', ['2026-10-07 10:00', '2026-10-07 11:00', '2026-10-07 12:00', '2026-10-07 13:00']);
    const smaller = stats('m', ['2026-10-07 15:00', '2026-10-07 16:00', '2026-10-07 17:00']);
    const old = stats('o', ['2026-10-06 10:00', '2026-10-07 11:00', '2026-10-07 12:00', '2026-10-07 13:00']);
    const two = stats('t', ['2026-10-07 10:00', '2026-10-07 11:00']);
    expect(appearedTopics([two, old, smaller, fresh], NOW).map((topic) => topic.id)).toEqual(['f0', 'm0']);
  });
});
