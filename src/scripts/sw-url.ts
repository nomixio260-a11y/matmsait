/** サービスワーカー（public/sw.js）の URL。通知（push-client.ts）とオフライン（pwa.ts）で同じにする（URL が変わると登録し直しになるため） */
export function serviceWorkerUrl(base: string, apiBase: string): string {
  return `${base}/sw.js?api=${encodeURIComponent(apiBase)}`;
}
