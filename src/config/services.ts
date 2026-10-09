// 外部サービスの設定。いずれも環境変数で指定し、未設定ならタグを一切出力しない。
import { verificationCodes } from '../lib/site-verification.ts';

/** Google AdSense のパブリッシャーID（例: ca-pub-1234567890123456） */
export const adsenseClient: string = import.meta.env.PUBLIC_ADSENSE_CLIENT ?? '';
/** 広告ユニットのスロットID（任意）。未設定なら自動広告のみ */
export const adsenseSlot: string = import.meta.env.PUBLIC_ADSENSE_SLOT ?? '';
/** Google アナリティクス 4 の測定ID（例: G-XXXXXXXXXX） */
export const gaMeasurementId: string = import.meta.env.PUBLIC_GA_ID ?? '';
/**
 * リポジトリに置く Google Search Console の所有権確認用コード（Search Console に出たタグをそのまま書いてよい。複数は改行で区切る）。
 * 確認のコードはページに出る公開の情報なので、運営者が GitHub の変数を設定できないときはここに書く
 */
const GOOGLE_SITE_VERIFICATION_IN_REPO = '';
/** Google Search Console の所有権確認用コード（上のものと、GitHub の変数 PUBLIC_GOOGLE_SITE_VERIFICATION の両方を出す） */
export const googleSiteVerification: string[] = verificationCodes(GOOGLE_SITE_VERIFICATION_IN_REPO, import.meta.env.PUBLIC_GOOGLE_SITE_VERIFICATION);
/** Bing Web マスターツールの所有権確認用コード */
export const bingSiteVerification: string[] = verificationCodes(import.meta.env.PUBLIC_BING_SITE_VERIFICATION);
/**
 * アクセス解析の接続先（Cloudflare Pages ではサイトと同じドメインの /api。公開のワークフローが設定する）。
 * 実際に使う値は src/lib/analytics-config.ts の analyticsEndpoint
 */
export const analyticsUrlOverride: string = import.meta.env.PUBLIC_ANALYTICS_URL ?? '';
