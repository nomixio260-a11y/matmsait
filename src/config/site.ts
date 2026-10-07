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
  /** ブランドのメインコピー（ヘッダー・トップ・共有画像） */
  tagline: 'ニュースを「記事」ではなく「話題」で読む。',
  /** キャッチコピーを、改行してよい位置で区切ったもの（狭い画面で言葉の途中で折り返さないように） */
  taglineParts: ['ニュースを「記事」ではなく', '「話題」で読む。'],
  /** サブコピー（トップ・about） */
  subcopy: '複数のメディアを横断して、何が起きたか、どれだけ広がっているか、各社がどう報じているかを一目で。',
  /** ブランドの考え方（3段階） */
  philosophy: ['記事を集める。', '話題を整理する。', '変化を見つける。'],
  /** トップページのタイトル（「サイト名｜〇〇」の〇〇）。検索されやすい言葉を入れる */
  seoTitle: '話題のニュースまとめ・ニュースランキング',
  description:
    'ニュースを「記事」ではなく「話題」で読むサイト。数十のメディアの記事を1時間ごとに集めて同じ出来事ごとにまとめ、話題度・急上昇・初報・各社の報道の違いと、今日の変化を一目で見られます。',
  // 運営者情報（about / privacy / contact ページで使用）
  operator: 'トピあつめ運営',
  // 問い合わせ先。メールアドレスを設定するとお問い合わせページに表示される
  contactEmail: '',
  contactUrl: 'https://github.com/nomixio260-a11y/matmsait/issues/new',
  /** サイトのデータを置いている GitHub リポジトリ（管理画面から要約を保存する先） */
  repository: { owner: 'nomixio260-a11y', repo: 'matmsait' },
  // 一覧ページの1ページあたり件数
  pageSize: 40,
  /**
   * 一覧（新着・カテゴリ別・掲載元別）を何ページ目まで作るか。
   * 収集元が多いと記事数に比例してページが増え、ビルドと公開が遅くなるため、古い記事は日別まとめと検索で見てもらう
   */
  maxListPages: 25,
  /** 検索ページで探せる記事の数（新しい順）。多すぎると検索ページの読み込みが重くなる */
  searchLimit: 6000,
  // 一覧の何件ごとに広告枠を入れるか
  adEvery: 10,
  /**
   * IndexNow（Bing などの検索エンジンへ更新を知らせる仕組み）の鍵。
   * 公開される前提の値なので秘密にする必要はない（変える場合は英数字8〜128文字）
   */
  indexNowKey: '16d5d3b0031cd65aad70f62e2dc855f7',
  /** 運営している SNS アカウント。設定するとフッターとサイドバーに「フォロー」リンクを表示する */
  socialAccounts: [{ name: 'Bluesky', url: 'https://bsky.app/profile/topiatsume.bsky.social' }] as SocialAccount[],
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
    slug: 'science',
    name: 'サイエンス',
    description: '宇宙・生物・医療・研究成果など、科学の最新ニュースまとめ',
    color: '#65a30d',
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
    description: 'サッカー・野球・バスケットボール・モータースポーツなどスポーツの最新ニュースまとめ',
    color: '#10b981',
  },
  {
    slug: 'mobility',
    name: '乗り物',
    description: 'クルマ・バイク・飛行機・鉄道など、乗り物と交通の最新ニュースまとめ',
    color: '#ea580c',
  },
  {
    slug: 'life',
    name: 'ライフ',
    description: '暮らし・料理・家電・旅行・健康・学び・ライフハックの最新記事まとめ',
    color: '#14b8a6',
  },
];
