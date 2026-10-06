import { site } from '../config/site.ts';
import { href } from '../lib/items.ts';

/** ホーム画面に追加したときのアプリ情報（PWA） */
export function GET() {
  const manifest = {
    name: `${site.name}｜${site.seoTitle}`,
    short_name: site.name,
    description: site.description,
    lang: 'ja',
    start_url: href('/'),
    scope: href('/'),
    display: 'standalone',
    background_color: '#f2f3f5',
    theme_color: '#c2410c',
    icons: [
      { src: href('/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: href('/icon-512.png'), sizes: '512x512', type: 'image/png' },
      { src: href('/icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/manifest+json' } });
}
