# 開発記録（引き継ぎ用）

このサイトの開発の経緯・現在の状態・未解決の課題をまとめた記録です。
開発を引き継ぐ人（人でも AI でも）は、まず「現在の状態」と「未解決の課題・次にやること」を読んでください。

## 記録のルール

- 開発（コード・設定・ワークフローの変更）をしたら、**作業の最後にこのファイルへ記録を追記し、変更と同じコミット（または同じ push）に含める**。
- 新しい記録は「開発の記録」のいちばん上に追加する（新しい順）。書き方は下の「記録のひな形」に合わせる。
- 「現在の状態」と「未解決の課題・次にやること」は、記録を追加するたびに最新の内容へ書き換える（古い情報を残さない）。
- GitHub Actions による自動更新（`chore:` で始まるコミット）は記録しない。
- 秘密の値（トークン・API キー・パスワード）は書かない。設定した「事実」だけを書く（例: `PUBLIC_ADSENSE_CLIENT を設定済み`）。

### 記録のひな形

```markdown
### YYYY-MM-DD 見出し（何をしたかが一目でわかるように）

- 依頼・目的: 誰の・どんな要望か、なぜ必要か
- やったこと: 変更内容を箇条書きで（仕様の決めごとや、採らなかった案とその理由も）
- 主な変更ファイル: `path/to/file`（役割）
- 確認したこと: 実行したテスト・確認の方法と結果
- 残った課題・注意点: 未確認のこと、次にやるべきこと
```

---

## 現在の状態（2026-10-08 時点）

> **運営者の方針**: 費用のかかる AI API（Claude API など）は使わない。要約の JSON は運営者が管理画面のプロンプトをチャット AI に貼り付けて作り、管理画面に貼り付けて保存する。

### 公開先

| 項目 | 場所 |
| --- | --- |
| サイト | **https://topiatsume.pages.dev/**（Cloudflare Pages。2026-10-07 に移転し、同日から毎時の更新もここに公開）。以前の https://nomixio260-a11y.github.io/matmsait/ は新しい URL の同じページへの転送ページ |
| 管理画面 | https://topiatsume.pages.dev/admin/ （ログインが必要。ログインページは `/admin/login/`。検索エンジンには非公開）。ページは「概要」（`/admin/`）・「AI要約・記事」（`/admin/summaries/`）・「ピックアップ・お知らせ」（`/admin/content/`）・「通知」（`/admin/notify/`）・「アクセス解析」（`/admin/analytics/`） |
| アクセス解析・通知 | サイトと同じドメインの `/api`（Pages の Functions）→ Worker `topiatsume-analytics` の Durable Object（Cloudflare、`workers.dev` では公開しない）。通知（プッシュ通知）の購読と送信も同じ Durable Object |
| リポジトリ | `nomixio260-a11y/matmsait`（公開。開発・テスト・毎時の収集とビルドはここと GitHub Actions） |
| 既定ブランチ | `ccr-28054993-x9r1qj`（このブランチへの push で公開される） |
| 公開方法 | GitHub Actions（`.github/workflows/update.yml`）→ Cloudflare Pages（`wrangler pages deploy`。Secrets がなければ GitHub Pages）。アクセス解析の Worker は `analytics.yml` |

### 自動で動いているもの

- **収集・公開**（`update.yml`）: 自動更新タイマー・push・手動実行（管理画面の「概要」の「今すぐ更新」/ Actions の Run workflow）で、テスト → 公開先の確認（Cloudflare の Secrets があれば Cloudflare Pages、なければ GitHub Pages）→ フィード取得 → 本文の自動取得 → よく読まれている記事の取得 → データをコミット → ビルド → Cloudflare Pages へ公開 → **フォロー中の新着の通知**（`POST /api/push/check`）→ GitHub Pages をページごとの転送ページに → IndexNow・WebSub へ通知（`notify` ジョブ。Cloudflare に公開しているときは GitHub Pages の転送ページの公開（数分かかることがある）を待たずに行い、GitHub Pages に公開しているときは公開を確かめてから行う）（新しく報じられた話題のページ・タグのページも）→ **Bluesky への自動投稿**（Secrets の `BLUESKY_APP_PASSWORD` があるときだけ。下の「SNS（Bluesky）」）。2026-10-07 に運営者が Secrets を登録し、run #51 から pages.dev に公開されている。実行のたびに、自動更新タイマーが止まっていれば再開する（`keep-timer` ジョブ）。
- **自動更新タイマー**（`timer.yml`）: 前回の `update.yml` の実行から60分（変数 `UPDATE_INTERVAL_MINUTES` で変更可）たつまで待ち、`update.yml` を実行して自分自身を次に予約する。GitHub の定期実行（schedule）は一度も動かなかったため、こちらで定期更新する。公開リポジトリでだけ動く（非公開にすると自動で止まる）。
- 収集元は `sources.yaml` の66件（ニュース・経済・テクノロジー・サイエンス・エンタメ・ゲーム・アニメ・スポーツ・乗り物・ライフの9カテゴリ）。どれも利用規約で商用サイトからの利用が禁じられていないことを確認済みで、確認結果（登録を見送ったサイトと理由も）は `docs/SOURCES.md` にある。はてなブックマーク（収集元・ブックマーク数）は商用で使えないため使っていない。
- **本文の自動取得**（`scripts/fetch-texts.ts`、`update.yml` の「AI が開けない記事の本文を取得」）: 管理画面が `data/text-requests.json` に書いた依頼（AI が開けなかった記事）について、フィードと同じブラウザ相当の通信（ボットの名前は名乗らない）で記事のページを取得し、本文を運営者の公開鍵（`data/text-keys.json`）で暗号化して `data/texts.json` に置く。robots.txt（クローラー全般と AI のクローラーの拒否）・noai・アクセスの拒否を守り、1回15件まで。依頼がなければ何もしない。
- **フォロー・通知**（2026-10-07 追加）: 読者がジャンル・掲載元・キーワードをフォローすると「フォロー中」（`/following/`）に新着をまとめ（ブラウザだけに保存）、通知をオンにした人には、毎時の公開のあとに Durable Object が `updates.json` のはじめて見た記事をフォローと照らし合わせてプッシュ通知を送る（1日1回の朝のまとめ・夜は送らない設定も）。いま話題のニュース（4媒体以上）と、管理画面からの運営のお知らせも送れる。VAPID の鍵は Durable Object が作って保存（秘密の設定は不要）。表示しない設定（ミュート）・既読・表示の設定（`/settings/`）もブラウザだけに保存。
- **アクセス解析**（Cloudflare。2026-10-07 から pages.dev で動作中）: サイトのページが見たページ・開いた記事・検索・保存・閲覧時間などを同じドメインの `/api/collect` に送り（`src/scripts/analytics.ts`）、Pages の Functions（`functions/api/[[path]].ts`、中身は `analytics/src/front.ts`）が Worker `topiatsume-analytics` の Durable Object（SQLite）に渡して数える。管理画面の「アクセス解析」（`/admin/analytics/`）で見る。`update.yml` が毎回よく読まれている記事を `/api/popular` から `data/popular.json` に取り込む（`scripts/popular.ts`。Cloudflare に公開していないときは何もしない）。GitHub Pages で公開している間はアクセス解析なし。
- **サイトのコンセプトと見た目**（2026-10-08 に全面改善の Phase 1 を公開。計画は `docs/REDESIGN.md`）: 「ニュースを「記事」ではなく「話題」で読む。」（記事を集める。話題を整理する。変化を見つける。）。ヘッダーのメニューは5つ（ホーム・話題 `/ranking/`・急上昇 `/rising/`・トレンド `/trends/`・ジャンル `/genres/`）。トップは今日のダッシュボード（今日の数字 → ニュースの温度 → 今日、変化したこと → ピックアップ → 今話題 → 急上昇 → 今日の5トピック → 注目ワード → 新着のタイムライン）。言葉は「トピック」（同じ出来事の記事のまとまり）・「N媒体が報道」・「初報＝最初に確認できた報道」・「今日の注目」（重要度の判断ではない）にそろえ、about の「言葉の意味」に説明がある。色は話題度＝赤（`--heat`）・急上昇＝紫（`--rise`）、アイコンは線のアイコン（`src/components/IconSprite.astro`。絵文字は使わない）、トピックのカードは `src/components/TopicList.astro` の1種類。煽る言葉は使わない。
- **話題エンジン**（2026-10-07 追加・10-08 拡張。`src/lib/topic-core.ts`・`src/lib/topics.ts`）: 同じ出来事を報じた記事のまとまり（`src/lib/related.ts` の `clusterTopics`。直近8日の記事）＝**トピック**ごとに、報じた媒体の数（「N媒体が報道」）・**話題度**（0〜100。今どれくらい話題か。報道1件ごとに1を足し12時間ごとに半分に減らす＋報じた媒体のジャンルの広がり＋サイトで読まれた人数。熱さ4で63点。内訳は `scoreBreakdown` で、一覧の「話題度」を押すと開く）・直近1/3/24時間に新しく報じた媒体の数・初報（最初に確認できた報道）・**勢い**（`momentumOf`。3時間で何媒体から何媒体に増えたか・その前の6時間と比べたペース）・**なぜ話題？**（`whyTrending`。報道の状況だけを数字から機械的に書く）を計算する。ここから「今話題」（話題度の順。トップの「今話題」の件数は話題度30以上）・「急上昇」（3時間に新しく報じた媒体の多い順。少なければ6・12時間に広げる）・「報じられ始めたトピック」（最初の報道から6時間）・「今日の注目／今日の5トピック」（24時間の報道の数とジャンルの広がり。ジャンルごとに件数の上限）・「注目ワード」（24時間の見出しに急に増えた言葉。候補は AI 要約のキーワードとタグの言葉）・「ニュースの温度」（`genreTemperature`。ジャンルごとの熱さの合計と昨日の同じ時刻との比較）・「今日、変化したこと」（`getTodayChanges`）・「メディア別」（トピックの数と初報の数。`/sources/` に表示）を作る。2つ以上の媒体が報じたトピックには**トピックのページ**（`/topic/<最初の記事のID>/`。各媒体の報道を報じた順に比較・初報・報道の広がりのグラフ・AI 要約の10秒/30秒/2分・関連するトピック）があり、記事の「N媒体が報道」から開ける。検索エンジンに出すのは3媒体以上か AI 要約のあるトピックだけ（ほかは noindex）。
- **SNS（Bluesky）**（2026-10-07 追加。`scripts/lib/social.ts`・`scripts/notify.ts`・`src/lib/social-source.ts`）: 公式アカウント **@topiatsume.bsky.social**（https://bsky.app/profile/topiatsume.bsky.social ）に、毎時の公開のあと自動で投稿する。決まった時間の投稿は、朝（7〜10時台）の今日の注目ニュース（`/ranking/#today`）・昼（12〜14時台）の AI ニュース（`/tag/ai/`）・夜（21時以降）の今日の話題ニュース（日別まとめ）・日曜の夕方（18〜20時台）の今週の話題ニュース TOP5（`/ranking/#week`）。話題が出たときの投稿は、急上昇（3時間で2媒体以上・計3媒体以上）・いま話題（4媒体以上・話題度50以上・12時間以内に報道があったもの）・10秒でわかるニュース（48時間以内の AI 要約の1文目。報じたメディアの多い話題から）で、リンクは話題のページ。深夜0〜7時は投稿しない・24時間に12件まで・急上昇などは前の投稿から1時間あけて1回1件・種類ごとに1日の上限（急上昇4・いま話題4・10秒3）・同じ話題は二度投稿しない（`SOCIAL_LIMITS`）。本文のリンクは短く表示して流入元の印（`utm_source=bluesky&utm_medium=social&utm_campaign=<種類>`。アクセス解析では「SNS」に数える）を付けたリンクにし、`#ニュース` とタグごとのハッシュタグ（`src/config/tags.ts` の `hashtags`）、リンクカード（`public/og.png`）を付ける。投稿の記録は `data/social.json`（`notify` ジョブがコミット）で、管理画面の「概要」の「SNS（Bluesky）の自動投稿」に最近の投稿と、次に投稿されうる内容の下書きが出る。フォロー・いいね・返信の自動化はしない。**管理画面の「今すぐ Bluesky に投稿」**（2026-10-07 追加）を押すと、依頼（`data/social-request.json`）を GitHub に保存 → その push で `update.yml` が動き、最新の記事の取り込み・公開のあとに `notify` が依頼を見つけて、時間帯・間隔を待たずにまだ投稿していない話題を1件（急上昇 → いま話題 → 10秒でわかるニュース。なければ「いま話題のニュース」のまとめ）投稿し、結果を `data/social.json` の `manual` に書く（管理画面がそれを読み、投稿へのリンクつきで表示。押してから約2分。24時間に24件まで・30分以上たった依頼は投稿しない）。サイトのフッター・サイドバー・トップ（急上昇の下）・急上昇・話題のページに「Bluesky でフォロー」の案内（`src/components/FollowCta.astro`）。X は API が有料なので使わない。Mastodon・Misskey は Secrets を登録すれば同じ内容を投稿する。
- **タグ**（`src/config/tags.ts`）: AI・Apple・Google・Microsoft・任天堂・PlayStation・MLB・セキュリティ・半導体・EV・災害・政治・株価の13個。見出しと AI 要約のキーワードを正規表現で当てはめ（タグごとにジャンルを絞って誤りを減らす）、`/tag/<slug>/`（AI は「AIニュースランキング」）と `/tags/` にまとめる。記事が8件未満のタグのページは noindex。
- よく読まれている記事: アクセス解析の読まれた人数による「よく読まれている記事」（`/popular/`・トップ・サイドバー・「人気N位」）と、管理画面の「よく読まれている順」。話題度スコアにも少し足す。
- 記事は直近30日・最大12000件を `data/items.json` に保存（更新の多いサイトで上限が埋まっても、各掲載元の新しい20件は残す）。一覧ページは25ページ（1000件）まで、検索は新しい6000件まで。

### 運営者の設定状況

| 設定 | 状態 |
| --- | --- |
| GitHub Pages（Source: GitHub Actions） | 設定済み・公開中 |
| AI 要約 | 運営者が管理画面で作成（有料の AI API は使わない）。AI が開けない記事は、運営者が本文を貼り付けて本文入りのプロンプトで依頼するか、同じ話題の別の記事に切り替える。長いプロンプトは分割・ファイルで渡せ、AI の回答はファイルでも読み込める |
| 管理画面のログイン | 管理画面を開くとログインページに移る。トークンはパスワードで暗号化して運営者のブラウザにだけ保存（Contents と Actions の Read and write が必要）。2026-10-07 に運営者が設定し直した（パスワードを忘れたため） |
| 本文の自動取得 | 公開済み。運営者の公開鍵は 2026-10-07 に登録済み（`data/text-keys.json`） |
| Cloudflare（公開先・アクセス解析・通知） | 運営者がアカウントと API トークンを作成し、GitHub の Secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）を登録済み（2026-10-07。登録後の update.yml run #51 で pages.dev への公開と GitHub Pages の転送ページを確認）。Worker `topiatsume-analytics` と Pages のプロジェクト `topiatsume` を使う。ダッシュボードで作られた Worker `matmsait`（Hello World のひな形）は使っていない |
| 管理画面のログイン（新しい URL） | 運営者が pages.dev の管理画面で初回設定済み（2026-10-07。本文の自動取得の鍵を新しく登録した push で確認） |
| お知らせ・ピックアップ・通知 | 機能は公開済み。お知らせ（`data/notice.json`）とピックアップ（`data/picks.json`）は、運営者が管理画面から保存すると作られる（まだない） |
| SNS（Bluesky） | アカウント `@topiatsume.bsky.social`（運営者が用意）。プロフィール（名前・説明・アイコン・バナー・サイトの URL）・「自動で投稿するアカウント」（bot）のラベル・固定の紹介の投稿は 2026-10-07 に設定済みで、同日に本番と同じ処理で2件（今日のまとめ・いま話題）を投稿して確かめた。GitHub の Secrets の `BLUESKY_APP_PASSWORD` は運営者が登録済み（2026-10-07。update.yml run #69 のログで値が入っていることを確認。ハンドルは既定値が入るので `BLUESKY_IDENTIFIER` は不要）。管理画面の「今すぐ Bluesky に投稿」も使える。X は使わない（API に無料枠がなく、URL つきの投稿は1件0.2ドル）。Mastodon・Misskey は未設定（任意） |
| AdSense・Google アナリティクス・Search Console | 未設定（変数を設定すると有効になる。Google アナリティクスは上のアクセス解析と併用できる。Search Console は `PUBLIC_GOOGLE_SITE_VERIFICATION` を設定するか DNS で確認し、サイトマップに `https://topiatsume.pages.dev/sitemap.xml` を登録する） |
| Cloudflare Web Analytics | 未設定（任意。Pages のプロジェクトの「Metrics」から無料で有効にできる。自前のアクセス解析と併用できる） |
| 独自ドメイン | なし（収益化の段階で取得を推奨） |

### 主なファイル

