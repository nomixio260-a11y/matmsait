import { describe, expect, it } from 'vitest';
import { firstSentence, readingSeconds, restSentences } from '../src/lib/summary-view.ts';

describe('要約の見せ方（10秒・30秒・2分）', () => {
  it('1文目を取り出す（かっこの中の「。」では切らない）', () => {
    expect(firstSentence('ソニーは新製品を発表した。価格は3万円だ。')).toBe('ソニーは新製品を発表した。');
    expect(firstSentence('同社は「値上げはしない。品質を守る」と説明した。発売は11月。')).toBe('同社は「値上げはしない。品質を守る」と説明した。');
    expect(firstSentence('本当か？ 調べてみた。')).toBe('本当か？');
    expect(firstSentence('句点のない文章')).toBe('句点のない文章');
    expect(firstSentence(`${'あ'.repeat(200)}。`, 50)).toBe(`${'あ'.repeat(49)}…`);
  });

  it('1文目のあとの文', () => {
    expect(restSentences('一つ目。二つ目。三つ目。')).toBe('二つ目。三つ目。');
    expect(restSentences('一つだけ。')).toBe('');
    expect(restSentences('句点なし')).toBe('');
  });

  it('読むのにかかる秒数の目安（1分に約500字）', () => {
    expect(readingSeconds('あ'.repeat(250))).toBe(30);
    expect(readingSeconds('あ')).toBe(5);
  });
});
