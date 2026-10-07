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

/** 同じ話題（同じ出来事）を報じた記事のまとまり */
export interface TopicCluster {
  /** 同じ話題の記事（新しい順） */
  items: Item[];
  /** 報じた掲載元の数（同じ掲載元の記事は1と数える） */
  coverage: number;
  /** 最初に報じられた日時（ISO 8601） */
  firstAt: string;
  /** 最後に報じられた日時（ISO 8601） */
  latestAt: string;
}

export interface ClusterOptions {
  /** 公開日時がこれ以上離れた記事はまとめない */
  windowHours?: number;
  /** 似ている度合い（0〜1）の下限 */
  minScore?: number;
  /** 珍しい組をいくつ以上共有していれば候補にするか */
  minShared?: number;
  /** 珍しい組とみなす出現数の割合（記事数に対する比。少なくとも minRareCount 件までは珍しいとみなす） */
  rareRatio?: number;
  minRareCount?: number;
  /** 必ず同じトピックにする記事の ID の組（運営者の統合。src/lib/topic-overrides-core.ts） */
  mustLink?: readonly (readonly [string, string])[];
  /** 同じトピックにしない記事の ID の組（運営者の分割） */
  cannotLink?: readonly (readonly [string, string])[];
  /**
   * 2段目のまとめ方: かぎかっこの中の名前（製品名・作品名など）が同じで、近い時刻に、見出しもある程度似ている別の掲載元の記事をまとめる。
   * false で使わない
   */
  quoteMerge?: false | QuoteMergeOptions;
}

export interface QuoteMergeOptions {
  /** 公開日時の差の上限（時間） */
  maxGapHours?: number;
  /** 見出しの似かた（1段目と同じ計算）の下限 */
  minScore?: number;
  /** その名前を見出しに含む記事（前後 maxGapHours 時間）がこれより多ければ、ありふれた名前とみなしてまとめない */
  maxItems?: number;
}

/** かぎかっこ（「」『』“”""）の中の名前（3〜40文字。比べやすい形にして重複を除く） */
export function quotedNames(title: string): string[] {
  const names = [...mainTitle(title).normalize('NFKC').matchAll(/「([^「」]{3,40})」|『([^『』]{3,40})』|“([^“”]{3,40})”|"([^"]{3,40})"/g)].map((match) =>
    compactKey(match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''),
  );
  return [...new Set(names)].filter((name) => Array.from(name).length >= 3);
}

/** 名前の比べ方（大文字・小文字と空白の違いを無視） */
function compactKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * 別々の掲載元が同じ出来事を報じた記事をまとめる（「◯媒体が報道」の数に使う）。
 * 見出しの2文字の組のうち珍しいものを共有する記事どうしだけを比べるので、記事が多くても速い。
 * 同じ掲載元の記事どうしはつながない（「〜を開催しました」のような定型の見出しで別の話題がまとまらないように）
 */
