/**
 * トピックのまとめ方の手直し（運営者が管理画面で行う統合・分割）。管理画面・サイトのビルド・日別まとめで共通。
 * - 分割: ある記事を、そのとき同じトピックだった記事とまとめない（別の出来事の記事が混ざったとき）
 * - 統合: 2つの記事を同じトピックにする（同じ出来事なのに見出しの言い回しが違ってまとまらなかったとき）
 * 記事の ID で保存するので、トピックの ID（最初の記事の ID）が変わっても効き続ける
 */

export const TOPIC_OVERRIDES_PATH = 'data/topic-overrides.json';

export interface TopicSplit {
  /** トピックから外す記事 */
  id: string;
  /** そのとき同じトピックだった記事（これらとはまとめない） */
  from: string[];
  /** 外した記事の見出し（管理画面の表示用） */
  title?: string;
  at: string;
}

export interface TopicMerge {
  /** 同じトピックにする2つの記事（それぞれのトピックの最初の記事） */
  ids: [string, string];
  /** 管理画面の表示用 */
  titles?: [string, string];
  at: string;
}

export interface TopicOverrides {
  splits: TopicSplit[];
  merges: TopicMerge[];
}

export const emptyOverrides = (): TopicOverrides => ({ splits: [], merges: [] });

const isId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,64}$/.test(value);

/** ファイルを読む。空・なければ空の設定、形が壊れていればエラー（上書きして消さないため） */
export function parseTopicOverrides(text: string | null | undefined): TopicOverrides {
  if (!text || !text.trim()) return emptyOverrides();
  const data = JSON.parse(text) as Partial<TopicOverrides>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('トピックの手直しのファイルの形式が正しくありません');
  const splits = (Array.isArray(data.splits) ? data.splits : []).filter(
    (split): split is TopicSplit => isId(split?.id) && Array.isArray(split.from) && split.from.every(isId) && typeof split.at === 'string',
  );
  const merges = (Array.isArray(data.merges) ? data.merges : []).filter(
    (merge): merge is TopicMerge => Array.isArray(merge?.ids) && merge.ids.length === 2 && merge.ids.every(isId) && merge.ids[0] !== merge.ids[1] && typeof merge.at === 'string',
  );
  return { splits, merges };
}

export function serializeTopicOverrides(overrides: TopicOverrides): string {
  return `${JSON.stringify(overrides, null, 1)}\n`;
}

/** 分割を足す（同じ記事の前の分割は置き換える） */
export function addSplit(overrides: TopicOverrides, split: TopicSplit): TopicOverrides {
  // 同じ2つの記事を統合していたら、その統合はやめる（最後の操作を優先）
  const from = new Set(split.from);
  return {
    splits: [...overrides.splits.filter((other) => other.id !== split.id), split],
    merges: overrides.merges.filter((merge) => !(merge.ids.includes(split.id) && merge.ids.some((id) => from.has(id)))),
  };
}

/** 統合を足す（同じ組の統合は置き換え、その2つの記事を分けていた分割はやめる） */
export function addMerge(overrides: TopicOverrides, merge: TopicMerge): TopicOverrides {
  const [a, b] = merge.ids;
  const same = (other: TopicMerge) => other.ids.includes(a) && other.ids.includes(b);
  return {
    splits: overrides.splits.filter((split) => !((split.id === a && split.from.includes(b)) || (split.id === b && split.from.includes(a)))),
    merges: [...overrides.merges.filter((other) => !same(other)), merge],
  };
}

/** 取り消す（分割は記事の ID、統合は2つの記事の ID で） */
export function removeSplit(overrides: TopicOverrides, id: string): TopicOverrides {
  return { ...overrides, splits: overrides.splits.filter((split) => split.id !== id) };
}

export function removeMerge(overrides: TopicOverrides, ids: readonly string[]): TopicOverrides {
  return { ...overrides, merges: overrides.merges.filter((merge) => !(merge.ids.includes(ids[0]) && merge.ids.includes(ids[1]))) };
}

/** まとめ方（clusterTopics）に渡す制約: 必ずまとめる組と、まとめない組 */
export function overrideLinks(overrides: TopicOverrides): { mustLink: [string, string][]; cannotLink: [string, string][] } {
  return {
    mustLink: overrides.merges.map((merge) => [merge.ids[0], merge.ids[1]]),
    cannotLink: overrides.splits.flatMap((split) => split.from.filter((other) => other !== split.id).map((other) => [split.id, other] as [string, string])),
  };
}
