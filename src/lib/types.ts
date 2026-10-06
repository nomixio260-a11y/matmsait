export interface Source {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string;
  category: string;
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
}
