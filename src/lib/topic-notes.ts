/**
 * AI 整理（data/topic-notes/YYYY-MM.json）をビルドのときに読み、トピックに結び付ける。
 * 出典は、いまのトピックの記事のうちサイトに載せてよい記事（非表示でなく、要約を禁じていない掲載元）だけを残す
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isHidden } from './blocklist.ts';
import { allowsSummary } from './items.ts';
import { TOPIC_NOTES_DIR, matchTopicNote, parseTopicNoteFile, type Emphasis, type SourcedText, type TopicNote } from './topic-notes-core.ts';
import type { Item } from './types.ts';

const NOTES_DIR = resolve(process.cwd(), TOPIC_NOTES_DIR);

let cache: TopicNote[] | undefined;

/** 保存されているすべての AI 整理（整理した日時の新しい順） */
export function getAllTopicNotes(): TopicNote[] {
  if (!cache) {
    const files = existsSync(NOTES_DIR) ? readdirSync(NOTES_DIR).filter((file) => /^\d{4}-\d{2}\.json$/.test(file)) : [];
    cache = files
      .flatMap((file) => {
        try {
          return parseTopicNoteFile(readFileSync(resolve(NOTES_DIR, file), 'utf8'));
        } catch {
          // 壊れたファイルはビルドを止めずに読み飛ばす（管理画面での上書きは parseTopicNoteFile がエラーにして防ぐ）
          return [];
        }
      })
      .sort((a, b) => b.notedAt.localeCompare(a.notedAt));
  }
  return cache;
}

/** サイトに出す AI 整理（出典をいまのトピックの記事に絞ったもの） */
export interface TopicNoteView {
  note: TopicNote;
  common: SourcedText[];
  emphasis: Emphasis[];
  differences: SourcedText[];
  /** 出典の記事（ID → 記事） */
  sources: Map<string, Item>;
  /** 整理したあとに加わった記事の数 */
  newer: number;
}

/** トピックの記事に当てはまる AI 整理（なければ undefined） */
export function topicNoteFor(items: readonly Item[]): TopicNoteView | undefined {
  const note = matchTopicNote(
    getAllTopicNotes(),
    items.map((item) => item.id),
  );
  if (!note) return undefined;
  const usable = new Map(items.filter((item) => !isHidden(item) && allowsSummary(item)).map((item) => [item.id, item]));
  const keep = (entry: SourcedText, min: number) => {
    const sources = entry.sources.filter((id) => usable.has(id));
    return sources.length >= min ? [{ ...entry, sources }] : [];
  };
  const common = note.common.flatMap((entry) => keep(entry, 2));
  if (common.length === 0) return undefined;
  const noted = new Set(note.items);
  return {
    note,
    common,
    emphasis: note.emphasis.filter((entry) => usable.has(entry.source)),
    differences: note.differences.flatMap((entry) => keep(entry, 2)),
    sources: usable,
    newer: items.filter((item) => !noted.has(item.id)).length,
  };
}
