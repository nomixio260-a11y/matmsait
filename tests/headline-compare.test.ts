import { describe, expect, it } from 'vitest';
import { compareHeadlines, headlineNumbers, headlineWords } from '../src/lib/headline-compare.ts';

describe('見出しの言葉', () => {
  it('数字に付いた助数詞や「第」「約」は言葉から外し、中黒でつながったカタカナは1つの言葉にする', () => {
    expect(headlineWords('10月8日配信、東日本第1リージョンで最小約191MB')).toEqual(['配信', '東日本', 'リージョン', '最小', '191MB']);
    expect(headlineWords('「スター・ウォーズ」新作')).toEqual(['スター・ウォーズ', '新作']);
  });

  it('カタカナ・漢字・英数字の続きを言葉にし、よく出る言葉や数字だけのもの・サイト名は除く', () => {
    expect(headlineWords('【速報】ソニー、ゲーミングヘッドホン「INZONE E9」の新色を10月22日に発売 - ITmedia')).toEqual([
      'ソニー',
      'ゲーミングヘッドホン',
      'INZONE',
      'E9',
      '新色',
      '発売',
    ]);
  });

  it('数字と単位（順番を表す「第3位」「2社目」は除く）', () => {
    expect(headlineNumbers('821社/団体が出展、来場者は10万人を見込む').map(({ text, unit, value }) => [text, unit, value])).toEqual([
      ['821社', '社', 821],
      ['10万人', '人', 100000],
    ]);
    expect(headlineNumbers('第3位に浮上、2社目の参入')).toEqual([]);
    expect(headlineNumbers('価格は２万９８００円')).toEqual([{ text: '2万9800円', unit: '円', value: 29800 }]);
  });
});

describe('見出しの比較', () => {
  const headlines = [
    { id: 'a', title: 'ソニー、ゲーミングヘッドホン「INZONE E9」の新色を発売 価格は2万9800円' },
    { id: 'b', title: 'ソニー「INZONE E9」に新色、10月22日発売' },
    { id: 'c', title: 'INZONE E9とINZONE H9 IIの新色が登場、ソニーが発表 3万円前後' },
  ];

  it('多くの見出しに共通する言葉と、その見出しにだけある言葉', () => {
    const result = compareHeadlines(headlines);
    expect(result.common).toEqual(expect.arrayContaining(['ソニー', 'INZONE', 'E9', '新色']));
    expect(result.unique.a).toContain('ゲーミングヘッドホン');
    expect(result.unique.c).toEqual(expect.arrayContaining(['H9', '登場']));
    // 共通の言葉は、その見出しだけの言葉には入らない
    expect(result.unique.b).not.toContain('ソニー');
  });

  it('同じ単位の数字が媒体によって違うときだけ挙げる（判断はしない）', () => {
    const result = compareHeadlines(headlines);
    expect(result.numbers).toEqual([
      {
        unit: '円',
        values: [
          { text: '2万9800円', ids: ['a'] },
          { text: '3万円', ids: ['c'] },
        ],
      },
    ]);
    // 片方がもう片方の一部だけを書いているのは違いとみなさない
    const subset = compareHeadlines([
      { id: 'x', title: '新モデルは3万円と5万円の2種類' },
      { id: 'y', title: '新モデル、3万円から' },
    ]);
    expect(subset.numbers).toEqual([]);
    expect(compareHeadlines([{ id: 'x', title: '来場者821社' }, { id: 'y', title: '来場者800社' }]).numbers).toHaveLength(1);
    // 桁の違う数字は別のものを指していることが多いので挙げない
    expect(compareHeadlines([{ id: 'x', title: '最大12人マルチ対応' }, { id: 'y', title: '同時接続1万5000人を突破' }]).numbers).toEqual([]);
  });

  it('言い回しが少し違っても、ほかの見出しに含まれていれば共通とみなす', () => {
    const result = compareHeadlines([
      { id: 'a', title: 'ノーベル化学賞に東京理科大学の名誉教授' },
      { id: 'b', title: 'ノーベル化学賞、東京理科大の研究者に' },
    ]);
    expect(result.common).toEqual(expect.arrayContaining(['ノーベル', '化学賞', '東京理科大']));
    // 「東京理科大学」は共通の言葉を含むので、その見出しだけの言葉にはしない
    expect(result.unique.a).toEqual(['名誉教授']);
    expect(result.unique.b).toEqual(['研究者']);
  });
});
