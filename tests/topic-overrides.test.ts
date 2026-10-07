import { describe, expect, it } from 'vitest';
import {
  addMerge,
  addSplit,
  emptyOverrides,
  overrideLinks,
  parseTopicOverrides,
  removeMerge,
  removeSplit,
  serializeTopicOverrides,
} from '../src/lib/topic-overrides-core.ts';

const AT = '2026-10-08T00:00:00.000Z';

describe('トピックの手直し（統合・分割）', () => {
  it('ファイルを読み書きし、形の壊れた項目は外す', () => {
    const overrides = addMerge(addSplit(emptyOverrides(), { id: 'x', from: ['a', 'b'], title: '白猫GOLF', at: AT }), { ids: ['p', 'q'], at: AT });
    expect(parseTopicOverrides(serializeTopicOverrides(overrides))).toEqual(overrides);
    expect(parseTopicOverrides('')).toEqual(emptyOverrides());
    expect(parseTopicOverrides('{"splits":[{"id":"x"}],"merges":[{"ids":["a","a"],"at":"t"}]}')).toEqual(emptyOverrides());
    expect(() => parseTopicOverrides('[]')).toThrow();
  });

  it('まとめ方への制約にする（分割は外す記事とそのときの記事の組、統合は2つの記事の組）', () => {
    const overrides = addMerge(addSplit(emptyOverrides(), { id: 'x', from: ['a', 'b', 'x'], at: AT }), { ids: ['p', 'q'], at: AT });
    expect(overrideLinks(overrides)).toEqual({
      mustLink: [['p', 'q']],
      cannotLink: [
        ['x', 'a'],
        ['x', 'b'],
      ],
    });
  });

  it('最後の操作を優先する（統合したものを分割したら統合をやめる。その逆も）', () => {
    const merged = addMerge(emptyOverrides(), { ids: ['a', 'x'], at: AT });
    const split = addSplit(merged, { id: 'x', from: ['a'], at: AT });
    expect(split.merges).toEqual([]);
    const again = addMerge(split, { ids: ['x', 'a'], at: AT });
    expect(again.splits).toEqual([]);
    expect(again.merges).toHaveLength(1);
    // 同じ記事の分割は置き換える
    expect(addSplit(split, { id: 'x', from: ['b'], at: AT }).splits).toEqual([{ id: 'x', from: ['b'], at: AT }]);
  });

  it('取り消す', () => {
    const overrides = addMerge(addSplit(emptyOverrides(), { id: 'x', from: ['a'], at: AT }), { ids: ['p', 'q'], at: AT });
    expect(removeSplit(overrides, 'x').splits).toEqual([]);
    expect(removeMerge(overrides, ['q', 'p']).merges).toEqual([]);
  });
});
