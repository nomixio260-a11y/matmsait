import { describe, expect, it } from 'vitest';
import { COPY_ARTICLE_BOOKMARKLET } from '../src/lib/bookmarklet.ts';
import { PASTE_MARKER } from '../src/lib/summary-core.ts';

describe('本文コピーのブックマークレット', () => {
  const code = decodeURIComponent(COPY_ARTICLE_BOOKMARKLET.slice('javascript:'.length));

  it('javascript: の URL で、戻り値でページが置き換わらないよう void で包む', () => {
    expect(COPY_ARTICLE_BOOKMARKLET.startsWith('javascript:')).toBe(true);
    expect(code.startsWith('void (')).toBe(true);
    // 改行や空白がそのまま URL に入らない（ブックマークに登録しても壊れない）
    expect(COPY_ARTICLE_BOOKMARKLET).not.toMatch(/[\s"<>]/);
  });

  it('管理画面が見分ける目印と同じ目印を付ける', () => {
    expect(code).toContain(JSON.stringify(PASTE_MARKER).slice(1, -1));
  });

  it('関数として読める（外の変数・関数を使っていない）', () => {
    // 構文として正しいか（実行はしない）
    expect(() => new Function(code)).not.toThrow();
  });
});
