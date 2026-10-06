export interface Category {
  slug: string;
  name: string;
  /** 一覧ページの説明文（検索結果にも表示される） */
  description: string;
  /** カテゴリを見分けるための色（小さな印にだけ使う） */
  color: string;
}

export interface SocialAccount {
  /** 表示名（例: X、Bluesky） */
  name: string;
  url: string;
}

export const site = {
  name: 'トピあつめ',
  tagline: '話題の新着ニュースをまとめてチェック',
  /** トップページのタイトル（「サイト名｜〇〇」の〇〇）。検索されやすい言葉を入れる */
  seoTitle: '話題のニュースまとめ・人気記事ランキング',
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
  /**
   * IndexNow（Bing などの検索エンジンへ更新を知らせる仕組み）の鍵。
   * 公開される前提の値なので秘密にする必要はない（変える場合は英数字8〜128文字）
   */
  indexNowKey: '16d5d3b0031cd65aad70f62e2dc855f7',
  /** 運営している SNS アカウント。設定するとフッターとサイドバーに「フォロー」リンクを表示する */
  socialAccounts: [] as SocialAccount[],
};

export const categories: Category[] = [
  {
    slug: 'news',
    name: 'ニュース',
    description: '国内・海外の社会、事件、政治など時事ニュースの最新記事まとめ',
    color: '#e5484d',
  },
  {
    slug: 'economy',
    name: '経済',
    description: '経済・ビジネス・企業・マネー・政治の最新ニュースまとめ',
    color: '#f59e0b',
  },
  {
    slug: 'tech',
    name: 'テクノロジー',
    description: 'IT・AI・ガジェット・スマホ・プログラミングなどテクノロジーの最新ニュースまとめ',
    color: '#3b82f6',
  },
  {
    slug: 'entertainment',
    name: 'エンタメ',
    description: '芸能・映画・音楽・ネットで話題のおもしろ記事の最新まとめ',
    color: '#ec4899',
  },
  {
    slug: 'game',
    name: 'ゲーム・アニメ',
    description: 'ゲーム・アニメ・マンガの新作情報や話題の最新ニュースまとめ',
    color: '#8b5cf6',
  },
  {
    slug: 'sports',
    name: 'スポーツ',
    description: 'サッカー・日本代表・Jリーグなどスポーツの最新ニュースまとめ',
    color: '#10b981',
  },
  {
    slug: 'life',
    name: 'ライフ',
    description: '暮らし・料理・健康・学び・ライフハックの最新記事まとめ',
    color: '#14b8a6',
  },
];
