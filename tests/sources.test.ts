import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSources } from '../src/lib/sources.ts';

function writeYaml(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sources-')), 'sources.yaml');
  writeFileSync(path, content);
  return path;
}

const valid = `
- id: example
  name: Example
  feedUrl: https://example.com/feed
  siteUrl: https://example.com/
  category: news
`;

describe('loadSources', () => {
  it('リポジトリの sources.yaml が正しく読み込める', () => {
    const sources = loadSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((source) => source.aggregator)).toBe(true);
  });

  it('正しい定義を読み込む', () => {
    expect(loadSources(writeYaml(valid))).toEqual([
      {
        id: 'example',
        name: 'Example',
        feedUrl: 'https://example.com/feed',
        siteUrl: 'https://example.com/',
        category: 'news',
      },
    ]);
  });

  it('任意項目（aggregator / stripTitle）を読み込む', () => {
    const [source] = loadSources(writeYaml(`${valid}  aggregator: true\n  stripTitle: '^\\[PR\\]'\n`));
    expect(source.aggregator).toBe(true);
    expect(source.stripTitle).toBe('^\\[PR\\]');
  });

  it('id の重複を検出する', () => {
    expect(() => loadSources(writeYaml(valid + valid))).toThrow(/重複/);
  });

  it('未定義のカテゴリを検出する', () => {
    expect(() => loadSources(writeYaml(valid.replace('news', 'unknown')))).toThrow(/カテゴリ/);
  });

  it('不正な正規表現を検出する', () => {
    expect(() => loadSources(writeYaml(`${valid}  stripTitle: '('\n`))).toThrow(/正規表現/);
  });
});
