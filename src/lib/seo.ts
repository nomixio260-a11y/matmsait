import type { Item } from './types.ts';

/** 見出しを「」で囲んで並べた短い紹介文（説明文に使う） */
export function headlineTeaser(items: Item[], count = 2, maxLength = 28): string {
  return items
    .slice(0, count)
    .map((item) => {
      const chars = Array.from(item.title);
      return `「${chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : item.title}」`;
    })
    .join('');
}

/** 説明文を検索結果に収まる長さ（全角120字程度）に切り詰める */
export function clampDescription(text: string, max = 120): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

interface CollectionOptions {
  name: string;
  description: string;
  url: string;
  items: Item[];
  dateModified?: string;
}

/** 記事一覧ページの構造化データ（CollectionPage + ItemList） */
export function collectionJsonLd({ name, description, url, items, dateModified }: CollectionOptions) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url,
    inLanguage: 'ja',
    ...(dateModified ? { dateModified } : {}),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: item.url,
        name: item.title,
      })),
    },
  };
}
