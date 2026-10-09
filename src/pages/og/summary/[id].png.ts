/** AI 要約のページの共有画像（/og/summary/<記事ID>.png） */
import type { APIRoute, GetStaticPaths } from 'astro';
import { cardOptions, summaryCard } from '../../../lib/og-cards.ts';
import { cachedCardPng } from '../../../lib/og-image.ts';
import { getSummaries } from '../../../lib/summaries.ts';
import type { SummaryRecord } from '../../../lib/types.ts';

export const getStaticPaths = (() => getSummaries().map((record) => ({ params: { id: record.id }, props: { record } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props, site }) => {
  const png = await cachedCardPng(summaryCard(props.record as SummaryRecord), cardOptions(site));
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
