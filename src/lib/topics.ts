import { getItems } from './items.ts';
import { buildRelatedIndex, type RelatedIndex } from './related.ts';
import { getSummaries } from './summaries.ts';

let index: RelatedIndex | undefined;

/** 掲載中の記事と要約から作った「同じ話題」の索引（ビルド中は1回だけ作る） */
export function getRelatedIndex(): RelatedIndex {
  index ??= buildRelatedIndex([...getItems(), ...getSummaries()]);
  return index;
}
