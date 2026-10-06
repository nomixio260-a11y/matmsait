/**
 * 見出しの似ている記事（同じ話題を別のサイトが報じた記事など）を探す。
 * 日本語は単語に区切れないので、見出しの2文字の組を比べる。
 * 「試合記録」「スタメン発表」のような多くの見出しに出てくる組は軽く、珍しい組は重く数える
 */
import type { Item } from './types.ts';

/** 「記事名 - サイト名」「記事名：新聞名」「記事名（配信元）」から記事名の部分を取り出す */
export function mainTitle(title: string): string {
  return title
    .normalize('NFKC')
    .split(/\s+[-–—]\s+|\s*\|\s*/)[0]
    .replace(/\s*:[^:]{1,12}$/, '')
    .replace(/\s*\([^()]{1,30}\)$/, '');
}

/** 見出しの2文字の組（記号・空白を除き、英字は小文字にそろえる） */
export function titleGrams(title: string): Set<string> {
  const chars = Array.from(mainTitle(title).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''));
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

export interface RelatedOptions {
  /** 公開日時がこれ以上離れた記事は比べない */
  windowDays?: number;
  /** 似ている度合い（0〜1）の下限 */
  minScore?: number;
  /** 珍しい組（出てくる見出しが rareCount 件以下）をいくつ以上共有していれば同じ話題とみなすか */
  minRare?: number;
  rareCount?: number;
}

export interface RelatedIndex {
  /** target と同じ話題の記事を、似ている順に返す */
  related(target: Item, limit?: number): Item[];
}

export function buildRelatedIndex(
  items: Item[],
  { windowDays = 3, minScore = 0.3, minRare = 3, rareCount = 4 }: RelatedOptions = {},
): RelatedIndex {
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const grams = new Map(unique.map((item) => [item.id, titleGrams(item.title)]));
  const counts = new Map<string, number>();
  for (const set of grams.values()) for (const gram of set) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  const total = unique.length;
  const weight = (gram: string) => Math.log((total + 1) / ((counts.get(gram) ?? 0) + 1));
  const totalWeight = new Map([...grams].map(([id, set]) => [id, [...set].reduce((sum, gram) => sum + weight(gram), 0)]));
  const window = windowDays * 24 * 60 * 60 * 1000;

  return {
    related(target, limit = 5) {
      const mine = grams.get(target.id) ?? titleGrams(target.title);
      const mineWeight = totalWeight.get(target.id) ?? [...mine].reduce((sum, gram) => sum + weight(gram), 0);
      const time = Date.parse(target.publishedAt);
      const scored: { item: Item; score: number }[] = [];
      for (const item of unique) {
        if (item.id === target.id || Math.abs(Date.parse(item.publishedAt) - time) > window) continue;
        const theirs = grams.get(item.id)!;
        let shared = 0;
        let rare = 0;
        for (const gram of mine) {
          if (!theirs.has(gram)) continue;
          shared += weight(gram);
          if ((counts.get(gram) ?? 0) <= rareCount) rare++;
        }
        const score = (2 * shared) / (mineWeight + totalWeight.get(item.id)! || 1);
        if (score >= minScore && rare >= minRare) scored.push({ item, score });
      }
      return scored
        .sort((a, b) => b.score - a.score || b.item.publishedAt.localeCompare(a.item.publishedAt))
        .slice(0, limit)
        .map(({ item }) => item);
    },
  };
}
