# まとめアンテナ（matmsait）

複数サイトの RSS フィードから新着記事の **見出し・短い抜粋・元記事リンク** を自動で集めて一覧表示する、まとめ（アンテナ）サイトです。
GitHub Actions で 1 時間ごとに収集し、静的サイトとして GitHub Pages に公開します（サーバー費 0 円）。
将来の広告収益化（Google AdSense）に必要なページや広告枠もあらかじめ用意しています。

## 仕組み

```
sources.yaml ──▶ scripts/fetch-feeds.ts ──▶ data/items.json ──▶ Astro でビルド ──▶ GitHub Pages
 (収集元一覧)     (取得・整形・重複排除)      (直近30日/最大3000件)   (静的HTML)
```

- 記事本文・画像は転載しません。抜粋は約 120 文字で切り詰め、全文は元サイトへ誘導します。
- 同じ記事（URL が同じもの）は 1 件にまとめます。トラッキング用パラメータ（`utm_*` など）は除去します。
- 1 つのフィードが失敗しても他は収集を続けます（失敗は Actions のログに出ます）。

## ローカルで動かす

Node.js 22.12 以上が必要です。

```sh
npm install
npm run fetch     # フィードを取得して data/items.json を更新
npm run dev       # http://localhost:4321 で開発サーバー
npm run build     # dist/ に静的サイトを生成
npm run preview   # ビルド結果を確認
npm test          # ユニットテスト
```

## 公開手順（GitHub Pages）

1. このブランチを `main` にマージする（定期実行は既定ブランチでのみ動きます）
2. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. **Actions** タブで「フィード更新とデプロイ」を **Run workflow** で一度手動実行する
4. 以降は毎時自動で収集・公開されます。公開 URL は `https://<ユーザー名>.github.io/matmsait/`

### 独自ドメインを使う場合

Settings → Pages → Custom domain にドメインを設定すると、ワークフローが自動でそのドメイン用にビルドします。
AdSense の審査や `ads.txt`（ドメイン直下に必要）を考えると、収益化する段階では独自ドメインを強く推奨します。

## カスタマイズ

| やりたいこと | 編集するファイル |
| --- | --- |
| サイト名・説明・運営者名・連絡先 | `src/config/site.ts` |
| カテゴリの追加・変更 | `src/config/site.ts` の `categories` |
| 収集元の追加・削除 | `sources.yaml` |
| 見た目 | `src/layouts/BaseLayout.astro`（色は `:root` の CSS 変数）、`src/components/*` |
| 保存期間・件数 | `scripts/lib/prune.ts` の `maxAgeDays` / `maxItems` |

**公開前に必ず `src/config/site.ts` の `operator`（運営者名）と `contactEmail` を設定してください。**

### 収集元を追加する

`sources.yaml` に追記します。`category` は `site.ts` の `categories` にある slug を指定します。

```yaml
- id: example          # 英小文字・数字・ハイフン（URL に使われる）
  name: 例のサイト
  feedUrl: https://example.com/feed
  siteUrl: https://example.com/
  category: tech
```

追記したら `npm run fetch` で取得できるか確認してください（`npm test` で設定ミスも検出できます）。

## 広告（Google AdSense）の有効化

1. 独自ドメインで公開し、AdSense に申し込む
2. 承認されたら GitHub の **Settings → Secrets and variables → Actions → Variables** に以下を登録
   - `PUBLIC_ADSENSE_CLIENT` … パブリッシャー ID（例: `ca-pub-1234567890123456`）
   - `PUBLIC_ADSENSE_SLOT` …（任意）広告ユニットのスロット ID
3. 次回のデプロイから反映されます
   - `PUBLIC_ADSENSE_CLIENT` のみ: AdSense タグを全ページに出力（自動広告）。`ads.txt` も自動生成
   - `PUBLIC_ADSENSE_SLOT` も設定: 記事一覧の 10 件ごとに広告ユニットを挿入（間隔は `site.ts` の `adEvery`）

プライバシーポリシー（Cookie・広告配信の記載）、運営者情報、お問い合わせ、サイトマップ、robots.txt は最初から用意しています。

### 審査に通りやすくするために

見出しとリンクだけのサイトは、AdSense で「有用性の低いコンテンツ」と判断されやすい傾向があります。審査前に以下のような**独自コンテンツ**を加えることをおすすめします。

- カテゴリごとの解説文や、注目記事への独自コメント・コラム
- 将来的には AI による要約・解説の生成（独自性が出るが API 費用がかかる）

## 法的な注意（必ずお読みください）

- **登録する各サイトの利用規約を確認してください。** RSS の利用を「個人・非営利目的に限る」としているサイトがあります（例: NHK、Yahoo!ニュースの RSS は登録していません）。広告を載せる場合は商用利用にあたります。
- 初期登録のフィードは取得できることを確認済みですが、商用利用の可否は運営者ご自身で最終確認してください。
- 記事本文・画像の転載、5ch などの掲示板・SNS 投稿の無断転載は著作権侵害や規約違反になるおそれがあるため行わないでください。
- 配信元から掲載停止の依頼があった場合は、`sources.yaml` から該当サイトを削除してください（次回の収集時に既存の記事も一覧から消えます）。