| 場所 | 役割 |
| --- | --- |
| `sources.yaml` | 収集元の一覧（任意の設定: `limit`・`excerpt: false`・`summary: false` など） |
| `docs/SOURCES.md` | 収集元の利用条件の確認記録（登録したサイト・見送ったサイトとその理由） |
| `src/config/site.ts` | サイト名・キャッチコピー（`tagline`・`taglineParts`・`subcopy`・`philosophy`）・カテゴリ・運営者情報などの設定 |
| `scripts/fetch-feeds.ts` | フィード取得（ブラウザ相当の通信は `scripts/lib/http.ts`、取得状態の記録は `scripts/lib/feed-state.ts`、同じ運営元のサイトをまとめるのは `scripts/lib/hosts.ts`） |
| `.github/workflows/timer.yml`, `scripts/timer.ts`, `scripts/lib/timer.ts` | 自動更新タイマー |
| `scripts/lib/store.ts` | 記事のマージ・重複（同じ URL・同じ見出し）のまとめ・保存 |
| `scripts/summaries.ts` | 要約のプロンプト作成・取り込み（コマンドライン） |
| `scripts/notify.ts`, `scripts/lib/social.ts`, `src/lib/social-source.ts` | 公開後の通知（IndexNow・WebSub）と SNS（Bluesky）の自動投稿（投稿の種類・時間帯・上限（`SOCIAL_LIMITS`）・本文とリンク（流入元の印・短い表示・ハッシュタグ・リンクカード）・投稿の材料（いま話題・急上昇・今日の重要・AI・今週・AI 要約）。話題はサイトのビルドと同じ計算なので話題のページの URL と一致する） |
| `src/components/FollowCta.astro`, `src/config/site.ts` の `socialAccounts` | 「Bluesky でフォロー」の案内（トップ・急上昇・話題のページ）と、フッター・サイドバー・構造化データ（`sameAs`）の SNS のリンク |
| `scripts/lib/daily.ts` | 日別まとめ（`data/daily`）の作成。多くのメディアが報じた話題の順に選び、同じ話題の記事は1件だけ載せる |
| `src/lib/summary-core.ts` | 要約のプロンプト・回答の読み取りと検証・要約ファイルの読み書き（管理画面と共通） |
| `src/lib/blocklist-core.ts` | 記事の非表示（NGワード・サイト・個別） |
| `src/lib/related.ts` | 見出しの似ている記事（同じ話題）を探す・話題ごとにまとめて話題度を数える（`clusterTopics`） |
| `src/lib/topics.ts` | トピック（`getTopicViews`: 話題度・急上昇・初報・AI 要約・タグつき）、今話題（`getHotTopics`）・急上昇（`getRisingTopics`）・今日の注目（`getImportantTopics`）・注目ワード（`getTrendWords`）・メディア別（`getMediaStats`）・タグの記事、記事ごとの媒体の数（`coverageOf`）、トピックの説明（`topicWhy`・`topicScoreBreakdown`・`topicMomentum`・`momentumText`）、ニュースの温度（`getGenreTemperature`）・今日の数字（`getTodayCounts`）・今日、変化したこと（`getTodayChanges`） |
| `src/lib/topic-core.ts`, `src/lib/tag-core.ts`, `src/config/tags.ts` | トピックの数字の計算（ID・初報・新しく報じた媒体の数・話題度とその内訳・ある時点の熱さ・勢い・なぜ話題？・ニュースの温度・重要度・注目ワード。Node の機能を使わない）とタグの定義・当てはめ |
| `src/pages/index.astro`, `src/pages/trends.astro`, `src/pages/genres.astro` | トップ（今日のダッシュボード）・トレンド（今日の変化・温度・注目ワード・報じられ始めたトピック）・ジャンル（ジャンル・テーマ・読み方から探す入口） |
| `src/pages/topic/[id].astro`, `src/pages/rising.astro`, `src/pages/ranking.astro`, `src/pages/tag/[slug].astro`, `src/pages/tags.astro` | トピックのページ（各媒体の報道の比較）・急上昇・話題のランキング（と今日の注目）・テーマ（AI ニュースランキングなど）・テーマ一覧 |
| `src/components/TopicList.astro`, `FocusTopics.astro`, `NewsTemperature.astro`, `TodayChanges.astro`, `ImportantList.astro`, `TrendWords.astro`, `MediaStats.astro`, `SummaryLevels.astro` | トピックのカード（どの一覧でも同じ形。話題度と内訳・N媒体・急上昇の印・勢い・なぜ話題？・初報）、今日の5トピック（何が起きた・なぜ話題）、ニュースの温度、今日、変化したこと、今日の注目、注目ワード、メディア別の表、AI 要約の10秒/30秒/2分 |
| `src/components/IconSprite.astro`, `Icon.astro`, `Wrap.astro`, `src/styles/global.css` | 線のアイコン（`<Icon name="heat" />`）、条件つきの入れ物、色（`--heat`・`--rise`）・文字の大きさ（`--fs-*`）・余白（`--sp-*`）・数字の等幅（`.num`）・説明の1行（`.definition`） |
| `src/components/Header.astro` | ヘッダー（5つのメニュー。カテゴリ・タグなどのページでは「ジャンル」を選ぶ。スマホでは均等に並べる） |
| `src/lib/summary-view.ts` | AI 要約の「10秒で読む」（要約の1文目。プロンプトで1文目に「誰が・何を・どうした」を書かせている）など |
| `src/scripts/pwa.ts`, `src/scripts/sw-url.ts`, `src/pages/offline.astro` | サービスワーカーの登録（すべての閲覧者。通知と同じ URL）・「ホーム画面に追加」の案内（2回目以降の訪問。閉じたら30日出さない）・オフラインのページ |
| `src/lib/search-core.ts` | サイト内検索（表記ゆれの吸収・並べ方・一致部分の強調・検索の候補） |
| `src/scripts/reader.ts` | 「あとで読む」と、前回の訪問のあとに届いた記事の印（どちらもブラウザ内だけ） |
| `src/lib/github-commit.ts` | 管理画面から GitHub API で保存・ワークフロー実行 |
| `src/lib/bookmarklet.ts` | 記事の本文をコピーするブックマークレット（AI が記事を開けないときに運営者が使う。管理画面に置いている） |
| `scripts/fetch-texts.ts`, `scripts/lib/text-fetcher.ts`, `scripts/lib/robots.ts`, `scripts/lib/article-text.ts` | 本文の自動取得（依頼の処理・robots.txt と AI の拒否の確認・本文の取り出し） |
| `src/lib/text-crypto.ts`, `src/lib/article-texts.ts` | 取得した本文の暗号化（RSA-OAEP＋AES-GCM）と、依頼・結果・公開鍵のファイルの扱い（管理画面と共通） |
| `data/text-requests.json`, `data/texts.json`, `data/text-keys.json` | 本文の自動取得の依頼（管理画面が書く）・結果（暗号化した本文。自動収集が書く）・運営者の公開鍵（管理画面が書く） |
| `wrangler.jsonc`（ルート）, `functions/api/[[path]].ts`, `public/_headers`, `public/_redirects`, `scripts/redirect-stub.mjs` | Cloudflare Pages の設定（プロジェクト名 `topiatsume`・`dist`・Durable Object の束縛）、サイトの `/api`、応答ヘッダー、以前の URL（`/matmsait/...`）の転送、GitHub Pages 用の転送ページ |
| `analytics/`（`src/index.ts`・`src/front.ts`・`src/core.ts`・`src/store.ts`・`wrangler.jsonc`） | アクセス解析（Cloudflare Workers・SQLite の Durable Object。入口（`front.ts`。Pages の Functions と共通）・受け取り・いま見ている人・今日の集計（メモリ）・日ごとの集計（毎時）・公開の人気記事・運営者用の API）。依存は wrangler だけで、`analytics/package.json` で別に入れる（`wrangler pages deploy` もこれを使う） |
| `.github/workflows/analytics.yml` | アクセス解析の Worker の公開（Cloudflare の Secrets があるときだけ。`analytics/` を変えて push したとき・手動） |
| `src/scripts/analytics.ts` | サイトの計測（閲覧・記事を開いた・検索・保存・閲覧時間・表示中の合図、いま見ている人数の表示、除外・Do Not Track・GPC） |
| `src/pages/admin/analytics.astro`, `src/scripts/admin-analytics.ts`, `src/scripts/charts.ts` | 管理画面のアクセス解析（グラフは SVG で自前に描く。管理画面の CSP で外部のスクリプトを読めないため） |
| `src/lib/analytics-config.ts`, `src/lib/popular.ts`, `scripts/popular.ts`, `src/pages/popular.astro`, `src/components/PopularList.astro` | アクセス解析の接続先、よく読まれている記事（取り込み・ページ・一覧・「人気N位」の印） |
| `data/popular.json` | よく読まれている記事（Cloudflare に公開している自動更新が書く） |
| `src/lib/follow-core.ts`, `src/pages/updates.json.ts` | フォロー・ミュートの照合（ブラウザと通知のサーバーで共通）と、直近の新着・話題のファイル（フォロー中のページ・ヘッダーの数・通知の材料） |
| `src/scripts/personal.ts`, `src/scripts/personal-store.ts`, `src/styles/personal.css` | 読者向けの機能（既読・ミュート・フォローのボタン・記事のメニュー（…）・ヘッダーの新着の数・お知らせを閉じる・先頭に戻る）と、ブラウザへの保存 |
| `src/pages/following.astro`, `src/scripts/following.ts`, `src/pages/settings.astro`, `src/scripts/settings.ts` | 「フォロー中」（新着の一覧・フォローの追加・通知の設定）と「表示の設定」（表示・ミュート・書き出しと読み込み・アクセス解析で数えない） |
| `src/scripts/push-client.ts`, `public/sw.js`, `public/badge-96.png` | ブラウザの通知の登録（サービスワーカー・購読・設定の送信・テスト）と、通知の表示。`sw.js` はオフラインのとき前に見たページ（40件まで）かオフラインのページを出し、`/_astro/` のファイルを使い回す（ページはいつもネットから読む） |
| `analytics/src/push.ts`, `analytics/src/webpush.ts` | 通知のサーバー（購読の保存・新着の確認・40件ずつの送信・お知らせ・集計）と、Web Push の暗号化（RFC 8291）・VAPID（RFC 8292） |
| `src/lib/editorial-core.ts`, `src/lib/editorial.ts`, `src/components/PickList.astro` | お知らせ（`data/notice.json`）とピックアップ（`data/picks.json`）の形・読み込み・トップページの表示 |
| `src/pages/admin/index.astro`（概要）, `summaries.astro`（AI要約・記事）, `content.astro`, `notify.astro`, `src/scripts/admin-dashboard.ts`, `admin-content.ts`, `admin-notify.ts`, `admin-shared.ts`, `src/styles/admin.css` | 管理画面の各ページと共通の処理・見た目（AI要約・記事のページの処理は今までどおり `src/scripts/admin.ts`） |
| `src/lib/admin-auth.ts`, `src/scripts/admin-login.ts`, `src/scripts/admin-common.ts`, `src/pages/admin/login.astro` | 管理画面のログイン（トークンの暗号化・ログイン中の状態・自動ログアウト・続けて間違えたときの制限・枠の中での表示の禁止） |
| `src/pages/admin/`, `src/scripts/admin.ts`, `src/layouts/AdminLayout.astro` | 管理画面（AdminLayout でページの切り替えと、接続先を制限する CSP を指定） |
| `data/items.json` | 収集した記事（1行1記事） |
| `data/summaries/YYYY-MM.json` | AI 要約（記事の公開月ごと） |
| `data/daily/YYYY-MM-DD.json` | 日別まとめ |
| `data/blocklist.json` | 記事の非表示の設定（管理画面から保存すると作られる） |
| `data/social.json` | SNS 投稿の記録（同じ話題を二度投稿しないため。投稿のページの URL つき。`notify` ジョブがコミットし、管理画面の「概要」に出る）と、「今すぐ投稿」の最後の結果（`manual`） |
| `data/social-request.json` | 管理画面の「今すぐ投稿」の依頼（ID と日時。管理画面が書き、`notify` が `data/social.json` の `manual.id` と照らし合わせて未処理なら投稿する） |
| `data/feeds.json` | 収集元ごとの取得の状態（ETag・Last-Modified・最後に取得できた日時・連続失敗の回数と最後のエラー） |

### 確認のしかた

```sh
npm test          # ユニットテスト（vitest）
npm run check     # 型チェック（.astro を含む）
SITE_URL=https://nomixio260-a11y.github.io BASE_PATH=/matmsait npm run build
SITE_URL=https://nomixio260-a11y.github.io BASE_PATH=/matmsait npx astro preview # ビルド結果の確認（ビルドと同じ環境変数が要る。Astro 7 の preview は常駐するので、止めるときは npx astro preview stop）
```

- 管理画面の動作（ログインを含む）は、Playwright で GitHub API をモックして確かめている（実際の GitHub には書き込まない）。ログインの確認には、Playwright の時計の早送り（`clock.fastForward`）で自動ログアウトや待ち時間を再現する。
- Cloudflare での公開と同じ組み合わせは、`cd analytics && npm install && npx wrangler dev --var GITHUB_API:<GitHub API のまね>` で解析の Worker を動かし、`SITE_URL=https://topiatsume.pages.dev BASE_PATH=/ PUBLIC_ANALYTICS_URL=/api npm run build` でビルドしてから、ルートで `analytics/node_modules/.bin/wrangler pages dev --port 8788` を動かして確かめる（http://127.0.0.1:8788。`dist`＋`/api`＋Durable Object。`npx tsc --noEmit`（analytics/）で Worker と Functions の型チェック）。Worker だけなら `PUBLIC_ANALYTICS_URL=http://127.0.0.1:8787` でビルドする。集計とデータの保存の中身は `tests/analytics.test.ts`（node:sqlite で SQL も実行）で確かめている。Playwright で数えさせるときは `navigator.webdriver` を false にする（自動操作のブラウザは数えないため）。
- 通知は、`wrangler dev` に `--var PUSH_TEST_HOSTS:127.0.0.1:9999 --var SITE_URL:http://127.0.0.1:8788` を付けると、偽の届け先（127.0.0.1:9999 で受け取りを記録する小さなサーバー）へ送れる。Playwright で `PushManager.prototype.subscribe` を偽の購読（鍵はテスト側で作る）に差し替え、届いた通知をテスト側で復号して中身を確かめる。サービスワーカーの通知の表示は、フル版の Chromium（`chromium.launch({ channel: 'chromium' })`。ヘッドレス専用版は通知を出せない）と CDP の `ServiceWorker.deliverPushMessage` で確かめる。暗号化は `tests/webpush.test.ts` が RFC 8291 の例と比べている。
- 話題のページ・トップの各セクション・急上昇・タグ・オフライン（サービスワーカー）は、ビルドしたサイトを Playwright で開いて確かめる（スマホの幅で CLS も測る。オフラインは `context.setOffline(true)`）。SNS の投稿内容は `NOTIFY_DRY_RUN=1 NOTIFY_SKIP_PING=1 SITE_BASE_URL=https://topiatsume.pages.dev npm run notify` で送らずに確認できる（`NOTIFY_SKIP_PING=1` は検索エンジン・フィードへの通知を省く）。投稿した中身（リンクの位置・流入元の印・タグ・リンクカード）は、Bluesky の公開 API（`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=topiatsume.bsky.social`）で確かめられる。「今すぐ投稿」は、`data/social-request.json`（`{"id":"…","at":"<いまの日時>"}`）を置いて `NOTIFY_DRY_RUN=1` で動かすと選ばれる投稿が分かる。実際に送る処理は、`BLUESKY_SERVICE` に偽の Bluesky（ログイン・画像・投稿を受けて記録する小さなサーバー）を指定して、本物に投稿せずに確かめる。管理画面のボタンは、Playwright で GitHub API をまねて（依頼の保存と、結果の記録を返す）確かめる。テストで作った依頼・記録のファイルはコミットしない。
- テストのために `data/` に作ったファイル（要約・非表示の設定・お知らせ・ピックアップなど）は**コミットしない**。

---

## 未解決の課題・次にやること

1. **運営者の作業: 通知を自分の端末で確かめる。** 公開後、サイトの「フォロー中」（ヘッダーのベル）で何かをフォローして通知をオンにし、「テストの通知を送る」で届くかを確かめる（iPhone・iPad は Safari の共有ボタンから「ホーム画面に追加」して、そのアイコンから開いたときだけ使える。iOS 16.4 以降）。新着の通知は毎時の公開のあとに送る（公開後の最初の確認はそれまでの記事を記録するだけで送らないので、届き始めるのはその次の更新から）。管理画面の「通知」で登録者数と送った記録を見られる。
2. **チャットに貼られた Cloudflare の API トークン**を作り直した（Roll）かは、こちらからは確認できなかった（確かめる操作は権限の都合で行えなかった）。Cloudflare のダッシュボード（My Profile → API Tokens）で、作り直したこと・Secrets に新しい値を登録したことを確かめる（同じトークンから作られた R2 のアクセスキーも、作り直せば無効になる）。使っていない Worker `matmsait`（ダッシュボードのひな形）は消してよい。トークンや Account ID はチャットやリポジトリに書かない。
3. 通知の無料枠の注意: 購読は2万件まで（`analytics/wrangler.jsonc` の `MAX_PUSH_SUBSCRIBERS`）、1回の処理で外へ送れるのが50件までなので40件ずつ送り、残りは1秒ごとのアラームで続ける（登録者が数千人を超えて毎時の送信が多くなったら、Workers の有料プランを検討）。送るたびに購読ごとの書き込みはせず、届かなかったときだけ書く。通知を届ける会社の URL（Google・Mozilla・Apple・Microsoft）だけに送る。
4. 一部の掲載元の見出しの末尾にサイト名などの決まり文句が入る（例: 「｜AERA DIGITAL」）。キーワードの候補（いま話題の言葉）は複数の掲載元に出る言葉だけにして避けたが、話題のまとめや検索にも少し影響するので、`sources.yaml` の `stripTitle` で取り除くかを検討する。
5. 収集元の利用条件は `docs/SOURCES.md` のとおり確認したが、最終確認は運営者が行う（規約は変わるので年1回程度見直す）。4Gamer.net と鉄道ファン（railf.jp）は「利用したら一報を」と歓迎しているので、収益化のときに連絡するとよい（任意）。
6. 「N媒体が報道」は見出しの似かたで同じ出来事をまとめているので、言い回しが大きく違う報道はまとまらないことがある（2026-10-07 の分析で、3日分に「同じ出来事なのにまとまっていない」疑いが89組。逆に別の出来事をまとめてしまう誤りは見つかっていない。`docs/REDESIGN.md` の「クラスタリング・データ品質」）。全面改善の Phase 3 で、固有の言葉（人名・社名・製品名）を手がかりにした2段目のまとめ方を、誤ってまとめる例を増やさないことを本番のデータで確かめながら入れる予定。調整するときは `src/lib/related.ts` の `clusterTopics` の既定値（`minScore` など）を変え、テストと本番のデータで確かめる。
7. 海外ニュースは、商用サイトで使えるフィードがほとんど見つからなかったため「海外」カテゴリは作っていない（BBC・CNN・AFPBB・聯合ニュースなどは NG）。使えるサイトが見つかったら `src/config/site.ts` にカテゴリを足す。
8. Bluesky の自動投稿は動いている（Secrets の `BLUESKY_APP_PASSWORD` は登録済み）。登録したのがチャットに貼られたアプリパスワードなら、Bluesky の「設定 → プライバシーとセキュリティ → アプリパスワード」で新しく発行して Secrets を登録し直し、古いものを削除するのが安全（任意）。効果はアクセス解析の流入元（SNS）で見て、フォロワーや流入が伸びなければ投稿の時間帯・種類・上限（`scripts/lib/social.ts` の `SOCIAL_LIMITS`）を見直す。フォロー・いいね・返信の自動化は、スパム扱いやアカウント停止のおそれがあるので行わない。
9. 管理画面で編集できる要約は新しい300件まで。それより古い要約は `data/summaries/YYYY-MM.json` を直接編集する。
10. 本文の自動取得で取得できるかはサイトしだい（アクセスを拒否するサイト・本文が動画だけのページ・JavaScript で本文を表示するページは取れない。2026-10-07 からはボットの名前を名乗らずブラウザ相当の通信で取るが、robots.txt と拒否は守り、ボット対策のすり抜けはしない）。取得できない記事は、本文を貼り付けるか同じ話題の別の記事に切り替える。取得結果で断られることが多い掲載元があれば、`summary: false` にするかを考える。
11. AI が開けない記事の記録（どのサイトがどれだけ開けなかったか）は運営者のブラウザにだけ残る（localStorage、14日間）。別の端末では記録がない状態から始まる。どのサイトを AI が開けないかが分かってきたら、`docs/SOURCES.md` に書き残しておくとよい。
12. 収益化の前に: 独自ドメインの取得、AdSense の審査の前に AI 要約を増やす（話題の記事を中心に。審査では独自の内容が重視される）、`ads.txt` の設置、気になる記事の非表示、`src/config/site.ts` の運営者名・問い合わせ先の確認。管理画面の「ピックアップ」のひとことも、運営者の独自の内容として審査で評価されやすい。
13. アクセス解析の注意: Cloudflare の無料プランは1日にリクエスト10万回・SQLite の書き込み10万行・読み込み500万行が上限（ページを見るごとに1回、表示中は2分ごとに1回（2026-10-07 に1分から変更）、離れるときに1回送る。1ページあたり2〜3回なので、月100万PV（1日3万3千PV）でほぼ上限。上限を超えても、サイトの表示は止まらず計測だけが止まる）。記録は1日4万件まで（`MAX_EVENTS_PER_DAY`）。足りなくなったら Workers の有料プラン（月5ドル）にするか、合図の間隔（`src/scripts/analytics.ts` の `PING_INTERVAL`）を延ばす。訪問者は「IP アドレス＋ブラウザの種類＋日ごとの塩」で数えるので、携帯電話の回線（多くの人が同じ IP を使う）で同じ機種・同じブラウザの人が1人に数えられることがある。人気の順位は同じ人を1回だけ数えるが、多くの IP から送れば操作はできる（おかしな順位に気づいたら、管理画面で記事を非表示にできる）。「いまN人が閲覧中」は2人以上のときだけ出す（`data-min`）。 検索エンジンには新しい URL（pages.dev）を覚え直してもらう必要がある（以前の URL は GitHub Pages の制約で 301 ではなく転送ページ。2026-10-07 からページごとに正規の URL と即時の転送を入れている。Search Console を使うなら新しい URL で登録する）。

14. 話題のページの URL は「話題の最初の記事の ID」なので、あとから届いたもっと早い記事で話題がつながると URL が変わる（古い URL は 404 になる。めったにない）。また話題をまとめる期間（直近8日）を過ぎると話題のページも消える（その日の話題は日別まとめに残る）。検索からの流入が増えてきたら、話題を `data/` に残して長く公開するかを検討する。
15. 話題度スコア・急上昇・注目ワードの数値は、2026-10-07 時点の記事（1日約1000件・66メディア）で決めた。1時間に新しく報じられる話題は少ない（日中でも3時間で数件）ので、急上昇は3時間で数えている。収集元が増えたり減ったりしたら、`src/lib/topic-core.ts` の定数（`HALF_LIFE_HOURS`・`SCORE_SCALE` など）を本番のデータで見直す。タグ（`src/config/tags.ts`）は本番の見出しで当てはまり方を確かめてから足す。
16. 「◯媒体が報道」は掲載元（媒体）の数なので、同じ会社の複数の媒体（例: Impress の PC Watch・ケータイ Watch など）は別々に数える（2026-10-08 に表記を「◯社」から「◯媒体」に変えたのはこのため。about の「言葉の意味」にも書いた）。気になるようなら `sources.yaml` に運営会社を足して数え方を変えることを検討する。
17. 「今すぐ投稿」は、管理画面が `data/social-request.json` を保存した push で `update.yml` が動くことを前提にしている。`update.yml` の push の条件（`paths-ignore`）を変えるときは、このファイルが対象から外れないようにする。投稿までの約2分は、記事の取り込みとサイトの公開を待つ時間（リンク先のページが必ずあるように、公開してから投稿する）。
18. **全面改善の続き（`docs/REDESIGN.md` の Phase 2〜4）**: Phase 1（ブランド・見た目・トップ・メニュー）は 2026-10-08 に公開した。次は Phase 2（トピックのページの刷新: なぜ話題？・10秒/30秒/2分・各媒体の見出しの比較・報道のタイムライン・報道の広がり・話題度の推移・関連と過去のトピック・折りたたみ。AI 整理（共通の事実・各媒体が強調している点・報道の違い）は、費用のかかる AI API を使わず、運営者が管理画面のプロンプトでチャット AI に作らせて貼り付ける形にする）→ Phase 3（キーワード・人物・企業のページ、検索をトピック・キーワード・記事に分ける、トピックのまとめ方の改善と管理画面での統合・分割）→ Phase 4（注目ワードの表・急に現れた言葉・言葉の組み合わせ・ジャンルの変化・昨日との比較・週間）。
19. Bluesky のプロフィールのバナー・説明は、まだ前のキャッチコピー（「いま何が話題か、一瞬でわかる。」）のまま（サイトと共有画像は新しいコピーにした）。そろえるなら、バナーの画像と説明文を新しいコピーで作り直して API で更新する。
20. トップの「今日の数字」の「今話題」は話題度30以上のトピックの数（`src/lib/topics.ts` の `HOT_SCORE_MIN`）。「急上昇」の件数は急上昇の一覧の件数、「今日の注目」は今日の注目の件数、「注目ワード」は注目ワードの数。夜中は急上昇が少なく0件のこともある。ニュースの温度の矢印は、昨日の同じ時刻の熱さと比べて1.2倍以上で上向き・0.8倍以下で下向き（差が小さいときは横ばい）。

