// AI 要約をコマンドラインで扱う（管理画面と同じ処理）
//
//   npm run summaries -- prompt [--count 20] [--category tech] [--sort popular|latest]
//                               [--length short|normal|long] [--no-points] [--out prompt.txt]
//       要約のない記事からプロンプトを作る（--out がなければ画面に出す）
//
//   npm run summaries -- import <AIの回答.json> [--dry-run] [--skip-existing]
//       AI の回答（または管理画面の「保存用JSON」）を検証して data/summaries/ に保存する
//       --skip-existing: すでに要約がある記事は上書きしない（自動要約の取り込みで使う）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { site } from '../src/config/site.ts';
import { allowsSummary, getItems, siteOf } from '../src/lib/items.ts';
import { coverageOf } from '../src/lib/topics.ts';
import {
  buildSummaryPrompt,
  extractJson,
  groupByFile,
  mergeSummaryRecords,
  normalizeEntries,
  parseSummaryFile,
  serializeSummaryFile,
  SUMMARY_LENGTHS,
  toSummaryRecord,
  validateEntries,
  type SummaryLength,
} from '../src/lib/summary-core.ts';
import { getSummaries, getSummary } from '../src/lib/summaries.ts';
import type { Item } from '../src/lib/types.ts';

function promptCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      count: { type: 'string', default: '20' },
      category: { type: 'string' },
      sort: { type: 'string', default: 'popular' },
      length: { type: 'string', default: 'normal' },
      'no-points': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const length = values.length as SummaryLength;
  if (!(length in SUMMARY_LENGTHS)) throw new Error(`--length は short / normal / long のいずれかです`);
  // 要約を載せられる掲載元の記事だけ。popular は多くの掲載元が報じた話題の順
  const pending = getItems()
    .filter((item) => !getSummary(item.id) && allowsSummary(item) && (!values.category || item.category === values.category))
    .sort((a, b) =>
      values.sort === 'latest'
        ? b.publishedAt.localeCompare(a.publishedAt)
        : coverageOf(b.id) - coverageOf(a.id) || b.publishedAt.localeCompare(a.publishedAt),
    );
  const batch = pending.slice(0, Number(values.count));
  if (batch.length === 0) {
    console.error('要約待ちの記事はありません');
    return;
  }
  const prompt = buildSummaryPrompt(
    batch.map((item) => ({ id: item.id, title: item.title, url: item.url, site: siteOf(item).label, excerpt: item.excerpt })),
    { siteName: site.name, length, points: !values['no-points'] },
  );
  if (values.out) {
    writeFileSync(values.out, `${prompt}\n`);
    console.error(`${batch.length}件のプロンプトを ${values.out} に保存しました（要約待ち ${pending.length}件）`);
  } else {
    console.log(prompt);
  }
}

function importCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'skip-existing': { type: 'boolean', default: false },
    },
  });
  const file = positionals[0];
  if (!file) throw new Error('取り込む JSON ファイルを指定してください');
  const raw = extractJson(readFileSync(file, 'utf8'));
  const entries = normalizeEntries(raw);

  // 記事情報は回答ではなくサイトのデータから取る（管理画面の保存用JSONなら、それ自体の記事情報も使える）
  const articles = new Map<string, Item>(getItems().map((item) => [item.id, item]));
  for (const record of getSummaries()) if (!articles.has(record.id)) articles.set(record.id, record);
  if (Array.isArray(raw)) {
    for (const record of raw as Partial<Item>[]) {
      if (record?.id && record.title && record.url && record.publishedAt && record.sourceId && record.category) {
        if (!articles.has(record.id)) articles.set(record.id, { excerpt: '', ...record } as Item);
      }
    }
  }

  const result = validateEntries(entries, (id) => (articles.has(id) ? { summarized: Boolean(getSummary(id)) } : undefined));
  if (values['skip-existing']) {
    for (const accepted of result.accepted.filter((entry) => entry.replaces)) {
      result.skipped.push({ id: accepted.id, reason: 'すでに要約があるため上書きしません' });
    }
    result.accepted = result.accepted.filter((entry) => !entry.replaces);
  }
  for (const issue of result.errors) console.error(`エラー  ${issue.id}: ${issue.reason}`);
  for (const issue of result.skipped) console.error(`見送り  ${issue.id}: ${issue.reason}`);

  const now = new Date();
  const records = result.accepted.map((accepted) => toSummaryRecord(articles.get(accepted.id)!, accepted, now));
  for (const [path, group] of groupByFile(records)) {
    const absolute = resolve(process.cwd(), path);
    const current = parseSummaryFile(existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
    const merged = mergeSummaryRecords(current, group);
    if (!values['dry-run']) {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, serializeSummaryFile(merged));
    }
    console.error(`${values['dry-run'] ? '（確認のみ）' : ''}${path}: ${group.length}件を保存（合計 ${merged.length}件）`);
  }
  console.error(`保存 ${records.length}件 ・ 見送り ${result.skipped.length}件 ・ エラー ${result.errors.length}件`);
  if (result.errors.length > 0) process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'prompt') promptCommand(rest);
  else if (command === 'import') importCommand(rest);
  else {
    console.error('使い方: npm run summaries -- prompt [...] / npm run summaries -- import <file>');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
