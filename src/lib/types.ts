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