（解決済み: Bluesky の Secrets（`BLUESKY_APP_PASSWORD`）は 2026-10-07 に運営者が登録した。GitHub の Secrets（Cloudflare）の登録と新しい URL の管理画面の初回設定は、2026-10-07 に運営者が行い、毎時の更新が pages.dev に公開されることを確かめた。はてなブックマークの商用利用の問題と、外した収集元・要約を禁じている掲載元の要約は、2026-10-06 に削除して解決した。管理画面のパスワードの設定し直しは、2026-10-07 に運営者が行った（本文を読むための公開鍵も登録済み）。下の記録を参照）

---

## 開発の記録（新しい順）

### 2026-10-08 全面改善 Phase 1: ブランドと見た目（トップを「今日のダッシュボード」に・話題度と急上昇の意味の見せ方・なぜ話題？・ニュースの温度・今日の変化・メニューを5つに・アイコンと色の決まり）

- 依頼・目的: 運営者の「トピあつめ 全面改善指示書」。コンセプトは「ニュースを「記事」ではなく「話題」で読む。」で、「普通のニュースサイトじゃない」「効率よく理解できそう」「また明日も開きたい」と感じてもらえる、ニュースの変化を見せるサイトにする。指示どおり、まずコードを変えずに現在のサイトとコードを分析し（`docs/REDESIGN.md`。2026-10-07 に push 済み）、Phase 1 → 2 → 3 → 4 の順に実装する。今回は Phase 1（ブランド・UI）。既存の機能は消さない。
- やったこと:
  - **ブランド**: キャッチコピーを「ニュースを「記事」ではなく「話題」で読む。」、サブコピーを「複数のメディアを横断して、何が起きたか、どれだけ広がっているか、各社がどう報じているかを一目で。」、考え方を「記事を集める。話題を整理する。変化を見つける。」にした（`src/config/site.ts`）。サイトの説明（description）・共有画像（`public/og.png`。チップは 話題度・急上昇・各社の報道を比較・今日の変化）も同じ言葉にした。about に考え方の3段・中立の方針（重要か・正しいかは判断しない、煽る表現は使わない）・**言葉の意味**（トピック・◯媒体が報道・話題度・急上昇・初報・今日の注目・注目ワード・ニュースの温度。`/about/#terms`）を足した。
  - **言葉をそろえた**: 同じ出来事の記事のまとまりは「トピック」、「◯社が報道」は「◯媒体が報道」（同じ会社の別の媒体を別に数えているため）、初報は「最初に確認できた報道」（最初に報じた媒体が正しいという意味ではないと注記）、「今日の重要ニュース」は「今日の注目」（重要度の判断ではないと注記。Bluesky の朝の投稿も「今日の注目ニュース」に）。Bluesky の投稿（「🚀 急上昇（3時間で+N媒体・計N媒体が報道）」「🔥 いま話題（N媒体が報道・話題度S）」、リンクカードのタイトル「｜N媒体の報道を比較」）・通知・管理画面の文面もそろえた。
  - **トップページ**（`src/pages/index.astro`）を「今日のダッシュボード」に作り直した。順番は キャッチコピーと「24時間でN記事 → Nトピック」・今話題／急上昇を見るボタン → 今日の数字（今話題（話題度30以上）・急上昇・今日の注目・注目ワードの件数）→ **今日のニュースの温度**（ジャンルごとの熱さの横棒と、昨日の同じ時刻と比べた矢印）→ **今日、変化したこと**（昨日の同じ時刻と比べたジャンルの増減・急に増えた言葉・報道が広がったトピック・報じられ始めたトピックの数・トピックの総数。数字から機械的に作る）→ 編集部のピックアップ → 今話題のトピック（話題度の内訳・なぜ話題？）→ 急上昇のトピック（勢い）→ **今日の5トピック**（何が起きた（AI 要約の1文目）・なぜ話題）→ 注目ワードと検索 → 新着（時刻のタイムライン10件）。スマホ（390px）の縦の長さは 15,349px → 約9,800px。トップから外した AI ニュース・10秒でわかるニュース・よく読まれている記事・カテゴリ別は「ジャンル」のページから、メディア別は掲載元一覧（`/sources/`）で見られる（機能は消していない）。
  - **話題度と急上昇の意味が分かる見せ方**: どの一覧にも「話題度＝今どれくらい話題か」「急上昇＝どれくらいの速さで広がっているか」の1行の説明を付けた。話題度は数字と目盛りで、押すと内訳（報道の件数・新しさで重みづけした件数・ジャンルの広がりの倍率・読まれた数・計算のしかたへのリンク）が開く。急上昇は「3時間で2→7媒体」と「直前6時間の3.0倍のペース」「この時間に報じられ始めました」などの勢いを出す（急上昇の一覧では、重なる「急上昇中」の印と「+N媒体」は出さない）。**なぜ話題？**は「最初の報道から2時間で3媒体が報じました。「テクノロジー」「ゲーム・アニメ」の2ジャンルの媒体に広がっています。」のように報道の状況だけを書く（同じ時刻に一斉に報じられたときは「1時間以内に」）。
  - **新しい計算**（`src/lib/topic-core.ts`）: 話題度の内訳（`scoreBreakdown`）・ある時点の熱さ（`heatAt`。昨日の同じ時刻との比較用）・勢い（`momentumOf`）・時間の表記（`durationText`）・なぜ話題？（`whyTrending`）・ニュースの温度（`genreTemperature`。トピックをいちばん多く報じたジャンルに振り分けて熱さを足す）。`src/lib/topics.ts` に、ページで使う形（`topicWhy`・`topicScoreBreakdown`・`topicMomentum`・`momentumText`・`getGenreTemperature`・`getTodayCounts`・`getTodayChanges`・`quoteTitle`・`paceText`（10倍以上は「10倍以上」とだけ書き、大げさに見せない））を足した。
  - **トピックのカードを1種類に**（`src/components/TopicList.astro`）: 状態（急上昇中・NEW）→ 題名 → 話題度・N媒体が報道・3時間で+N媒体 → 勢い・なぜ話題？ → 初報（最初に確認できた報道）と時間 → ほかの媒体の見出し（「ほかN媒体の報道を比べる」）。新着は時刻を左に並べたタイムライン（`ItemRow` の `timeline`）。
  - **メニューを5つに**（`src/components/Header.astro`）: 14個あったタブを「ホーム・話題・急上昇・トレンド・ジャンル」にした。新しいページ **`/trends/`**（今日、変化したこと・ニュースの温度・注目ワード30語・報じられ始めたトピック）と **`/genres/`**（ニュースの温度・ジャンルのカード（24時間のトピックと記事の数・いちばん話題のトピック）・テーマ（タグ）のカード・読み方から探す（AI ニュース・10秒で把握・よく読まれている・新着・日別アーカイブ・メディア一覧））。カテゴリ・タグ・AI 要約・人気・掲載元のページでは「ジャンル」が選ばれた状態になる。スマホでは5つを均等に並べ、横スクロールしない（320px でも1行）。フッターにも急上昇・トレンド・ジャンルを足した。
  - **見た目の決まり**（`src/styles/global.css`・`items.css`）: 話題度＝赤（`--heat`）、急上昇＝紫（`--rise`）、今日の注目＝星（ダークモードの色も別に用意）。絵文字（🔥🚀など。端末で見た目が変わる）をやめて線のアイコン（`src/components/IconSprite.astro` の symbol と `Icon.astro`）にした。文字の大きさ（`--fs-caption`〜`--fs-display`）・余白（`--sp-1`〜`--sp-6`）・数字の等幅（`.num`）・説明の1行（`.definition`）を共通にした。キャッチコピーは狭い画面でも言葉の途中で折り返さないように区切りを決めた（`taglineParts`）。
  - そのほか: 急上昇・ランキングのページの見出しと説明を新しい言葉に（急上昇のページはフォローの案内を一覧の下に移した）、ジャンルのカードはスマホでも2列、注目ワードの「×N」（ふだんの何倍）と「新」（ふだんほとんど出てこない言葉）、検索の候補の見出しを「いま多くの見出しに出ている言葉」に。
- 主な変更ファイル: `src/config/site.ts`、`src/lib/topic-core.ts`・`src/lib/topics.ts`、`src/pages/index.astro`・`trends.astro`（新規）・`genres.astro`（新規）・`ranking.astro`・`rising.astro`・`about.astro`・`sources.astro`・`topic/[id].astro`・`category/[slug]/[...page].astro`・`search.astro`・`following.astro`、`src/components/TopicList.astro`・`FocusTopics.astro`（新規）・`NewsTemperature.astro`（新規）・`TodayChanges.astro`（新規）・`IconSprite.astro`（新規）・`Icon.astro`（新規）・`Wrap.astro`（新規）・`Header.astro`・`Footer.astro`・`Sidebar.astro`・`ItemRow.astro`・`ItemList.astro`・`TrendWords.astro`・`MediaStats.astro`・`ImportantList.astro`、`src/layouts/BaseLayout.astro`、`src/styles/global.css`・`items.css`・`personal.css`、`scripts/lib/social.ts`・`analytics/src/push.ts`（投稿・通知の文面）、管理画面の文面（`src/scripts/admin*.ts`・`src/pages/admin/`）、`public/og.png`、テスト（`tests/topic-core.test.ts`・`tests/social.test.ts`・`tests/push.test.ts`）、`README.md`
- 確認したこと: `npm test`（32ファイル・294件。話題度の内訳・ある時点の熱さ・勢い・時間の表記・なぜ話題？（6通り）・ニュースの温度のテストを追加）・`npm run check`（0 errors）・`npm run build`（552ページ）。ビルドしたサイトを Playwright で開き、トップ・ジャンル・トレンド・急上昇・ランキング・about・掲載元一覧を 390px・1280px × ライト・ダークで撮って見た（横のはみ出しなし・CLS 0・ページのエラーなし（掲載元一覧の一部の掲載元のアイコンが外部のサービスで404になるのは以前から））。見て直したこと: キャッチコピーが「では／なく」で折り返していた、ジャンル名（ゲーム・アニメ）が途中で切れていた、「なぜ話題？」の文がラベルの次の行に回っていた、急上昇のカードで同じ増え方を3回書いていた、新着の「…」ボタンが次の行に回っていた、話題度の内訳がカードの横に出ていた。axe で14ページ（トップ・ジャンル・トレンド・急上昇・ランキング・about・掲載元・カテゴリ・新着・検索・トピック2つ・AI 要約・日別）× 390/1280 × ライト/ダークに違反なし。320px と 390px でメニューの5つが1行に収まること、話題度の内訳が開いて数字の下に出ること、「今話題を見る」で見出しまで移動することを確かめた。
- 残った課題・注意点: 「未解決の課題」の6（トピックのまとめ方）・18（Phase 2〜4）・19（Bluesky のバナー）・20（今日の数字の決め方）。トピックのページの本格的な作り直し（なぜ話題？・タイムライン・推移・AI 整理）は Phase 2 で行う。

### 2026-10-07 管理画面の「今すぐ Bluesky に投稿」（押すと最新の話題をすぐに投稿）

- 依頼・目的: 運営者から「管理画面で手動でボタンを押したら、即時にリアルタイムの最新の自動投稿をするように」。
- やったこと:
  - **仕組み**: Bluesky のアプリパスワードは GitHub の Secrets にしかない（管理画面のブラウザには置かない）ので、投稿は今までどおり GitHub Actions で行う。ボタンを押すと、管理画面が依頼（`data/social-request.json`。依頼ごとの ID と日時）を GitHub に保存し、その push で `update.yml` が始まる。最新の記事を取り込んでサイトを公開したあと、`notify` が未処理の依頼（`data/social.json` の `manual.id` と違う ID）を見つけて投稿し、結果を `manual` に書いてコミットする。管理画面は10秒ごとに `data/social.json` を読み（GitHub の応答は60秒キャッシュされるので、キャッシュを使わない指定 `fresh` を `readFile` に追加）、結果が出たら「投稿しました」と、投稿へのリンク（Bluesky で見る・サイトのページ）を表示する。本番の実測では、push から投稿の処理の完了まで約2分（下の「待ち時間を短くした」のあと。run #72 で2分0秒）。ブラウザから Bluesky に直接投稿する案は、アプリパスワードをブラウザに置くことになり、まだ公開していない最新の話題のページへのリンクになってしまうので採らなかった。`workflow_dispatch` の入力で投稿させる案は、`notify` の待ち行列（concurrency）で後から来た実行に取り消されると依頼が消えるので、ファイルで依頼を残す形にした（次に動いた `notify` が拾う）。
  - **何を投稿するか**（`scripts/lib/social.ts` の `planPosts` の `manual`）: 深夜・前の投稿からの間隔・種類ごとの1日の上限を待たずに、まだ投稿していない話題を 急上昇 → いま話題 → 10秒でわかるニュース の順に1件。どれもなければ新しく「いま話題のニュース」のまとめ（話題度の高い順に5件・トップページへのリンク。同じ時間帯は1回まで）。その時間帯の決まった投稿（朝・昼・夜・日曜）がまだなら、それも一緒に投稿する。同じ話題は二度投稿しない。誤って何度も押したときの歯止めとして、自動投稿と合わせて24時間に24件まで。30分以上たっても処理されなかった依頼は投稿しない（結果は `expired`）。
  - **待ち時間を短くした**: `notify` が GitHub Pages の転送ページの公開（`deploy` ジョブ。本番の実測で13秒〜1分12秒）の完了とジョブの起動を待っていたため、Cloudflare に公開しているときは待たずに動くようにした（`needs: build`。Cloudflare への公開は `build` の中で終わっている）。GitHub Pages に公開しているとき（予備の設定）は、公開したサイトの `admin/data.json` の作成日時が今回のビルドの日時になるまで待ってから知らせる（最大10分。`build` が `cloudflare`・`built_at` を出力）。run #72 で、`notify` が `build` の4秒後に（`deploy` と並んで）始まり、待つ手順が省かれることを確かめた。
  - **結果の表示**: 投稿した（リンクつき）／新しい話題がなかった／Secrets（`BLUESKY_APP_PASSWORD`）が未登録（登録ページへのリンク）／失敗（Bluesky にログインできないときはアプリパスワードの確認を案内）／上限／依頼が古い、を出し分ける。待っている間はボタンを押せない。ページを開き直しても、処理中の依頼があれば結果を待つ。「最近の投稿」も開いたときに GitHub の最新の記録から表示し直し、投稿へのリンク（Bluesky で見る）を付けた（投稿の記録に URL を残すようにした）。
- 主な変更ファイル: `scripts/lib/social.ts`（`manual`・`nowPost`・`pendingRequest`・`recordManual`・`reachedDailyLimit`・投稿の URL）、`scripts/notify.ts`（依頼の処理と結果の記録）、`.github/workflows/update.yml`（`notify` が GitHub Pages の公開を待たない）、`src/lib/github-commit.ts`（`readFile` の `fresh`）、`src/pages/admin/index.astro`・`src/scripts/admin-dashboard.ts`（ボタン・結果・最近の投稿）、テスト（`tests/social.test.ts`・`tests/github-commit.test.ts`）、`README.md`
- 確認したこと: `npm test`（32ファイル・288件）・`npm run check`・`npm run build`。`scripts/notify.ts` を手元で動かし、依頼があると送信なしの確認で選ばれる投稿が出ること、認証情報がなければ `no-credentials` を記録すること、処理済みの依頼は二度処理しないこと、偽の Bluesky（`BLUESKY_SERVICE`）に向けて実際に送る処理を動かし `posted` と投稿の URL（`https://bsky.app/profile/…/post/…`）を記録すること、パスワードが違うと `failed` と理由を記録することを確かめた。手元の Cloudflare と同じ構成で、管理画面を Playwright で操作し（GitHub API はまね）、依頼の保存（`data/social-request.json`・コミットの説明）→ 待機中はボタンを押せない → 結果と投稿へのリンク → 最近の投稿への反映、未登録の案内と登録ページへのリンク（スマホの幅・ダーク）、開いたときに処理中の依頼の結果を待つこと、保存に失敗したらすぐ押し直せること、結果の読み込みがキャッシュを使わないこと、axe で違反なし・横のはみ出しなし・ページのエラーなしを確かめた。本物の Bluesky への投稿と、本番での依頼の処理は、テストのデータをコミットしないために行っていない（運営者がボタンを押したときに動く）。
- 残った課題・注意点: 「未解決の課題」の17（push の条件）。Secrets（`BLUESKY_APP_PASSWORD`）は運営者が登録済みなので、ボタンを押すと本当に投稿される。

### 2026-10-07 SNS を Bluesky の完全自動投稿に（X を外す・プロフィールの設定・週のまとめ・10秒でわかるニュース・流入の計測・フォローの案内）と、日別まとめの同じ話題の重複の解消

- 依頼・目的: 運営者から「X は使えないので Bluesky で自動投稿する。アカウント @topiatsume.bsky.social を使い、プロフィールやアイコンも好きにしてよい。完全自動でマーケティングするように」。アプリパスワードはチャットで受け取った（リポジトリ・ドキュメント・ファイルには書いていない）。
- やったこと:
  - **Bluesky のアカウントの設定**（API で実施。リポジトリの変更ではない）: 表示名「トピあつめ｜いま話題のニュース」、説明（何が届くか・自動投稿のアカウントであること・サイトの URL）、サイトの URL、アイコン（サイトのアイコンと同じ図柄。丸く切り抜かれても欠けない大きさ）、バナー（「いま何が話題か、一瞬でわかる。」と、いま話題・急上昇・AIニュース・各社の報道を比較）、**「自動で投稿するアカウント」（bot）のラベル**（自己申告のラベル `bot`。Bluesky のアプリで名前の横にロボットの印が出る）、固定の紹介の投稿（サイトへのリンクカードつき）。
  - **自動投稿の作り直し**（`scripts/lib/social.ts`）: X の投稿の処理と X 用の Variables・Secrets を削除（API に無料枠がなく、URL つきの投稿は1件0.2ドルのため）。Bluesky を中心に、投稿の種類を「朝の今日の重要ニュース・昼の AI ニュース・夜の今日の話題ニュース・**日曜の今週の話題ニュース TOP5**（新規）・急上昇・いま話題・**10秒でわかるニュース**（新規。AI 要約の1文目と話題のページ）」にした。上限は1日12件・急上昇などは1時間あけて1回1件・種類ごとに1日の上限・深夜は投稿しない・同じ話題は二度投稿しない（10秒でわかるニュースで投稿した話題も含む）。
  - **本文とリンク**: 本文の URL は短い表示（例: `topiatsume.pages.dev/topic/077d…`）にして、そこに流入元の印（`utm_source=bluesky&utm_medium=social&utm_campaign=<種類>`）付きのリンクを付ける（Bluesky の文字数300の節約と、アクセス解析で SNS からの流入を数えるため）。`#ニュース` とタグごとのハッシュタグ（`src/config/tags.ts` に `hashtags` を追加。例: AI は `#AI #生成AI`、MLB は `#MLB #大谷翔平`）をタグとして付け、リンクカードにはサイトの共有画像（`public/og.png`）を付ける（1回の実行で1度だけアップロードして使い回す）。投稿の材料は `src/lib/social-source.ts` にまとめ、管理画面の下書きと同じ計算にした。
  - **共有画像とキャッチコピー**: `public/og.png` とヘッダーのキャッチコピー（`src/config/site.ts` の `tagline`）を、バナーと同じ「いま何が話題か、一瞬でわかる。」にそろえた（リンクカード・シェア・プロフィール・サイトで同じ言葉が出るように）。
  - **サイトからのフォローの案内**: `src/config/site.ts` の `socialAccounts` に Bluesky を登録（フッター・サイドバーのリンクと、トップページの構造化データ `sameAs`）。「Bluesky でフォロー」の案内（`src/components/FollowCta.astro`）をトップ（急上昇の下）・急上昇・話題のページに置いた（リンクに `rel="me"`）。ランキングのページは `#week` で開くと「1週間」のタブを出す（週のまとめの投稿のリンク先）。
  - **管理画面**: 「概要」のカードを「SNS（Bluesky）の自動投稿」にし、最近の投稿（種類・日時・サービス・サイトのページ）と、次に投稿されうる内容の下書き（Bluesky の投稿画面を開く・コピー）を出す。
  - **日別まとめの重複の解消**（`scripts/lib/daily.ts`）: 日別まとめの「多くのメディアが報じたニュース」に同じ話題の記事が何件も並んでいた（10/7 は INZONE の記事が5件など。夜のまとめの投稿も同じ）。日別まとめを作るときに、話題のまとまり（`clusterTopics`）ごとに1件（話題度・AI 要約・新しさの順でいちばん上の記事）だけを載せ、空いた枠に別の話題を入れるようにした。見出しの似かただけで重複を除く案も試したが、本番のデータで別々の出来事（別の日の「高市総理ビデオメッセージ」・別の会社の不正アクセス）をまとめてしまったので採らなかった。直近3日分は毎時作り直すので次の更新で直る（それより前の 10/4 は1件だけ重複が残る）。
  - 公開後の通知に `NOTIFY_SKIP_PING=1`（検索エンジンへの通知を省いて SNS の投稿だけ行う）を追加。
  - 投稿の記録のコミット（`update.yml` の「投稿の記録をコミット」）は、今回投稿したとき（記録が変わったとき）だけ行うようにした（投稿しなかった回が、ほかで更新された記録を古い内容で上書きしないように）。
