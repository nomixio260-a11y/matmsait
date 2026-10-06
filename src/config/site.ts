export interface Category {
  slug: string;
  name: string;
  description: string;
  /** カテゴリを見分けるための色（小さな印にだけ使う） */
  color: string;
}

export const site = {
  name: 'トピあつめ',
  tagline: '話題の新着ニュースをまとめてチェック',
  description:
    'ニュース・経済・テクノロジー・エンタメ・ゲーム・スポーツなど、人気サイトの新着記事とはてなブックマークで話題の記事を1時間ごとにまとめてお届けします。',
  // 運営者情報（about / privacy / contact ページで使用）
  operator: 'トピあつめ運営',
  // 問い合わせ先。メールアドレスを設定するとお問い合わせページに表示される
  contactEmail: '',
  contactUrl: 'https://github.com/nomixio260-a11y/matmsait/issues/new',
  // 一覧ページの1ページあたり件数
  pageSize: 40,
  // 一覧の何件ごとに広告枠を入れるか
  adEvery: 10,
};

export const categories: Category[] = [
  { slug: 'news', name: 'ニュース', description: '国内外の社会・時事ニュースの新着記事', color: '#e5484d' },
  { slug: 'economy', name: '経済', description: '経済・ビジネス・政治の新着記事', color: '#f59e0b' },
  { slug: 'tech', name: 'テクノロジー', description: 'IT・ガジェット・開発の新着記事', color: '#3b82f6' },
  {
    slug: 'entertainment',
    name: 'エンタメ',
    description: '芸能・映画・音楽・おもしろ話題の新着記事',
    color: '#ec4899',
  },
  { slug: 'game', name: 'ゲーム・アニメ', description: 'ゲーム・アニメ・マンガの新着記事', color: '#8b5cf6' },
  { slug: 'sports', name: 'スポーツ', description: 'サッカーなどスポーツの新着記事', color: '#10b981' },
  { slug: 'life', name: 'ライフ', description: '暮らし・学び・ライフハックの新着記事', color: '#14b8a6' },
];
