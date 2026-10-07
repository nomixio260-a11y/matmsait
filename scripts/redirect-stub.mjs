// 以前の公開先（GitHub Pages）を、新しい公開先（Cloudflare Pages）への転送ページにする。
// どの URL で来ても（GitHub Pages はないページに 404.html を出す）、同じパスの新しいページへ移す。
// ビルドしたサイトのフォルダーを渡すと、そのページごとに転送ページを置く（ないページの 404 ではなく、
// 正規の URL と即時の転送を返すので、検索エンジンにも移転先が伝わりやすい）。
// 使い方: node scripts/redirect-stub.mjs <新しい公開先の URL> <以前のベースパス（例: /matmsait）> <出力するフォルダー> [ビルドしたサイトのフォルダー]
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const [target, basePath = '/', outDir = 'gh-pages', siteDir] = process.argv.slice(2);
if (!/^https:\/\/[^/\s]+$/.test(target ?? '')) {
  console.error('新しい公開先の URL（例: https://example.pages.dev）を指定してください');
  process.exit(1);
}
const base = basePath.replace(/\/+$/, '');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 転送ページ。page は新しい公開先のページ（パス）。noindex は、どのページか分からない 404 のときだけ付ける */
const stub = (page, noindex) => {
  const url = `${target}${page}`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>トピあつめは移転しました</title>
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="canonical" href="${escape(url)}">
<script>
(function () {
  var path = location.pathname, base = ${JSON.stringify(base)};
  if (base && path.indexOf(base) === 0) path = path.slice(base.length) || '/';
  location.replace(${JSON.stringify(target)} + path + location.search + location.hash);
})();
</script>
<meta http-equiv="refresh" content="0; url=${escape(url)}">
</head>
<body>
<p>トピあつめは <a href="${escape(url)}">${escape(url)}</a> に移転しました。自動で移らないときは、リンクを押してください。</p>
</body>
</html>
`;
};

/** フォルダーの中の index.html（ページ）を探す */
function pages(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 管理画面は転送しない（新しい URL でログインし直す必要があるため、トップと同じ扱いにする）
      if (entry.name === 'admin' && dir === siteDir) continue;
      out.push(...pages(path));
    } else if (entry.name === 'index.html') {
      out.push(path);
    }
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), stub('/', false));
writeFileSync(join(outDir, '404.html'), stub('/', true));
let count = 1;
if (siteDir) {
  for (const file of pages(siteDir)) {
    const dir = relative(siteDir, dirname(file)).split(sep).filter(Boolean);
    if (dir.length === 0) continue;
    mkdirSync(join(outDir, ...dir), { recursive: true });
    writeFileSync(join(outDir, ...dir, 'index.html'), stub(`/${dir.join('/')}/`, false));
    count++;
  }
}
console.log(`転送ページを作りました: ${outDir}/ に${count}ページ（→ ${target}）`);