- 主な変更ファイル: `scripts/lib/social.ts`・`scripts/notify.ts`・`src/lib/social-source.ts`（新規）・`.github/workflows/update.yml`（SNS・投稿の記録のコミット）、`src/config/site.ts`・`src/config/tags.ts`、`src/components/FollowCta.astro`（新規）・`src/pages/index.astro`・`rising.astro`・`topic/[id].astro`・`ranking.astro`、`src/pages/admin/data.json.ts`・`admin/index.astro`・`src/scripts/admin-dashboard.ts`（管理画面）、`scripts/lib/daily.ts`（日別まとめ）、`public/og.png`、`data/social.json`（実際の投稿の記録）、テスト（`tests/social.test.ts` を書き直し、`tests/daily.test.ts` を更新）、`README.md`
- 確認したこと: `npm test`（32ファイル・282件）・`npm run check`・`npx tsc --noEmit`（analytics/）・`npm run build`（452ページ）。日別まとめは本番の記事データの写しで作り直し、10/5〜10/7 の上位が別々の話題になること（10/7 は68件→69件で、INZONE などが1件ずつ）を確かめた。ビルドしたサイトを Playwright で開き、フォローの案内（トップ・急上昇・話題のページ、ライト・ダーク × 1280px・390px）・リンク先と `rel`・フッターのリンク・`/ranking/#week` で1週間のタブ・構造化データの `sameAs` を確かめ、axe で違反なし・横のはみ出しなし（ボタンの青は白い文字とのコントラストが足りなかったので濃くした）。手元の Cloudflare と同じ構成で、管理画面の最近の投稿（新しい順・話題のページへのリンク）と下書き（Bluesky の投稿画面のリンクに文面が入る・X のリンクはない）を確かめた。**本番と同じ処理（`scripts/notify.ts`）で Bluesky に実際に2件（10/7 の今日の話題ニュース・いま話題の「ファイティングゴルフ」）を投稿**し、公開 API で、短い表示のリンクに流入元の印つきの URL が付くこと（UTF-8 のバイト位置が合っていること）・ハッシュタグ・リンクカード（画像つき）・bot のラベル・言語（ja）を確かめ、プロフィールの画面も確かめた。投稿の記録は `data/social.json` に入れた（Secrets を登録したあとに同じ投稿をしないため）。
- 残った課題・注意点: 「未解決の課題」の8（Secrets の `BLUESKY_APP_PASSWORD` の登録。登録するまで毎時の自動投稿は動かない）。フォロー・いいね・返信の自動化はしていない（スパム扱いやアカウント停止のおそれ）。

### 2026-10-07 「いま何が話題か一瞬で分かる」サイトへ: 話題度スコア・急上昇・話題のページ（各社の比較）・トップの作り直し・タグ・10秒/30秒/2分・SEO・SNS・WAU/MAU・PWA

- 依頼・目的: 運営者から「アクセス数・リピーターを増やすために大幅改善」。ニュースまとめから「今何が話題なのか一瞬で分かるサイト」へ。今話題・急上昇・話題度スコア・何社が報道しているかの可視化・1/3/24時間の増加量・新しく報じられたニュースの検出・今日の重要ニュース・AI 要約の10秒/30秒/2分・ニュースごとのページ・関連ニュース・各社の報道の比較・AI ニュースのランキング・タグのページ、トップページの作り直し、SEO（sitemap.xml・構造化データ・OGP など）、SNS の自動投稿の設計（スパム対策・無料優先）、無料のアクセス解析（WAU/MAU など）、PWA、著作権の点検。条件は「現在のサイトを実際に確認する・良い機能は残す・推測で実装しない・重い機能や不要な機能を増やさない・無料優先・実際にアクセスが増える施策を優先」。
- 現在のサイトの確認（本番）: スマホ（390px）とパソコン（1280px）で画面を撮り、速さを測った。トップの HTML は 233KB（転送 26KB）、スマホのトップは **CLS 0.12**（「良い」の 0.1 を超える。原因は「◯分前」の書き換えで行の幅が変わり、「いま話題」の行が上下にずれること）。sitemap.xml は 404（`sitemap-index.xml` だけ）。記事データ（2507件・1日約1000件・66メディア）で話題の統計を取り、24時間に2社以上が報じた話題は約40件（5社以上は2件）、1時間に新しく報じられる話題は日中でも1件程度・3時間で約9件だったので、急上昇は「3時間」で数え、少ないときは時間を広げることにした。見出しを機械的に区切った言葉は「発表」「判明」ばかりになったので、注目ワードの候補は AI 要約のキーワード（固有名詞）に限った（山本由伸・大谷翔平・INZONE などが上位に出ることを確認）。よく読まれている記事（アクセス解析）はまだデータがない（`data/popular.json` が空）。
- やったこと:
  - 話題エンジン（`src/lib/topic-core.ts`・`src/lib/topics.ts`）: 話題の ID（最初の記事の ID）・初報・メディアごとの最初の報道・1/3/24時間に新しく報じたメディアの数・**話題度スコア**（報道1件ごとに1、12時間で半分、分野の広がりで上乗せ、読まれた人数を少し足し、0〜100 の目盛りに）・急上昇・報じられ始めた話題・重要度（今日の重要ニュース。分野ごとに件数の上限）・注目ワード・メディア別（話題の数・初報の数）。「いま話題」は報道の数だけでなくスコア（新しさ）の順にした。
  - **話題のページ**（`/topic/<ID>/`。2社以上の話題すべて。今回のデータで68ページ、うち検索エンジンに出すのは3社以上か AI 要約のある21ページ）: 話題度スコア・報じたメディアの数（点の数でも表示）・初報・1/3/24時間の増加、AI 要約（10秒/30秒/2分）、**各メディアの報道を報じた順に比較**（初報の印・「初報から2時間後」・続報）、**報道の広がりのグラフ**（報じたメディアの数の累計。SVG）、関連する話題（同じタグ・見出しの似た話題・同じ分野）、分野の新着。構造化データは CollectionPage＋ItemList＋パンくず、OGP は article（公開・更新の日時つき）。記事の「◯社が報道」、話題の一覧の見出し、フォロー中のページ、いま話題の通知、SNS の投稿から開く（サイトの中の回遊と、検索から入る入口を増やすため）。記事ごとのページ（要約のない記事1件ずつ）は、中身が見出しと抜粋だけの薄いページになり検索エンジンの評価を下げるおそれと著作権の点から作らず、2社以上の話題と AI 要約のある記事だけにした。
  - **トップページの作り直し**（スマホ優先）: 「24時間で◯件の記事・◯件の話題」とページ内の移動ボタン、🔥いま話題（スコア・N社・3時間の増加・ほかの報道）、🚀急上昇（いま話題と重ならないもの）、🔎注目ワード（タグの言葉はタグのページへ、ほかは検索へ）と検索の入力欄、📰今日の重要ニュース（分野ごとに1件）、🤖AI ニュース、AI 要約（10秒の1文）、📊メディア別（初報の多い順）、よく読まれている記事、新着（30件→20件）、カテゴリ別（6件→4件）。編集部のピックアップは今までどおり。HTML は 233KB → 187KB。
  - **急上昇のページ**（`/rising/`）・**タグ**（`src/config/tags.ts` の13個。`/tag/<slug>/` と `/tags/`。AI のタグは「AIニュースランキング」。本番の見出しで当てはまり方を確かめ、「PS5連勝（野球のポストシーズン）」「インテル（サッカー）」「宇宙戦艦ヤマト」などを拾わないようタグごとにジャンルを絞り、記事の少ない「宇宙」は外した）。ヘッダーのタブに「急上昇」「AIニュース」を追加。話題のランキング（`/ranking/`）は24時間をスコアの順・1週間を報道の数の順にし、「今日の重要ニュース」（分野ごとに3件まで）を加えた。
  - **AI 要約の10秒/30秒/2分**（`src/components/SummaryLevels.astro`）: 要約の形式とプロンプトは変えずに（今までの要約にもそのまま使えるよう）、10秒＝要約の1文目（プロンプトで1文目に「誰が・何を・どうした」を書かせている）、30秒＝要約と要点、2分＝要約・要点・背景・ほかのメディアの要約にしかない要点・報道の広がり・キーワード、を切り替えて読めるようにした。要約のページ・話題のページ・要約のカード（10秒の1文）に使う。要約のページから話題のページ（各社の比較）へ案内する。
  - SEO: `/sitemap.xml`（`sitemap-index.xml` と同じ内容。ビルドの最後に写す）、robots.txt はそれを案内。話題・タグのページは noindex のものをサイトマップから外し（ビルドした HTML の robots を見て決める）、話題のページは最後の報道の日時を lastmod に。要約のページの構造化データを NewsArticle にし、要約・話題のページの og:type を article（公開・更新の日時つき）に。twitter:title・description を追加。IndexNow に新しく報じられた話題のページ・急上昇・タグのページも送る。見出し（h1）の最後の1文字だけが次の行に回らないように。
  - 速さ（Core Web Vitals）: 「◯分前」をビルドした時点の値で書いておき（24時間より前は日時）、閲覧時に書き直す（行の幅がほとんど変わらない）。NEW の印もビルド時に付ける → スマホのトップの **CLS 0.12 → 0**。記事の行の「あとで読む」「…」のアイコンを共通の `<symbol>` にして HTML を軽くし、「…」が次の行に1つだけ回る崩れを直した（右下に固定）。
  - SNS（`scripts/lib/social.ts`・`scripts/notify.ts`）: 投稿の種類を、朝の今日の重要ニュース・昼の AI ニュース・夜の今日のまとめ（従来）・急上昇（3時間で2社以上・計3社以上）・いま話題（4社以上・スコア50以上）にし、リンクを元の記事ではなく話題のページにした（サイトに来てもらうため）。スパム対策として、深夜（0〜7時）は投稿しない・24時間に8件まで・急上昇といま話題は90分あけて1回1件・同じ話題は二度投稿しない・急上昇といま話題はそれぞれ1日3件まで。X の API は2026年2月から無料枠がなく URL つきの投稿は1件0.2ドル（公式の料金表で確認）なので、X だけは既定で夜のまとめを1日1件・月31件までにし（Variables で変更可）、管理画面の「概要」に **SNS の下書き**（X・Bluesky の投稿画面を開くリンクとコピー）を置いて、無料で手で投稿できるようにした。話題はサイトのビルドと同じ計算なので、投稿のリンクは話題のページと一致する。
  - アクセス解析: **WAU・MAU**（この週（月曜から）・この月の訪問者数）を追加。ブラウザに残っている前回の閲覧日時から「この週・この月に初めての訪問か」だけを送り（`ret` の印。日をまたいで同じ人を追いかけない）、サーバーで足す（`visit.wk`・`visit.mo`）。管理画面の「概要」と「アクセス解析」に表示。ページの種類に topic・tag・rising を追加。「いま見ている人」の合図を1分ごと→2分ごとにして、月100万PV でも Cloudflare の無料枠（1日10万リクエスト）に収まるようにした（サーバーは3分以内の合図で数えるので表示は変わらない）。DAU・リピート率・閲覧時間・流入元（検索・SNS・AI）・人気のページ・リアルタイム・記事を開いた人の割合はもともとある。
  - PWA: サービスワーカーをすべての閲覧者に登録（通知と同じ URL）し、ページはいつもネットから読み、つながらないときだけ前に見たページ（40件まで）かオフラインのページ（`/offline/`）を出す。`/_astro/` のファイルは使い回す。2回目以降に来た人に「ホーム画面に追加」を画面の下に小さく案内（Chrome などは追加の画面、iPhone は共有ボタンの手順。閉じたら30日出さない）。
  - 著作権の点検: 掲載は見出し・短い抜粋（約120字。`excerpt: false` の掲載元は見出しだけ）・元記事へのリンクで、画像は転載していない。AI 要約は本文の書き写しや直接の引用をしないようプロンプトで指示し、運営者が確認して載せている（要約を禁じる掲載元は `summary: false` で除外）。本文の自動取得は robots.txt と AI での利用の拒否を守り、運営者の鍵で暗号化して要約が済んだら消し、長くても14日で消している。話題のページも各社の見出しと同じ短い抜粋とリンクだけで、問題は見つからなかった（変更なし）。
  - 説明: about に「話題度スコア・急上昇の計算のしかた」（`#score`。話題のページからリンク）と新しい使い方、プライバシーポリシーに週・月の初めての訪問の印・「ホーム画面に追加」の案内の記録・サービスワーカーのキャッシュを追記。
- 主な変更ファイル: `src/lib/topic-core.ts`・`src/lib/topics.ts`・`src/lib/tag-core.ts`・`src/config/tags.ts`・`src/lib/summary-view.ts`（話題・タグ・要約の見せ方）、`src/pages/topic/[id].astro`・`rising.astro`・`tag/[slug].astro`・`tags.astro`・`offline.astro`（新しいページ）、`src/pages/index.astro`・`ranking.astro`・`summary/[id].astro`・`about.astro`・`privacy.astro`、`src/components/TopicList.astro`・`ImportantList.astro`・`TrendWords.astro`・`MediaStats.astro`・`SummaryLevels.astro`・`ItemRow.astro`・`SummaryCard.astro`・`PopularList.astro`・`Header.astro`、`src/layouts/BaseLayout.astro`（OGP・アイコン・相対時刻・PWA）、`astro.config.mjs`（サイトマップ）、`src/pages/robots.txt.ts`、`src/pages/updates.json.ts`・`src/lib/follow-core.ts`・`src/scripts/following.ts`（話題の ID）、`scripts/lib/social.ts`・`scripts/notify.ts`・`.github/workflows/update.yml`（SNS）、`src/pages/admin/data.json.ts`・`admin/index.astro`・`src/scripts/admin-dashboard.ts`・`admin-analytics.ts`・`src/styles/admin.css`（下書き・WAU/MAU）、`analytics/src/core.ts`・`index.ts`・`src/scripts/analytics.ts`（WAU/MAU・合図の間隔）、`public/sw.js`・`src/scripts/pwa.ts`・`sw-url.ts`・`push-client.ts`・`settings.ts`、`src/styles/*.css`、テスト（`tests/topic-core.test.ts`・`summary-view.test.ts` を追加、`social.test.ts`・`analytics.test.ts`・`analytics-site.test.ts` を更新）
- 確認したこと: `npm test`（32ファイル・281件）・`npm run check`・`npx tsc --noEmit`（analytics/）・`npm run build`（420ページ）。ビルドしたサイトを Playwright で確かめた（トップの6つのセクション・話題の見出しが話題のページへ・ページ内の移動・話題のページのスコア/報道の比較/初報/グラフ/構造化データ/10秒・30秒・2分の切り替え・急上昇/タグ/ランキングの今日の重要・要約のページの NewsArticle・「…」が行の中に収まる・スマホのトップの CLS 0・サービスワーカーの登録とオフライン（前に見たページ・見ていないページはオフラインのページ）・ページのエラーなし）。axe（ライト・ダーク × 1280px・390px、トップ・話題・急上昇・タグ・ランキング・要約・オフライン・about）で違反なし・横のはみ出しなし。手元の Cloudflare と同じ構成（wrangler dev＋pages dev）で、管理画面の「概要」に WAU・MAU（週・月に初めての印つきの閲覧を送って 2・2）と SNS の下書き（7件。X の投稿画面のリンクに文面が入る）が出ること、アクセス解析のページに週・月が出ることを確かめた。読者向けの機能の確認（フォロー・通知（偽の届け先で受け取り・復号）・サービスワーカーの通知の表示・ミュート・既読・表示の設定）も通った。SNS は `NOTIFY_DRY_RUN=1` で、Bluesky などには急上昇の話題を話題のページのリンクで投稿し、X には投稿しない（既定）ことを確かめた。サイトマップは179件（話題21・タグ13・急上昇・タグ一覧を含む。noindex の話題は入らない）。
- 残った課題・注意点: 「未解決の課題」の8・13〜16。公開後に本番で、トップ・話題のページ・サイトマップ・オフラインを確かめる。X は無料枠がないので、下書きから手で投稿するのがおすすめ。

### 2026-10-07 設定の確認・読者向けの機能（フォロー・通知・ミュート・既読・表示の設定）・管理画面の拡充（概要・ピックアップ・お知らせ・通知）

- 依頼・目的: 運営者から「設定した、確認しろ」「管理画面の管理機能の充実や拡充」「使用者や読者が使いやすいように機能拡充、改善」「新しい記事や気になるジャンル等の通知機能の実装」。
- やったこと（設定の確認）:
  - 運営者が GitHub の Secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）を登録したあとの update.yml run #51 で、「Cloudflare Pages に公開」が成功し（Functions を含む）、GitHub Pages が転送ページになったことを確認。pages.dev の最終更新がその実行の時刻（10/7 11:50）になり、`/api/popular` が動き、`data/popular.json` が作られた。以前の URL（`/matmsait/category/tech/` など）は新しい URL に移る。新しい URL の管理画面での初回設定も済んでいる（本文の自動取得の鍵の登録の push で確認）。
  - チャットに貼られたトークンが作り直されたかを確かめようとしたが、権限の都合で確かめられなかった（「未解決の課題」2）。
- やったこと（読者向け）:
  - **フォロー**: ジャンル・掲載元・キーワードをフォローして、新着を「フォロー中」（`/following/`）にまとめる。ジャンル・掲載元のページの「フォローする」、検索結果の「フォローする」、サイドバーのジャンル、記事ごとのメニュー（…）から追加。フォロー中のページは、直近36時間の新着（`updates.json`）を、当てはまった理由・前回見たあとの印つきで日付ごとに出し、フォローごとに絞り込める。ヘッダーのベルに前回見たあとの新着の数（サイトの更新ごとに1回だけ数え直す）。キーワードの候補（いま話題の言葉）は、複数の掲載元の見出しに出る言葉だけにした（サイト名などの決まり文句を除くため。検索ページの候補も同じ）。照合は `src/lib/follow-core.ts`（英数字だけのキーワードは前後が英数字でないときだけ当てはまる。「AI」が「Gmail」に当たらない）。
  - **通知（プッシュ通知）**: フォロー中のページでオンにすると、フォローに当てはまる新着（毎時の公開のあと。1件なら見出し、複数なら件数と見出し3件）、いま話題のニュース（4社以上・同じ話題は1回だけ）、運営からのお知らせを送る。「1日1回、朝7時ごろにまとめて」「夜（23〜7時）は送らず朝にまとめる」（既定）も選べる。テストの通知・やめるもできる。iPhone・iPad はホーム画面に追加したときだけ使えると案内する。
  - **表示しない（ミュート）**: 掲載元・キーワード・ジャンル。記事のメニューか表示の設定から。隠した件数を見出しの下に出し、一時的に表示もできる。ジャンル・掲載元のページでは、そのジャンル・掲載元は隠さない。
  - **既読**（開いた記事の色を変える・隠す・何もしない）、**表示の設定**（`/settings/`。文字の大きさ・抜粋・既読・画面の色、ミュート、設定の書き出しと読み込み、アクセス解析で数えない、設定の消去）。表示の設定は head のスクリプトで最初から反映（ちらつかない）。
  - そのほか: ページの先頭に戻るボタン、運営からのお知らせのバー（閉じると内容が変わるまで出ない・掲載期間が過ぎたら出さない）、トップページの「編集部のピックアップ」、「このサイトについて」に使い方、プライバシーポリシーに通知（`#push`）と、ブラウザに保存するもの。
- やったこと（通知の仕組み）:
  - 通知のサーバーはアクセス解析と同じ Durable Object（`analytics/src/push.ts`）。購読（届け先の URL と鍵）・フォロー・ミュート・受け取り方だけを保存し、IP やアクセス解析とは結び付けない。届け先は通知を届ける会社（Google・Mozilla・Apple・Microsoft）の URL だけに限る。登録・変更は1人1時間30回まで、購読は2万件まで。同じ URL の登録は同じ鍵でしか変えられない。
  - 公開のワークフローが公開後に `POST /api/push/check` を呼ぶと、Pages の Functions が公開したサイトの `updates.json` を読んで（呼んだ側の内容は使わない）Durable Object に渡す。はじめて見た記事（72時間覚える）と、あらたに話題になった出来事（7日覚える）だけを材料にし、同じビルドは1回だけ扱う。最初の1回は記録だけ。購読は40件ずつ処理し、残りは1秒後のアラームで続ける（無料プランの1回の処理で外へ送れる50件の上限のため。毎時の集計のアラームと同じ枠を使う）。送った結果は購読ごとには書かず、取り消された購読（404・410）は消し、失敗が続いた購読も消す。送った記録は200件まで残す。
  - 暗号化は RFC 8291（aes128gcm）、送り主の証明は VAPID（RFC 8292。ES256）を WebCrypto で実装（`analytics/src/webpush.ts`）。VAPID の鍵は Durable Object が最初に作って保存する（秘密の値の設定は不要）。サービスワーカー（`public/sw.js`）は通知を表示し、押すとサイト内のページを開く（ほかのサイトの URL はトップに置き換える）。Android の通知の小さなアイコン（`public/badge-96.png`）はロゴから作った。
  - 採らなかった案: 外部の通知サービス（OneSignal など）→ 読者の情報が外部に渡る・費用と依存が増えるので不採用。ワークフローから新着の内容を直接送る → 送り主を確かめる秘密の値が要るので、公開したサイトのファイルを読む方式にした。VAPID の鍵を Secrets に置く → 運営者の設定作業が増えるので不採用。
