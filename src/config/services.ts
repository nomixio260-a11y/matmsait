// 外部サービスの設定。いずれも環境変数で指定し、未設定ならタグを一切出力しない。

/** Google AdSense のパブリッシャーID（例: ca-pub-1234567890123456） */
export const adsenseClient: string = import.meta.env.PUBLIC_ADSENSE_CLIENT ?? '';
/** 広告ユニットのスロットID（任意）。未設定なら自動広告のみ */
export const adsenseSlot: string = import.meta.env.PUBLIC_ADSENSE_SLOT ?? '';
/** Google アナリティクス 4 の測定ID（例: G-XXXXXXXXXX） */
export const gaMeasurementId: string = import.meta.env.PUBLIC_GA_ID ?? '';
/** Google Search Console の所有権確認用コード */
export const googleSiteVerification: string = import.meta.env.PUBLIC_GOOGLE_SITE_VERIFICATION ?? '';
/** Bing Web マスターツールの所有権確認用コード */
export const bingSiteVerification: string = import.meta.env.PUBLIC_BING_SITE_VERIFICATION ?? '';
/**
 * アクセス解析のサーバー（analytics/ の Cloudflare Worker）の URL。通常は公開のワークフローが data/analytics.json に書くので
 * 設定しなくてよい（独自ドメインで動かすときなどに上書きする）。実際に使う値は src/lib/analytics-config.ts の analyticsEndpoint
 */
export const analyticsUrlOverride: string = import.meta.env.PUBLIC_ANALYTICS_URL ?? '';
