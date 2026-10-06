import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TEXT_REQUESTS_PATH,
  TEXTS_PATH,
  parseJsonList,
  pickRequests,
  pickResults,
} from '../../lib/article-texts.ts';

const read = (file: string) => {
  const path = resolve(process.cwd(), file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

/**
 * 管理画面用: 本文の自動取得の依頼と結果。
 * 本文は運営者の公開鍵で暗号化してあり、運営者の秘密鍵（運営者のブラウザにだけある）がなければ読めない
 */
export function GET() {
  const body = {
    requests: parseJsonList(read(TEXT_REQUESTS_PATH), pickRequests),
    items: parseJsonList(read(TEXTS_PATH), pickResults),
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