- やったこと（管理画面）:
  - ページを「概要」（`/admin/`。新規）・「AI要約・記事」（`/admin/summaries/`。今までの `/admin/` を移した）・「ピックアップ・お知らせ」（新規）・「通知」（新規）・「アクセス解析」に分け、上のタブで切り替える。ログインのあとは「概要」が開く。
  - 概要: やること（更新が止まっている・直近の更新の失敗・取得できていない収集元・3日以上記事がない収集元・3社以上が報じたのに要約がない話題（同じ話題は1つに数える）・きょうの要約・お知らせとピックアップの状況・通知の確認が止まっている）、きょうの数字、サイトの更新（「今すぐ更新」・自動更新タイマー・最近の実行・接続の確認。AI要約のページから移した）、よく使う操作。
  - ピックアップ・お知らせ: 記事を探して（何も入れなければ話題の記事を1話題1件）ピックアップに加え、ひとこと・期限・並びを決めて `data/picks.json` に保存。お知らせは本文・リンク（サイト内か https だけ）・種類・掲載期間を `data/notice.json` に保存し、通知でも送れる。
  - 通知: 登録者数と受け取り方の内訳、よくフォローされているもの（キーワードは2人以上のものだけ）、お知らせを送る（ジャンルで絞れる・5分に1回まで・夜は注意を出す）、送った記録。
  - 共通の見た目を `src/styles/admin.css`、共通の処理を `src/scripts/admin-shared.ts` にまとめた。AI要約のページのコード（`admin.ts`）は、更新の実行と接続の確認を外しただけで、ほかは変えていない（大きなコードを作り直す危険を避けた）。「概要」からのリンク（`#sources-card` など）で閉じた欄を開く。
- やったこと（そのほか）: GitHub Pages の転送ページを、サイトのページごとに置くようにした（正規の URL と即時の転送。ないページだけ 404.html）。`sw.js` は毎回確かめるヘッダー。フォロー中・表示の設定のページはサイトマップに入れない。
- 主な変更ファイル: `src/lib/follow-core.ts`・`src/pages/updates.json.ts`・`src/scripts/personal.ts`・`src/scripts/personal-store.ts`・`src/scripts/push-client.ts`・`src/scripts/following.ts`・`src/scripts/settings.ts`・`src/pages/following.astro`・`src/pages/settings.astro`・`src/styles/personal.css`・`public/sw.js`・`public/badge-96.png`（新規、読者向け）、`analytics/src/push.ts`・`analytics/src/webpush.ts`（新規、通知のサーバー）、`analytics/src/index.ts`・`analytics/src/front.ts`・`analytics/wrangler.jsonc`、`src/lib/editorial-core.ts`・`src/lib/editorial.ts`・`src/components/PickList.astro`（新規）、`src/pages/admin/index.astro`（概要に作り直し）・`summaries.astro`（移動）・`content.astro`・`notify.astro`・`src/scripts/admin-dashboard.ts`・`admin-content.ts`・`admin-notify.ts`・`admin-shared.ts`・`src/styles/admin.css`（新規）、`src/scripts/admin.ts`、`src/pages/admin/data.json.ts`、`src/layouts/BaseLayout.astro`・`AdminLayout.astro`、`src/components/Header.astro`・`ItemRow.astro`・`Sidebar.astro`・`Footer.astro`、カテゴリ・掲載元・検索・トップ・プライバシーポリシー・このサイトについてのページ、`src/lib/search-core.ts`、`src/scripts/reader.ts`・`analytics.ts`、`scripts/redirect-stub.mjs`、`.github/workflows/update.yml`・`analytics.yml`、`public/_headers`、`astro.config.mjs`、`README.md`、テスト（`tests/follow-core.test.ts`・`webpush.test.ts`・`push.test.ts`・`editorial.test.ts`・`helpers/webpush.ts` は新規、`analytics-front.test.ts`・`search-core.test.ts`）
- 確認したこと:
  - ユニットテスト 256件（暗号化が RFC 8291 の例と同じ結果になる・ブラウザ側の復号・VAPID の署名の検証、フォローの照合と英数字の語の区切り・ミュート、updates.json の検証、購読の確認（届け先の制限・鍵の形）、通知の中身（1件・複数・話題・夜・朝のまとめ・1日1回）、SQLite での購読の登録・変更・取り消し・同じ鍵でしか変えられない・登録の回数の制限・最初の確認は記録だけ・同じビルドは1回・40件ずつ・取り消された購読を消す・話題は1回だけ・お知らせをジャンルで絞る・集計、入口の /api/push/check が公開したサイトのファイルを渡す、お知らせとピックアップの形）、型チェック（サイト・Worker と Functions）、actionlint。暗号化は、別の実装（`http_ece` で復号・`web-push` で鍵を読む）でも確かめた（作業用のフォルダーで。リポジトリには入れていない）。
  - 手元の Cloudflare と同じ構成（`wrangler dev` の Worker ＋ `wrangler pages dev` ＋ 偽の届け先）で、読者向けの E2E（ジャンルのページと検索からフォロー → フォロー中の一覧・理由・絞り込み・追加と削除 → 通知をオン（サービスワーカーの登録・サーバーへの登録）→ テストの通知が VAPID つき・暗号化されて届き復号できる → 新着の確認でフォローに当てはまる記事の通知が届く → サービスワーカーが通知を表示し、ほかのサイトの URL はトップに置き換える → 記事のメニューでミュート・掲載元のページでは隠さない・既読 → 表示の設定と書き出し → ヘッダーの新着の数 → 通知をやめるとサーバーからも消える）と、管理画面の E2E（ログインで概要が開く・やることと数字・今すぐ更新・接続の確認・AI要約のページの移動と欄へのリンク・ピックアップの追加と並べ替えと保存・お知らせの保存と危ないリンクを断る・通知でお知らせが届く・通知のページの集計と送る・続けては送れない・スマホの幅とダークモード）がすべて通った。
  - 移した「AI要約・記事」のページで、以前からの E2E（本文の貼り付け・ファイルの読み込み・本文の自動取得）が通った。GitHub Pages（ベースパス /matmsait・サーバーなし）でもフォロー中のページのリンクが正しく、通知の欄は出ないことを確かめた。
  - axe（サイトの9ページ・記事のメニュー・知らせ、管理画面の5ページ。ライト・ダーク、1280px・390px）で問題なし。横にはみ出すページなし。確認のために一時的に作ったお知らせ・ピックアップのデータは消した（コミットしていない）。
- 残った課題・注意点: 本番の通知は、運営者の端末で確かめる（「未解決の課題」1）。公開後の最初の新着の確認は記録だけなので、通知が届き始めるのはその次の毎時の更新から。登録者が増えたときの無料枠（「未解決の課題」3）。
- 公開後の確認: push による実行（update.yml run #53・analytics.yml run #3）がどちらも成功。update.yml の「フォロー中の新着を通知」で最初の確認（記録だけ）が済み、同じビルドで呼び直すと `duplicate` になる。本番で `/following/`・`/settings/`・`updates.json`（約370KB）・`/api/push/key`（本番の Durable Object が VAPID の鍵を作った）、届け先がおかしい登録は 400・ほかのサイトからは 403・運営者用の `/api/admin/push` はトークンなしで 401、`sw.js` は `no-cache`。以前の URL の深いページ（`/matmsait/category/tech/` など）が 200 で、新しい URL への正規の URL と転送つき（297ページ分）。実際のブラウザ（スマホの幅）で、ジャンルのフォロー・フォロー中の一覧（100件）と通知の欄・記事のメニュー・表示の設定が、エラーなく動いた。

### 2026-10-07 公開先を Cloudflare Pages（topiatsume.pages.dev）に移し、アクセス解析を同じドメインの /api に

- 依頼・目的: 運営者から「開発や実験検証などを除いて、公開バージョンは Cloudflare にサーバーを完全に移して pages.dev で公開」。あわせて Cloudflare のアカウント ID と API トークン（と R2 のアクセスキー）がチャットに貼られた。
- やったこと:
  - **方針**: 開発・テスト・毎時の収集とビルドは GitHub（リポジトリと GitHub Actions）のまま、公開するサイトとアクセス解析を Cloudflare に置く。サイトは Cloudflare Pages の Direct Upload（GitHub Actions から `wrangler pages deploy`）。Cloudflare 側でビルドする Git 連携は、無料プランのビルド数（月500回）では毎時の更新に足りないので使わない。アクセス解析は workers.dev の別ドメインをやめ、サイトと同じドメインの `/api`（Pages の Functions）から Durable Object を直接使う（同じドメインなので CORS が要らず、広告ブロックなどで別ドメインごと止められにくい。Worker は workers.dev で公開しない）。
  - **解析の入口を共通に**: 送り元の確認・CORS・振り分けを `analytics/src/front.ts` に切り出し、Worker（手元で試すとき）と Pages の Functions（`functions/api/[[path]].ts`）の両方から使う。同じドメインの GET には Origin が付かないので、ブラウザが付ける `Sec-Fetch-Site: same-origin` で見分ける。接続先の `data/analytics.json` の仕組みはやめ、`PUBLIC_ANALYTICS_URL=/api`（ワークフローが入れる）にした。
  - **公開のワークフロー**（`update.yml`）: Secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）があれば、Pages のプロジェクト `topiatsume` がなければ作り（本番のブランチは main）、URL を調べ、解析の Worker がなければ先に公開し、その URL 用（`BASE_PATH=/`）にビルドして公開する。GitHub Pages には、新しい URL の同じページへ移る転送ページ（`scripts/redirect-stub.mjs`。どの URL でも 404.html から移る）を公開する。Secrets がなければ、これまでどおり GitHub Pages に公開する（移行の途中でサイトが止まらないように）。独自ドメインにしたときは変数 `SITE_URL` で正規の URL を変えられる。`analytics.yml` は Worker の公開だけにした。
  - **Cloudflare ならではの設定**: `public/_headers` で応答ヘッダー（全体に nosniff・Referrer-Policy・Permissions-Policy、管理画面に X-Frame-Options: DENY・frame-ancestors 'none'・noindex・no-store、`/_astro/` は1年キャッシュ）、`public/_redirects` で以前の URL（`/matmsait/...`）を同じページへ 301。
  - **実際の公開**（運営者のトークンで、この作業の中でだけ使い、ファイル・リポジトリには書いていない）: Worker `topiatsume-analytics`（Durable Object・`REPOSITORY` を設定、workers.dev なし）を公開し、Pages のプロジェクト `topiatsume` を作り、最新のデータでビルドしたサイトを公開した（https://topiatsume.pages.dev/）。
  - README（公開先（Cloudflare）・独自ドメイン・手元での確かめ方）、管理画面のアクセス解析の設定の手順、`.env.example` を新しい公開先に合わせた。
- 主な変更ファイル: `analytics/src/front.ts`（新規）, `analytics/src/index.ts`, `analytics/wrangler.jsonc`（workers.dev なし）, `analytics/tsconfig.json`, `functions/api/[[path]].ts`（新規）, `wrangler.jsonc`（新規・ルート）, `public/_headers`（新規）, `public/_redirects`（新規）, `scripts/redirect-stub.mjs`（新規）, `.github/workflows/update.yml`, `.github/workflows/analytics.yml`, `scripts/popular.ts`, `src/lib/analytics-config.ts`, `src/layouts/AdminLayout.astro`, `src/config/services.ts`, `src/pages/admin/analytics.astro`, `tests/analytics-front.test.ts`（新規）, `tests/analytics-site.test.ts`, `tsconfig.json`, `.gitignore`, `README.md`, `.env.example`
- 確認したこと:
  - ユニットテスト（入口: 同じドメインの記録を /api を外して渡す・IP と国を渡す・同じドメインの GET を Sec-Fetch-Site で見分けてトークンを渡す・ほかのサイトは 403・許可したオリジン・人気の記事はどこからでも・事前確認・404/405/413。接続先のパス `/api`）、型チェック（サイト・Worker と Functions）、actionlint。
  - 手元で `wrangler dev`（解析の Worker）＋ `wrangler pages dev`（`dist`＋Functions）を動かし、curl で /api（同じドメインの記録・ほかのサイトの拒否・運営者の確認）・応答ヘッダー・以前の URL の 301 を、Playwright でサイトの計測の E2E（訪問者2人・来た回数2・クリック3 など前回と同じ項目）・管理画面のアクセス解析の E2E（axe を含む）・ログインの E2E（ルートに置いた URL で）を確認した。
  - 本番（https://topiatsume.pages.dev/）: ページの表示と正規の URL・robots.txt とサイトマップが新しい URL、`/api/popular` が JSON、ボットの記録は 204（Durable Object まで届く）、ほかのサイトからは 403、運営者用の API はトークンなしでも不正なトークンでも 401、管理画面と全体の応答ヘッダー、`/matmsait/category/tech/` → `/category/tech/` の 301、workers.dev では Worker を呼べない（404）。実際のブラウザで1回開き、`/api/collect` が 200（いま1人）を返すことを確かめた（この1回分の閲覧が記録に残っている）。
- 残った課題・注意点: GitHub の Secrets が登録されるまで、毎時の更新は GitHub Pages に公開され、pages.dev は今回公開した内容のまま（「未解決の課題」1）。チャットに貼られたトークンは作り直してから登録すること。新しい URL の管理画面では初回設定がもう一度必要。
- 公開後の確認: push による実行（update.yml run #50）が成功し、Secrets がないので「Cloudflare Pages に公開」「転送ページ」は飛ばされ、GitHub Pages にこれまでどおりのサイトが公開された（正規の URL は github.io のまま）。同時に動いた analytics.yml（run #2）も Secrets がないので何もせずに成功。pages.dev は今回手で公開したサイトが表示されている。

### 2026-10-07 本文の自動取得で名乗るのをやめた・アクセス解析（いま見ている人数・よく読まれている記事など）

- 依頼・目的: 運営者から「（本文の自動取得で）別に名乗るな、ブロックされる可能性が上がる」「サイトに訪問者が来たアクセス解析などを実装。現在訪問しているユーザー数やどの記事が人気かなど、さまざまな機能を実装」。
- やったこと（本文の自動取得）:
  - TopiatsumeBot と名乗るのをやめ、フィードの取得と同じブラウザ相当のヘッダー（`scripts/lib/http.ts` の `browserHeaders('document')`）で取得する。名乗る名前がないので、robots.txt はクローラー全般（`User-agent: *`）のルールと、主な AI のクローラーの拒否に従う。noai・拒否されたら再試行しない・1回15件・同じサイトへは間隔を空ける、は変えていない。ボット対策のすり抜け（ヘッドレスブラウザ・CAPTCHA の突破・IP の切り替えなど）はしない。
  - 運営者情報の TopiatsumeBot の節は、名前を出さない取得の方針の説明（`/about/#fetch`）に書き換えた（編集方針・管理画面・README・`docs/SOURCES.md` も）。
- やったこと（アクセス解析）:
  - **しくみ**: GitHub Pages では訪問の記録を受け取れないので、記録を受け取って集計する小さなサーバーを Cloudflare Workers の無料プランに置く（`analytics/`）。入口の Worker が送り元（サイトのオリジン）を確かめ、1つの Durable Object（SQLite）が数える。生のイベントは1件1行（主キーを時刻にして索引を作らず、書き込みを1行に）で14日残し、過去の日は毎時の処理（アラーム）で日ごとの集計（metric・日・内訳）にまとめて約400日残す。今日の分はメモリで数えるので、管理画面を開いても生のイベントを読み直さない。いま見ている人（3分以内に合図があった人）もメモリで数える。採らなかった案: Google アナリティクスだけ（サイトや管理画面に「いま見ている人数」「人気の記事」を出せない。GA4 は今までどおり変数で併用できる）、Supabase・Firebase（ブラウザ用のライブラリが重い・同時接続の上限）、D1（いま見ている人を数えるたびに書き込みが要る）。
  - **数え方とプライバシー**: Cookie は使わず、ブラウザに新しく保存するものもない。IP アドレスは保存せず、「IP＋ブラウザの種類＋日ごとの塩」の SHA-256 で匿名の訪問者番号を作る（塩は翌日に消すので、日をまたいで同じ人かは分からない）。入口（サイトに来た）は、前の閲覧から30分以上空いた閲覧（「あとで読む」の新着の印と同じ訪問の記録を使う）。参照元はホスト名だけ（utm_source があればそれ）で、AI チャット・検索・SNS・ほか・直接に分ける。ボット（User-Agent）・自動操作のブラウザ（webdriver）・Do Not Track・GPC・管理画面で除外したブラウザ（ログインすると自動で除外）は数えない。1人1分60件まで、1日4万件まで。プライバシーポリシーに、送る情報・送り先・目的・保存期間を載せた（電気通信事業法の外部送信の公表を兼ねる）。
  - **サイト**（`src/scripts/analytics.ts`）: 閲覧（ページの種類・カテゴリ・要約ページなら記事）・記事を開いた（見出し・元記事のリンク。`data-aid` などを記事のリンクに付けた）・サイト内検索（入力が止まってから、同じ言葉は1回）・あとで読むへの保存・閲覧時間（表示していた時間）・表示中は1分ごとの合図を送る。合図の応答の「いま見ている人数」を、トップと人気のページに「いまN人が閲覧中」として出す（2人以上のとき）。
  - **よく読まれている記事**: サーバーの公開の API（`/popular`。24時間・1週間、記事を開いた・要約ページを読んだ・保存した人の数）を、自動更新のたびに `scripts/popular.ts` が `data/popular.json` に取り込む（順位が変わらなければ書かない）。ページ `/popular/`（データがなければ noindex・サイトマップから外す）、トップとサイドバーの一覧、ヘッダーの「人気」、フッターのリンク、上位10件の記事の「人気N位」の印。
  - **管理画面**（`/admin/analytics/`）: リアルタイム（いま見ている人数・直近30分の1分ごとの閲覧数・見られているページ・最近の動き。15秒ごと）、期間（今日・昨日・7日間・30日間・90日間。選んだ期間を覚える）ごとの主な数字（訪問者・閲覧・来た回数・記事を開いた回数と人の割合・1ページの閲覧時間・1ページで離れた人・前にも来た人。前の期間と比べる。今日は昨日の値を並べる）、閲覧数と訪問者数の推移、よく読まれている記事（要約ありの印）・ページ・流入元と来たサイト・入口・検索された言葉（0件の回数）・カテゴリ・掲載元・時間帯・見たページ数・保存された記事・端末・OS・ブラウザ・国。グラフは SVG で自前に描き（CSP で外部のスクリプトを読めないため）、ポインターとキーボードで値を出し、「表で見る」も付けた。色は見分けやすさを検証した組み合わせ（ライト・ダーク）。サーバー未設定のときは設定の手順を出す。管理画面のページの切り替え（AI要約の管理・アクセス解析）を付けた。要約の候補の並び順に「よく読まれている順」（直近7日）を足した。
  - **運営者の確認**: 管理画面がサーバーに問い合わせるときは、ログイン中の GitHub のトークンを送り、サーバーが GitHub API でサイトのリポジトリに書き込めるかを確かめる（トークンは保存せず、確かめた結果をトークンのハッシュで10分間覚える）。管理画面の CSP の接続先にサーバーを足した。
  - **公開**: `.github/workflows/analytics.yml`（Secrets の `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` があるときだけ。型チェック → `wrangler deploy`（受け付けるオリジンは Pages の設定から） → URL を `data/analytics.json` に書いてコミット → `update.yml` を実行）。`update.yml` に「よく読まれている記事を取得」を足し、`analytics/` だけの push では収集・公開をしないようにした。
