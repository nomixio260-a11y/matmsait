import { normalizeText, type TopicEntry, type WordEntry } from '../lib/search-core.ts';
import { getTopicViews } from '../lib/topics.ts';
import { getWordViews } from '../lib/words.ts';

/**
 * 検索ページ用の小さな索引: トピック（2媒体以上）とキーワードのページ。
 * 検索ページを開いたらすぐ読み、記事の索引（search-index.json。大きい）は検索したときに読む
 */
export function GET() {
  const topics: TopicEntry[] = getTopicViews().map((view) => ({
    i: view.id,
    t: view.lead.title,
    // どの記事の見出しで探しても見つかるように、トピックのすべての見出しを正規化してつなぐ
    w: [...new Set(view.items.map((item) => normalizeText(item.title)))].join(' '),
    v: view.coverage,
    sc: view.score,
    g: view.growth.h3,
    d: view.latestAt,
    c: view.categories[0] ?? view.lead.category,
  }));
  const words: WordEntry[] = getWordViews().map((view) => ({ w: view.word, s: view.slug, n: view.items.length }));
  return new Response(JSON.stringify({ topics, words }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
