# トピあつめ（matmsait）

複数サイトの RSS フィードから新着記事の **見出し・短い抜粋・元記事リンク** を集めて一覧表示する、まとめ（アンテナ）サイトです。
GitHub Actions で 1 時間ごとに収集し、静的サイトとして GitHub Pages に公開します（サーバー費 0 円）。
はてなブックマーク数による人気ランキング、記事検索、広告枠（Google AdSense）も備えています。

公開URL: https://nomixio260-a11y.github.io/matmsait/

## 仕組み

```
sources.yaml ─▶ scripts/fetch-feeds.ts ─▶ data/items.json ─▶ Astro でビルド ─▶ GitHub Pages
 (収集元一覧)    (取得・整形・重複排除・     (直近30日/最大3000件)    (静的HTML)
                  はてブ数の取得)
```

- 記事本文・画像は転載しません。抜粋は約 120 文字で切り詰め、全文は元サイトへ誘導します。
- 同じ記事（URL が同じもの）は 1 件にまとめます。はてブ経由で先に見つけた記事でも、配信元自身のフィードにあれば配信元の情報を優先します。
- 抜粋がタイトルの繰り返しやページ部品の断片になっている場合は取り除きます。
- 公開から 36 時間以内の記事は、はてなブックマーク数を毎回更新し、ランキングに使います。

### 収集時の通信について

- 通常の閲覧者と同じに見えるよう、Windows 版 Chrome と同じヘッダー（User-Agent・Accept・`sec-ch-ua`・`Sec-Fetch-*` など）を同じ順序で送ります。
  Node の `fetch` は独自のヘッダーを付け足してしまうため、`node:https` で直接リクエストしています（`scripts/lib/http.ts`）。
- User-Agent の Chrome のバージョンは日付から自動で計算する（現行の 1 つ前の版）ので、放置しても古くなりません。
- 同じサイトへは 1 件ずつ、1.5〜4 秒のランダムな間隔を空けてアクセスし、サイトの巡回順も毎回入れ替えます。定期実行の開始時刻も最大 2 分ずらします。
- gzip / deflate / brotli / zstd の圧縮、リダイレクト、Shift_JIS・EUC-JP のフィードに対応しています。一時的なエラー（通信失敗・429・5xx）は 1 回だけ再試行します。

## ローカルで動かす

Node.js 22.12 以上が必要です。

```sh
npm install
npm run fetch     # フィードを取得して data/items.json を更新
npm run dev       # http://localhost:4321 で開発サーバー
npm run build     # dist/ に静的サイトを生成
npm run preview   # ビルド結果を確認
npm test          # ユニットテスト
npm run check     # 型チェック（.astro ファイルを含む）
```

## 公開・自動更新

`.github/workflows/update.yml` が以下のタイミングで「テスト → 収集 → データをコミット → ビルド → GitHub Pages へ公開」を行います。

- 毎時 7 分（UTC）の定期実行
- 既定ブランチへの push
- Actions タブからの手動実行（Run workflow）

GitHub Pages の設定（Settings → Pages → Source）は **GitHub Actions** にしてください。
定期実行は、リポジトリに 60 日間動きがないと GitHub に停止されますが、収集データを毎時コミットしているので通常は止まりません。

### 独自ドメインを使う場合

Settings → Pages → Custom domain にドメインを設定すると、ワークフローが自動でそのドメイン用にビルドします。
AdSense の審査や `ads.txt`・`robots.txt`（ドメイン直下に置く必要がある）を考えると、収益化する段階では独自ドメインを強く推奨します。

## カスタマイズ

| やりたいこと | 編集するファイル |
| --- | --- |
| サイト名・キャッチコピー・運営者名・問い合わせ先 | `src/config/site.ts` |
| カテゴリの追加・変更・色 | `src/config/site.ts` の `categories` |
| 収集元の追加・削除 | `sources.yaml` |
| 1ページの件数・広告を入れる間隔 | `src/config/site.ts` の `pageSize` / `adEvery` |
| 見た目（色・余白など） | `src/styles/global.css`（色は `:root` の変数）、`src/styles/items.css`、`src/components/*` |
| 保存期間・件数 | `scripts/lib/store.ts` の `maxAgeDays` / `maxItems` |
| SNS 共有用の画像 | `public/og.png`（1200×630）。サイト名を変えたら差し替えてください |

### 収集元を追加する

`sources.yaml` に追記します。`category` は `site.ts` の `categories` にある slug を指定します。

```yaml
- id: example          # 英小文字・数字・ハイフン（URL に使われる）
  name: 例のサイト
  feedUrl: https://example.com/feed
  siteUrl: https://example.com/
  category: tech
  # 任意
  aggregator: true     # はてブのように他サイトの記事を紹介するフィードの場合
  stripTitle: '^【PR】' # タイトルから取り除く部分（正規表現）
```

追記したら `npm test`（設定ミスの検出）と `npm run fetch`（実際に取得できるか）で確認してください。

## 広告・アクセス解析の有効化

GitHub の **Settings → Secrets and variables → Actions → Variables** に登録すると、次回のデプロイから反映されます（`.env.example` 参照）。

| 変数 | 内容 |
| --- | --- |
| `PUBLIC_ADSENSE_CLIENT` | AdSense のパブリッシャー ID（例: `ca-pub-1234567890123456`）。全ページに AdSense タグを出力（自動広告）し、`ads.txt` も生成 |
| `PUBLIC_ADSENSE_SLOT` | （任意）広告ユニットのスロット ID。記事一覧の 10 件ごととサイドバーに広告枠を表示 |
| `PUBLIC_GA_ID` | （任意）Google アナリティクス 4 の測定 ID（例: `G-XXXXXXXXXX`） |
| `PUBLIC_GOOGLE_SITE_VERIFICATION` | （任意）Google Search Console の所有権確認コード |

プライバシーポリシー（Cookie・広告配信・アクセス解析の記載）、運営者情報、お問い合わせ、サイトマップ、構造化データ、OGP 画像は最初から用意しています。
2 ページ目以降の一覧と検索ページは `noindex` にし、サイトマップからも除外しています（内容の薄いページが大量に検索結果に出ないようにするため）。

### 審査に通りやすくするために

見出しとリンクだけのサイトは、AdSense で「有用性の低いコンテンツ」と判断されやすい傾向があります。審査前に以下のような**独自コンテンツ**を加えることをおすすめします。

- カテゴリごとの解説文や、注目記事への独自コメント・コラム
- 将来的には AI による要約・解説の生成（独自性が出るが API 費用がかかる）

また、AdSense の申し込み前に `src/config/site.ts` の運営者名・問い合わせ先を実際のものにしてください（現在の問い合わせ先は GitHub の Issue です）。

## 法的な注意（必ずお読みください）

- **登録する各サイトの利用規約を確認してください。** RSS の利用を「個人・非営利目的に限る」としているサイトがあります（例: NHK、Yahoo!ニュースの RSS は登録していません）。広告を載せる場合は商用利用にあたります。
- 初期登録のフィードは取得できることを確認済みですが、商用利用の可否は運営者ご自身で最終確認してください。
- 記事本文・画像の転載、5ch などの掲示板・SNS 投稿の無断転載は著作権侵害や規約違反になるおそれがあるため行わないでください。
- 配信元から掲載停止の依頼があった場合は、`sources.yaml` から該当サイトを削除してください（次回の収集時に既存の記事も一覧から消えます）。
