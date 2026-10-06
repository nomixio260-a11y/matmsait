// Google AdSense のパブリッシャーID（例: ca-pub-1234567890123456）。
// 未設定の間は広告タグ・広告枠を一切出力しない。
export const adsenseClient: string = import.meta.env.PUBLIC_ADSENSE_CLIENT ?? '';
// 広告ユニットのスロットID（任意）。未設定なら自動広告のみ。
export const adsenseSlot: string = import.meta.env.PUBLIC_ADSENSE_SLOT ?? '';
