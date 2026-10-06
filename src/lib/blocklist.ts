import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOCKLIST_PATH, blockReason, emptyBlocklist, parseBlocklist, type Blocklist } from './blocklist-core.ts';

let cache: Blocklist | undefined;

/** data/blocklist.json（ビルド時に1回だけ読み込む） */
export function getBlocklist(): Blocklist {
  if (!cache) {
    const path = resolve(process.cwd(), BLOCKLIST_PATH);
    cache = existsSync(path) ? parseBlocklist(readFileSync(path, 'utf8')) : emptyBlocklist();
  }
  return cache;
}

/** サイトに載せない記事か */
export function isHidden(item: { id: string; title: string; url: string }): boolean {
  return blockReason(item, getBlocklist()) !== undefined;
}
