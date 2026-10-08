import { describe, expect, it } from 'vitest';
import { MAX_SENTENCE_LENGTH, sentencesOf, summaryWarnings, titleNovelty } from '../src/lib/summary-quality.ts';

/** 注意の種類だけを取り出す */
const kinds = (summary: string, options: { title?: string; points?: string[]; background?: string } = {}) =>
  summaryWarnings({ summary, points: options.points, background: options.background }, { title: options.title }).map(
    (warning) => warning.kind,
  );

/** 改善指示書の「良い要約」に近い書き方の例（注意が出ないこと） */
const GOOD =
  'Appleは10月7日、新型スマートフォン「iPhone 18」を11月14日に発売すると発表した。価格は12万9800円からで、カメラの画素数を4800万画素に上げた。日本での予約は10月10日に始まる。';

describe('要約の品質の確認', () => {
  it('良い要約には注意を出さない', () => {
    expect(kinds(GOOD, { title: 'Apple、新型iPhone 18を発表' })).toEqual([]);
  });

  it('見出しの言い換えだけの要約に注意を出す', () => {
    expect(kinds('Appleが新型iPhone 18を発表した。', { title: 'Apple、新型iPhone 18を発表' })).toContain('title');
    // 見出しにない情報（日付・価格・変更点）があれば出さない
    expect(kinds(GOOD, { title: 'Apple、新型iPhone 18を発表' })).not.toContain('title');
    // 見出しがわからなければ確かめない
    expect(kinds('Appleが新型iPhone 18を発表した。')).not.toContain('title');
  });

  it('中身のない書き出し・宣伝の言葉・定型文・推測に注意を出す', () => {
    expect(kinds('新型スマートフォンについて新たな情報が明らかになった。価格は9万8000円。')).toContain('opening');
    expect(kinds('○○社は画期的な新製品を発表した。価格は9万8000円。')).toContain('promo');
    expect(kinds('○○社は新製品を発表した。今後の動向が注目される。')).toContain('cliche');
    expect(kinds('○○社は新製品を発表した。ファンの期待が高まる。')).toContain('cliche');
    expect(kinds('○○社は新製品を発表した。市場を大きく変えるだろう。')).toContain('guess');
    // 本文どおりの書き方（警察・予報の見立て）や、かぎかっこの中の名前は拾わない
    expect(kinds('警察によると、男は火をつけたとみられる。最高気温は22度と予想されている。')).toEqual([]);
    expect(kinds('映画「画期的な夜」の公開が11月14日に決まった。上映は全国120館。')).toEqual([]);
  });

  it('あとで読むと日付がずれる言い方に注意を出す（作品名の中は除く）', () => {
    expect(kinds('○○社は本日、新製品を発表した。価格は9万8000円。')).toContain('date');
    expect(kinds('命令は先月28日付で確定した。罰金は10万円。')).toContain('date');
    expect(kinds('ドラマ「今日から俺は!!」の続編が10月7日に発表された。放送は2027年1月から。')).not.toContain('date');
  });

  it('です・ます調の文・長すぎる文・単位のない数字・長い引用に注意を出す', () => {
    expect(kinds('○○社は新製品を発表しました。価格は9万8000円です。')).toContain('style');
    // 引用の中の「です・ます」は文体の混在とみなさない
    expect(kinds('監督は会見で「ありがとうございます」と話した。チームは3連勝した。')).not.toContain('style');
    const long = `${'あ'.repeat(MAX_SENTENCE_LENGTH + 5)}。`;
    expect(kinds(long)).toContain('length');
    expect(kinds('○○社の売上は前年比30増加した。営業利益は12億円。')).toContain('unit');
    expect(kinds('○○社の売上は前年比30%増加した。営業利益は12億円。')).not.toContain('unit');
    expect(kinds('社長は「私たちはこの製品で、すべての人の毎日の暮らしをもっと便利で楽しいものに変えていきたいと考えています」と述べた。')).toContain(
      'quote',
    );
    // 長い製品名は引用とみなさない
    expect(kinds('アンカーは「Anker Nano USB-C ハブ (10-in-1, 240Hz, Display)」を発売した。価格は1万2990円。')).not.toContain('quote');
  });

  it('SNS の反応の誇張と、接続詞の多用に注意を出す', () => {
    expect(kinds('新曲がSNSで話題になっている。再生回数は100万回を超えた。')).toContain('sns');
    expect(kinds('発売日は公式SNSで告知した。価格は800円。')).not.toContain('sns');
    expect(kinds('新製品を発表した。また、価格は800円。さらに、色は3色。なお、発売は11月。')).toContain('conjunction');
    expect(kinds('新製品を発表した。また、価格は800円。発売は11月。')).not.toContain('conjunction');
  });

  it('要点と背景も確かめ、欄ごとに同じ種類の注意は1つにまとめる', () => {
    const warnings = summaryWarnings(
      { summary: GOOD, points: ['革新的な発見', '圧倒的な性能'], background: '業界に大きな影響を与えるだろう。' },
      { title: 'Apple、新型iPhone 18を発表' },
    );
    expect(warnings.map((warning) => `${warning.field}:${warning.kind}`)).toEqual(['points:promo', 'background:cliche', 'background:guess']);
    expect(warnings[0].message).toMatch(/^要点: /);
    expect(warnings[1].message).toMatch(/^背景: /);
  });
});

describe('文の分け方・見出しとの重なり', () => {
  it('かぎかっこの中の句点では文を分けない', () => {
    expect(sentencesOf('彼は「勝った。次も勝つ。」と話した。試合は3-1だった。')).toEqual(['彼は「勝った。次も勝つ。」と話した。', '試合は3-1だった。']);
    expect(sentencesOf('句点のない要点')).toEqual(['句点のない要点']);
  });

  it('要約の文字の組のうち、見出しにない組の割合と数', () => {
    const same = titleNovelty('Appleが新型iPhoneを発表', 'Apple、新型iPhoneを発表');
    expect(same.ratio).toBeLessThan(0.2);
    const rich = titleNovelty(GOOD, 'Apple、新型iPhone 18を発表');
    expect(rich.ratio).toBeGreaterThan(0.6);
    expect(rich.count).toBeGreaterThan(30);
  });
});
