/**
 * 同じ運営元のサイトをまとめるためのキー。
 * pc.watch.impress.co.jp と car.watch.impress.co.jp のように、サブドメインが違っても同じ会社のサーバーなので、
 * 取得するときは同じグループとして1件ずつ間隔を空けて順番に読む（相手のサーバーに同時に負荷をかけない）
 */

/** 「co.jp」のように2つのラベルで1つの区切りになるもの（この後ろの1つ目までが組織のドメイン） */
const SECOND_LEVEL_SUFFIXES = new Set([
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'gr.jp',
  'ad.jp',
  'ed.jp',
  'lg.jp',
  'co.kr',
  'or.kr',
  'com.tw',
  'org.tw',
  'com.cn',
  'co.uk',
  'org.uk',
  'com.au',
]);

/** ホスト名から組織のドメイン（例: pc.watch.impress.co.jp → impress.co.jp、feeds.bbci.co.uk → bbci.co.uk） */
export function siteKey(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1) ?? '')) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}