- 主な変更ファイル: `scripts/lib/http.ts`, `scripts/lib/text-fetcher.ts`, `scripts/fetch-texts.ts`, `analytics/`（新規: `src/index.ts`・`src/core.ts`・`src/store.ts`・`wrangler.jsonc`・`package.json`・`tsconfig.json`）, `.github/workflows/analytics.yml`（新規）, `.github/workflows/update.yml`, `scripts/popular.ts`（新規）, `src/scripts/analytics.ts`（新規）, `src/scripts/admin-analytics.ts`（新規）, `src/scripts/charts.ts`（新規）, `src/pages/admin/analytics.astro`（新規）, `src/pages/popular.astro`（新規）, `src/components/PopularList.astro`（新規）, `src/lib/popular.ts`（新規）, `src/lib/analytics-config.ts`（新規）, `src/layouts/BaseLayout.astro`, `src/layouts/AdminLayout.astro`, `src/components/ItemRow.astro`・`TopicList.astro`・`SummaryCard.astro`・`Sidebar.astro`・`Header.astro`・`Footer.astro`, `src/pages/index.astro`・`search.astro`・`saved.astro`・`summary/[id].astro`・`ranking.astro`・`privacy.astro`・`editorial.astro`・`about.astro`・`admin/index.astro`, `src/scripts/reader.ts`・`admin.ts`・`admin-login.ts`, `src/styles/global.css`・`items.css`, `astro.config.mjs`, `tsconfig.json`（`analytics/` を除外）, `README.md`, `docs/SOURCES.md`, `.env.example`
- 確認したこと:
  - ユニットテスト219件（新規: イベントの検証・ボット・OS とブラウザ・流入元・日本時間の日付・集計（訪問・入口・直帰・見たページ数・記事ごとの人数）・日をまたいだ合計と上位の取り出し・訪問者番号と塩、node:sqlite で保存・日ごとの集計・期間の読み出し・古いデータの削除・記事の名前、サイト側のページの種類・参照元・入口の判定・接続先の確認・人気のファイルの読み取り。本文の自動取得はブラウザ相当の通信と robots.txt の `*` で確かめるよう変更）、型チェック（サイトとサーバー）、actionlint、ビルド（接続先あり・なし）、`wrangler deploy --dry-run`（39 KiB）。
  - 手元で `wrangler dev`（Cloudflare と同じ workerd）でサーバーを動かし、Playwright で: Google から来たパソコン・X から来たスマホの閲覧、記事を開く・カテゴリ・検索（入力が止まってから1回）・保存（外しても送らない）・要約ページ・元記事・閲覧時間を送り、「いま2人が閲覧中」が出る。GPC・除外したブラウザ・自動操作のブラウザからは送らない。運営者用の API で訪問者2人・来た回数2・クリック3・検索1・保存1・流入元（検索・SNS）・記事の名前・端末・OS を確認。書き込めないトークン（401）・ほかのサイトからの送信（403）は断る。人気の記事を取り込んで `/popular/`・トップ・サイドバー・ヘッダーの「人気」・「人気N位」の印が出る。管理画面のアクセス解析: ログインで自動で除外、数字・推移・時間帯・一覧・リアルタイムの表示、グラフの値（ポインター・キーボード）、期間の切り替えと記憶、「よく読まれている順」、CSP 違反なし、スマホ・ダークで横にはみ出さない、axe 違反なし（ライト・ダーク。公開ページ・設定の手順のページも）。
  - 本物の Durable Object の SQLite（workerd）で、日ごとの集計・やり直しても同じ結果・古いイベントの削除・塩を確認（手元だけの確認用ワーカー）。
  - これまでの E2E（ログイン・本文の貼り付け・ファイル・本文の自動取得・ブックマークレット）も通った。
- 残った課題・注意点: 運営者が Cloudflare を設定するまでアクセス解析は動かない（「未解決の課題」1。初めて公開したら本番で確かめる）。無料の範囲と数え方の注意は「未解決の課題」10。テストで作った `data/popular.json` はコミットしていない。
- 公開後の確認: push による実行（update.yml run #49）が成功し、新しい手順「よく読まれている記事を取得」も成功（サーバー未設定なので何もしない）。同時に動いた「アクセス解析のサーバーを公開」（analytics.yml run #1）は、Secrets がないので公開せずに成功した。本番で、計測のスクリプトが読み込まれていない（接続先なし）こと、`/popular/` が noindex で「集計中」、ヘッダーに「人気」が出ないこと、プライバシーポリシーのアクセス解析の節、運営者情報の取得の方針（`#fetch`。TopiatsumeBot の記載なし）、管理画面のアクセス解析に設定の手順が出ること、管理画面の CSP の接続先が GitHub API だけのまま、要約の並び順の「よく読まれている順」が隠れていることを確認した。

### 2026-10-06 AI が開けない記事の本文の自動取得（TopiatsumeBot・サイトの拒否を守る・暗号化して運営者だけが読む）とパスワードの案内

- 依頼・目的: 運営者から「AI が開けない記事は自動収集で本文を取得するようにして」「管理者ログインのパスワードを忘れたので、とりあえず 1234567890 にしておいて」。
- 方針: 以前は「本文を自動で取ってくる仕組みは作らない」としていた（ボット対策のすり抜け・公開リポジトリへの本文の掲載になるため）。次の条件なら、サイトの意向に反さず本文を公開せずに自動化できるので作った。(1) TopiatsumeBot と名乗り、ブラウザのふりをしない（断りたいサイトが robots.txt で断れる）、(2) robots.txt で自分または主な AI のクローラーを断っているページ・noai の指定があるページは取得しない、(3) アクセスを拒否されたら再試行しない（すり抜けない）、(4) 本文は運営者の公開鍵で暗号化して置き、公開しない。ボット対策をすり抜ける取得（ブラウザのふり・ヘッドレスブラウザなど）はしない。
- 調べたこと: 66件のフィードのうち、RSS に本文が入っているのは Think IT・ナゾロジー・AUTOSPORT web など数件で、AI が開けないサイト（カラパイア・政府広報オンライン・首相官邸）の RSS には本文がないため、RSS からは取れない。TopiatsumeBot と名乗ったアクセスは、首相官邸・カラパイアが受け付け、政府広報オンラインは curl では 403、取得の処理では 200 だった。実際に試した首相官邸・政府広報オンラインの記事は動画だけのページで本文がなく（34字・192字）、AI が `unavailable` を返す原因もこれとみられる。カラパイア・GIGAZINE・4Gamer.net は本文を取得できた。
- やったこと:
  - **取得の処理**（`scripts/fetch-texts.ts`・`scripts/lib/text-fetcher.ts`）: 依頼（`data/text-requests.json`）のうち結果のないもの（依頼し直したものを含む）を古い順に1回15件まで、サイトごとに1件ずつ3〜5秒空けて取得する。robots.txt はサイトごとに1回読み（4xx は「ルールなし」、5xx・読めないときは取得しない）、`robots.ts` で TopiatsumeBot と AI のエージェントの可否を判定する（名前が一致するグループ、なければ `*`。パスはいちばん長く一致するルールを優先）。本文は `article-text.ts`（node-html-parser）で、本文の目印か文字がいちばん多いまとまりを選び、メニュー・関連記事・コメントなどを除いて取り出す（ブックマークレットと同じ考え方）。200字未満なら「本文なし」。結果は `data/texts.json` に、取得できた本文は暗号化して置く。14日たった結果と、要約を保存した記事の結果は消す。中身が変わらなければファイルを書かない（毎回コミットしないように）。
  - **暗号化**（`src/lib/text-crypto.ts`）: Web Crypto だけを使い、ブラウザと Node の両方で動く。本文ごとに使い捨ての AES-256-GCM の鍵で暗号化し、その鍵を登録してある各公開鍵（RSA-OAEP 3072・SHA-256）で包む。公開鍵がなければ取得自体をしない。
  - **鍵の管理**: ログインの初回設定で鍵の組を作り、秘密鍵をトークンと一緒にパスワードで暗号化して保存する（`VaultSecrets`。以前の版の保存内容にはログインのときに鍵を足して保存し直す）。ログイン中は秘密鍵をセッションに置き、管理画面が公開鍵を `data/text-keys.json` に登録する（端末ごとに5件まで）。
  - **管理画面**: 手順3で `unavailable` になった記事は自動で取得を依頼する（`data/text-requests.json` へのコミットがきっかけで自動収集が動く）。`/admin/texts.json`（ビルド時に `data/texts.json` と依頼から作る）を読み、取得できた本文を復号して本文の欄に入れ、本文入りのプロンプトを作る。取得を待っている記事があれば1分ごとに確認する（最長30分）。記事ごとに「取得しています」「取得できませんでした: 理由」「もう一度自動で取得」を出す（サイトが断っている場合は依頼し直させない。断られたサイトの記事は自動では依頼しない）。自分で書き換えた・消した本文は自動の本文で上書きしない。作業を戻したときは依頼し直さない。
  - **ワークフロー**: 収集のあとに「AI が開けない記事の本文を取得」を追加（失敗しても公開は続ける）。データのコミットでは、最新の `data/texts.json` に今回の結果をまとめる（`--merge`）。
  - 運営者情報（`/about/#bot`）に TopiatsumeBot の説明と断り方を、編集方針に取得の方針を載せた。
- パスワード: 管理画面のパスワードはどこにも保存しておらず（ブラウザの中でトークンの暗号化に使うだけ）、こちらから 1234567890 に設定することはできない。ログインページの「保存したトークンを消してやり直す」で、運営者自身がトークンと新しいパスワードを入れ直す手順を README と「未解決の課題」1に書いた（1234567890 は10文字の条件は満たすが、よく使われるパスワードなので勧めない）。
- 主な変更ファイル: `scripts/fetch-texts.ts`（新規）, `scripts/lib/text-fetcher.ts`（新規）, `scripts/lib/robots.ts`（新規）, `scripts/lib/article-text.ts`（新規）, `scripts/lib/http.ts`（ボットとして名乗るヘッダー）, `src/lib/text-crypto.ts`（新規）, `src/lib/article-texts.ts`（新規）, `src/lib/admin-auth.ts`, `src/scripts/admin-login.ts`, `src/scripts/admin.ts`, `src/pages/admin/index.astro`, `src/pages/admin/texts.json.ts`（新規）, `src/pages/admin/data.json.ts`, `src/pages/about.astro`, `src/pages/editorial.astro`, `.github/workflows/update.yml`, `package.json`（node-html-parser）, `README.md`, `docs/SOURCES.md`
- 確認したこと:
  - ユニットテスト196件（robots.txt の読み取り・グループとパスの判定・AI の拒否・noai、本文の取り出し（不要な部分を除く・本文の目印・改行で書かれたページ）、暗号化（登録したどの鍵でも復号でき、ほかの鍵では読めない）、依頼と結果のまとめ方、取得の処理（ボットとして名乗る・暗号化する・robots.txt・AI の拒否・noai・403・本文なし・robots.txt が読めないときの扱い・再試行しない・公開鍵がなければ取得しない）、ログインの保存内容に鍵を含めること）、型チェック、actionlint、ビルド。
  - 実際のサイトで取得の処理を実行（一時的な鍵で）: カラパイア・GIGAZINE・4Gamer.net は取得・暗号化でき、保存したファイルに本文がそのまま入っていないこと、秘密鍵で復号できることを確認。首相官邸・政府広報オンラインは本文なし（動画のページ）として記録された。
  - Playwright で管理画面（GitHub API はコミットまでモック）: 初回設定で鍵を作り公開鍵を登録する、localStorage に秘密鍵とトークンが平文で残らない、`unavailable` の記事の取得を依頼する（依頼の中身）、取得できた本文を復号して欄と本文入りのプロンプトに入れる、取得できなかった理由を出す、作業を戻しても依頼し直さない、自分で消した本文を入れ直さない、鍵のない以前のログインでは案内を出す、以前の保存内容でログインすると鍵を足して登録する、CSP 違反なし。これまでの E2E（ログイン・AI が開けない記事・分割とファイル・ブックマークレット）も通った。
- 残った課題・注意点: 運営者はパスワードを設定し直す必要がある（「未解決の課題」1）。取得できるかはサイトしだい（同7）。
- 公開後の確認: push による実行（update.yml run #43）が成功し、新しい手順「AI が開けない記事の本文を取得」も成功（依頼がないので何もしない）。本番で、`/admin/texts.json` が空の一覧（依頼・結果なし）を返すこと、運営者情報に TopiatsumeBot の説明（`/about/#bot`）があること、管理画面に自動取得の欄があることを確認した。公開鍵はまだ登録されていない（運営者が設定し直してログインすると登録される）。

### 2026-10-06 本文入りのプロンプトを自動で作る・プロンプトの分割とファイル保存・AI の回答と本文のファイル読み込み

- 依頼・目的: 運営者から「unavailable の本文を取得したら、それが入った指示プロンプトを作って AI に記事要約の JSON を書かせるようにコピペ用のプロンプトを作成するように。またコピペには文字制限があるので、JSON などはダウンロード・アップロードでもできるように」。
- やったこと:
  - **本文入りのプロンプト**: 「AI が開けない記事」の欄で本文を貼る（または読み込む）と、欄のいちばん下に、本文を貼った記事だけの要約を依頼するプロンプトを自動で作る（コピー・ファイルで保存のボタンつき）。手順1・2の「URL を開いてもらうプロンプト」とは分け、本文を貼った記事は手順1で自動では選ばない（二重に依頼しないように）。これに合わせて「本文を貼った記事だけを選ぶ」ボタンはなくした。
  - **本文のまとめて貼り付け・ファイル読み込み**: 「本文をまとめて貼り付け」の欄に、ブックマークレットでコピーした本文を（いくつ続けてでも）貼ると、本文の先頭の URL で記事に自動で振り分ける（`splitPastedBlocks` で本文ごとに分け、`comparePastedUrl` で同じページの記事を探す）。振り分けられなかった本文は欄に残して知らせる。「本文のファイルを読み込む」で本文のテキストファイルを複数まとめて読み込める（欄へのドラッグも可）。
  - **ブックマークレットの「ファイルで保存」**: コピーしたときに出る案内に「ファイルで保存」を追加（`article-サイト名-日時.txt`）。何件か開いてファイルに保存し、管理画面でまとめて読み込める。案内はマウスを乗せている間は消えないようにした。
  - **プロンプトの分割**: 「1回に貼り付ける長さの上限」（既定15,000字。8,000・30,000・60,000字・上限なし）を超えるプロンプトは、記事の順番を変えずに何回かに分ける（`splitPromptArticles`）。各回のプロンプトには「全N回のうちk回目。この回の記事だけを要約し、前の回の記事は出力しない」と書く。「1回目」「2回目」…のボタンで切り替え、コピーすると「k回目をコピーしました。回答を確認・保存したら次の回へ」と案内する。1件だけで上限を超える記事はその1件で1回分にし、注意を出す。手順2と本文入りのプロンプトの両方で使う。
  - **プロンプトをファイルで保存**: 「ファイルで保存」で今の回を、「全部を1つのファイルで保存」で分けない全体をテキストファイルに保存する。保存すると、AI にファイルを添付するときに送る一言（「添付したファイルは記事の要約の依頼です。ファイルに書かれた指示どおりに…」）を出し、ボタンでコピーできる。
  - **AI の回答のしかた**: 「コードブロック（コピー）」と「JSON ファイル（ダウンロード）」を選べる。JSON ファイルでは、AI に `summaries.json`（JSON の配列だけ・UTF-8）を作ってダウンロードできるようにしてもらい、作れなければコードブロックで出すよう指示する。
  - **AI の回答をファイルで読み込む**: 手順3に「ファイルから読み込む」を追加（複数可・回答の欄へのドラッグも可）。`summaries.json`、回答を保存したテキスト（説明文やコードブロック入りでもよい）、「保存用JSON」を読み込み、そのまま内容を確認する。読めないファイルは理由を出す。1ファイル5MB・50ファイルまで。
  - 「回答に含まれていません」の判定を、回答に含まれる記事から「どの回のプロンプトへの回答か」を見分けて、その回の記事だけで行うようにした（分けたときに、ほかの回の記事を「含まれていない」と出さないように）。
  - 上限・回答のしかたの設定はブラウザに残る。スマホ幅で選択肢がはみ出さないようにした。
- 主な変更ファイル: `src/lib/summary-core.ts`（`AnswerMode`・`splitPromptArticles`・`splitPastedBlocks`・分けたときの指示・ファイルでの回答の指示）, `src/lib/bookmarklet.ts`, `src/pages/admin/index.astro`, `src/scripts/admin.ts`, `tests/summary-core.test.ts`, `tests/bookmarklet.test.ts`（新規）, `README.md`
- 確認したこと:
  - ユニットテスト177件（ファイルでの回答の指示、上限に収まれば分けない・収まらなければ順番どおりに上限以内で分ける・1件で超える記事は1件で1回分、まとめて貼った本文の切り分け、ブックマークレットの URL の形と目印が管理画面と同じこと）、型チェック、ビルド。
  - Playwright で管理画面（GitHub API はモック）: 50件・上限8,000字で4回に分かれてどの回も8,000字以内・全50件が重ならずに入ること、今の回と全部のファイル保存（中身とファイル名）、添付するときの一言のコピー、コピーの案内、JSON ファイルでの依頼、回答のファイル読み込み（コードブロック入りの .md・JSON だけの summaries.json・読めないファイル）と内容の確認、回答に含まれない記事をその回だけで出すこと、ドラッグでの読み込み、本文のまとめて貼り付け（2件を振り分け・振り分けられない本文は欄に残る）と本文入りのプロンプト、本文のファイル読み込み、本文入りのプロンプトの分割・コピー・保存、設定が残ること、ブックマークレットの「ファイルで保存」（ファイル名と中身）、CSP 違反なし。これまでの E2E（ログイン・AI が開けない記事・ブックマークレットの本文の取り出し）も通り、幅390でのはみ出しなし、axe の違反0件。
- 公開後の確認: push による実行（update.yml run #35）が成功。本番の管理画面に、長さの上限・回答のしかた・分けた回の切り替え・全部を1つのファイルで保存・回答のファイル読み込み・本文のまとめて貼り付けとファイル読み込み・本文入りのプロンプトの欄があり、ブックマークレットに「ファイルで保存」が入っていることを確認した。
- 残った課題・注意点: チャット AI に貼り付けられる長さの上限は AI やプランによって違うので、貼り付けられなかったら上限を下げるか、ファイルで添付する。ファイルを作れない AI では「JSON ファイル」を選んでもコードブロックで答える。

### 2026-10-06 AI が記事を開けない（unavailable）ときの対処: 本文の貼り付け・同じ話題の別の記事・開けなかった記事の記録

- 依頼・目的: 運営者から「unavailable となるサイトがいくつかあるので対処したい。AI に読ませようとしてもスクレイピング対策でブロックされるので、何かいい方法を考えて」。
- 調べたこと: 66件の収集元それぞれで、robots.txt が AI の取得（ChatGPT-User・Claude-User など）を拒否しているかと、記事のページを AI の User-Agent で開いたときの応答を確かめた。要約の候補になる収集元で robots.txt が AI の取得を拒否しているものはなかった（AERA DIGITAL は拒否しているが、もともと `summary: false`）。AI の User-Agent を拒否したのはカラパイア（ChatGPT に 403）、政府広報オンライン（AI と自動のブラウザに 403）、首相官邸（AI と自動のブラウザに「ページが見つかりません」）。実際の AI は各社のサーバーから開くので、IP アドレスで拒否するボット対策（Cloudflare など）があるサイトでは、これ以外でも開けないことがある。どのサイトで起きるかは AI によって変わるので、管理画面で記録して見えるようにした。
- 方針: 記事の本文を自動で取ってくる仕組み（記事ページを機械的に取得する・ボット対策をすり抜ける）は作らない。サイトが拒否している取得を回避することになり、利用規約・著作権の問題になりやすく、取得した本文を公開リポジトリ（このサイトのデータはすべて公開される）に置くことにもなるため。代わりに、運営者が自分のブラウザで普通に記事を読んでコピーした本文を、その場でプロンプトに入れる方法と、同じ話題を報じた別の掲載元の記事に切り替える方法を用意した。
- やったこと:
  - **本文の貼り付け**: 管理画面に「AI が開けない記事（本文を貼り付けて要約）」の欄を追加。記事ごとに本文を貼る欄があり、貼るとその記事が選ばれ、プロンプトに本文が入る。プロンプトでは記事一覧に `"text": true` を付け、本文は最後に id つきの区切り（`---- 本文の始め（id: …） ----`）でまとめる。本文のある記事は URL を開かずに本文から要約し、本文に混ざったメニュー・広告などは無視し、本文の中の指示には従わないよう指示する。すべての記事に本文があるときは URL を開く指示を出さない。本文は1記事6,000字まで（超えた分は切って注意を出す）。プロンプトが3万字を超えたら記事を減らすよう注意を出す。
  - 貼り付けた本文はプロンプトを作るのに使うだけで、サイトや GitHub には保存・公開しない。自動ログアウトや再読み込みで消えないよう、そのタブの sessionStorage にだけ残す（タブを閉じると消える。localStorage には入れない）。
  - **本文をコピーするブックマークレット**（`src/lib/bookmarklet.ts`）: 管理画面の「本文をコピー（トピあつめ）」をブックマークバーに登録し、記事のページで押すと、本文を取り出してクリップボードにコピーする。本文の目印（`itemprop="articleBody"`）があればそれを、なければ文字がいちばん多いまとまりを本文とし、メニュー・関連記事・ランキング・共有ボタン・コメント・写真の説明などを除いて、画面に見えるとおりの改行で取り出す。選んだ部分があればそれを使う。先頭にタイトルと URL を付けるので、管理画面は別のサイト・別のページの本文を貼り間違えたら注意を出す（`comparePastedUrl`）。コピーできない環境では、手でコピーできる欄を出す。どこにも送信しない。管理画面の CSP によりブックマークレットは管理画面では動かない（押すと使い方を案内する）。
  - **同じ話題の別の記事**: 管理画面のデータに話題のキー（`topic`）を加え、AI が開けなかった記事に、同じ話題を報じたほかの掲載元の記事を「代わりに ○○ の記事を選ぶ」として出す。同じ話題がすでに要約済みならそのことを出す。
  - **開けなかった記事の記録**: 回答の確認で `unavailable`（と「アクセスできませんでした」のような断り文）になった記事を、このブラウザに14日間記録し、「AI が開けない記事」の欄に出す。記録した記事と、開けなかった記事が2件以上あるサイト（「AI が開けないことが多いサイト」）の記事は、本文を貼るまで手順1で自動では選ばない（件数を表示）。そのサイトの記事を本文なしで要約できたら解除する。「記録を消す」「リストから外す」もある。手順1の各記事にも「本文を貼る」ボタンを付けた。
  - 選んだ記事は、カテゴリで絞り込んでいてもすべてプロンプトに入れるようにした（別のカテゴリの記事に切り替えたときに抜け落ちないように）。
