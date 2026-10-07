import { describe, expect, it } from 'vitest';
import { buildRelatedIndex, clusterTopics, mainTitle, quotedNames, titleGrams } from '../src/lib/related.ts';
import type { Item } from '../src/lib/types.ts';

function item(id: string, title: string, publishedAt = '2026-10-06T00:00:00.000Z'): Item {
  return { id, title, url: `https://example.com/${id}`, excerpt: '', sourceId: 's', category: 'news', publishedAt };
}

describe('mainTitle / titleGrams', () => {
  it('配信元の付け足しを除く', () => {
    expect(mainTitle('簗農相が発言を撤回 | 毎日新聞')).toBe('簗農相が発言を撤回');
    expect(mainTitle('簗農相が発言を撤回（NHK） - Yahoo!ニュース')).toBe('簗農相が発言を撤回');
    expect(mainTitle('簗農相が発言を撤回：朝日新聞')).toBe('簗農相が発言を撤回');
    expect([...titleGrams('Ab「C」')]).toEqual(['ab', 'bc']);
  });
});

describe('buildRelatedIndex', () => {
  const items = [
    item('a', '簗和生農相「道路予算カット」発言を撤回して謝罪 辞任は否定 | 毎日新聞'),
    item('b', '簗農相 地元の道路“予算カット”発言撤回 「深く反省」陳謝 | NHKニュース'),
    item('c', 'ファーウェイ「WATCH FIT 4」に高耐久なサファイアガラスモデル'),
    item('d', '岐阜vs山口 試合記録'),
    item('e', '愛媛vs群馬 試合記録'),
    item('f', '長野vs奈良 試合記録'),
    item('g', '松本vs鳥取 試合記録'),
    item('g2', '滋賀vs熊本 試合記録'),
    item('g3', '仙台vs磐田 試合記録'),
    item('h', '簗農相の予算カット発言を撤回、過去の記事', '2026-09-01T00:00:00.000Z'),
    ...Array.from({ length: 30 }, (_, i) => item(`x${i}`, `まったく関係のないニュース${i}番目の見出しです`)),
  ];
  const index = buildRelatedIndex(items);

  it('同じ話題の記事を見つける', () => {
    expect(index.related(items[0]).map((i) => i.id)).toEqual(['b']);
    expect(index.related(items[1]).map((i) => i.id)).toEqual(['a']);
  });

  it('決まり文句だけが共通の見出しは関連づけない', () => {
    expect(index.related(items[3])).toEqual([]);
  });

  it('関係のない記事・日付の離れた記事は含めない', () => {
    expect(index.related(items[2])).toEqual([]);
    expect(index.related(items[0]).some((i) => i.id === 'h')).toBe(false);
  });

  it('索引にない記事でも探せる', () => {
    expect(index.related(item('new', '簗農相が道路予算カット発言を撤回、謝罪')).map((i) => i.id)).toContain('a');
  });
});

