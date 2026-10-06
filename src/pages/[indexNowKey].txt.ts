import type { APIContext } from 'astro';
import { site } from '../config/site.ts';

// IndexNow の鍵ファイル（/<鍵>.txt）。検索エンジンが送信元を確認するために読む
export function getStaticPaths() {
  return [{ params: { indexNowKey: site.indexNowKey } }];
}

export function GET({ params }: APIContext) {
  return new Response(params.indexNowKey);
}
