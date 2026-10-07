/**
 * サイトと同じドメインの /api/* を、アクセス解析の Durable Object につなぐ（Cloudflare Pages の Functions）。
 * Durable Object は Worker「topiatsume-analytics」（analytics/）が持ち、ルートの wrangler.jsonc の durable_objects で使えるようにしている。
 * 処理の中身（送り元の確認・振り分け）は analytics/src/front.ts（Worker と共通）
 */
import { handle, type FrontEnv } from '../../analytics/src/front.ts';

export const onRequest: PagesFunction<FrontEnv> = (context) => handle(context.request, context.env, '/api');
