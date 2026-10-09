/** 話題のページの共有画像（/og/topic/<ID>.png。話題のページと同じ話題について作る） */
import type { APIRoute, GetStaticPaths } from 'astro';
import { cardOptions, topicCard } from '../../../lib/og-cards.ts';
import { cachedCardPng } from '../../../lib/og-image.ts';
import { getTopicViews, type TopicView } from '../../../lib/topics.ts';

export const getStaticPaths = (() => getTopicViews().map((view) => ({ params: { id: view.id }, props: { view } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props, site }) => {
  const png = await cachedCardPng(topicCard(props.view as TopicView), cardOptions(site));
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
