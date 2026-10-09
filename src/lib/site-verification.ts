/**
 * 検索エンジン（Google Search Console・Bing Web マスターツール）の所有権確認のコード。
 * 運営者が GitHub の変数に、タグ全体（<meta name="google-site-verification" content="…" />）や
 * DNS の TXT レコードの形（google-site-verification=…）を貼り付けても、meta タグの content に入れるコードだけを取り出す。
 * 複数のコード（別のアカウントで確認するときなど）は、空白・カンマ・改行で区切る
 */

/** コードに使われる文字（それ以外を含むもの（HTML ファイルの名前など）は使わない） */
const CODE_PATTERN = /^[A-Za-z0-9_\-+/=]+$/;

export function verificationCodes(...values: (string | undefined)[]): string[] {
  const codes = values.flatMap((value) => {
    if (!value?.trim()) return [];
    // タグを貼り付けたときは content="…" の中だけ
    const quoted = [...value.matchAll(/content\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]);
    const parts = quoted.length > 0 ? quoted : value.split(/[\s,、]+/);
    return parts.map((part) =>
      part
        .trim()
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/^google-site-verification\s*[=:]\s*/i, ''),
    );
  });
  return [...new Set(codes.filter((code) => CODE_PATTERN.test(code)))];
}
