import { adsenseClient } from '../config/services.ts';

// AdSense 承認後、PUBLIC_ADSENSE_CLIENT を設定すると自動で ads.txt が出力される。
// ※ ads.txt はドメイン直下に置く必要があるため、独自ドメインでの運用時のみ有効。
export function GET() {
  const body = adsenseClient
    ? `google.com, ${adsenseClient.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`
    : '# PUBLIC_ADSENSE_CLIENT を設定すると AdSense の行が出力されます\n';
  return new Response(body);
}
