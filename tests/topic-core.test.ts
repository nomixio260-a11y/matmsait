import { describe, expect, it } from 'vitest';
import { tags } from '../src/config/tags.ts';
import type { TopicCluster } from '../src/lib/related.ts';
import { tagsOf } from '../src/lib/tag-core.ts';
import {
  HOUR,
  analyzeTopic,
  growthWithin,
  heatOf,
  importanceOf,
  newTopics,
  normalizeWord,
  rankHot,
  rankImportant,
  rankRising,
  reportsOf,
  scoreOf,
  topicIdOf,
  trendingWords,
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

describe('今日の重要ニュース', () => {
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