export function clusterTopics(
  items: Item[],
  {
    windowHours = 48,
    minScore = 0.33,
    minShared = 2,
    rareRatio = 0.003,
    minRareCount = 5,
    mustLink = [],
    cannotLink = [],
    quoteMerge = {},
  }: ClusterOptions = {},
): TopicCluster[] {
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const total = unique.length;
  const grams = unique.map((item) => titleGrams(item.title));
  const counts = new Map<string, number>();
  for (const set of grams) for (const gram of set) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  const weight = (gram: string) => Math.log((total + 1) / ((counts.get(gram) ?? 0) + 1));
  const totalWeight = grams.map((set) => [...set].reduce((sum, gram) => sum + weight(gram), 0));
  const rareMax = Math.max(minRareCount, Math.round(total * rareRatio));

  // 珍しい組 → その組を含む記事の番号
  const postings = new Map<string, number[]>();
  grams.forEach((set, index) => {
    for (const gram of set) {
      if ((counts.get(gram) ?? 0) > rareMax) continue;
      const list = postings.get(gram);
      if (list) list.push(index);
      else postings.set(gram, [index]);
    }
  });

  // 珍しい組を共有する記事の組ごとに、共有している数を数える
  const shared = new Map<number, number>();
  for (const list of postings.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const key = list[a] * total + list[b];
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }

  const parent = unique.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  // 運営者の分割: まとめてはいけない記事の組。まとまりごとに、制約のある記事だけを覚えておいて調べる
  const indexById = new Map(unique.map((item, index) => [item.id, index]));
  const forbidden = new Map<number, Set<number>>();
  for (const [a, b] of cannotLink) {
    const ia = indexById.get(a);
    const ib = indexById.get(b);
    if (ia === undefined || ib === undefined || ia === ib) continue;
    forbidden.set(ia, (forbidden.get(ia) ?? new Set()).add(ib));
    forbidden.set(ib, (forbidden.get(ib) ?? new Set()).add(ia));
  }
  const constrained = new Map<number, number[]>([...forbidden.keys()].map((index) => [index, [index]]));
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) return;
    const mi = constrained.get(ri);
    const mj = constrained.get(rj);
    if (mi && mj && mi.some((a) => mj.some((b) => forbidden.get(a)?.has(b)))) return;
    parent[ri] = rj;
    if (mi) {
      constrained.set(rj, [...(mj ?? []), ...mi]);
      constrained.delete(ri);
    }
  };
  // 運営者の統合を先に（時間や見出しの似かたにかかわらずまとめる）
  for (const [a, b] of mustLink) {
    const ia = indexById.get(a);
    const ib = indexById.get(b);
    if (ia !== undefined && ib !== undefined) union(ia, ib);
  }
  const times = unique.map((item) => Date.parse(item.publishedAt));
  const window = windowHours * 60 * 60 * 1000;
  const similarity = (i: number, j: number) => {
    let both = 0;
    for (const gram of grams[i]) if (grams[j].has(gram)) both += weight(gram);
    return (2 * both) / (totalWeight[i] + totalWeight[j] || 1);
  };
  for (const [key, count] of shared) {
    if (count < minShared) continue;
    const i = Math.floor(key / total);
    const j = key % total;
    if (unique[i].sourceId === unique[j].sourceId || Math.abs(times[i] - times[j]) > window) continue;
    if (similarity(i, j) < minScore) continue;
    union(i, j);
  }

  // 2段目: 見出しの言い回しが大きく違ってまとまらなかった報道を、かぎかっこの中の名前で拾う。
  // 名前だけでは同じ製品の別の話題（発売とレビューなど）までまとめてしまうので、近い時刻・見出しの似かたの条件も付ける
  // （2026-10-08 に本番のデータで、この条件でまとまる組がすべて同じ出来事であることを確かめた。docs/DEVLOG.md）
  if (quoteMerge) {
    const { maxGapHours = 6, minScore: quoteMinScore = 0.3, maxItems = 8 } = quoteMerge;
    const gap = maxGapHours * 60 * 60 * 1000;
    const keys = unique.map((item) => compactKey(mainTitle(item.title)));
    const order = unique.map((_, index) => index).sort((a, b) => times[a] - times[b]);
    const position = new Map(order.map((index, pos) => [index, pos]));
    unique.forEach((item, i) => {
      for (const name of quotedNames(item.title)) {
        // 前後 gap の記事のうち、見出しにその名前を含むもの（かっこなしで書いた記事も）
        const holders: number[] = [];
        const pos = position.get(i)!;
        for (let p = pos - 1; p >= 0 && times[i] - times[order[p]] <= gap; p--) if (keys[order[p]].includes(name)) holders.push(order[p]);
        for (let p = pos + 1; p < order.length && times[order[p]] - times[i] <= gap; p++) if (keys[order[p]].includes(name)) holders.push(order[p]);
        if (holders.length + 1 > maxItems) continue;
        for (const j of holders) {
          if (unique[j].sourceId === item.sourceId || find(i) === find(j)) continue;
          if (similarity(i, j) >= quoteMinScore) union(i, j);
        }
      }
    });
  }

  const groups = new Map<number, Item[]>();
  unique.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(item);
    else groups.set(root, [item]);
  });
  return [...groups.values()].map((group) => {
    const sorted = group.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return {
      items: sorted,
      coverage: new Set(sorted.map((item) => item.sourceId)).size,
      firstAt: sorted[sorted.length - 1].publishedAt,
      latestAt: sorted[0].publishedAt,
    };
  });
}

/** 記事に話題度（同じ話題を報じた掲載元の数。2以上のときだけ）を付けたコピーを返す */
export function withCoverage(items: Item[], options?: ClusterOptions): Item[] {
  const coverage = new Map<string, number>();
  for (const cluster of clusterTopics(items, options)) {
    if (cluster.coverage < 2) continue;
    for (const item of cluster.items) coverage.set(item.id, cluster.coverage);
  }
  return items.map((item) => {
    const value = coverage.get(item.id);
    if (value) return { ...item, coverage: value };
    if (item.coverage === undefined) return item;
    const { coverage: _, ...rest } = item;
    return rest;
  });
}