describe('clusterTopics', () => {
  const at = (hours: number) => new Date(Date.UTC(2026, 9, 6, 12) - hours * 3600e3).toISOString();
  const from = (id: string, sourceId: string, title: string, hours = 0): Item => ({
    ...item(id, title, at(hours)),
    sourceId,
  });
  const noise = Array.from({ length: 40 }, (_, i) => from(`n${i}`, `src${i % 7}`, `無関係なニュースの見出し${i}号について`));

  it('別々の掲載元が同じ出来事を報じた記事をまとめ、報じた掲載元の数を数える', () => {
    const clusters = clusterTopics([
      from('a', 'ktai-watch', 'Google ドライブとドキュメント、Markdownファイルを直接編集可能に 変換不要で共同編集'),
      from('b', 'impress-watch', 'Googleドキュメント、Markdownにネイティブ対応 直接編集可能に', 1),
      from('c', 'gihyo', 'Googleドキュメント、ドライブでMarkdownファイルを変換なしで表示、編集可能に', 2),
      from('d', 'car-watch', 'ホンダ、新型SUVの受注を開始 価格は400万円から', 1),
      ...noise,
    ]);
    const google = clusters.find((cluster) => cluster.items.some((i) => i.id === 'a'))!;
    expect(google.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(google.coverage).toBe(3);
    expect(google.latestAt).toBe(at(0));
    expect(google.firstAt).toBe(at(2));
    expect(clusters.find((cluster) => cluster.items.some((i) => i.id === 'd'))!.coverage).toBe(1);
  });

  it('同じ掲載元の定型の見出しどうしはまとめない', () => {
    const clusters = clusterTopics([
      from('k1', 'kantei', '高市総理は第４５回復興推進会議を開催しました'),
      from('k2', 'kantei', '高市総理は第８回日本成長戦略会議を開催しました', 1),
      ...noise,
    ]);
    expect(clusters.find((cluster) => cluster.items.some((i) => i.id === 'k1'))!.items).toHaveLength(1);
  });

  it('運営者の分割（まとめない組）と統合（必ずまとめる組）を反映する', () => {
    const google = [
      from('a', 'ktai-watch', 'Google ドライブとドキュメント、Markdownファイルを直接編集可能に 変換不要で共同編集'),
      from('b', 'impress-watch', 'Googleドキュメント、Markdownにネイティブ対応 直接編集可能に', 1),
      from('c', 'gihyo', 'Googleドキュメント、ドライブでMarkdownファイルを変換なしで表示、編集可能に', 2),
    ];
    const honda = from('d', 'car-watch', 'ホンダ、新型SUVの受注を開始 価格は400万円から', 1);
    const of = (clusters: ReturnType<typeof clusterTopics>, id: string) =>
      clusters
        .find((cluster) => cluster.items.some((i) => i.id === id))!
        .items.map((i) => i.id)
        .sort();
    // c を a・b から外す（a と b はまとまったまま）
    const split = clusterTopics([...google, honda, ...noise], { cannotLink: [['c', 'a'], ['c', 'b']] });
    expect(of(split, 'a')).toEqual(['a', 'b']);
    expect(of(split, 'c')).toEqual(['c']);
    // 見出しの似ていない d を a とまとめる
    const merged = clusterTopics([...google, honda, ...noise], { mustLink: [['a', 'd']] });
    expect(of(merged, 'd')).toEqual(['a', 'b', 'c', 'd']);
    // ない記事の ID は無視する
    expect(of(clusterTopics([...google, ...noise], { mustLink: [['a', 'zz']], cannotLink: [['zz', 'b']] }), 'a')).toEqual(['a', 'b', 'c']);
  });

  it('2段目: かぎかっこの中の名前が同じで、近い時刻に、見出しもある程度似ている報道をまとめる', () => {
    const ripple = [
      from('a', 'denfaminicogamer', '1988年のサンソフトのゲーム『リップルアイランド』が10月8日より「コンアカ」で配信開始。9種類のコマンドを駆使し、魔物にさらわれた王女を救い出す'),
      from('b', 'ascii', 'サンソフトの『リップルアイランド』が「コンソールアーカイブス」で10月8日に配信！', 0.5),
    ];
    const ids = (clusters: ReturnType<typeof clusterTopics>, id: string) =>
      clusters
        .find((cluster) => cluster.items.some((i) => i.id === id))!
        .items.map((i) => i.id)
        .sort();
    // 1段目では（似かたの下限を高くして）まとまらないようにし、2段目だけを確かめる
    const strict = { minScore: 0.95 };
    expect(ids(clusterTopics([...ripple, ...noise], { ...strict, quoteMerge: false }), 'a')).toEqual(['a']);
    expect(ids(clusterTopics([...ripple, ...noise], strict), 'a')).toEqual(['a', 'b']);
    // 時刻が離れていればまとめない
    const later = [ripple[0], { ...ripple[1], publishedAt: at(10) }];
    expect(ids(clusterTopics([...later, ...noise], strict), 'a')).toEqual(['a']);
    // 同じ名前でも、見出しの似ていない別の話題はまとめない
    const other = from('c', 'automaton', '『リップルアイランド』の開発者インタビュー 当時の制作秘話を語る', 1);
    expect(ids(clusterTopics([ripple[0], other, ...noise], strict), 'a')).toEqual(['a']);
    // 同じ掲載元どうしはまとめない
    const same = [ripple[0], { ...ripple[1], sourceId: 'denfaminicogamer' }];
    expect(ids(clusterTopics([...same, ...noise], strict), 'a')).toEqual(['a']);
  });

  it('かぎかっこの中の名前', () => {
    expect(quotedNames('サンソフトの『リップルアイランド』が「コンソール アーカイブス」で配信 - 4Gamer')).toEqual(['リップルアイランド', 'コンソールアーカイブス']);
    expect(quotedNames('「AI」が「AI」を')).toEqual([]);
  });

  it('公開日時が離れすぎた記事はまとめない', () => {
    const clusters = clusterTopics([
      from('a', 'impress-watch', 'auじぶん銀行、阪神リーグ優勝で円定期金利を2.08%(2連覇)に'),
      from('b', 'ktai-watch', 'auじぶん銀行、阪神優勝記念で1カ月もの円定期の金利を年2.08％に', 72),
      ...noise,
    ]);
    expect(clusters.find((cluster) => cluster.items.some((i) => i.id === 'a'))!.coverage).toBe(1);
    const near = clusterTopics([
      from('a', 'impress-watch', 'auじぶん銀行、阪神リーグ優勝で円定期金利を2.08%(2連覇)に'),
      from('b', 'ktai-watch', 'auじぶん銀行、阪神優勝記念で1カ月もの円定期の金利を年2.08％に', 3),
      ...noise,
    ]);
    expect(near.find((cluster) => cluster.items.some((i) => i.id === 'a'))!.coverage).toBe(2);
  });
});