- 主な変更ファイル: `src/lib/summary-core.ts`（`parsePastedText`・`comparePastedUrl`・本文入りのプロンプト・`unavailable` の印）, `src/lib/bookmarklet.ts`（新規）, `src/pages/admin/data.json.ts`（話題のキー）, `src/pages/admin/index.astro`, `src/scripts/admin.ts`, `tests/summary-core.test.ts`, `README.md`
- 確認したこと:
  - ユニットテスト169件（本文入りのプロンプト: 本文のある記事だけ `"text": true`・本文は最後に id つきで入る・すべて本文なら URL を開かせない・本文のない記事だけなら従来どおり、貼り付けた本文の整え方と切り詰め、ページの URL の比べ方、`unavailable` の印）、型チェック、ビルド。
  - ブックマークレット（ビルドした管理画面のもの）を Playwright で試験用の記事ページに使い、本文・小見出し・箇条書きが入り、メニュー・共有ボタン・関連記事・サイドバー・フッター・写真の説明が入らないこと、本文の目印があればその中だけ、段落を使わないページ、選んだ部分の優先、クリップボードが使えないときの案内を確認。実際の記事ページ（GIGAZINE・4Gamer.net・文春オンライン・PRESIDENT Online・シネマトゥデイ・FOOTBALL ZONE・くるまのニュース・Pouch など14サイト、各1記事）でも本文を取り出せることを確認（4Gamer.net は段落を使わないページで、最初の版では取れなかったので取り出し方を改めた。カラパイアのコメント欄は除くようにした）。
  - Playwright で管理画面（GitHub API はモック）: 回答の unavailable と断り文の記録、開けないことが多いサイトの表示、自動の選択から外れること、同じ話題の別の記事への切り替え、本文の貼り付け（字数・別サイトの注意・プロンプトへの反映・目印の除去）、本文を貼った記事だけを選ぶ、再読み込みで本文が戻り localStorage には残らないこと、リストから外す・記録を消す、チェックを外した記事を一覧の作り直しで選び直さないこと、幅390・1280とダークで横にはみ出さないこと、axe の違反0件、CSP 違反なし。ログインの E2E も再実行して問題なし。
- 公開後の確認: push による実行（update.yml run #33）が成功。本番の管理画面に「AI が開けない記事」の欄とブックマークレットがあり、管理画面のデータの要約待ち1324件のうち74件に話題のキーが付いている（同じ話題の要約待ちが2件以上ある話題が30。これらは「代わりに ○○ の記事を選ぶ」が使える）ことを確認した。
- 残った課題・注意点: AI が開けない記事の記録はブラウザごと（「未解決の課題」7）。ブックマークレットはスマホでは使いにくいので、スマホでは本文を選んでコピーする。本文を貼る作業は手間がかかるので、まずは同じ話題の別の記事に切り替えられないかを見るとよい。

### 2026-10-06 収益化できないもの（はてなブックマーク）の削除・管理画面のログイン・UI と検索の大幅改善・SEO と再訪のしかけ

- 依頼・目的: 運営者から「収益化できないのは全て消して、管理者用のログインページとログイン機能を実装。UI の大幅改善、AdSense に通りやすく、要約を活かす、SEO 対策、検索機能の改善、プロンプトの強化と改良、開発記録、検索上位に入る工夫、セキュリティの向上、人が集まってまた見に来てくれるように」。
- やったこと:
  - **収益化できないものを削除**:
    - はてなブックマーク（ホットエントリー8カテゴリの収集元と、ブックマーク数の API）をやめた。Hatena Developer Center の利用規約が「宣伝や商用を目的とした内容」での利用を、はてなの許諾がない限り認めていないため。収集元は74件→66件。`scripts/lib/hatena.ts` を削除し、はてブ数のランキング・「users」の表示もなくした。保存済みのデータに残る `hatebu` は読み込むときに捨て、外した収集元の記事は次の収集で一覧と日別まとめから消える（`pruneDailySnapshots`）。シェアボタンの「はてブ」は共有ページへのリンクだけで API を使わないので残した。
    - AI 要約のうち、商用で使えない記事の要約を `data/summaries/2026-10.json` から削除した（105件→36件）: 以前外した収集元（ゲキサカ15件・ITmedia 12件・ハフポスト6件・J-CAST 6件・BBC 1件）、はてなブックマーク経由で見つけた記事（20件、掲載元の規約を確認していない）、規約で要約・改変を認めていない AUTOMATON（9件）。サイトでも、登録していない掲載元と `summary: false` の掲載元の要約は表示しない（`allowsSummary`）ので、同じものが保存されても載らない。
  - **話題度（「N社が報道」）**: はてブ数の代わりの人気の目安として、同じ出来事を報じた掲載元の数を数える（`clusterTopics`）。見出しの「まれな2文字の組」を共有する記事どうしを候補にし、重み付きの一致度が一定以上のときだけ同じ話題とする。同じ掲載元どうしはまとめない（同じサイトの続報を別の社の報道と数えないため）。本番のデータ（約1540件）で約40の話題がまとまり、別の出来事をまとめる誤りは見つからなかった。トップの「いま話題のニュース」、「話題」ページ（24時間・1週間・カテゴリ別）、サイドバー、カテゴリページ、日別まとめの並び、SNS の「いま話題」（3社以上）、管理画面の「話題の順」に使う。
  - **管理画面のログイン**（`/admin/login/`）:
    - 初回: トークンが本当にこのリポジトリに書き込めるか（`canPush`）を GitHub で確かめ、パスワード（10文字以上）から PBKDF2-SHA256（60万回）で作った鍵の AES-GCM で暗号化して、そのブラウザの localStorage にだけ保存する。パスワードはどこにも保存しない。2回目からはパスワードで復号し、トークンがまだ使えるかを確かめてログイン。
    - ログイン中の状態は sessionStorage（タブを閉じると消える）。30分操作がないか、ログインから8時間で自動ログアウト。選んだ記事と貼り付けた回答はタブの中に残し、同じタブで再ログインすると戻る（チャット AI の回答を待つ間にログアウトしても作業が消えない）。
    - パスワードを5回続けて間違えると30秒ロックし、間違えるたびに倍（最長15分）。ログイン後に移る先（`next`）は管理画面の中だけ（ほかのサイトへ飛ばされない）。
    - 以前の版で平文のまま保存したトークン（`admin.githubToken`）は初回設定の欄に入れ、暗号化して保存し直したら消す。管理画面からトークンの入力欄をなくし、「接続を確認」とログイン中の表示（GitHub のユーザー名・ログアウト）にした。トークンが失効していたときは設定し直す方法をエラーに出す。
    - 管理画面に CSP（スクリプトは自分のサイトのものだけ、通信先は自分のサイトと api.github.com だけ、`object-src 'none'`・`base-uri`・`form-action` の制限）と `no-referrer` を指定し、ほかのサイトの枠（iframe）の中では中身を消す。GitHub Pages ではレスポンスヘッダーを付けられないので meta とスクリプトで行う。インラインのスクリプトをなくした（テーマの反映も外部ファイルへ）。
  - **UI**: トップを「いま話題のニュース」（各社の報道を並べて表示）→「AI要約 ニュースのポイント」（カード）→ 新着 → カテゴリ別の順に作り直した。「ランキング」タブを「話題」に。AI 要約のカード（`SummaryCard`）と話題の一覧（`TopicList`）を新しく作り、要約一覧・カテゴリページで使う。スマホでの横はみ出し、日本語の文中に入っていた余計な空白（テンプレートの改行）、スマホでの管理画面のヘッダーの折り返しを直した。
  - **要約を活かす**: 要約ページに「背景・用語」と「キーワード」（検索へのリンク）、「この話題を報じたほかのメディア」、キーワードが重なる「関連する要約」を追加。AI 要約の RSS（`/summaries/rss.xml`）を新設し WebSub にも通知。要約は検索の対象（要約の本文とキーワード）にも入れ、記事が古くなって一覧から消えても要約で見つかる。
  - **検索**（`src/lib/search-core.ts`）: 全角・半角、大文字・小文字、カタカナ・ひらがなの違いを吸収し、見出し > 要約のキーワード > 要約・抜粋 > 掲載元の順に重み付け（新しい記事・話題の記事・要約のある記事を少し上げる）。カテゴリ・期間・並び順・AI 要約ありで絞り込み、一致部分をマーカーで強調、直近の見出しによく出る言葉を候補として表示、条件は URL に残す（共有・戻るで再現）。「さらに表示」で続きを出す。
  - **プロンプトの強化**: 要約の項目に `background`（背景・用語、120字以内）と `keywords`（固有名詞3〜5個）を追加。書き方のルールを具体的にした（最初の文で「誰が・何を・どうした」、要点は具体的な事実、本文の言い回しを10字以上続けて写さない・直接の引用をしない、数字・固有名詞は正確に、推測や感想を入れない、事件・事故の私人の実名を書かない）。回答の読み取りは「背景」「キーワード」「タグ」などの項目名や「A、B、C」の形にも対応。管理画面の編集でも背景・キーワードを直せる。
  - **SEO・AdSense**: 内容の薄いページ（掲載元別一覧・新着一覧・検索・あとで読む）を `noindex` にしてサイトマップから外し、評価を独自の内容（要約ページ・話題・日別まとめ・カテゴリ）に集める。編集方針のページ（`/editorial/`: 掲載元の選び方・話題の決め方・AI 要約の作り方・著作権・訂正の受付・広告の扱い）を追加し、フッター・運営者情報・要約ページからリンク。要約ページの構造化データにキーワードを追加。カテゴリページの1ページ目に説明・そのカテゴリの話題・要約・掲載元の一覧を表示。
  - **再訪のしかけ**: 「あとで読む」（各記事のしおりボタンで保存、`/saved/`、ヘッダーに件数）、前回の訪問のあとに追加された記事に青い印を付け、トップにその件数を表示（30分あけて開き直すと「前回の訪問」が更新される）。どちらもブラウザ内（localStorage）だけで、プライバシーポリシーに追記した。
  - その他: 検索結果の強調が効いていなかった不具合（入力のままの言葉と正規化した文字列を比べていた）を直し、強調の色をライト・ダークとも読みやすい色にした。ヘッダーの「あとで読む」は、表示している件数も読み上げられるようにした。
- 主な変更ファイル: `sources.yaml`, `docs/SOURCES.md`, `scripts/fetch-feeds.ts`, `scripts/merge-items.ts`, `scripts/lib/store.ts`, `scripts/lib/daily.ts`, `scripts/lib/social.ts`, `scripts/notify.ts`, `scripts/summaries.ts`, `scripts/lib/hatena.ts`（削除）, `src/lib/related.ts`, `src/lib/topics.ts`, `src/lib/items.ts`, `src/lib/summaries.ts`, `src/lib/summary-core.ts`, `src/lib/search-core.ts`（新規）, `src/lib/admin-auth.ts`（新規）, `src/lib/github-commit.ts`, `src/pages/admin/login.astro`（新規）, `src/scripts/admin-login.ts`（新規）, `src/scripts/admin-common.ts`（新規）, `src/scripts/admin.ts`, `src/layouts/AdminLayout.astro`, `src/scripts/reader.ts`（新規）, `src/components/TopicList.astro`（新規）, `src/components/SummaryCard.astro`（新規）, `src/components/RankingList.astro`（削除）, `src/pages/index.astro`, `src/pages/ranking.astro`, `src/pages/search.astro`, `src/pages/saved.astro`（新規）, `src/pages/editorial.astro`（新規）, `src/pages/summary/[id].astro`, `src/pages/summaries/`, `src/pages/category/[slug]/[...page].astro`, `astro.config.mjs`, `data/summaries/2026-10.json`, `README.md`
- 確認したこと:
  - ユニットテスト163件（話題のまとめ方と同じ掲載元をまとめないこと、日別まとめの並びと外した収集元の削除、SNS の話題の判定、背景・キーワードの読み取りと編集、検索の正規化・並べ方・キーワード・強調、トークンの暗号化と誤ったパスワード・ログイン中の状態の期限・続けて間違えたときの制限、GitHub のユーザー名の取得など）、型チェック（0件）、ビルド。
  - Playwright で管理画面のログインを確認（GitHub API はモック）: ログインしていないと管理画面を開けない、初回設定の入力チェック（短い・確認と違うパスワード、無効なトークン）、設定後に管理画面が開きユーザー名が出る、localStorage にトークンが平文で残らない、ログアウト、5回間違えるとロックされ正しいパスワードでも入れない、外部の `next` に移らない、30分操作がないと自動ログアウトし再ログインで作業が戻る、8時間で必ずログアウト、平文のトークンの引き継ぎと削除、保存したトークンを消してやり直す、iframe の中ではフォームを消す、CSP 違反やスクリプトのエラーがないこと。
  - Playwright でトップ・話題・検索・あとで読む・編集方針・要約一覧・要約ページ（背景・キーワードの表示はリポジトリのコピーに試しのデータを入れて確認）・カテゴリ・運営者情報・日別まとめを、ライト／ダーク・幅1280／390で表示し、横のはみ出しなし、axe の違反0件（「あとで読む」の読み上げ名と、ダークでの検索の強調のコントラストを直したあと）、スクリプトのエラーなし。
- 公開後の確認: push による実行（update.yml run #27）が成功（収集・ビルド・公開・通知）。66件すべて取得に成功し（`data/feeds.json` の失敗0件）、記事1592件にはてなの記事・はてブ数は残っていない。日別まとめ（10/4〜10/6）からもはてなの記事が消え、話題度が入った。本番で、管理画面を開くとログインページに移り CSP が指定されていること、トップの「いま話題のニュース」と「N社が報道」、新しいページ（編集方針・あとで読む・要約の RSS・話題）、検索の強調を確認。新しいログインページ（`/admin/login/`）がサイトマップに入っていた（robots.txt で拒否している URL を送ることになる）ので、`/admin/` の下をすべて外した（`astro.config.mjs`）。
- 残った課題・注意点: 運営者は管理画面の初回設定が必要（「未解決の課題」1）。話題度は見出しの似かたで数えるので、言い回しの違う報道はまとまらないことがある（同3）。

### 2026-10-06 収集元を23件から74件に拡充（利用条件を確認）・カテゴリ「サイエンス」「乗り物」を追加

- 依頼・目的: 運営者から「より多く広くのコンテンツを収集」。
- やったこと:
  - 候補のフィード（URL の候補を含めて約200件）を本番と同じ通信（`httpGet`）で取得して、取得できるか・1日の件数・抜粋の有無・見出しの形を確かめ、取得できたサイトの利用規約・RSS の利用条件・リンクポリシーを確認した。商用サイト（広告を載せる予定）で使えないサイト（個人・非営利に限る、営利目的のリンクは不可、クローラーでの収集禁止など）は登録しない。結果は `docs/SOURCES.md` にまとめた（登録しなかったサイトとその理由も記録）。
  - 新しく58件を登録した: FNNプライムオンライン・文春オンライン・デイリー新潮・AERA DIGITAL・日刊SPA!・首相官邸・外務省 海外安全ホームページ（ニュース）、PRESIDENT Online・Business Journal・財経新聞・MarkeZine（経済）、インプレスの各 Watch・窓の杜・ASCII.jp・gihyo.jp・CodeZine・Think IT・DevelopersIO・Security NEXT・デジタル庁（テクノロジー）、ナゾロジー・カラパイア・JAXA・国立天文台・理化学研究所・Science Portal（サイエンス）、シネマトゥデイ・Real Sound・ENCOUNT・ガジェット通信・ロケットニュース24・デイリーポータルZ（エンタメ）、電ファミニコゲーマー・KAI-YOU・マグミクス・おたくま経済新聞（ゲーム・アニメ）、FOOTBALL ZONE・Qoly・Full-Count・ベースボールチャンネル・THE ANSWER・THE DIGEST・AUTOSPORT web（スポーツ）、Car Watch・くるまのニュース・WEB CARTOP・VAGUE・バイクのニュース・Merkmal・鉄道ファン（乗り物）、トラベル Watch・家電 Watch・Pouch・政府広報オンライン・消費者庁（ライフ）。
  - **既存の7件を外した**: 規約を確認したところ、ITmedia（営利目的のリンクは不可・RSS の改変禁止）、ライフハッカー・ジャパン（私的利用の範囲を超える使用の禁止・営利目的のリンクは不可）、BBC（RSS の業務利用は許可が必要）、東洋経済オンライン（営利目的でないことが条件・クローラーでの収集禁止）、ゲキサカ（営利目的の利用禁止）が NG、ハフポスト日本版・J-CAST ニュース（見出し・コンテンツの表示や転載に許可が必要と読める）が要確認だったため。外した収集元の記事は次の収集で一覧から消える（日別まとめと AI 要約は残る）。
  - カテゴリ「サイエンス」（`science`）と「乗り物」（`mobility`）を追加した。「海外」も検討したが、商用で使える海外ニュースのフィードがほとんどなかったので見送った。
  - `sources.yaml` の任意の設定を追加: `limit`（1回に取り込む件数の上限。1日に数百件を配信する FNN・ASCII.jp に設定）、`excerpt: false`（抜粋を載せない。抜粋の扱いがはっきりしないサイトと、加工時に注記が必要な官公庁）、`summary: false`（規約で要約・改変・翻案を禁じているサイト。管理画面の AI 要約の候補に出さない。はてブ経由の同じサイトの記事も同じ）。
  - 記事が増えても重くならないように: 保存の上限を3000件→12000件にし、更新の多いサイトで上限が埋まっても各掲載元の新しい20件は残す。一覧ページ（新着・カテゴリ別・掲載元別）は25ページまで、検索の対象は新しい6000件まで、管理画面に渡す要約待ちの記事は新しい3000件＋はてブの多い500件まで。トップページの「新着」とカテゴリ別の欄は、同じ掲載元を数件までにして新着順に並べる（更新の多いサイトで埋まらないように）。
  - 取得のマナー: 同じ運営元のサイト（`pc.watch.impress.co.jp` と `car.watch.impress.co.jp` のようなサブドメイン違い）は1つのグループとして1件ずつ間隔を空けて取得する。サイトのグループは6つまで同時に取得する（以前はホスト4つ）。
  - 収集元のカテゴリを変えたとき、取得済みの記事も次の収集で新しいカテゴリに移るようにした（`withSourceSettings`）。
  - メニューのタブが増えたので、広い画面ではタブの余白を少し詰め、1行に収まらない幅では右端のぼかしで横スクロールできることを示すようにした。
- 主な変更ファイル: `sources.yaml`, `docs/SOURCES.md`（新規）, `src/config/site.ts`, `src/lib/sources.ts`, `src/lib/types.ts`, `src/lib/items.ts`, `scripts/fetch-feeds.ts`, `scripts/merge-items.ts`, `scripts/lib/store.ts`, `scripts/lib/hosts.ts`（新規）, `src/pages/index.astro`, `src/pages/latest/[...page].astro`, `src/pages/category/[slug]/[...page].astro`, `src/pages/source/[id]/[...page].astro`, `src/pages/search-index.json.ts`, `src/pages/admin/data.json.ts`, `src/components/Header.astro`, `src/pages/about.astro`, `README.md`
- 確認したこと: ユニットテスト（142件。保存の上限と掲載元ごとの最低件数、カテゴリの付け替えと抜粋の削除、同じ掲載元を続けない選び方、一覧の上限、同じ運営元のまとめ方、`limit` の検証、全カテゴリに収集元があること、要約の候補から外す判定）、型チェック、ビルド。リポジトリのコピーで実際に74件すべてを取得して成功（約80秒、新規1196件、はてブ数1316件を更新）、`excerpt: false` の掲載元に抜粋が残らないこと、外した収集元の記事が消えることを確認。その結果でビルドし、Playwright でトップ・サイエンス・乗り物・掲載元一覧を表示（同じ掲載元は「新着」で3件・カテゴリ欄で2件まで）、axe 0件、管理画面で新しいカテゴリの絞り込みと、要約を禁じている掲載元の記事が候補に出ないことを確認。記事数を1万5千件にしたデータでもビルドが約12秒で終わることを確認。
- 公開後の確認: push による実行（update.yml run #23）が成功。GitHub Actions からも74件すべて取得に成功し（`data/feeds.json` の失敗0件）、記事は1836件（テクノロジー552・ゲーム297・ニュース191・エンタメ189・スポーツ149・ライフ146・経済126・乗り物115・サイエンス71）。本番サイトでサイエンス・乗り物のページと「掲載元一覧（全74サイト）」が表示されることを確認した。
- 残った課題・注意点: はてなブックマーク数の API の商用利用（「未解決の課題」2）。収集元の利用条件の最終確認は運営者（同3）。「海外」カテゴリは見送り（同4）。外した収集元の記事と、要約を禁じている AUTOMATON の記事に、運営者が作った要約がある（同5）。

