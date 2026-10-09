/** 日別まとめのページの共有画像（/og/daily/<YYYY-MM-DD>.png。その日の話題ニュースの上位5件） */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getDailySnapshots } from '../../../lib/daily.ts';
import { cardOptions, dailyCard } from '../../../lib/og-cards.ts';
import { cachedCardPng } from '../../../lib/og-image.ts';
import type { DailySnapshot } from '../../../lib/types.ts';

export const getStaticPaths = (() =>
  getDailySnapshots()
    .filter((snapshot) => snapshot.items.length > 0)
    .map((snapshot) => ({ params: { date: snapshot.date }, props: { snapshot } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props, site }) => {
  const png = await cachedCardPng(dailyCard(props.snapshot as DailySnapshot), cardOptions(site));
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
