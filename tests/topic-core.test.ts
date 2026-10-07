import { describe, expect, it } from 'vitest';
import { tags } from '../src/config/tags.ts';
import type { TopicCluster } from '../src/lib/related.ts';
import { tagsOf } from '../src/lib/tag-core.ts';
import {
  HOUR,
  analyzeTopic,
  durationText,
  genreTemperature,
  growthWithin,
  heatAt,
  heatOf,
  importanceOf,
  momentumOf,
  newTopics,
  normalizeWord,
  rankHot,
  rankImportant,
  rankRising,
  reportsOf,
  scoreBreakdown,
  scoreOf,
  topicIdOf,
  trendingWords,
  whyTrending,
  type TopicStats,
} from '../src/lib/topic-core.ts';
import type { Item } from '../src/lib/types.ts';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function item(id: string, sourceId: string, hours: number, category = 'tech', title = `見出し${id}`): Item {
  return { id, title, url: `https://example.com/${id}`, excerpt: '', sourceId, category, publishedAt: hoursAgo(hours) };
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

describe('話題の ID・メディアごとの最初の記事', () => {
  it('最初に報じた記事の ID を話題の ID にする（同じ時刻なら ID の小さいほう）', () => {
    expect(topicIdOf([item('b', 's1', 1), item('a', 's2', 3), item('c', 's3', 2)])).toBe('a');
    expect(topicIdOf([item('d', 's1', 3), item('c', 's2', 3)])).toBe('c');
  });

  it('メディアごとに最初の記事だけを、報じた順に並べる', () => {
    const reports = reportsOf([item('a', 's1', 1), item('b', 's1', 5), item('c', 's2', 3)]);
    expect(reports.map((report) => report.item.id)).toEqual(['b', 'c']);
    expect(reports[0].time).toBe(NOW - 5 * HOUR);
  });

  it('直近に新しく報じたメディアの数', () => {
    const reports = reportsOf([item('a', 's1', 0.5), item('b', 's2', 2), item('c', 's3', 10), item('d', 's3', 0.2)]);
    expect([1, 3, 24].map((hours) => growthWithin(reports, NOW, hours))).toEqual([1, 2, 3]);
  });
});

describe('話題度スコア', () => {
  it('報道は時間がたつと半分ずつ軽くなり、ジャンルが広いほど上乗せする', () => {
    expect(heatOf(reportsOf([item('a', 's1', 0)]), NOW)).toBeCloseTo(1);
    expect(heatOf(reportsOf([item('a', 's1', 12)]), NOW)).toBeCloseTo(0.5);
    const four = [item('a', 's1', 0), item('b', 's2', 0), item('c', 's3', 0), item('d', 's4', 0)];
    expect(heatOf(reportsOf(four), NOW)).toBeCloseTo(4);
    const mixed = [item('a', 's1', 0, 'tech'), item('b', 's2', 0, 'economy'), item('c', 's3', 0, 'news'), item('d', 's4', 0, 'tech')];
    expect(heatOf(reportsOf(mixed), NOW)).toBeCloseTo(4 * 1.4);
    // 読まれた人数は対数で少し足す（7人 → 0.5 × 3）
    expect(heatOf(reportsOf(four), NOW, { reads: 7 })).toBeCloseTo(5.5);
  });

  it('0〜100 のスコアにする（大きな話題ほど 100 に近い）', () => {
    expect(scoreOf(0)).toBe(0);
    expect(scoreOf(4)).toBe(63);
    expect(scoreOf(8)).toBe(86);
    expect(scoreOf(-1)).toBe(0);
    expect(scoreOf(1000)).toBe(100);
  });

  it('話題の数字をまとめて計算する', () => {
    const stats = analyzeTopic(cluster([item('a', 's1', 30), item('b', 's2', 2, 'game'), item('c', 's3', 0.5), item('d', 's3', 0.1)]), NOW);
    expect(stats.id).toBe('a');
    expect(stats.coverage).toBe(3);
    expect(stats.reports.map((report) => report.item.id)).toEqual(['a', 'b', 'c']);
    expect(stats.growth).toEqual({ h1: 1, h3: 2, h24: 2 });
    expect(stats.categories).toEqual(['tech', 'game']);
    expect(stats.score).toBe(scoreOf(stats.heat));
  });
});

/** ランキングのテスト用の話題（報じた時間の一覧から作る） */
function topic(id: string, hours: number[], category = 'tech', reads = 0): TopicStats {
  return analyzeTopic(
    cluster(hours.map((h, index) => item(`${id}${index}`, `${id}-s${index}`, h, category))),
    NOW,
    { reads },
  );
}

describe('話題度の内訳・急上昇の勢い・なぜ話題？', () => {
  it('話題度の内訳（新しさで重みづけした報道の数 × ジャンルの広がり ＋ 読まれた数）', () => {
    const reports = reportsOf([item('a', 's1', 0, 'tech'), item('b', 's2', 12, 'game')]);
    const breakdown = scoreBreakdown(reports, NOW, { reads: 3 });
    expect(breakdown.reports).toBe(2);
    expect(breakdown.weighted).toBeCloseTo(1.5);
    expect(breakdown.genres).toBe(2);
    expect(breakdown.spread).toBeCloseTo(1.2);
    expect(breakdown.readsBonus).toBeCloseTo(1);
    expect(breakdown.heat).toBeCloseTo(1.5 * 1.2 + 1);
    expect(breakdown.score).toBe(scoreOf(breakdown.heat));
    expect(heatOf(reports, NOW, { reads: 3 })).toBeCloseTo(breakdown.heat);
  });

  it('ある時点の熱さは、その時点までの報道だけで計算する', () => {
    const reports = reportsOf([item('a', 's1', 30), item('b', 's2', 26), item('c', 's3', 1)]);
    // 24時間前の時点では、30時間前と26時間前の報道だけ（6時間前・2時間前の扱い）
    expect(heatAt(reports, NOW - 24 * HOUR)).toBeCloseTo(0.5 ** (6 / 12) + 0.5 ** (2 / 12));
  });

  it('急上昇の勢い: 何媒体から何媒体に増えたか、その前の6時間と比べて何倍のペースか', () => {
    // 3時間より前に2媒体（そのうち1媒体が直前6時間）、直近3時間に3媒体
    const reports = reportsOf([item('a', 's1', 20), item('b', 's2', 5), item('c', 's3', 2.5), item('d', 's4', 1), item('e', 's5', 0.2)]);
    const momentum = momentumOf(reports, NOW, 3);
    expect(momentum).toMatchObject({ hours: 3, before: 2, after: 5, gained: 3, baseline: 1, baselineHours: 6 });
    // 直近は1時間に1媒体、その前は6時間に1媒体 → 6倍
    expect(momentum.ratio).toBeCloseTo(6);
    // その前に増えていなければ倍率は出さない
    expect(momentumOf(reportsOf([item('a', 's1', 2), item('b', 's2', 1)]), NOW, 3).ratio).toBeUndefined();
  });

  it('経過時間の短い表記', () => {
    expect(durationText(20 * 60_000)).toBe('20分');
    expect(durationText(3 * HOUR)).toBe('3時間');
    expect(durationText(72 * HOUR)).toBe('3日');
  });

  it('なぜ話題？は報道の状況だけを短く書く', () => {
    const name = (slug: string) => ({ tech: 'テクノロジー', game: 'ゲーム・アニメ', news: 'ニュース' })[slug];
    const burst = analyzeTopic(cluster([item('a', 's1', 2, 'tech'), item('b', 's2', 1, 'game'), item('c', 's3', 0.5, 'tech')]), NOW);
    expect(whyTrending(burst, NOW, name)).toBe('最初の報道から2時間で3媒体が報じました。「テクノロジー」「ゲーム・アニメ」の2ジャンルの媒体に広がっています。');
    const growing = analyzeTopic(cluster([item('a', 's1', 10), item('b', 's2', 2), item('c', 's3', 1)]), NOW);
    expect(whyTrending(growing, NOW, name)).toBe('直近3時間で新たに2媒体が報じ、計3媒体になりました。');
    const day = analyzeTopic(cluster([item('a', 's1', 20), item('b', 's2', 10)]), NOW);
    expect(whyTrending(day, NOW, name)).toBe('最初の報道から10時間で2媒体に広がりました。');
    // 同じ時刻に一斉に報じられたときは「1分で」ではなく「1時間以内に」
    const together = analyzeTopic(cluster([item('a', 's1', 7), item('b', 's2', 7), item('c', 's3', 6.9)]), NOW);
    expect(whyTrending(together, NOW, name)).toBe('最初の報道から1時間以内に3媒体が報じました。');
    const continued = analyzeTopic(cluster([item('a', 's1', 30), item('b', 's2', 10), item('c', 's3', 8)]), NOW);
    expect(whyTrending(continued, NOW, name)).toBe('この24時間で新たに2媒体が報じ、計3媒体になりました。');
    const old = analyzeTopic(cluster([item('a', 's1', 40), item('b', 's2', 30)]), NOW, { reads: 9 });
    expect(whyTrending(old, NOW, name)).toBe('2媒体が報じています。トピあつめでもよく読まれています。');
  });
});

describe('ニュースの温度（ジャンルごと）', () => {
  it('トピックをいちばん多く報じたジャンルに振り分け、熱さと昨日の同じ時刻の熱さを足す', () => {
    const topics = [
      analyzeTopic(cluster([item('a1', 'a-s1', 1, 'tech'), item('a2', 'a-s2', 2, 'tech'), item('a3', 'a-s3', 2, 'game')]), NOW),
      analyzeTopic(cluster([item('b1', 'b-s1', 5, 'game'), item('b2', 'b-s2', 30, 'game')]), NOW),
      analyzeTopic(cluster([item('c1', 'c-s1', 26, 'news'), item('c2', 'c-s2', 28, 'news')]), NOW),
    ];
    const genres = genreTemperature(topics, NOW);
    expect(genres.map((genre) => genre.category)).toEqual(['tech', 'game', 'news']);
    const tech = genres[0];
    expect(tech).toMatchObject({ topics: 1, previousTopics: 0, outlets: 3, rising: 1, previous: 0 });
    expect(tech.heat).toBeCloseTo(heatOf(topics[0].reports, NOW));
    const game = genres[1];
    // 30時間前の報道は、昨日の同じ時刻の熱さに入る
    expect(game.previous).toBeCloseTo(heatAt(topics[1].reports, NOW - 24 * HOUR));
    const news = genres[2];
    // 24時間より前の報道だけのトピックは、今日の数には入らない
    expect(news).toMatchObject({ topics: 0, heat: 0, previousTopics: 1 });
    expect(news.previous).toBeGreaterThan(0);
  });
});

describe('いま話題・急上昇・報じられ始めた話題', () => {
  const fresh = topic('a', [1, 1.5, 2]);
  const big = topic('b', [20, 21, 22, 23, 24, 25]);
  const growing = topic('c', [10, 2.5, 0.5]);
  const old = topic('d', [30, 31]);

  it('いま話題はスコアの高い順', () => {
    expect(rankHot([old, big, growing, fresh]).map((entry) => entry.id[0])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('急上昇は直近3時間に新しく報じたメディアの多い順', () => {
    const rising = rankRising([old, big, growing, fresh], NOW, { minTopics: 1 });
    expect(rising.hours).toBe(3);
    expect(rising.topics.map((entry) => [entry.topic.id[0], entry.gained])).toEqual([
      ['a', 3],
      ['c', 2],
    ]);
  });

  it('当てはまる話題が少なければ、集計する時間を広げる', () => {
    const rising = rankRising([old, big, topic('e', [5, 4])], NOW, { minTopics: 1 });
    expect(rising.hours).toBe(6);
    expect(rising.topics.map((entry) => entry.topic.id[0])).toEqual(['e']);
    expect(rankRising([old], NOW).topics).toEqual([]);
    expect(rankRising([old], NOW).hours).toBe(12);
  });

  it('報じられ始めた話題（最初の報道が6時間以内）', () => {
    expect(newTopics([old, big, growing, fresh, topic('e', [5, 4])], NOW).map((entry) => entry.id[0])).toEqual(['a', 'e']);
  });
});

describe('今日の注目（今日の5トピック）', () => {
  it('報じたメディアの数とジャンルの広がりの順で、1つのジャンルは決めた件数まで', () => {
    const topics = [
      topic('a', [1, 2, 3, 4, 5], 'game'),
      topic('b', [1, 2, 3, 4], 'game'),
      topic('c', [1, 2, 3], 'game'),
      topic('d', [1, 2], 'news'),
      topic('e', [40, 41, 42, 43, 44, 45], 'news'),
    ];
    const since = NOW - 24 * HOUR;
    expect(rankImportant(topics, since, { perCategory: 2 }).map((entry) => entry.id[0])).toEqual(['a', 'b', 'd']);
    expect(rankImportant(topics, since, { limit: 2 }).map((entry) => entry.id[0])).toEqual(['a', 'b']);
  });

  it('重要度は時間で減らさず、読まれた人数を少し足す', () => {
    expect(importanceOf(topic('a', [1, 2]))).toBe(2);
    expect(importanceOf(topic('a', [40, 41]))).toBe(2);
    expect(importanceOf(topic('a', [1, 2], 'tech', 3))).toBeCloseTo(3);
  });
});

describe('注目ワード', () => {
  const entry = (title: string, sourceId: string, hours: number) => ({ title, sourceId, publishedAt: hoursAgo(hours) });

  it('直近の見出しに急に増えた言葉を、候補の言葉の中から選ぶ', () => {
    const entries = [
      entry('山本由伸が10奪三振', 'a', 1),
      entry('山本由伸、PS5連勝', 'b', 2),
      entry('ドジャースの山本由伸が快投', 'c', 3),
      entry('ドジャース、地区シリーズ突破に王手', 'a', 4),
      entry('ドジャースが勝利', 'b', 5),
      ...Array.from({ length: 12 }, (_, index) => entry(`ドジャースの試合${index}`, 'c', 30 + index)),
      entry('ソニーの新製品', 'a', 1),
      entry('ソニーが発表', 'a', 2),
      entry('新型の発表', 'b', 1),
      entry('新型を発表', 'c', 2),
    ];
    const words = trendingWords(entries, ['山本由伸', 'ドジャース', 'ソニー', '新型', '10月15日', '山本'], NOW);
    expect(words.map((word) => word.word)).toEqual(['山本由伸', 'ドジャース']);
    expect(words[0]).toMatchObject({ count: 3, sources: 3, baseline: 0, score: 3 });
    expect(words[1].baseline).toBeCloseTo(12 / 6);
  });

  it('言葉の比べ方（全角・半角、大文字・小文字、カタカナ・ひらがな）', () => {
    expect(normalizeWord('ＩＮＺＯＮＥ  H9')).toBe('inzone h9');
    expect(normalizeWord('ソニー')).toBe(normalizeWord('そにー'));
  });
});

describe('タグ', () => {
  const tagNames = (title: string, category = 'tech', keywords: string[] = []) =>
    tagsOf({ title, category }, keywords, tags).map((tag) => tag.slug);

  it('見出しとキーワードからタグを付ける', () => {
    expect(tagNames('OpenAIが新しい生成AIモデルを発表')).toContain('ai');
    expect(tagNames('ChatGPTに新機能')).toContain('ai');
    expect(tagNames('新製品の発表会', 'tech', ['Claude'])).toContain('ai');
    expect(tagNames('不正アクセスで情報漏えい')).toEqual(['security']);
  });

  it('英字の単語の一部やジャンルの違う記事には付けない', () => {
    expect(tagNames('MAILの新しい使い方')).not.toContain('ai');
    expect(tagNames('AIRの新モデル')).not.toContain('ai');
    expect(tagNames('山本由伸がPS5連勝', 'sports')).not.toContain('playstation');
    expect(tagNames('山本由伸がPS5連勝', 'sports')).toContain('mlb');
    expect(tagNames('インテルがセリエAで勝利', 'sports')).not.toContain('semiconductor');
    expect(tagNames('台風の目になるチーム', 'sports')).not.toContain('disaster');
  });
});
