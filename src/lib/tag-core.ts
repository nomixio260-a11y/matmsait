/**
 * タグ（src/config/tags.ts）の当てはめ。Node 専用の機能は使わない
 */
import { tags, type TagDefinition } from '../config/tags.ts';
import type { Item } from './types.ts';

/** 見出しと AI 要約のキーワードから、記事に当てはまるタグを返す（タグごとに決めたジャンルの記事だけ） */
export function tagsOf(
  item: Pick<Item, 'title' | 'category'>,
  keywords: readonly string[] = [],
  definitions: readonly TagDefinition[] = tags,
): TagDefinition[] {
  const text = [item.title, ...keywords].join(' ').normalize('NFKC');
  return definitions.filter((tag) => (!tag.categories || tag.categories.includes(item.category)) && tag.pattern.test(text));
}
