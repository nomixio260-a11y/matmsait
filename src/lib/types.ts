export interface Source {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string;
  category: string;
  /** はてなブックマークなど、他サイトの記事を紹介する集約元か */
  aggregator?: boolean;
  /** タイトルから取り除く文字列の正規表現（例: "^\\[ITmedia [^\\]]+\\]\\s*"） */
  stripTitle?: string;
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
  /** はてなブックマーク数（0件のときは省略） */
  hatebu?: number;
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
  /** はてブ数の多い記事とカテゴリごとの上位記事（人気順） */
  items: Item[];
}
