export interface Category {
  slug: string;
  name: string;
  description: string;
}

export const site = {
  name: 'まとめアンテナ',
  description:
    'ニュース・テクノロジー・エンタメ・ゲームなど、各サイトの新着記事を自動で集めて一覧できるまとめサイトです。',
  // 運営者情報（about / privacy / contact ページで使用）
  operator: '運営者名をここに設定',
  contactEmail: 'contact@example.com',
  // 一覧ページの1ページあたり件数
  pageSize: 30,
  // 一覧の何件ごとに広告枠を入れるか
  adEvery: 10,
};

export const categories: Category[] = [
  { slug: 'news', name: 'ニュース', description: '国内外の社会・時事ニュースの新着記事' },
  { slug: 'economy', name: '経済', description: '経済・ビジネス・政治の新着記事' },
  { slug: 'tech', name: 'テクノロジー', description: 'IT・ガジェット・開発の新着記事' },
  { slug: 'entertainment', name: 'エンタメ', description: '芸能・映画・音楽・おもしろ話題の新着記事' },
  { slug: 'game', name: 'ゲーム・アニメ', description: 'ゲーム・アニメの新着記事' },
  { slug: 'sports', name: 'スポーツ', description: 'スポーツの新着記事' },
  { slug: 'life', name: 'ライフ', description: '暮らし・学び・ライフハックの新着記事' },
];

