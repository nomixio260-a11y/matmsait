export interface Source {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string;
  category: string;
  /** 他サイトの記事を紹介する集約元か（現在は登録なし。以前ははてなブックマークに使っていた） */
  aggregator?: boolean;
  /** タイトルから取り除く文字列の正規表現（例: JAXA の「[プレスリリース・記者会見等] 」を消す "^\\[[^\\]]+\\]\\s*"） */
  stripTitle?: string;
  /** 1回の取得で取り込む記事数の上限（1日に数百件を配信するサイトで一覧が埋まらないようにする） */
  limit?: number;
  /** false のとき抜粋を載せない（見出しとリンクだけにする。利用条件で抜粋の掲載がはっきりしないサイト向け） */
  excerpt?: boolean;
  /** false のとき AI 要約の候補にしない（利用規約で記事の要約の掲載を禁じているサイト向け） */
  summary?: boolean;
}

export interface Item {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  sourceId: string;
  category: string;
  /** ISO 8601 */
  publishedAt: string;
  /**
   * 同じ話題を報じた掲載元の数（話題度。2以上のときだけ）。
   * items.json には保存せず、日別まとめ（data/daily）に保存するときとビルド時に計算して付ける
   */
  coverage?: number;
}

/** 1日分の話題の記事（data/daily/YYYY-MM-DD.json） */
export interface DailySnapshot {
  /** 日本時間の日付（YYYY-MM-DD） */
  date: string;
  /** 内容が最後に変わった日時（ISO 8601） */
  updatedAt: string;
  /** その日に掲載した記事数 */
  total: number;
  /** カテゴリごとの記事数 */
  counts: Record<string, number>;
  /** 多くの掲載元が報じた話題の記事・AI 要約のある記事と、カテゴリごとの上位記事（話題度の高い順） */
  items: Item[];
}

/** AI 要約つきの記事（data/summaries/YYYY-MM.json）。記事が items.json から消えても要約ページを出せるよう記事情報ごと保存する */
export interface SummaryRecord extends Item {
  /** AI が作成した要約 */
  summary: string;
  /** 要点（箇条書き） */
  points: string[];
  /** 背景・用語の説明（AI が書いた場合だけ） */
  background?: string;
  /** キーワード（記事の中心になる固有名詞など） */
  keywords?: string[];
  /** 要約を保存した日時（ISO 8601） */
  summarizedAt: string;
  /** 管理画面で要約を手直しした日時（ISO 8601。手直ししていなければなし） */
  updatedAt?: string;
  /** AI が自動で作った要約のモデル（例: @cf/qwen/qwen3-30b-a3b-fp8。運営者がチャット AI で作った要約にはない） */
  generator?: string;
}