### 2026-10-06 本番での動作確認（自動更新タイマー・管理画面）と、説明書きだけの push で更新しない設定

- やったこと: 自動更新タイマーと管理画面の GitHub 連携が本番で動くことを確かめた。あわせて、`update.yml` の push のきっかけから `**.md` と `docs/**` を外した（開発記録の追記のたびに収集・公開が走り、タイマーの間隔がずれるのを防ぐ）。
- 確認したこと:
  - 管理画面（CORS 修正後）: 運営者のブラウザから「今すぐ更新」（update.yml run #17、09:17 UTC）と「保存して公開」（要約10件、push による run #18、09:20 UTC）が成功し、要約ページが公開された。
  - 自動更新タイマー: timer run #1（08:21 起動）は、途中の push・手動更新で数え直したあと、1ジョブの上限（70分）で timer run #2 に引き継いだ（09:31）。#2 は最後の更新（run #18、09:20）から60分後の 10:22 に update.yml（run #19、github-actions[bot] による実行）を起動し、run #19 は成功。#2 は次のタイマー #3 を予約して正常終了した。以後、約1時間ごとに自動で更新される。
- 主な変更ファイル: `.github/workflows/update.yml`, `docs/DEVLOG.md`
- 残った課題・注意点: なし（運営者のトークンの作り直しは「未解決の課題」1）。

### 2026-10-06 管理画面から GitHub に接続できない不具合（CORS）を修正

- 依頼・目的: 運営者から「トークンを作ったが更新できない」。
- 原因: 管理画面はブラウザから直接 GitHub API を呼ぶが、すべてのリクエストに `X-GitHub-Api-Version` ヘッダーを付けていた。GitHub API の CORS（プリフライトの Access-Control-Allow-Headers）はこのヘッダーを許可していない（公式ドキュメントの許可一覧は Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With のみ）ため、ブラウザがすべての通信を止め、「接続を確認」「今すぐ更新」「保存して公開」が「Failed to fetch」で失敗していた。これまでの管理画面のテストは Playwright の route でモックしており、Playwright がプリフライトを自動で通してしまうため見つけられなかった。
- 確認: 運営者のトークン自体は有効で、ワークフローの実行（今すぐ更新と同じ API）は 204 で成功した（トークンの問題ではない）。
- やったこと:
  - `X-GitHub-Api-Version` を送らないようにした（省略しても既定の 2022-11-28 が使われる）。送ってよいヘッダーを `CORS_ALLOWED_HEADERS` として明記し、これ以外を送ったら失敗するテストを追加。
  - 通信そのものの失敗（「Failed to fetch」）を「GitHub に接続できませんでした…」という分かりやすいメッセージにした。
- 主な変更ファイル: `src/lib/github-commit.ts`, `tests/github-commit.test.ts`
- 確認したこと: 公式ドキュメントどおりの CORS を返す偽の api.github.com（ローカルの HTTPS サーバー）にブラウザをつないで、修正前は「Failed to fetch」で失敗すること（Chromium のエラー: Request header field x-github-api-version is not allowed）、修正後は「接続を確認」「今すぐ更新」「保存して公開」（GET・POST・PATCH の一連の処理）が通ることを確認。ユニットテスト、型チェック。
- 残った課題・注意点: 運営者がチャットに貼ったトークンは漏えい扱いとし、削除して作り直してもらう（新しいトークンには Contents と Actions の Read and write が必要）。

### 2026-10-06 記事収集の点検と、自動更新を「自動更新タイマー」に作り直し

- 依頼・目的: 記事収集・更新機能の点検と、自動更新システムの修正と改良。
- 点検の結果:
  - 収集は正常: 直近の実行で23収集元すべて取得成功（新規10件・合計854件）、フィード取得は約23秒、はてなブックマーク数の取得は約18秒、実行全体で約2分。
  - データにも問題なし: 未来の日時・崩れた見出し・追跡用パラメータつき URL・同じ URL の重複はなし。抜粋のない記事は17件（フィードに説明がないもの）。日別まとめの 10/5 と 10/6 がどちらも338件なのは偶然（カテゴリ別の内訳は別）で不具合ではない。
  - **問題: GitHub の定期実行（schedule）が一度も動いていない**。ワークフローは有効（active）、GitHub の障害もなし。GitHub の定期実行はベストエフォートで、新しいリポジトリでは登録されないことがある（GitHub Community でも同様の報告多数。「既定ブランチへの push で再登録される」とされるが、何度 push しても動かなかった）。
- やったこと:
  - **自動更新タイマー**（`.github/workflows/timer.yml` + `scripts/timer.ts`）: 前回の `update.yml` の実行から60分たつまで待ってから `update.yml` を実行し、自分自身を次に予約する。GITHUB_TOKEN による workflow_dispatch は新しい実行を作れる（GitHub が認めている例外）ことを利用。待っている間に push や「今すぐ更新」があればそこから数え直す（二重に更新しない）。1つのジョブで待つのは最大70分で、それより長い待ち（間隔を長くした場合など）は待てるだけ待ってから次のタイマーに引き継ぐ（すぐに引き継ぐと実行が次々に作られるため）。concurrency で常に1つだけ動かす。
  - `update.yml` から schedule を外し、`keep-timer` ジョブを追加: 実行のたびにタイマーが動いているかを確かめ、止まっていれば再開する（自己修復）。このジョブが失敗しても収集・公開の結果には影響させない（continue-on-error）。
  - タイマー自体が一時的な不調（npm・GitHub API）で失敗したときは、5分後に次のタイマーを予約し直す。失敗が3回続いたら繰り返さずに止める（無限に失敗を繰り返さないため）。
  - 待っている間も Actions の実行時間を使うため、非公開リポジトリでは動かさない（タイマーと keep-timer の両方で確認）。間隔はリポジトリの変数 `UPDATE_INTERVAL_MINUTES`（15〜360分）。
  - 収集の改良: 条件付きリクエスト（前回の ETag・Last-Modified を送り、変わっていなければ 304 で本文を受け取らない。12時間に1回は全部取り直す）、`Retry-After` に従う再試行、はてなブックマーク数の取得を一部の失敗に強く（1回やり直し、失敗した分だけ前回の値のまま）、収集元ごとの状態を `data/feeds.json` に記録。
  - 管理画面: 「サイトの更新」に「自動更新: 動作中（次の更新は〇時ごろ）／停止中」を表示、タイマーが実行した更新を「自動更新」と表示。「収集元の状況」に取得の状態（正常／取得失敗 N回連続とエラー）を追加し、失敗が3回以上続いている収集元を「要確認」にする。
- 主な変更ファイル: `.github/workflows/timer.yml`（新規）, `.github/workflows/update.yml`, `scripts/timer.ts`, `scripts/lib/timer.ts`, `scripts/lib/feed-state.ts`（新規）, `scripts/fetch-feeds.ts`, `scripts/lib/http.ts`, `scripts/lib/hatena.ts`, `scripts/lib/timing.ts`, `src/lib/github-commit.ts`, `src/pages/admin/*`, `src/scripts/admin.ts`, `README.md`
- 確認したこと: ユニットテスト（タイマーを偽の時計と偽の GitHub で: 60分後に更新、記録がなければすぐ、待機中の手動更新で数え直し、長い間隔でも実行を次々に作らない、非公開では何もしない／取得状態の記録／はてブの部分失敗）、型チェック、actionlint、ローカルでフィード取得を2回続けて実行し2回目に8収集元が 304（変更なし）になること、ビルド、Playwright で管理画面（タイマーの表示・停止中の案内・「自動更新」の表示・取得失敗が続く収集元の表示、既存の保存・編集・非表示）、axe 0件。
- 公開後の確認: push による実行（run #13）が成功し、`keep-timer` が自動更新タイマー（timer.yml の run #1）を起動、タイマーが次の更新まで待機に入ったことを確認。`data/feeds.json` も記録された。
- 公開後に見つかったこと: GitHub Actions からの取得でハフポスト日本版のフィードが1回だけ HTTP 406 を返した（直前の実行とローカルからは 200。CDN のボット対策が GitHub のサーバーからのアクセスにだけ時々反応しているとみられる）。403・406・408 も1回だけ再試行するようにした。失敗が続くかは「収集元の状況」で確認できる。
- 残った課題・注意点: 本番で最初のタイマーによる自動実行が起きることを確認する（「未解決の課題」1）。

### 2026-10-06 Claude API による自動要約を削除

- 依頼・目的: 運営者から「コピペ不要ではない。記事の JSON（要約）は自分で作る。費用のかかる Claude（API）は絶対に使わない」との指示。
- やったこと:
  - 自動要約の仕組みをすべて削除した: `scripts/auto-summarize.ts`・`scripts/lib/auto-summary.ts`・`scripts/lib/article.ts` とそのテスト、依存パッケージ（`@anthropic-ai/sdk`・`@mozilla/readability`・`linkedom`）、`npm run auto-summarize`。
  - ワークフローから、手動実行の入力「要約する件数」、変数 `AUTO_SUMMARY_COUNT` による定期要約、`ANTHROPIC_API_KEY` を使う手順、要約の取り込みを削除した。サイトから有料の AI API を呼ぶ処理は残っていない。
  - 管理画面から「AIで自動要約して更新」ボタン・件数・API キーの説明を削除し、「サイトの更新」（今すぐ更新・最近の実行）だけを残した。チャット AI の例から Claude を外した。
  - README・開発記録・`CLAUDE.md` に「有料の AI API は使わない、要約の JSON は運営者が作る」方針を書いた。
- 主な変更ファイル: `.github/workflows/update.yml`, `src/pages/admin/index.astro`, `src/scripts/admin.ts`, `package.json`, `README.md`, `docs/DEVLOG.md`, `CLAUDE.md`
- 確認したこと: ユニットテスト、型チェック、actionlint、ビルド、リポジトリ内に API を呼ぶコード・設定が残っていないこと（`anthropic` / `ANTHROPIC` / `auto-summarize` で検索）、管理画面の E2E（今すぐ更新・保存・編集・非表示）。
- 残った課題・注意点: なし（以前の「AI 自動要約を本物の API で確認する」課題は削除した）。

### 2026-10-06 AI 用プロンプトの詳細化・要約の編集と作り直し・開発記録の開始

- 依頼・目的: プロンプトを丸ごとコピーして AI に渡し、返ってきた JSON をそのままサイトに載せたいので、JSON の指示を詳しくしてほしい。要約の修正をできるようにしてほしい。開発のたびに記録を残して引き継げるようにしてほしい。要約が投稿された記事が「要約する記事を選ぶ」から外れるかの確認。
- やったこと:
  - プロンプト（`buildSummaryPrompt`）を全面的に書き直した。作業の手順、要約の書き方（常体で書く・見出しを繰り返さない等）、出力形式（```json のコードブロック1つだけ・記事一覧と同じ順番で件数ちょうど・項目は id / status / summary / points の4つだけ・各項目の型と値・ダブルクォート・「」を使う・改行や Markdown を入れない・末尾カンマなし）、架空の記事2件の出力例（指定した要約の長さに合わせた文例）、出力前の確認項目、出力しきれないときは配列を正しく閉じる指示を入れた。記事一覧も JSON のコードブロックで渡す。
  - 回答の読み取りを頑丈にした: コードブロックが複数（回答が2回に分かれた）ならつなげる、配列の括弧がない「1行1件」の形、日本語の項目名（要約・要点など）、1件だけのオブジェクト、知らない包み方（`{"output": [...]}`）、要点が文字列で返ってきた場合、要点先頭の「・」「1.」「①」を外す。
  - 断り文の判定の誤検出を減らした: 以前は「サイトにアクセスできない状態が続いた」「ポイントを取得できる」のような普通のニュースの文まで「AI が読めなかった」とはじいていた。AI 自身の「〜できませんでした」という報告（記事・ページ・URL などが主語）と「申し訳ありません」「要約できません」、英語の定型文だけをはじくようにした。
  - 要約の編集: 管理画面の「保存済みの要約」に「編集」ボタンと絞り込みを追加。要約・要点を直して保存すると、最新のファイルを読み直してその要約だけを書き換え、`updatedAt`（手直しした日時）を記録する（最初の保存日時と記事情報はそのまま）。長さは AI の回答と同じ基準で確認し、断り文の判定はしない。要約ページの構造化データ・サイトマップ・IndexNow は `updatedAt` を使う。
  - 要約の作り直し: 手順1に「要約済みの記事も選べるようにする（AI で作り直す）」を追加。要約済みの記事を先頭に並べ、自動では選ばない（チェックしたものだけ）。保存すると「上書き」になる。
  - 開発記録（このファイル）を作り、README と `CLAUDE.md` に「開発したら記録する」決まりを書いた。
  - 確認した仕様: 要約が保存された記事は「要約する記事を選ぶ」に出ない（`/admin/data.json` の要約待ちは要約のない記事だけ。管理画面で保存した直後は、サイトに反映されるまでの間もブラウザ側で6時間外す。AI 自動要約・コマンドラインのプロンプトも要約済みを除く）。要約を削除すると要約待ちに戻る。
- 主な変更ファイル: `src/lib/summary-core.ts`, `src/scripts/admin.ts`, `src/pages/admin/index.astro`, `src/lib/types.ts`, `scripts/lib/auto-summary.ts`, `scripts/notify.ts`, `astro.config.mjs`, `src/pages/summary/[id].astro`, `docs/DEVLOG.md`, `CLAUDE.md`, `README.md`, `tests/summary-core.test.ts`
- 確認したこと: ユニットテスト（プロンプトの中の出力例と記事一覧が JSON として読めること、回答の各種の形、断り文の判定をニュースの文4例・断り文5例で確認）、型チェック、ビルド、Playwright で管理画面（要約済みの記事が候補に出ないこと、絞り込み、編集の検証と保存、作り直しの上書き保存、非表示・実行ボタンの既存テスト）、アクセシビリティ検査（axe）0件。
- 残った課題・注意点: 管理画面で編集できるのは新しい300件まで。

### 2026-10-06 開発の継続（Claude API による自動要約ほか ※自動要約はこのあと削除）

- 依頼・目的: 「時間がもったいない、すぐに開発を継続し改善」。定期実行が動いていない問題への対処と、要約の手作業を減らすための自動化。
- やったこと:
  - **Claude API による自動要約**（`npm run auto-summarize`）: 要約のない記事をカテゴリが偏らないように選び、記事ページから本文を取得（収集と同じブラウザ相当の通信、同じサイトへは間隔を空けて1件ずつ）、Readability で本文を抽出して見出しとの一致を確認し、最大5,000字を Claude に1件ずつ渡す。構造化出力（JSON Schema）で受け取り、管理画面と同じ検証を通してから保存。既定モデル `claude-opus-5-5`・effort `low`（変数 `SUMMARY_MODEL` / `SUMMARY_EFFORT` / `SUMMARY_LENGTH` で変更可）、安全性の判定で断られたときは server-side fallbacks（`fallbacks: "default"`）で別モデルに再実行。認証・権限・利用上限のエラーや連続エラーで打ち切り、結果と費用の目安を Actions の Summary に表示。
  - ワークフロー: 手動実行の入力「要約する件数」（0/5/10/20/30/50）、変数 `AUTO_SUMMARY_COUNT` で定期実行ごとの自動要約。要約は `$RUNNER_TEMP` に書き出し、データのコミット時に `summaries -- import --skip-existing` で取り込む（既存の要約は上書きしない）。要約の失敗はサイトの更新を止めない。
  - 管理画面: 「今すぐ更新」「AIで自動要約して更新」（費用の目安を確認してから実行）、最近の実行状況、サイトが3時間以上更新されていない警告、収集元の状況（3日以上新着がない収集元を「要確認」）。
  - 記事の非表示（NGワード・サイト・個別）: `data/blocklist.json`。一覧・ランキング・検索・RSS・日別まとめ・要約ページ・SNS 投稿から外す。収集データからは消さない。
  - 見出しが同じ記事（Yahoo!ニュースへの転載・スマホ版 URL など）を1件にまとめる。要約のある記事 → 配信元のフィード → 転載サイト以外 → 先に公開 の順で残す。
  - 要約ページに「この話題の関連記事」（見出しの2文字の組を珍しさで重みづけして比較。「試合記録」のような決まり文句だけの一致は除く）。
  - フィード取得の結果（収集元ごとの成功・失敗・件数）を Actions の Summary に表で表示。
  - 同時実行の制御を公開（deploy）と通知（notify）だけにした。以前は全体を1つの concurrency group にしていたため、待機中の実行が次の実行で取り消され、管理画面から依頼した AI 要約が消えることがあった。build は並行してもデータのコミットが衝突しない（取り込み直してから push）。
  - 定期実行の cron を「毎時7分」→「毎時23分」に変えて登録し直した。
- 主な変更ファイル: `scripts/auto-summarize.ts`, `scripts/lib/auto-summary.ts`, `scripts/lib/article.ts`, `.github/workflows/update.yml`, `src/lib/github-commit.ts`, `src/lib/blocklist*.ts`, `src/lib/related.ts`, `src/lib/topics.ts`, `scripts/lib/store.ts`, `scripts/fetch-feeds.ts`, 管理画面一式
- 確認したこと: ユニットテスト（118件）、型チェック、actionlint、模擬 Claude API サーバーでの通し確認（正常・断られた・読めない・401・fallbacks 非対応）、本文抽出を全23収集元の実記事で確認（46件中42件で抽出、38件が見出しと一致）、Playwright で管理画面（実行ボタン・非表示・保存）、axe 0件、リンク切れ0件。本番で同じ見出しの重複が消えたこと、並行実行（run 9・10）がどちらも成功することを確認。
- 残った課題・注意点: 定期実行が動くかは未確認。API キー未設定のため本物の API では未確認。

### 2026-10-06 AI 要約の管理画面と要約ページ

- 依頼・目的: 要約のない記事をまとめて AI に投げるプロンプトを作り、AI が JSON で返した要約をそのままサイトが読み込んで各記事に載せたい。10件・20件をまとめて、管理画面で操作したい。
- やったこと: 管理画面 `/admin/`（記事を選ぶ → プロンプト → 回答を確認 → GitHub に1コミットで保存、保存済みの削除）、回答の検証（一覧にない id・長さ・断り文）、`data/summaries/YYYY-MM.json` への保存（記事情報ごと保存するので元記事が一覧から消えても要約ページは残る）、要約ページ `/summary/{id}/` と一覧 `/summaries/`、一覧・ランキング・検索・RSS での表示、サイトマップ・IndexNow への反映、コマンドライン版。
- 確認したこと: ユニットテスト、Playwright（GitHub API をモック）で選択・プロンプト・検証・保存・削除。

### 2026-10-06 SEO と自動集客

- 依頼・目的: 検索に出るように、自動で人が集まるようにしてほしい。
- やったこと: 日別アーカイブ（`data/daily/` に永続保存）、検索されやすいタイトル・説明文、構造化データ（WebSite・Organization・CollectionPage/ItemList・BreadcrumbList・Article）、サイトマップの lastmod、PWA マニフェスト、カテゴリ別・日別の RSS と WebSub、公開後の IndexNow・WebSub 通知、SNS 自動投稿（X・Bluesky・Mastodon・Misskey、認証情報があるときだけ）、シェアボタン、Bing の所有権確認タグ。データのコミットを「最新に取り込み直してから push」にして、再実行・同時実行でも衝突しないようにした（`scripts/merge-items.ts`）。
- 残った課題・注意点: Search Console・Bing への登録は運営者の作業。

### 2026-10-06 UI の全面改善と収集処理の強化

- 依頼・目的: User-Agent などを普通の利用者に見えるように。詰められるところは詰めて、UI を改善して公開してほしい。
- やったこと: Windows 版 Chrome と同じヘッダーを同じ順序で送る通信（Node の fetch は独自ヘッダーを足すため `node:https` で実装）、Chrome のバージョンを日付から算出、同じホストへはランダムな間隔で1件ずつ、圧縮・リダイレクト・Shift_JIS/EUC-JP・一時エラーの再試行に対応、はてなブックマーク数の取得とランキング、抜粋の整理。UI は2カラム・ランキング・検索・ダークモード・番号付きページ送り・OGP 画像・アクセシビリティ修正。サイト名を「トピあつめ」に。
- 残った課題・注意点: GitHub Pages の環境保護ルールで公開が止まった（運営者が設定を直して解決）。

### 2026-10-06 初期実装

- 依頼・目的: 複数サイトからコンテンツを集めて載せ、将来的に広告で収益化するサイトを作りたい。ジャンルは全般、掲載は RSS の見出し＋短い抜粋＋元記事へのリンク（本文・画像は転載しない）、無料の静的サイトで運用。
- やったこと: Astro による静的サイト、`sources.yaml` の収集元から RSS を取得して `data/items.json` に保存、カテゴリ・収集元別の一覧、広告枠（AdSense の ID を設定したときだけ表示）、運営者情報・プライバシーポリシー・お問い合わせ、RSS・サイトマップ、GitHub Actions による毎時の更新と GitHub Pages への公開。
