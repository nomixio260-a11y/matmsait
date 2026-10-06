import { describe, expect, it } from 'vitest';
import { blockReason, normalizeHost, parseBlocklist, serializeBlocklist } from '../src/lib/blocklist-core.ts';

const article = (title: string, url = 'https://news.example.com/a', id = 'abc') => ({ id, title, url });

describe('parseBlocklist / serializeBlocklist', () => {
  it('空・未作成なら空の設定', () => {
    expect(parseBlocklist(null)).toEqual({ words: [], hosts: [], ids: [] });
    expect(parseBlocklist('')).toEqual({ words: [], hosts: [], ids: [] });
  });

  it('重複・空行を除いて並べ、サイトはホスト名にそろえる', () => {
    const list = parseBlocklist(
      JSON.stringify({ words: ['b', ' a ', '', 'b', 1], hosts: ['https://www.Example.com/path', 'sub.example.org'], ids: ['x', 'x'] }),
    );
    expect(list).toEqual({ words: ['a', 'b'], hosts: ['example.com', 'sub.example.org'], ids: ['x'] });
    expect(parseBlocklist(serializeBlocklist(list))).toEqual(list);
  });

  it('壊れたファイルは上書きしないようエラーにする', () => {
    expect(() => parseBlocklist('{')).toThrow('JSON');
  });
});

describe('normalizeHost', () => {
  it('URL やサブドメインつきの書き方をホスト名にする', () => {
    expect(normalizeHost('https://www.example.com/news/1')).toBe('example.com');
    expect(normalizeHost('Example.com')).toBe('example.com');
    expect(normalizeHost('  ')).toBe('');
    expect(normalizeHost('not a host!!')).toBe('');
    expect(normalizeHost('localhost')).toBe('');
    expect(normalizeHost('日本語.jp')).toBe('xn--wgv71a119e.jp');
  });
});

describe('blockReason', () => {
  const list = { words: ['ＮＧ語', 'adult'], hosts: ['example.com'], ids: ['hidden1'] };

  it('個別の記事・NGワード・サイトで非表示にする', () => {
    expect(blockReason(article('ふつうの見出し', 'https://ok.jp/', 'hidden1'), list)).toBe('個別に非表示');
    // 全角・半角、大文字・小文字は区別しない
    expect(blockReason(article('ng語を含む見出し', 'https://ok.jp/'), list)).toBe('NGワード「ＮＧ語」');
    expect(blockReason(article('ADULT content', 'https://ok.jp/'), list)).toBe('NGワード「adult」');
    expect(blockReason(article('見出し', 'https://news.example.com/1'), list)).toBe('サイト example.com');
    expect(blockReason(article('見出し', 'https://example.com/1'), list)).toBe('サイト example.com');
  });

  it('条件に当たらなければ表示する', () => {
    expect(blockReason(article('見出し', 'https://notexample.com/1'), list)).toBeUndefined();
    expect(blockReason(article('見出し', 'not a url'), list)).toBeUndefined();
  });
});
