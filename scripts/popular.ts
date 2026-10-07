/**
 * よく読まれている記事をアクセス解析のサーバーから取ってきて data/popular.json に保存する（自動更新のたびに実行）。
 * 接続先（PUBLIC_ANALYTICS_URL）が設定されていなければ何もしない。サイトと同じドメインのパス（/api）のときは、
 * 公開先の URL（SITE_URL）につなげて読む。取ってこられなかったときは前回の内容のまま（サイトの更新は止めない）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POPULAR_PATH, analyticsEndpoint } from '../src/lib/analytics-config.ts';
import { parsePopularFile, type PopularFile } from '../src/lib/popular.ts';

const endpoint = analyticsEndpoint();
const site = process.env.SITE_URL?.replace(/\/+$/, '') ?? '';
if (!endpoint || (endpoint.startsWith('/') && !/^https?:\/\//.test(site))) {
  console.log('アクセス解析の接続先が設定されていないため、よく読まれている記事は取得しません');
  process.exit(0);
}
const popularUrl = endpoint.startsWith('/') ? `${site}${endpoint}/popular` : `${endpoint}/popular`;

const path = resolve(process.cwd(), POPULAR_PATH);
try {
  const res = await fetch(popularUrl, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { generatedAt?: unknown; day?: unknown; week?: unknown };
  const fetched = parsePopularFile(JSON.stringify({ updatedAt: data.generatedAt, day: data.day, week: data.week }));
  if (!fetched) throw new Error('サーバーの応答の形が正しくありません');
  const current = existsSync(path) ? parsePopularFile(readFileSync(path, 'utf8')) : undefined;
  const same = (a: PopularFile | undefined, b: PopularFile) => JSON.stringify([a?.day, a?.week]) === JSON.stringify([b.day, b.week]);
  // 順位が変わっていなければ書かない（毎回コミットしないように）
  if (same(current, fetched)) {
    console.log('よく読まれている記事: 変わりなし');
  } else {
    // 1行1件で書く（差分を読みやすくする）
    const list = (entries: PopularFile['day']) => entries.map((entry) => JSON.stringify(entry)).join(',\n');
    writeFileSync(
      path,
      `{\n"updatedAt": ${JSON.stringify(fetched.updatedAt)},\n"day": [\n${list(fetched.day)}\n],\n"week": [\n${list(fetched.week)}\n]\n}\n`,
    );
    console.log(`よく読まれている記事: 24時間 ${fetched.day.length}件・1週間 ${fetched.week.length}件`);
  }
} catch (error) {
  console.warn(`よく読まれている記事を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`);
}
