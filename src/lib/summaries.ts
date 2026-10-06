import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSummaryFile } from './summary-core.ts';
import type { SummaryRecord } from './types.ts';

// Astro のビルド後はモジュールの位置が変わるため、プロジェクトルート基準で解決する
const SUMMARIES_DIR = resolve(process.cwd(), 'data/summaries');

let cache: Map<string, SummaryRecord> | undefined;

function load(): Map<string, SummaryRecord> {
  if (!cache) {
    const files = existsSync(SUMMARIES_DIR)
      ? readdirSync(SUMMARIES_DIR).filter((file) => /^\d{4}-\d{2}\.json$/.test(file))
      : [];
    cache = new Map(
      files.flatMap((file) =>
        parseSummaryFile(readFileSync(resolve(SUMMARIES_DIR, file), 'utf8')).map((record) => [record.id, record]),
      ),
    );
  }
  return cache;
}

/** 要約つきの記事を、要約した日時の新しい順で返す */
export function getSummaries(): SummaryRecord[] {
  return [...load().values()].sort(
    (a, b) => b.summarizedAt.localeCompare(a.summarizedAt) || b.publishedAt.localeCompare(a.publishedAt),
  );
}

export function getSummary(id: string): SummaryRecord | undefined {
  return load().get(id);
}

export function summaryPath(id: string): string {
  return `/summary/${id}/`;
}
