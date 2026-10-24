#!/bin/bash
# matmsait は git-crypt で暗号化している（.gitattributes）。クラウドセッション開始時に、
# 環境変数 REPO_KEY（git-crypt の鍵を base64 にしたもの）で作業ツリーを復号する（git-crypt unlock）。
# 鍵がない・git-crypt が入れられないときは、何もせずに終わる（失敗してもセッションは続ける。src/ などは暗号化されたまま）。
# 復号の前に npm install が走る Setup script を使っているときは、この復号を Setup script の先頭にも入れること。
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# このリポジトリが git-crypt の対象でなければ何もしない
grep -q 'filter=git-crypt' .gitattributes 2>/dev/null || exit 0

# すでに復号済みなら何もしない（package.json が git-crypt の目印で始まっていなければ平文＝復号済み）
if ! head -c 9 package.json 2>/dev/null | grep -qa 'GITCRYPT'; then
  exit 0
fi

# 鍵がなければ、知らせて終わる（セッションは続くが暗号化されたまま）
if [ -z "${REPO_KEY:-}" ]; then
  echo 'git-crypt: 環境変数 REPO_KEY が未設定のため復号できません。Claude の環境設定に REPO_KEY（git-crypt の鍵を base64 にしたもの）を登録してください。' >&2
  exit 0
fi

SUDO=''; [ "$(id -u)" -eq 0 ] || SUDO='sudo'
if ! command -v git-crypt >/dev/null 2>&1; then
  $SUDO apt-get update -qq >/dev/null 2>&1 && $SUDO apt-get install -y -qq git-crypt >/dev/null 2>&1 || {
    echo 'git-crypt: git-crypt を入れられませんでした（Setup script に `apt-get install -y git-crypt` を追加してください）。' >&2; exit 0; }
fi

keyfile="$(mktemp)"; trap 'rm -f "$keyfile"' EXIT
if ! printf '%s' "$REPO_KEY" | base64 -d > "$keyfile" 2>/dev/null; then
  echo 'git-crypt: REPO_KEY を base64 として読めませんでした。' >&2; exit 0
fi
if git-crypt unlock "$keyfile" 2>/dev/null; then
  echo 'git-crypt: 作業ツリーを復号しました。'
else
  echo 'git-crypt: 復号に失敗しました（鍵が違う可能性があります）。' >&2
fi
# 復号後、依存がなければ入れる（既にあれば何もしない）。package-lock.json のとおりに入れ、インストールのスクリプトは動かさない
# （GitHub Actions と同じ。esbuild・workerd はなくても動く。2026-10-24 のセキュリティの点検）
if [ ! -d node_modules ] && head -c 1 package.json 2>/dev/null | grep -qa '{'; then
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || echo 'git-crypt 後の npm ci に失敗しました（手動で npm ci --ignore-scripts を実行してください）。' >&2
fi
exit 0
