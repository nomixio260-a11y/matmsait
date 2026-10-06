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
    expect(loadSources().length).toBeGreaterThan(0);
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

  it('id の重複を検出する', () => {
    expect(() => loadSources(writeYaml(valid + valid))).toThrow(/重複/);
  });

  it('未定義のカテゴリを検出する', () => {
    expect(() => loadSources(writeYaml(valid.replace('news', 'unknown')))).toThrow(/カテゴリ/);
  });
});
