// 以前の公開先（GitHub Pages）を、新しい公開先（Cloudflare Pages）への転送ページにする。
// どの URL で来ても（GitHub Pages はないページに 404.html を出す）、同じパスの新しいページへ移す。
// 使い方: node scripts/redirect-stub.mjs <新しい公開先の URL> <以前のベースパス（例: /matmsait）> <出力するフォルダー>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [target, basePath = '/', outDir = 'gh-pages'] = process.argv.slice(2);
if (!/^https:\/\/[^/\s]+$/.test(target ?? '')) {
  console.error('新しい公開先の URL（例: https://example.pages.dev）を指定してください');
  process.exit(1);
}
const base = basePath.replace(/\/+$/, '');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>トピあつめは移転しました</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${escape(target)}/">
<script>
(function () {
  var path = location.pathname, base = ${JSON.stringify(base)};
  if (base && path.indexOf(base) === 0) path = path.slice(base.length) || '/';
  location.replace(${JSON.stringify(target)} + path + location.search + location.hash);
})();
</script>
<meta http-equiv="refresh" content="0; url=${escape(target)}/">
</head>
<body>
<p>トピあつめは <a href="${escape(target)}/">${escape(target)}/</a> に移転しました。自動で移らないときは、リンクを押してください。</p>
</body>
</html>
`;
mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', '404.html']) writeFileSync(join(outDir, file), html);
console.log(`転送ページを作りました: ${outDir}/（→ ${target}）`);
