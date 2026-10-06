import type { APIContext } from 'astro';

export function GET(context: APIContext) {
  const sitemap = new URL(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/sitemap-index.xml`, context.site);
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`);
}
