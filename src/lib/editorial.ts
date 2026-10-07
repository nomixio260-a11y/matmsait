/**
 * 運営者のお知らせとピックアップを、ビルドのときに読む（data/notice.json・data/picks.json。管理画面から保存する）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTICE_PATH, PICKS_PATH, activeNotice, activePicks, parseNotice, parsePicks, type Notice, type EditorPick } from './editorial-core.ts';
import { builtAt, getItems } from './items.ts';
import { getSummaries } from './summaries.ts';
import type { Item } from './types.ts';

function read(path: string): string | undefined {
  const file = resolve(process.cwd(), path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

let notice: Notice | undefined | null;

/** いま載せるお知らせ（なければ undefined） */
export function getNotice(): Notice | undefined {
  if (notice === undefined) notice = activeNotice(parseNotice(read(NOTICE_PATH)), builtAt.getTime()) ?? null;
  return notice ?? undefined;
}

let picks: (EditorPick & { item: Item })[] | undefined;

/** いま載せるピックアップと、その記事（記事が一覧から消えた・非表示にしたものは除く） */
export function getPicks(): (EditorPick & { item: Item })[] {
  if (!picks) {
    const byId = new Map<string, Item>([...getSummaries(), ...getItems()].map((item) => [item.id, item]));
    picks = activePicks(parsePicks(read(PICKS_PATH)), builtAt.getTime()).flatMap((pick) => {
      const item = byId.get(pick.id);
      return item ? [{ ...pick, item }] : [];
    });
  }
  return picks;
}

/** ピックアップした記事か */
export function isPicked(id: string): boolean {
  return getPicks().some((pick) => pick.id === id);
}
