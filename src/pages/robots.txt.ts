import type { APIContext } from 'astro';
import { href } from '../lib/items.ts';

export function GET(context: APIContext) {
  const sitemap = new URL(href('/sitemap-index.xml'), context.site);
  return new Response(`User-agent: *\nAllow: /\nDisallow: ${href('/search/')}\n\nSitemap: ${sitemap}\n`);
}
