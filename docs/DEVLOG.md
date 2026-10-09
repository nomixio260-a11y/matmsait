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

## 現在の状態（2026-10-09 時点）

> **運営者の方針**: 費用のかかる AI API（Claude API など）は使わない。要約の JSON は運営者が管理画面のプロンプトをチャット AI に貼り付けて作り、管理画面に貼り付けて保存する。例外は 2026-10-09 に運営者の依頼で入れた **AI の自動要約**だけで、Cloudflare Workers AI を無料枠（1日1万ニューロン）の中だけで使う（料金がかかる設定・上限・モデルにはしない）。チャット AI の画面（chat.qwen.ai など）をプログラムで動かすことは、利用規約で禁じられているのでしない。

### 公開先

| 項目 | 場所 |
| --- | --- |
| サイト | **https://topiatsume.pages.dev/**（Cloudflare Pages。2026-10-07 に移転し、同日から毎時の更新もここに公開）。以前の https://nomixio260-a11y.github.io/matmsait/ は新しい URL の同じページへの転送ページ |
| 管理画面 | https://topiatsume.pages.dev/admin/ （ログインが必要。ログインページは `/admin/login/`。検索エンジンには非公開）。ページは「ホーム」（`/admin/`）・「AI要約・記事」（`/admin/summaries/`。要約を作る・自動要約・保存済み・記事の非表示・収集元のタブ。要約を作るタブは、上に手順の進み具合、下に次にやることのボタン）・「トピック整理」（`/admin/topics/`）・「SNS 投稿」（`/admin/social/`）・「ピックアップ・お知らせ」（`/admin/content/`）・「通知」（`/admin/notify/`）・「アクセス解析」（`/admin/analytics/`）。PC は左のメニュー、スマホは上のメニューボタンで切り替える（2026-10-09 に整理） |
| アクセス解析・通知 | サイトと同じドメインの `/api`（Pages の Functions）→ Worker `topiatsume-analytics` の Durable Object（Cloudflare、`workers.dev` では公開しない）。通知（プッシュ通知）の購読と送信も同じ Durable Object |
| リポジトリ | `nomixio260-a11y/matmsait`（公開。開発・テスト・毎時の収集とビルドはここと GitHub Actions） |
| 既定ブランチ | `ccr-28054993-x9r1qj`（このブランチへの push で公開される） |
| 公開方法 | GitHub Actions（`.github/workflows/update.yml`）→ Cloudflare Pages（`wrangler pages deploy`。Secrets がなければ GitHub Pages）。アクセス解析の Worker は `analytics.yml` |

### 自動で動いているもの

- **収集・公開**（`update.yml`）: 自動更新タイマー・push・手動実行（管理画面の「ホーム」の「今すぐ更新」/ Actions の Run workflow）で、テスト → 公開先の確認（Cloudflare の Secrets があれば Cloudflare Pages、なければ GitHub Pages）→ フィード取得 → 本文の自動取得 → よく読まれている記事の取得 → **AI の自動要約**（push のときは前回から50分以上たっていれば）→ データをコミット → ビルド → Cloudflare Pages へ公開 → **フォロー中の新着の通知**（`POST /api/push/check`）→ GitHub Pages をページごとの転送ページに → IndexNow・WebSub へ通知（`notify` ジョブ。Cloudflare に公開しているときは GitHub Pages の転送ページの公開（数分かかることがある）を待たずに行い、GitHub Pages に公開しているときは公開を確かめてから行う）（新しく報じられた話題のページ・タグのページも）→ **Bluesky への自動投稿**（Secrets の `BLUESKY_APP_PASSWORD` があるときだけ。下の「SNS（Bluesky）」）。2026-10-07 に運営者が Secrets を登録し、run #51 から pages.dev に公開されている。実行のたびに、自動更新タイマーが止まっていれば再開する（`keep-timer` ジョブ）。
- **自動更新タイマー**（`timer.yml`）: 前回の `update.yml` の実行から60分（変数 `UPDATE_INTERVAL_MINUTES` で変更可）たつまで待ち、`update.yml` を実行して自分自身を次に予約する。待っている間に、前回の更新から30分（変数 `SOCIAL_INTERVAL_MINUTES` で変更可。`0` でやめる）たったら **SNS の投稿だけの実行**（`social.yml`。収集・ビルド・公開はせず、`scripts/notify.ts` で投稿だけ）も行う（2026-10-08 追加。深夜0〜7時と、次の更新まで20分を切っているときは実行しない。投稿だけの実行ができなくても更新は続ける）。GitHub の定期実行（schedule）は一度も動かなかったため、こちらで定期更新する。公開リポジトリでだけ動く（非公開にすると自動で止まる）。
- 収集元は `sources.yaml` の66件（ニュース・経済・テクノロジー・サイエンス・エンタメ・ゲーム・アニメ・スポーツ・乗り物・ライフの9カテゴリ）。どれも利用規約で商用サイトからの利用が禁じられていないことを確認済みで、確認結果（登録を見送ったサイトと理由も）は `docs/SOURCES.md` にある。はてなブックマーク（収集元・ブックマーク数）は商用で使えないため使っていない。
- **AI の自動要約**（2026-10-09 追加。`scripts/auto-summary.ts`・`scripts/lib/auto-summary.ts`・`src/lib/auto-summary-state.ts`、`update.yml` の「AI で自動要約」）: 定期の更新と「今すぐ更新」（workflow_dispatch）のたびに（管理画面の保存などの push では、前回から50分以上たっているときだけ。`--min-interval 50`）、要約のない記事を選び（48時間以内の要約のないトピックを報じた媒体の多い順 → 反応のよいジャンルの24時間以内の記事。`summary: false` の掲載元・非表示の記事は除き、うまくいかなかった記事は7日間選ばない）、本文の自動取得と同じ決まり（robots.txt・AI のクローラーへの拒否・noai・アクセスの拒否を守る）で本文を取得し（保存しない）、管理画面と同じ本文入りのプロンプトで Cloudflare Workers AI の **Qwen3.8 27B（`@cf/qwen/qwen3.8-27b`）に考える量 xhigh（`reasoning_effort`）で**要約を頼む（2026-10-09 に運営者の依頼で Qwen3 30B・考えないから変更。変数 `AUTO_SUMMARY_MODEL`・`AUTO_SUMMARY_REASONING` で変えられる）。管理画面と同じ検証を通り、推測・宣伝・定型文・見出しの言い換えなどの注意（`BLOCKING_KINDS`）がない要約だけを保存する（注意があれば同じ会話で1回だけ直させる。見出しと関係のない要約・本文が見出しの記事と一致しない記事は使わない）。上限は1回4件（変数 `AUTO_SUMMARY_PER_RUN`。0 で止める）・1日（UTC）60件（`AUTO_SUMMARY_PER_DAY`）・使う量の見積もり1日8,000ニューロン（無料枠1万の手前。変えられない）で、使う量は1日の時間で均す（`pacedBudget`）。Qwen3.8 27B・xhigh は1件1,500〜3,000ニューロンほどなので、実際は1日3件前後になる見込み。作った要約は `--out` のファイルから「取得したデータをコミット」で `npm run summaries -- import --skip-existing` で取り込み（その間に運営者が保存した要約は上書きしない）、`generator`（モデル）を記録する。要約のページには「AIが元記事の本文をもとに自動で作成し、機械的な確認だけで掲載しています」と出し（`isAutoSummary`。運営者が編集すると消える）、編集方針（`/editorial/#auto-summary`）と about の取得のしかたにも書いた。試した記録・その日の使った量の見積もり・最後の実行・続いている問題（権限がない・無料枠を使い切った・依頼が続けて失敗した）は `data/auto-summary.json` に残し、管理画面の「AI要約・記事」の「自動要約」のタブと「ホーム」（権限などの問題は「対応が必要なこと」、作った数は「お知らせ・提案」）に出す。自動で作った要約も「10秒でわかるニュース」として Bluesky に自動投稿される。
- **本文の自動取得**（`scripts/fetch-texts.ts`・`scripts/lib/text-fetcher.ts`・`scripts/lib/article-text.ts`、`update.yml` の「AI が開けない記事の本文を取得」）: 管理画面が `data/text-requests.json` に書いた依頼（AI が開けなかった記事）について、フィードと同じブラウザ相当の通信（ボットの名前は名乗らない）で記事のページを取得し、本文を運営者の公開鍵（`data/text-keys.json`）で暗号化して `data/texts.json` に置く。robots.txt（クローラー全般と AI のクローラーの拒否）・noai・アクセスの拒否を守り、1回15件・5分まで（`RUN_BUDGET_MS`。残りは次の実行）。依頼がなければ何もしない。2026-10-09 に取り方を改善した: 本文の候補（構造化データ・埋め込みデータ・本文の目印・文の多いまとまり）を比べて選び、前後の余計な行（日付・カテゴリ・写真や次ページへのリンク・ページ送り・共有ボタン・著作権表示など）を落とす。複数ページの記事は2ページ目以降（最大6ページ）をつなげ、「全文を読む」「つづきを読む」の先を使い、本文が短ければ記事本体へのリンク・AMP 版・WordPress の API を試す（たどる先・転送先も robots.txt で確かめる）。一時的な失敗は30分あけて3回まで、前の取り方（版 `TEXT_FETCH_VERSION`）で本文を取れなかった記事は1回だけ自動で取り直す。
- **フォロー・通知**（2026-10-07 追加）: 読者がジャンル・掲載元・キーワードをフォローすると「フォロー中」（`/following/`）に新着をまとめ（ブラウザだけに保存）、通知をオンにした人には、毎時の公開のあとに Durable Object が `updates.json` のはじめて見た記事をフォローと照らし合わせてプッシュ通知を送る（1日1回の朝のまとめ・夜は送らない設定も）。いま話題のニュース（4媒体以上）と、管理画面からの運営のお知らせも送れる。VAPID の鍵は Durable Object が作って保存（秘密の設定は不要）。表示しない設定（ミュート）・既読・表示の設定（`/settings/`）もブラウザだけに保存。
- **アクセス解析**（Cloudflare。2026-10-07 から pages.dev で動作中）: サイトのページが見たページ・開いた記事・検索・保存・閲覧時間などを同じドメインの `/api/collect` に送り（`src/scripts/analytics.ts`）、Pages の Functions（`functions/api/[[path]].ts`、中身は `analytics/src/front.ts`）が Worker `topiatsume-analytics` の Durable Object（SQLite）に渡して数える。管理画面の「アクセス解析」（`/admin/analytics/`）で見る。`update.yml` が毎回よく読まれている記事を `/api/popular` から `data/popular.json` に取り込む（`scripts/popular.ts`。Cloudflare に公開していないときは何もしない）。GitHub Pages で公開している間はアクセス解析なし。
- **サイトのコンセプトと見た目**（2026-10-08 に全面改善の Phase 1 を公開。計画は `docs/REDESIGN.md`）: 「ニュースを「記事」ではなく「話題」で読む。」（記事を集める。話題を整理する。変化を見つける。）。ヘッダーのメニューは5つ（ホーム・話題 `/ranking/`・急上昇 `/rising/`・トレンド `/trends/`・ジャンル `/genres/`）。トップは今日のダッシュボード（今日の数字 → ニュースの温度 → 今日、変化したこと → ピックアップ → 今話題 → 急上昇 → 今日の5トピック → 注目ワード → 新着のタイムライン）。言葉は「トピック」（同じ出来事の記事のまとまり）・「N媒体が報道」・「初報＝最初に確認できた報道」・「今日の注目」（重要度の判断ではない）にそろえ、about の「言葉の意味」に説明がある。色は話題度＝赤（`--heat`）・急上昇＝紫（`--rise`）、アイコンは線のアイコン（`src/components/IconSprite.astro`。絵文字は使わない）、トピックのカードは `src/components/TopicList.astro` の1種類。煽る言葉は使わない。
- **話題エンジン**（2026-10-07 追加・10-08 拡張。`src/lib/topic-core.ts`・`src/lib/topics.ts`）: 同じ出来事を報じた記事のまとまり（`src/lib/related.ts` の `clusterTopics`。直近8日の記事。2026-10-08 から、かぎかっこの中の名前が同じ・6時間以内・見出しの似かた0.3以上の報道もまとめる2段目と、運営者の統合・分割（`data/topic-overrides.json`）を反映）＝**トピック**ごとに、報じた媒体の数（「N媒体が報道」）・**話題度**（0〜100。今どれくらい話題か。報道1件ごとに1を足し12時間ごとに半分に減らす＋報じた媒体のジャンルの広がり＋サイトで読まれた人数。熱さ4で63点。内訳は `scoreBreakdown` で、一覧の「話題度」を押すと開く）・直近1/3/24時間に新しく報じた媒体の数・初報（最初に確認できた報道）・**勢い**（`momentumOf`。3時間で何媒体から何媒体に増えたか・その前の6時間と比べたペース）・**なぜ話題？**（`whyTrending`。報道の状況だけを数字から機械的に書く）を計算する。ここから「今話題」（話題度の順。トップの「今話題」の件数は話題度30以上）・「急上昇」（3時間に新しく報じた媒体の多い順。少なければ6・12時間に広げる）・「報じられ始めたトピック」（最初の報道から6時間）・「今日の注目／今日の5トピック」（24時間の報道の数とジャンルの広がり。ジャンルごとに件数の上限）・「注目ワード」（24時間の見出しに急に増えた言葉。候補は AI 要約のキーワードとタグの言葉）・「ニュースの温度」（`genreTemperature`。ジャンルごとの熱さの合計と昨日の同じ時刻との比較）・「今日、変化したこと」（`getTodayChanges`）・「メディア別」（トピックの数と初報の数。`/sources/` に表示）を作る。2つ以上の媒体が報じたトピックには**トピックのページ**（`/topic/<最初の記事のID>/`。2026-10-08 に Phase 2 で作り直し: 段階（発生・拡大・ピーク・減少。`lifecycleOf`）と概要の文（`topicOverview`）→ 数字（話題度の内訳・媒体・急上昇・初報）→ なぜ話題？ → AI 要約の10秒で把握/30秒で理解/2分で深掘り → **各メディアの視点**（AI 整理があればそれ、なければ見出しの機械的な比較 `src/lib/headline-compare.ts`）→ 報道タイムライン → 報道の広がり（節目・ジャンルの順・累計のグラフ）→ 話題度の推移（`heatSeries`）→ 関連するトピック・前後のニュース）があり、記事の「N媒体が報道」から開ける。検索エンジンに出すのは3媒体以上か AI 要約のあるトピックだけ（ほかは noindex）。
- **日ごとの集計とトレンド**（2026-10-08 追加。全面改善の Phase 4。`scripts/lib/trends.ts`・`src/lib/trend-core.ts`・`src/lib/trends.ts`）: 毎時の収集（`fetch-feeds.ts`、ワークフローでは取り込み直しの `merge-items.ts`）で、`data/trends/YYYY-MM-DD.json`（日本時間の1日ごと）の直近3日分を作り直す（中身が変わらない日は書かない）。記事・媒体・トピックの数、ジャンルごとの記事・トピック・温度、見出しの言葉（AI 要約のキーワードとタグの言葉。2件以上）の数、その日のトピックの上位（最高話題度・その日に増えた媒体・3時間の増加の最大・初報の見出しと URL）。トピックはサイトと同じ直近8日・同じまとめ方（統合・分割を含む）で、非表示の記事は数えない。記事が消えたあとも残り、日別のページの「その日の分析」と `/weekly/`（今週のトピあつめ）に使う（表示のときにも非表示の設定で外す）。`/trends/` は記事から計算する「いまの変化」（昨日との違い＝急増・急減・新登場・収束、急に現れた言葉、注目ワードの表、一緒に出始めた言葉、ジャンルの変化）。注目ワードの「ふだん」は 2026-10-08 にそれまでの6日間から7日間（`WORD_BASELINE_DAYS`）に変え、「新」は7日間に1件以下（`isNewWord`）にそろえた。
- **キーワードのページと検索**（2026-10-08 追加。`src/lib/words.ts`・`src/pages/word/[slug].astro`・`src/pages/words.astro`・`src/lib/search-core.ts`・`src/pages/search-topics.json.ts`）: AI 要約のキーワードとテーマの言葉のうち、直近8日間に3件・2媒体以上の見出しに出てくる言葉に `/word/<言葉>/`（7日間の推移・トピック・一緒に出てくる言葉・テーマ・新着。8件・3媒体以上でトピックもあれば検索エンジンに出す）。一覧は `/words/`。検索はトピック・キーワード・記事に分けて出し、「今日 急上昇 AI」のような期間・並べ方・ジャンルの言葉を条件として読む。
- **AI 整理（トピック整理）**（2026-10-08 追加。`src/lib/topic-notes-core.ts`・`src/lib/topic-notes.ts`・管理画面 `/admin/topics/`）: 運営者が管理画面でトピックを選んでプロンプトをコピーし、チャット AI の回答を貼り付けて保存すると、`data/topic-notes/YYYY-MM.json`（トピックの最初の報道の月。記事の ID の組で保存）に入り、トピックのページの「各メディアの視点」に「共通して報じられていること（出典が2つ以上）・各媒体が特に伝えていること・報道内容の差（判断しない）・背景」と、事実と分けた「AI による整理・解釈」が出る。要約を禁じている掲載元の記事はプロンプトに入れず、出典からも外す。煽る言葉・URL を含む回答は受け付けない。費用のかかる AI API は使わない。
- **SNS（Bluesky）**（2026-10-07 追加。`scripts/lib/social.ts`・`scripts/notify.ts`・`src/lib/social-source.ts`）: 公式アカウント **@topiatsume.bsky.social**（https://bsky.app/profile/topiatsume.bsky.social ）に、**30分ごとに1件**自動で投稿する（2026-10-08 に毎時から変更。投稿の機会は、毎時の公開のあと（`update.yml` の `notify`）と、その30分後の投稿だけの実行（`social.yml`。同じ `notify` の並び（concurrency group）で1つずつ動く））。決まった時間の投稿は、朝（7〜10時台）の今日の注目ニュース（`/ranking/#today`）・昼（12〜14時台）の AI ニュース（`/tag/ai/`）・夜（21時以降）の今日の話題ニュース（日別まとめ）・日曜の夕方（18〜20時台）の今週の話題ニュース TOP5（`/ranking/#week`）。話題の投稿（決まった時間の投稿がないとき）は、急上昇（3時間で2媒体以上・計3媒体以上）・いま話題（4媒体以上・話題度50以上・12時間以内に報道があったもの）・10秒でわかるニュース（48時間以内に保存した、公開から48時間以内の記事の AI 要約の1文目と要点の箇条書き（見出し・1文目の繰り返しの要点は省く）。報じたメディアの多い話題から、テクノロジー・ゲーム・サイエンスを少し優先（`SOCIAL_LIMITS.preferredCategories`）。急上昇・いま話題がない時間はこれで30分ごとの投稿を埋める）で、リンクは話題のページ。急上昇・いま話題の投稿には AI 要約の1文目（あれば）と報じたメディアの名前（「報じたメディア: A・B・C ほか2媒体」）を入れ、話題の投稿のあとは10秒でわかるニュースを先にする（交互になるように。2026-10-09 から）。深夜0〜7時は投稿しない・自動の投稿は1回1件で前の投稿（種類を問わない）から20分以上あける・24時間に40件まで・種類ごとに24時間の上限（急上昇12・いま話題12・10秒30）・同じ話題は二度投稿しない（`SOCIAL_LIMITS`）。本文のリンクは短く表示して流入元の印（`utm_source=bluesky&utm_medium=social&utm_campaign=<種類>`。アクセス解析では「SNS」に数える）を付けたリンクにし、`#ニュース`・タグごとのハッシュタグ（`src/config/tags.ts` の `hashtags`）・AI 要約のキーワードのハッシュタグ（空白・記号のない固有名詞。合わせて3つまで）と、投稿ごとの見出しのカード画像のリンクカード（`src/lib/og-image.ts`。作れなければ `public/og.png`）を付ける。投稿の記録は `data/social.json`（`notify` ジョブと `social.yml` がコミット）で、管理画面の「SNS 投稿」（`/admin/social/`）に最近の投稿（何を投稿したかの題名つき。題名はサイトのビルドのときに記事・要約から付ける）と、次に投稿されうる内容の下書きが出る（「ホーム」にも最新の3件）。フォロー・いいね・返信の自動化はしない。**管理画面の「今すぐ Bluesky に投稿」**（2026-10-07 追加）を押すと、依頼（`data/social-request.json`）を GitHub に保存 → その push で `update.yml` が動き、最新の記事の取り込み・公開のあとに `notify` が依頼を見つけて、時間帯・間隔を待たずにまだ投稿していない話題を1件（急上昇 → いま話題 → 10秒でわかるニュース。なければ「いま話題のニュース」のまとめ）投稿し、結果を `data/social.json` の `manual` に書く（管理画面がそれを読み、投稿へのリンクつきで表示。押してから約2分。24時間に50件まで・30分以上たった依頼は投稿しない）。サイトのフッター・サイドバー・トップ（急上昇の下）・急上昇・話題のページに「Bluesky でフォロー」の案内（`src/components/FollowCta.astro`）。X は API が有料なので使わない。Mastodon・Misskey は Secrets を登録すれば同じ内容を投稿する。
- **共有画像（OGP）**（2026-10-09 追加。`src/lib/og-image.ts`・`src/lib/og-cards.ts`・`src/pages/og/`）: 話題のページ・AI 要約のページ・日別まとめのページに、ページごとの見出しのカード（1200×630 の PNG。「N媒体が報道」「AI要約」などの印・見出し・AI 要約の1文目・ジャンル。日別は上位5件の見出し）を `og:image`・`twitter:image` に出す（ほかのページは `public/og.png`）。ビルドのときに satori（文字を図形に）と sharp（PNG に）で作り、フォントは `assets/fonts/NotoSansJP-Bold.woff`（Noto Sans JP の太字を日本語の範囲に絞ったもの。約2.7MB。SIL Open Font License、`assets/fonts/OFL.txt`）。1枚約0.2秒かかるので、内容の同じ画像は `.cache/og`（git の対象外）に残して使い回し、`update.yml` は `actions/cache@v6` で次のビルドに引き継ぐ（3日使われない画像は消す）。キャッシュがないビルド（最初の1回）は画像約600枚で約2分長くかかり、ふだんは数秒。Bluesky の投稿の画像は、投稿のたびに `scripts/notify.ts` が同じ部品で作る。
- **タグ**（`src/config/tags.ts`）: AI・Apple・Google・Microsoft・任天堂・PlayStation・MLB・セキュリティ・半導体・EV・災害・政治・株価の13個。見出しと AI 要約のキーワードを正規表現で当てはめ（タグごとにジャンルを絞って誤りを減らす）、`/tag/<slug>/`（AI は「AIニュースランキング」）と `/tags/` にまとめる。記事が8件未満のタグのページは noindex。
- よく読まれている記事: アクセス解析の読まれた人数による「よく読まれている記事」（`/popular/`・トップ・サイドバー・「人気N位」）と、管理画面の「よく読まれている順」。話題度スコアにも少し足す。
- 記事は直近30日・最大12000件を `data/items.json` に保存（更新の多いサイトで上限が埋まっても、各掲載元の新しい20件は残す）。一覧ページは25ページ（1000件）まで、検索は新しい6000件まで。

### 運営者の設定状況

| 設定 | 状態 |
| --- | --- |
| GitHub Pages（Source: GitHub Actions） | 設定済み・公開中 |
| AI 要約 | 運営者が管理画面で作成（有料の AI API は使わない）。AI が開けない記事は、運営者が本文を貼り付けて本文入りのプロンプトで依頼するか、同じ話題の別の記事に切り替える。長いプロンプトは分割・ファイルで渡せ、AI の回答はファイルでも読み込める。2026-10-08 にプロンプトを「AI 要約内容 改善指示書」の基準で書き直し、回答の確認・保存済みの要約に「要確認」（宣伝の言葉・定型文・推測・あいまいな日付・長すぎる文など）を出すようにした（保存は止めない） |
| AI の自動要約（Workers AI） | 仕組みは公開済み（2026-10-09）。モデル・考える量は既定（Qwen3.8 27B・xhigh。変数 `AUTO_SUMMARY_MODEL`・`AUTO_SUMMARY_REASONING` は未設定）。Workers AI の権限のある API トークン（Secrets の `CLOUDFLARE_AI_TOKEN`）は**未登録**。登録していなければ公開用の `CLOUDFLARE_API_TOKEN` で試すが、2026-10-09 の本番の最初の実行で、公開用のトークンには Workers AI の権限がない（HTTP 401）ことを確かめた。そのため自動要約は、運営者が `CLOUDFLARE_AI_TOKEN` を登録するまで止まっている。権限がなければ管理画面に「要対応」と出るので、README の「AI の自動要約」の手順でトークンを作って登録する |
| 管理画面のログイン | 管理画面を開くとログインページに移る。トークンはパスワードで暗号化して運営者のブラウザにだけ保存（Contents と Actions の Read and write が必要）。2026-10-07 に運営者が設定し直した（パスワードを忘れたため） |
| 本文の自動取得 | 公開済み。運営者の公開鍵は 2026-10-07 に登録済み（`data/text-keys.json`） |
| Cloudflare（公開先・アクセス解析・通知） | 運営者がアカウントと API トークンを作成し、GitHub の Secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）を登録済み（2026-10-07。登録後の update.yml run #51 で pages.dev への公開と GitHub Pages の転送ページを確認）。Worker `topiatsume-analytics` と Pages のプロジェクト `topiatsume` を使う。ダッシュボードで作られた Worker `matmsait`（Hello World のひな形）は使っていない |
| 管理画面のログイン（新しい URL） | 運営者が pages.dev の管理画面で初回設定済み（2026-10-07。本文の自動取得の鍵を新しく登録した push で確認） |
| お知らせ・ピックアップ・通知 | 機能は公開済み。お知らせ（`data/notice.json`）とピックアップ（`data/picks.json`）は、運営者が管理画面から保存すると作られる（まだない） |
| SNS（Bluesky） | アカウント `@topiatsume.bsky.social`（運営者が用意）。プロフィール（名前・説明・アイコン・バナー・サイトの URL）・「自動で投稿するアカウント」（bot）のラベル・固定の紹介の投稿は 2026-10-07 に設定済みで、同日に本番と同じ処理で2件（今日のまとめ・いま話題）を投稿して確かめた。GitHub の Secrets の `BLUESKY_APP_PASSWORD` は運営者が登録済み（2026-10-07。update.yml run #69 のログで値が入っていることを確認。ハンドルは既定値が入るので `BLUESKY_IDENTIFIER` は不要）。管理画面の「今すぐ Bluesky に投稿」も使える。X は使わない（API に無料枠がなく、URL つきの投稿は1件0.2ドル）。Mastodon・Misskey は未設定（任意） |
| AdSense・Google アナリティクス | 未設定（変数を設定すると有効になる。Google アナリティクスは上のアクセス解析と併用できる） |
| Search Console | 確認待ち。2026-10-09 に運営者が変数 `PUBLIC_GOOGLE_SITE_VERIFICATION` を設定した（DNS の TXT レコード用の形 `google-site-verification=…` で入っていたので、サイトはコードだけを取り出して meta タグに出す）。「ドメイン」のプロパティで DNS の確認をして失敗した（`pages.dev` は DNS を変えられない）ので、「URL プレフィックス」（`https://topiatsume.pages.dev/`）のプロパティを作り、HTML タグで確認する。確認できたらサイトマップに `sitemap.xml` を送信する |
| Cloudflare Web Analytics | 未設定（任意。Pages のプロジェクトの「Metrics」から無料で有効にできる。自前のアクセス解析と併用できる） |
| 独自ドメイン | なし（収益化の段階で取得を推奨） |

### 主なファイル

| 場所 | 役割 |
| --- | --- |
| `sources.yaml` | 収集元の一覧（任意の設定: `limit`・`excerpt: false`・`summary: false` など） |
| `docs/SOURCES.md` | 収集元の利用条件の確認記録（登録したサイト・見送ったサイトとその理由） |
| `src/config/site.ts` | サイト名・キャッチコピー（`tagline`・`taglineParts`・`subcopy`・`philosophy`）・カテゴリ・運営者情報などの設定 |
| `scripts/fetch-feeds.ts` | フィード取得（ブラウザ相当の通信は `scripts/lib/http.ts`、取得状態の記録は `scripts/lib/feed-state.ts`、同じ運営元のサイトをまとめるのは `scripts/lib/hosts.ts`） |
| `.github/workflows/timer.yml`, `scripts/timer.ts`, `scripts/lib/timer.ts` | 自動更新タイマー（更新の合間に SNS の投稿だけの実行 `social.yml` も呼ぶ。`planCycle`・`nextSocialAt`） |
| `.github/workflows/social.yml` | SNS の投稿だけの実行（更新の合間。`NOTIFY_SKIP_PING=1` で `scripts/notify.ts` を動かし、投稿の記録をコミットする） |
| `scripts/lib/store.ts` | 記事のマージ・重複（同じ URL・同じ見出し）のまとめ・保存 |
| `scripts/summaries.ts` | 要約のプロンプト作成・取り込み（コマンドライン） |
| `scripts/auto-summary.ts`, `scripts/lib/auto-summary.ts`, `src/lib/auto-summary-state.ts` | AI の自動要約（記事の選び方 `pickCandidates`・本文の取得 `articleTextOf`・Workers AI への依頼 `workersAiClient`・1件の要約と直し `summarizeItem`・上限と記録 `runAutoSummary`）と、記録のファイルの読み書き・管理画面に出す状況（`autoSummaryStatus`） |
| `data/auto-summary.json` | AI の自動要約の記録（その日（UTC）の使った量の見積もりと保存数・14日分の試した記録・最後の実行・続いている問題。毎時の更新が書く） |
| `src/lib/og-image.ts`, `src/lib/og-cards.ts`, `src/pages/og/`, `assets/fonts/` | 共有画像（ページ・投稿ごとの見出しのカード）の描画（satori＋sharp・作った画像の使い回し）・中身（話題・要約・日別）・画像のページ（`/og/topic/<ID>.png` など）・フォント（Noto Sans JP の太字を絞ったもの。OFL） |
| `scripts/notify.ts`, `scripts/lib/social.ts`, `src/lib/social-source.ts` | 公開後の通知（IndexNow・WebSub）と SNS（Bluesky）の自動投稿（投稿の種類・時間帯・上限（`SOCIAL_LIMITS`）・本文とリンク（流入元の印・短い表示・ハッシュタグ・リンクカード）・投稿の材料（いま話題・急上昇・今日の重要・AI・今週・AI 要約）。話題はサイトのビルドと同じ計算なので話題のページの URL と一致する） |
| `src/components/FollowCta.astro`, `src/config/site.ts` の `socialAccounts` | 「Bluesky でフォロー」の案内（トップ・急上昇・話題のページ）と、フッター・サイドバー・構造化データ（`sameAs`）の SNS のリンク |
| `scripts/lib/daily.ts` | 日別まとめ（`data/daily`）の作成。多くのメディアが報じた話題の順に選び、同じ話題の記事は1件だけ載せる |
| `src/lib/summary-core.ts` | 要約のプロンプト（書き方の決まり `summaryRules`・記事の公開日時・直してもらうプロンプト `buildFixPrompt`）・回答の読み取りと検証・要約ファイルの読み書き（管理画面と共通） |
| `src/lib/summary-quality.ts` | 要約の品質の確認（見出しの言い換え・中身のない書き出し・宣伝の言葉・定型文・推測・あいまいな日付・文体・長すぎる文・単位・長い引用・SNS の誇張・接続詞。要約・保存済みの要約・CLI・AI 整理で共通の「要確認」） |
| `src/lib/blocklist-core.ts` | 記事の非表示（NGワード・サイト・個別） |
| `src/lib/related.ts` | 見出しの似ている記事（同じ話題）を探す・話題ごとにまとめて話題度を数える（`clusterTopics`） |
| `src/lib/topics.ts` | トピック（`getTopicViews`: 話題度・急上昇・初報・AI 要約・タグつき）、今話題（`getHotTopics`）・急上昇（`getRisingTopics`）・今日の注目（`getImportantTopics`）・注目ワード（`getTrendWords`）・メディア別（`getMediaStats`）・タグの記事、記事ごとの媒体の数（`coverageOf`）、トピックの説明（`topicWhy`・`topicScoreBreakdown`・`topicMomentum`・`momentumText`）、ニュースの温度（`getGenreTemperature`）・今日の数字（`getTodayCounts`）・今日、変化したこと（`getTodayChanges`） |
| `src/lib/topic-core.ts`, `src/lib/tag-core.ts`, `src/config/tags.ts` | トピックの数字の計算（ID・初報・新しく報じた媒体の数・話題度とその内訳・ある時点の熱さ・勢い・なぜ話題？・ニュースの温度・重要度・注目ワード。Node の機能を使わない）とタグの定義・当てはめ |
| `src/pages/index.astro`, `src/pages/trends.astro`, `src/pages/genres.astro` | トップ（今日のダッシュボード）・トレンド（今日、変化したこと・昨日との違い・急に現れた言葉・注目ワードの表・一緒に出始めた言葉・ジャンルの変化・報じられ始めたトピック）・ジャンル（ジャンル・テーマ・読み方から探す入口） |
| `src/lib/trend-core.ts`, `src/lib/trends.ts`, `scripts/lib/trends.ts`, `data/trends/YYYY-MM-DD.json` | トレンドの計算（日ごとの集計・その日の最高話題度と広がる速さ・ジャンルの変化・その日の注目ワード・週間のまとめ・言葉の増減・一緒に出始めた言葉・収束したトピック・新しく登場したトピック）、サイトでの読み込みと「いまの変化」、毎時の集計の保存 |
| `src/pages/weekly.astro`, `src/components/DayAnalysis.astro`, `YesterdayDiff.astro`, `WordTable.astro`, `GenreChangeTable.astro` | 今週のトピあつめ、日別のページの「その日の分析」、昨日との違い、注目ワードの表、ジャンルの変化の表 |
| `src/pages/topic/[id].astro`, `src/pages/rising.astro`, `src/pages/ranking.astro`, `src/pages/tag/[slug].astro`, `src/pages/tags.astro` | トピックのページ（各媒体の報道の比較）・急上昇・話題のランキング（と今日の注目）・テーマ（AI ニュースランキングなど）・テーマ一覧 |
| `src/components/TopicList.astro`, `FocusTopics.astro`, `NewsTemperature.astro`, `TodayChanges.astro`, `ImportantList.astro`, `TrendWords.astro`, `MediaStats.astro`, `SummaryLevels.astro` | トピックのカード（どの一覧でも同じ形。話題度と内訳・N媒体・急上昇の印・勢い・なぜ話題？・初報）、今日の5トピック（何が起きた・なぜ話題）、ニュースの温度、今日、変化したこと、今日の注目、注目ワード、メディア別の表、AI 要約の10秒/30秒/2分 |
| `src/components/IconSprite.astro`, `Icon.astro`, `Wrap.astro`, `src/styles/global.css` | 線のアイコン（`<Icon name="heat" />`）、条件つきの入れ物、色（`--heat`・`--rise`・`--warn`（報道の違い））・文字の大きさ（`--fs-*`）・余白（`--sp-*`）・数字の等幅（`.num`）・説明の1行（`.definition`） |
| `src/components/ReportTimeline.astro`, `SpreadSteps.astro`, `HeatTrend.astro`, `HeadlineCompare.astro`, `TopicNotes.astro`, `src/lib/headline-compare.ts` | トピックのページの部品（報道タイムライン・報道の広がり・話題度の推移と段階・見出しの比較・AI 整理の表示）と、見出しの比較の計算 |
| `src/lib/topic-notes-core.ts`, `src/lib/topic-notes.ts`, `src/pages/admin/topics.astro`, `src/scripts/admin-topics.ts`, `data/topic-notes/` | AI 整理（プロンプト・回答の検証・保存ファイル・トピックとの結び付け）と管理画面の「トピック整理」 |
| `src/lib/topic-overrides-core.ts`, `src/lib/topic-overrides.ts`, `data/topic-overrides.json` | トピックのまとめ方の手直し（分割・統合。`clusterTopics` の `cannotLink`・`mustLink` にする。サイトのビルドと日別まとめで同じものを使う） |
| `src/lib/words.ts`, `src/pages/word/[slug].astro`, `src/pages/words.astro` | キーワードのページ（候補の言葉・記事の数・7日間の推移・一緒に出てくる言葉）と一覧 |
| `src/pages/search-topics.json.ts`, `src/pages/search.astro` | 検索のトピック・キーワードの小さな索引と、検索ページ（言葉での条件・トピック・キーワード・記事・一致した場所） |
| `src/components/Header.astro` | ヘッダー（5つのメニュー。カテゴリ・タグなどのページでは「ジャンル」を選ぶ。スマホでは均等に並べる） |
| `src/lib/summary-view.ts` | AI 要約の「10秒で把握」（要約の1文目。プロンプトで1文目に「誰が・何を・どうした」を書かせている）など |
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
| `src/pages/admin/index.astro`（ホーム）, `summaries.astro`（AI要約・記事）, `social.astro`（SNS 投稿）, `content.astro`, `notify.astro`, `src/scripts/admin-dashboard.ts`, `admin-social.ts`, `admin-content.ts`, `admin-notify.ts`, `admin-shared.ts`, `admin-tabs.ts`（ページの中のタブ）, `src/styles/admin.css` | 管理画面の各ページと共通の処理・見た目（AI要約・記事のページの処理は今までどおり `src/scripts/admin.ts`。タブは `admin-tabs.ts` の `setupTabs`） |
| `src/lib/admin-auth.ts`, `src/scripts/admin-login.ts`, `src/scripts/admin-common.ts`, `src/pages/admin/login.astro` | 管理画面のログイン（トークンの暗号化・ログイン中の状態・自動ログアウト・続けて間違えたときの制限・枠の中での表示の禁止） |
| `src/pages/admin/`, `src/scripts/admin.ts`, `src/layouts/AdminLayout.astro` | 管理画面（AdminLayout で、メニュー（PC は左・スマホはボタンで開く。グループ分けとアイコン）と、接続先を制限する CSP を指定） |
| `data/items.json` | 収集した記事（1行1記事） |
| `data/summaries/YYYY-MM.json` | AI 要約（記事の公開月ごと） |
| `data/daily/YYYY-MM-DD.json` | 日別まとめ |
| `data/trends/YYYY-MM-DD.json` | 日ごとの集計（毎時の収集が直近3日分を作り直す。その日の分析・今週のトピあつめに使う） |
| `data/blocklist.json` | 記事の非表示の設定（管理画面から保存すると作られる） |
| `data/social.json` | SNS 投稿の記録（同じ話題を二度投稿しないため。投稿のページの URL つき。`notify` ジョブがコミットし、管理画面の「SNS 投稿」に出る）と、「今すぐ投稿」の最後の結果（`manual`） |
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

1. **運営者の作業: Workers AI のトークンを登録する（自動要約はこれで動き始める）。** 2026-10-09 の本番の最初の実行（16:23 JST）で、公開用のトークン（`CLOUDFLARE_API_TOKEN`）には Workers AI の権限がなく、HTTP 401（10000 Authentication error）で止まった（使った量は0。管理画面に「要対応」と出る）。README の「AI の自動要約」の手順で Workers AI のトークンを作り、Secrets の `CLOUDFLARE_AI_TOKEN` に登録すると、次の更新（または前回から50分たったあとの push）から動く。登録後は、管理画面の「AI要約・記事」の「自動要約」のタブとログで、保存した件数・使った量の見積もり（Qwen3.8 27B・xhigh で1件1,500〜3,000の見込み）を確かめる。Workers AI の実際の返事の形（`choices[0].message.content`・`usage`）は本番で初めて確かめるので、「AI の回答の形が正しくない」が続くようなら `scripts/lib/auto-summary.ts` の `replyText` を直す。
2. **運営者の作業（ときどき）: 自動で作った要約を確かめる。** 機械的な確認だけで掲載するので、管理画面の「AI要約・記事」の「保存済み」のタブの「AI が自動で作り、まだ手直ししていないものだけ表示」で記事と見比べ、誤りがあれば編集・削除する（自動で作った要約も Bluesky の「10秒でわかるニュース」に投稿されるので、早めに）。誤りが多ければ `BLOCKING_KINDS` を増やす・変数 `AUTO_SUMMARY_PER_RUN` を下げる・`0` で止める。Qwen3.8 27B・xhigh で1日に作れるのは3件前後の見込みなので、本番の使った量（管理画面の「自動要約」のタブ・ログの「約Nニューロン」）を見て、少なすぎれば `AUTO_SUMMARY_REASONING` を `medium`・`low` にするか、件数を優先して Qwen3（`@cf/qwen/qwen3-30b-a3b-fp8`・`off`）に戻す。xhigh で考えすぎて書かせる上限（8,192トークン）で切れ、「AI の回答の形が正しくない」が続くときは、`outputLimit` を上げる（使う量の見積もりも増える）か考える量を下げる。AdSense の審査では独自の内容が重視され、検索エンジンは大量に自動で作ったページを低く評価することがあるので、1日の上限（60件）は上げすぎず、運営者の確認・ピックアップのひとこと・AI 整理を足していくのがよい。2026-10-09 に、件数の目安（Qwen3.8 27B・xhigh で1日3〜4件、low で約7件、Qwen3 30B で約50件）を運営者に示し、どれにするかを尋ねている（未回答。回答があるまで既定の Qwen3.8 27B・xhigh のまま）。
3. 自動要約の注意: 本文が取れない掲載元の記事は要約されない（2026-10-09 に掲載元ごとの最新の記事で確かめた結果、要約を載せられる58掲載元のうち51で取れた。ベースボールチャンネル・おたくま経済新聞は robots.txt で AI のクローラーを拒否、デジタル庁・政府広報オンライン・国立天文台・AUTOSPORT web はその記事の本文が短い（動画・告知）、VAGUE は複数ページに分かれた記事。2026-10-09 の本文の取り方の改善で、AUTOSPORT web（「全文を読む」の先）・VAGUE（2ページ目以降）は取れるようになった）。モデル（既定は `@cf/qwen/qwen3.8-27b`）の提供が終わると管理画面に「AI への依頼が続けて失敗しました」と出るので、変数 `AUTO_SUMMARY_MODEL` で別のモデルにする（料金表 `NEURON_RATES` にないモデルは多めに見積もる。Qwen 以外にしたら編集方針のモデル名も直す）。定期の更新と「今すぐ更新」が同時に動くと、記録（`data/auto-summary.json`）は後から終わった方で上書きされる（使った量の見積もりが1回分少なくなるだけで、要約は `--skip-existing` で重複しない）。自動更新タイマーは push のたびに60分を数え直すので、push（開発や管理画面の保存）が1時間より短い間隔で続くと定期の更新が来ない。そのため、push のときも前回の自動要約から50分以上たっていれば自動要約を動かす（その push の公開が、自動要約の分（考える量 xhigh で1〜3分ほど）だけ遅れることがある）。
4. **運営者の作業: 通知を自分の端末で確かめる。** 公開後、サイトの「フォロー中」（ヘッダーのベル）で何かをフォローして通知をオンにし、「テストの通知を送る」で届くかを確かめる（iPhone・iPad は Safari の共有ボタンから「ホーム画面に追加」して、そのアイコンから開いたときだけ使える。iOS 16.4 以降）。新着の通知は毎時の公開のあとに送る（公開後の最初の確認はそれまでの記事を記録するだけで送らないので、届き始めるのはその次の更新から）。管理画面の「通知」で登録者数と送った記録を見られる。
5. **チャットに貼られた Cloudflare の API トークン**を作り直した（Roll）かは、こちらからは確認できなかった（確かめる操作は権限の都合で行えなかった）。Cloudflare のダッシュボード（My Profile → API Tokens）で、作り直したこと・Secrets に新しい値を登録したことを確かめる（同じトークンから作られた R2 のアクセスキーも、作り直せば無効になる）。使っていない Worker `matmsait`（ダッシュボードのひな形）は消してよい。トークンや Account ID はチャットやリポジトリに書かない。
6. 通知の無料枠の注意: 購読は2万件まで（`analytics/wrangler.jsonc` の `MAX_PUSH_SUBSCRIBERS`）、1回の処理で外へ送れるのが50件までなので40件ずつ送り、残りは1秒ごとのアラームで続ける（登録者が数千人を超えて毎時の送信が多くなったら、Workers の有料プランを検討）。送るたびに購読ごとの書き込みはせず、届かなかったときだけ書く。通知を届ける会社の URL（Google・Mozilla・Apple・Microsoft）だけに送る。
7. 一部の掲載元の見出しの末尾にサイト名などの決まり文句が入る（例: 「｜AERA DIGITAL」）。キーワードの候補（いま話題の言葉）は複数の掲載元に出る言葉だけにして避けたが、話題のまとめや検索にも少し影響するので、`sources.yaml` の `stripTitle` で取り除くかを検討する。
8. 収集元の利用条件は `docs/SOURCES.md` のとおり確認したが、最終確認は運営者が行う（規約は変わるので年1回程度見直す）。4Gamer.net と鉄道ファン（railf.jp）は「利用したら一報を」と歓迎しているので、収益化のときに連絡するとよい（任意）。
9. 「N媒体が報道」は見出しの似かたで同じ出来事をまとめているので、言い回しが大きく違う報道はまとまらないことがある。2026-10-08 に2段目（かぎかっこの中の名前・6時間以内・似かた0.3以上）を入れ、本番のデータで新たに11のまとまり（2媒体以上のトピックが88→93）ができ、すべて同じ出来事だった。固有の言葉だけを手がかりにする案（3日分で136組の候補）は、同じ製品・作品の別の話題（発売とレビュー、別々のインタビュー、別の会社の同じ記念モデル）をまとめてしまうので採らなかった（似かたの下限を0.25にしても約16%が誤り）。まだまとまらない報道や誤ってまとまった報道は、管理画面の「トピック整理」の「まとめ方を直す」（分割・統合）で直せる。調整するときは `src/lib/related.ts` の `clusterTopics` の既定値（`minScore`・`quoteMerge`）を変え、テストと本番のデータで確かめる。
10. 海外ニュースは、商用サイトで使えるフィードがほとんど見つからなかったため「海外」カテゴリは作っていない（BBC・CNN・AFPBB・聯合ニュースなどは NG）。使えるサイトが見つかったら `src/config/site.ts` にカテゴリを足す。
11. Bluesky の自動投稿は動いている（Secrets の `BLUESKY_APP_PASSWORD` は登録済み）。登録したのがチャットに貼られたアプリパスワードなら、Bluesky の「設定 → プライバシーとセキュリティ → アプリパスワード」で新しく発行して Secrets を登録し直し、古いものを削除するのが安全（任意）。効果はアクセス解析の流入元（SNS）で見て、フォロワーや流入が伸びなければ投稿の時間帯・種類・上限（`scripts/lib/social.ts` の `SOCIAL_LIMITS`）を見直す。2026-10-08 から30分ごと（1日約34件）に投稿しているので、多すぎると感じたら（フォローを外される・スパムの報告など）リポジトリの変数 `SOCIAL_INTERVAL_MINUTES` を `60` にするか `0`（毎時の更新のあとだけ）にする。30分ごとの投稿の多くは「10秒でわかるニュース」で、48時間以内の AI 要約から選ぶので、要約を追加しない日が続くと投稿が減る。2026-10-09 時点でフォロワー4人・投稿49件で、「いいね」は10秒でわかるニュース（26件中6件）とテクノロジーの話題に集まり、まとめの投稿（朝・昼・夜）には反応がなかった。同日に投稿の中身（要点・報じたメディア・キーワードのハッシュタグ・見出しのカード画像・交互の並び）を改善したので、1〜2週間ほど反応を見て、優先するジャンル（`SOCIAL_LIMITS.preferredCategories`）やまとめの投稿を続けるかを見直す。返信・引用・フォローは運営者が手で行う（README の「集客のためにできること」）。フォロー・いいね・返信の自動化は、スパム扱いやアカウント停止のおそれがあるので行わない。
12. 管理画面で編集できる要約は新しい300件まで。それより古い要約は `data/summaries/YYYY-MM.json` を直接編集する。
13. 本文の自動取得で取得できるかはサイトしだい（アクセスを拒否するサイト・本文が動画だけのページ・JavaScript でしか本文を出さず埋め込みデータもないページは取れない。ボットの名前は名乗らずブラウザ相当の通信で取るが、robots.txt と拒否は守り、ボット対策のすり抜けはしない）。取得できない記事は、本文を貼り付けるか同じ話題の別の記事に切り替える。取得結果で断られることが多い掲載元があれば、`summary: false` にするかを考える。2026-10-09 に取り方を改善し、全収集元の記事132件で取れたのが118件 → 123件になった（残りは robots.txt で AI のクローラーを拒否する AERA DIGITAL・ベースボールチャンネル・おたくま経済新聞の6件（取らないのが正しい）と、動画だけのページ（政府広報オンライン）・外部サイトへのリンクだけの告知（国立天文台））。本番では、前の取り方で「本文なし」だった記事を1回だけ取り直し、AUTOSPORT web の記事は取れた（首相官邸・政府広報オンラインの動画のページは本文がないので「本文が短いページ」「動画が中心のページ」のまま。2026-10-08 の首相官邸の2件は次の更新で取り直す）。取り方を変えたら `src/lib/article-texts.ts` の `TEXT_FETCH_VERSION` を上げる（前の版で取れなかった記事を1回だけ取り直す）。本文の取り出しを直すときは、いくつかのサイトの実際のページで前後を比べる（1つのサイトに合わせると、ほかのサイトで本文を落としやすい）。
14. AI が開けない記事の記録（どのサイトがどれだけ開けなかったか）は運営者のブラウザにだけ残る（localStorage、14日間）。別の端末では記録がない状態から始まる。どのサイトを AI が開けないかが分かってきたら、`docs/SOURCES.md` に書き残しておくとよい。
15. 収益化の前に: 独自ドメインの取得、AdSense の審査の前に AI 要約を増やす（話題の記事を中心に。審査では独自の内容が重視される）、`ads.txt` の設置、気になる記事の非表示、`src/config/site.ts` の運営者名・問い合わせ先の確認。管理画面の「ピックアップ」のひとことも、運営者の独自の内容として審査で評価されやすい。
16. アクセス解析の注意: Cloudflare の無料プランは1日にリクエスト10万回・SQLite の書き込み10万行・読み込み500万行が上限（ページを見るごとに1回、表示中は2分ごとに1回（2026-10-07 に1分から変更）、離れるときに1回送る。1ページあたり2〜3回なので、月100万PV（1日3万3千PV）でほぼ上限。上限を超えても、サイトの表示は止まらず計測だけが止まる）。記録は1日4万件まで（`MAX_EVENTS_PER_DAY`）。足りなくなったら Workers の有料プラン（月5ドル）にするか、合図の間隔（`src/scripts/analytics.ts` の `PING_INTERVAL`）を延ばす。訪問者は「IP アドレス＋ブラウザの種類＋日ごとの塩」で数えるので、携帯電話の回線（多くの人が同じ IP を使う）で同じ機種・同じブラウザの人が1人に数えられることがある。人気の順位は同じ人を1回だけ数えるが、多くの IP から送れば操作はできる（おかしな順位に気づいたら、管理画面で記事を非表示にできる）。「いまN人が閲覧中」は2人以上のときだけ出す（`data-min`）。 検索エンジンには新しい URL（pages.dev）を覚え直してもらう必要がある（以前の URL は GitHub Pages の制約で 301 ではなく転送ページ。2026-10-07 からページごとに正規の URL と即時の転送を入れている。Search Console を使うなら新しい URL で登録する）。

17. 話題のページの URL は「話題の最初の記事の ID」なので、あとから届いたもっと早い記事で話題がつながると URL が変わる（古い URL は 404 になる。めったにない）。また話題をまとめる期間（直近8日）を過ぎると話題のページも消える（その日の話題は日別まとめに残る）。検索からの流入が増えてきたら、話題を `data/` に残して長く公開するかを検討する。
18. 話題度スコア・急上昇・注目ワードの数値は、2026-10-07 時点の記事（1日約1000件・66メディア）で決めた。1時間に新しく報じられる話題は少ない（日中でも3時間で数件）ので、急上昇は3時間で数えている。収集元が増えたり減ったりしたら、`src/lib/topic-core.ts` の定数（`HALF_LIFE_HOURS`・`SCORE_SCALE` など）を本番のデータで見直す。タグ（`src/config/tags.ts`）は本番の見出しで当てはまり方を確かめてから足す。
19. 「◯媒体が報道」は掲載元（媒体）の数なので、同じ会社の複数の媒体（例: Impress の PC Watch・ケータイ Watch など）は別々に数える（2026-10-08 に表記を「◯社」から「◯媒体」に変えたのはこのため。about の「言葉の意味」にも書いた）。気になるようなら `sources.yaml` に運営会社を足して数え方を変えることを検討する。
20. 「今すぐ投稿」は、管理画面が `data/social-request.json` を保存した push で `update.yml` が動くことを前提にしている。`update.yml` の push の条件（`paths-ignore`）を変えるときは、このファイルが対象から外れないようにする。投稿までの約2分は、記事の取り込みとサイトの公開を待つ時間（リンク先のページが必ずあるように、公開してから投稿する）。更新の合間の投稿（`social.yml`）が先に動いたときは、そちらが依頼を処理する（同じ `scripts/notify.ts` なので結果は同じ）。
21. **全面改善（`docs/REDESIGN.md`）は Phase 1〜4 をすべて公開した**（2026-10-08。Phase 4 はトレンド・日ごとの集計・今週のトピあつめ・その日の分析）。日ごとの集計（`data/trends/`）は公開後の最初の更新から作られるので、2026-10-06 より前の日はない。今週のトピあつめの「前の週」との比較は、集計が14日分たまってから出る（それまでは比べない）。掲載元を増やすと記事・トピックの数も増えるので、週や日の比較を見るときは掲載元の数の変化も考える（ページに注記している）。次の改善の候補: 言葉の表記ゆれ（「Google」と「グーグル」）を同じ言葉として数える・AI 要約のキーワードを人物・企業などに分ける（指示書の「関連企業・関連人物」）・月間のまとめ。
22. **運営者の作業（任意）: AI 整理を作る。** 管理画面の「トピック整理」で、多くの媒体が報じたトピックから整理を作ると、トピックのページの「各メディアの視点」に出る（整理がないトピックは見出しの機械的な比較）。各媒体の報じ方の違いはこのサイトにしかない内容なので、検索や AdSense の審査でも評価されやすい。AI の回答は保存の前にプレビューで中身（出典・数字）を確かめる。
23. トップの「今日の数字」の「今話題」は話題度30以上のトピックの数（`src/lib/topics.ts` の `HOT_SCORE_MIN`）。「急上昇」の件数は急上昇の一覧の件数、「今日の注目」は今日の注目の件数、「注目ワード」は注目ワードの数。夜中は急上昇が少なく0件のこともある。ニュースの温度の矢印は、昨日の同じ時刻の熱さと比べて1.2倍以上で上向き・0.8倍以下で下向き（差が小さいときは横ばい）。
24. **運営者の作業（任意）: まとめ方の誤りを直す。** 2026-10-08 時点で、「コードギアス ロストストーリーズ」のサービス終了のトピックに、別のゲーム「白猫GOLF」のサービス終了の記事（4Gamer.net）がまとまっている（どちらも「サービス終了」「2022年…配信開始から」）。管理画面の「トピック整理」でこのトピックを選び、「まとめ方を直す」で白猫GOLF の記事を「外す」と直る（テスト用の一時ファイルで外せることを確かめた。本番のデータは運営者の判断に任せて変えていない）。トピックのページの見出しの比較で「この見出しだけ」の言葉が目立つ記事は、混ざっている可能性がある。
25. キーワードのページは、AI 要約のキーワードとテーマの言葉から作るので、要約が増えるほど言葉も増える（2026-10-08 時点で136ページ・うち検索エンジンに出すのは32）。人物・企業の言葉に偏らせたいときは、`src/lib/words.ts` の `STOP_WORDS`（「逮捕」「障害」のような一般的な言葉を外す）や件数の条件（`MIN_ARTICLES` など）を見直す。言葉の表記ゆれ（「Google」と「グーグル」）は別々のページになる。
26. **運営者の作業（任意）: 要確認の要約を直す。** 2026-10-08 時点で、保存済みの要約314件のうち45件に「要確認」が出る（多くは100字を超える文と「注目が集まっている」「期待される」のような定型文。ほかに「革新的」「画期的」「究極」「高い完成度」・「今月」「先月」・「と思われる」・「反響を呼んでいる」）。管理画面の「AI要約・記事」の「保存済み」のタブで「要確認だけ表示」にし、編集するか作り直す。要確認は文字の並びから機械的に見つけたもので、本文どおりの言い方なら直さなくてよい（例: 「圧倒的な強さ」）。誤検出が多い言葉があれば `src/lib/summary-quality.ts` の一覧から外す。
27. 要約のプロンプトは、書き方の決まりを増やしたので長くなった（記事1件のプロンプトで約3,200字 → 約6,500字）。「1回に貼り付ける長さの上限」を8,000字にしていると、本文入りの記事は1回に1件ずつになる（既定の15,000字なら問題ない）。決まりの文を削るときは `summaryRules` と `tests/summary-core.test.ts` をあわせて直す。
28. SNS の投稿だけの実行（`social.yml`）は1回1分ほどで、サイトの公開（Cloudflare Pages へのデプロイ）はしないので、公開の回数は増えない（更新は今までどおり1時間ごと）。GitHub Actions の実行時間は公開リポジトリなので無料。投稿の時刻は「毎時の更新のあと（更新から約2分後）」と「更新の30分後」なので、間隔は約28〜32分になる。管理画面から更新が続いたときは、前の投稿から20分たつまで投稿しない。
29. **運営者の作業: Search Console の所有権の確認。** 「URL プレフィックス」で `https://topiatsume.pages.dev/` を追加する（「ドメイン」は DNS の TXT レコードが必要で、`pages.dev` では使えない）。いまのサイトに出ているコード（変数の値から取り出したもの）で自動で確認されなければ、確認方法「HTML タグ」に出るタグを、GitHub の変数 `PUBLIC_GOOGLE_SITE_VERIFICATION` に入れ直すか、`src/config/services.ts` の `GOOGLE_SITE_VERIFICATION_IN_REPO` に書いて公開し直し、「確認」を押す。変数とコードは確認のあとも消さない（Google がときどき確かめ直す）。
30. 共有画像の見た目を変えたら、`src/lib/og-image.ts` の `RENDER_VERSION` を上げる（上げないと、使い回しの画像が古い見た目のまま残る）。フォントにない文字（絵文字・ごく珍しい漢字）は四角で表示されることがある（カードの文字には絵文字を使わない）。キャッシュがないとビルドが約2分長くなるので、`actions/cache` が使えなくなったら（版の廃止など）`update.yml` の版を上げる。

31. 管理画面は 2026-10-09 に運営者の「使いづらいし見にくい」という声で整理した（PC は左のメニュー・スマホはメニューボタン、ホームを「対応が必要なこと」中心に短く、SNS 投稿のページを新設、AI要約・記事をタブに、長い説明は「?」の欄に畳む）。同じ日に「スマホだと AI要約・記事が使いづらい」という声で、「要約を作る」に手順の表示と下に固定の次にやることのボタン（コピー → 貼り付けて確認 → 保存）を付け、確認の結果をカードにした。使ってみて分かりにくいところがあれば聞いて直す。下のボタンの中身は `src/scripts/admin.ts` の `flowState`（手順を増やしたら、ここも直す）。「AI要約・記事」のページ（`summaries.astro`）には、`admin.css` と同じ見た目の指定が `:global(...)` で重複して残っている（以前このページだけで管理画面を作っていた名残）。見た目を変えるときは両方を確かめ、整理するなら画面を撮って見比べながら少しずつ消す。

（解決済み: Bluesky のプロフィールの説明とバナーは 2026-10-08 に新しいキャッチコピーにそろえた。Bluesky の Secrets（`BLUESKY_APP_PASSWORD`）は 2026-10-07 に運営者が登録した。GitHub の Secrets（Cloudflare）の登録と新しい URL の管理画面の初回設定は、2026-10-07 に運営者が行い、毎時の更新が pages.dev に公開されることを確かめた。はてなブックマークの商用利用の問題と、外した収集元・要約を禁じている掲載元の要約は、2026-10-06 に削除して解決した。管理画面のパスワードの設定し直しは、2026-10-07 に運営者が行った（本文を読むための公開鍵も登録済み）。下の記録を参照）

---

## 開発の記録（新しい順）

### 2026-10-09 本文の自動取得の改善（続きのページ・全文のページ・記事本体のページをたどる、本文の候補を比べて選ぶ、前後の余計な行を落とす、転送先の robots.txt、自動の取り直し）

- 依頼・目的: 運営者から「AI が開けない記事の本文を取得する機能を改善し、現在の取得できないサイトも対応し、汎用性を上げて、取得できるサイトもより良いように改善しろ」。
- やったこと:
  - 現状の把握: 全収集元の最新の記事132件（1掲載元2件）で本文の自動取得を試した（robots.txt などの決まりは本番と同じく守る）。取れたのは118件で、取れなかったのは AI のクローラーを拒否するサイト6件（取らないのが正しい）・本文なし6件（AUTOSPORT web は「全文を読む」の先に本文、消費者庁はお知らせのページから記事本体へリンクしているだけ、鉄道ファンは表の中の「．」で終わる文、ほかに動画・画像のページ）・robots.txt を一時的に読めない2件（国立天文台）。取れた記事も、複数ページの記事は1ページ目だけ（PRESIDENT Online・Merkmal・文春オンライン・日刊SPA!・VAGUE など）、デイリー新潮は冒頭の3段落と「こんな記事も読まれています」だけ、本文の前後にメニュー・日付・関連記事・共有ボタン・著作権表示などの行が混じる（121行）といった問題があった。
  - 本文の取り出し（`scripts/lib/article-text.ts`）: 本文の候補を作って比べる（JSON-LD の `articleBody`（`@graph` の中も）・Next.js の `__NEXT_DATA__` などの埋め込みデータ・`itemprop="articleBody"`・「。」で終わる文がいちばん多いまとまり）。サイトの目印はいちばん本文らしい候補の半分以上の点なら優先し、構造化データ・埋め込みデータはページから取ったものより明らかに本文らしいとき（JavaScript で本文を出すページなど）だけ使う（最初の段落だけを入れるサイトがあるため）。点は「文の文字数 − 余計な行」で、見出しの言葉がほとんど出てこなければ下げる。文の数え方は「．」で終わる文も数え、見出しのタグの文字は数えない（見出しに「。」「？」がある記事で、見出しを含む外側のまとまり（横の欄や筆者紹介を含む）を選んでいた）。外側のまとまりへ広げるのは、増える部分そのものが本文らしい（増える文の文字 ≥ 文でない文字×0.5 ＋ リンクの文字）ときだけにした。除くもの: リンクばかりのまとまり（リンクが3つ以上で文字の7割以上）、別のページへのリンクだけの短い段落（写真のページ・関連記事・「次ページ：〜」。見出しと同じ文字のリンクは記事本体の手がかりなので残す）、ページ送り（pagination・pager）・共有ボタン（social・share・sns の id も）、見出しより前の行、見出しのすぐ後のカテゴリ・日付・筆者の行（最初の方の日付の行とそれより前の短い行。「開催日時」のような項目名の後の日付は残す）、「キーワード :」の行、末尾の筆者紹介・画像の一覧・宣伝・著作権表示・ページ番号（「[1/2ページ]」「前へ 1 2 次へ」）・「写真を見る」「URL をコピー」「優先ソースに設定」・「ほかの記事の見出し - サイト名」の行。たどれるリンクも見つける: 「全文を読む」「つづきを読む」「続きを読む」などの先（同じ記事のクエリ違いか下のパス）、2ページ目以降（`/2`・`-2.html`・`_2`・`/page/2`・`?page=2` など。「次の記事」は含めない）、AMP 版、WordPress の記事の API、本文がなく見出しと同じ文字のリンクだけがあるページのそのリンク。動画・画像が中心のページかも調べ、本文が短い理由に使う。
  - 取得（`scripts/lib/text-fetcher.ts`）: 「全文を読む」の先が長ければそれを使い、本文が短ければ記事本体へのリンク → AMP 版 → WordPress の API の順に試し、2ページ目以降をつなげる（1記事6ページ・2万字まで。前のページと同じ行は除き、新しい文字が50字に満たないページ（筆者・タグ・関連記事だけのページなど）でやめる）。たどる先は同じサイトのページだけで、1つずつ robots.txt（クローラー全般・主な AI のクローラー）を確かめ、続きのページに noai があれば記事ごと使わない。転送（リダイレクト）の先も確かめ、別のサイトへ転送されたらそのサイトの robots.txt を読んでから進む（`scripts/lib/http.ts` の `followRedirect`。断られていれば転送先を開かない）。通信の失敗・500・502・504 は少し待って1回だけやり直す（401・403・429・451・503 の拒否はやり直さない）。1回の実行は5分まで（`RUN_BUDGET_MS`。時間を過ぎたら新しい記事は次の実行に回し、続きのページもたどらない）にし、`update.yml` のこの手順にも10分の上限を付けた（毎時の更新（25分の上限）を遅らせないため）。記事の見出し（`titleOf`。`scripts/fetch-texts.ts` が記事の一覧から渡す）を本文選びの手がかりにする。AI の自動要約も同じ取り方を使う（続きのページはプロンプトに入れる長さの2倍まで）。
  - 通信（`scripts/lib/http.ts`）: ブラウザと同じく、ページの中のリンクから移るとき（続きのページなど）は移る前のページを `Referer` で送り `Sec-Fetch-Site: same-origin` にする。Cookie を覚えて、同じ記事の取得の間だけ送り返す（初めて開くと Cookie を付けて同じページへ転送するサイト・続きのページで同じ Cookie が要るサイトのため。保存はしない。ほかのドメインの Cookie は受け取らない）。応答のヘッダーに文字コードがなければ、HTML の `<meta charset>` を見る（Shift_JIS・EUC-JP のページ）。
  - 結果の記録と取り直し（`src/lib/article-texts.ts`）: 結果に取り方の版（`v`。`TEXT_FETCH_VERSION = 2`）と試した回数（`tries`）を残す。前の版で「本文なし」「失敗」だった記事は1回だけ取り直し、一時的な失敗は30分あけて3回まで取り直す（`shouldRetry`。拒否・ページなしは取り直さない）。何ページ分かを結果の `detail`（「3ページ分」）に、本文がない理由を「動画が中心のページ（N字）」「画像が中心のページ（N字）」「本文が短いページ（N字）」で残す。
  - 既存の不具合の修正: 要約を保存した記事の取得結果はファイルに書くときに外しているが、依頼（`data/text-requests.json`）は残るため、「結果のない依頼」として毎回の更新で取り直していた（本番の push 後の確認で、要約済みの11件が毎時取り直しの対象になっていたことが分かった。14日間、同じページを毎時取りに行き、1回15件の枠も使っていた）。要約を保存した記事の依頼は取りに行かないようにした（`fetchTexts` の `done`。`scripts/fetch-texts.ts` が `getSummary` で渡す）。
  - 管理画面（`src/scripts/admin.ts`）: 「AI が開けない記事」の欄に、本文がない理由（「本文を見つけられませんでした（動画が中心のページ（12字））」）、自動で取り直す記事には「毎時の更新のときに、自動でもう一度試します」、何ページかに分けて取れた本文には「自動で取得した本文（3ページ分）」と出す。
  - 採らなかった案: Mozilla の Readability（linkedom と組み合わせて保存したページで試したが、日本語のニュースサイトでは本文の一部を落とす・関連記事を含めるページがあり、今の方法を直す方がよかった）。ヘッドレスブラウザで JavaScript を動かして本文を出す（ボット対策のすり抜けにつながりやすく、方針に反する。重い）。検索エンジンのキャッシュ・ほかのサイトの転載から取る（サイトの意向を回り道することになる）。AI のクローラーを拒否しているサイト（AERA DIGITAL・ベースボールチャンネル・おたくま経済新聞）は今までどおり取らない。
- 主な変更ファイル: `scripts/lib/article-text.ts`（本文の取り出し・たどれるリンク）、`scripts/lib/text-fetcher.ts`（続きのページ・全文のページ・記事本体・AMP・WordPress の API・転送先の robots.txt・やり直し・時間の上限）、`scripts/lib/http.ts`（Referer・Cookie・転送の確認・meta の文字コード）、`src/lib/article-texts.ts`（取り方の版・試した回数・取り直しの判断・理由の文言）、`scripts/fetch-texts.ts`（見出しを渡す・要約済みの記事を取りに行かない）、`scripts/lib/auto-summary.ts`（自動要約でも見出しと長さを渡す）、`src/scripts/admin.ts`（理由・取り直し・ページ数の表示）、`.github/workflows/update.yml`（本文の取得の手順に10分の上限）、`src/pages/about.astro`（取得のしかたの説明に、続きのページ・全文のページも取ること、失敗したら数回まで取り直すこと、続きのページ・転送先も1ページずつ確かめることを追記）、`tests/article-text.test.ts`・`tests/text-fetcher.test.ts`・`tests/http.test.ts`・`tests/article-texts.test.ts`、`README.md`、`docs/DEVLOG.md`
- 確認したこと: `npm test`（40ファイル・437件。新しく、余計な行の除き方・リード文を残す・「．」の文と表の中の本文・見出しにつられて横の欄を含めない・構造化データと埋め込みデータ・動画のページ・たどれるリンク・ページ番号、続きのページをつなげて Referer を送る・「つづきを読む」の先・記事本体へのリンク／AMP 版／WordPress の API・たどる先の robots.txt と noai・別のサイトへの転送と robots.txt・一時的なエラーのやり直しと拒否のやり直しなし・時間の上限・本文がない理由・要約済みの記事は取りに行かない、Referer のヘッダー・転送の確認・Cookie・meta の文字コード、取り直しの判断・試した回数）、`npm run check`（エラー0）、`npm run build`、actionlint。取り出しの前後の比較は、保存したページ（改善前124ページ・改善後156ページ）で1ページずつ消えた行・増えた行を見て、本文の文が消えていないことを確かめた（途中で、見出しの「。」「？」につられて Qiita・4Gamer.net・Publickey で横の欄まで含めてしまう問題が見つかり、見出しを数えない・増える部分で判断するように直した）。全収集元の記事132件で実際に取り直して（robots.txt などは本番と同じく守る）、取れた記事は118件 → 123件（要約を載せられる掲載元では104件 → 109件）、本文の前後の余計な行は121行 → 16行、11件は複数ページをつなげて取れた（例: デイリー新潮 冒頭3段落 → 2ページ2,882字、Merkmal 583字 → 5ページ、PRESIDENT Online 1,524字 → 3ページ3,832字、VAGUE 2ページ2,603字）。新しく取れたのは AUTOSPORT web（「全文を読む」の先）・消費者庁（記事本体のページ）・鉄道ファン（「．」の文）・デイリーポータルZ・国立天文台。取れないままの3件は、動画だけのページ（政府広報オンライン2件）と外部サイトへのリンクだけの告知（国立天文台）で、理由が「動画が中心のページ」「本文が短いページ」と出る。本番で「本文なし」だった AUTOSPORT web の記事も新しい取り方で795字取れることを確かめた。管理画面は Playwright（GitHub API はまね）で、要約を作る流れ（コピー → 貼り付けて確認 → 保存）がスマホの幅で通ること、作り物の取得結果で「自動でもう一度試します」・本文がない理由・貼り付けの案内の出し分けを確かめた（画面のエラーなし）。
- 本番での確認: push の後の更新（run #170）で、前の取り方で「本文なし」だった記事を取り直し、AUTOSPORT web の記事が795字取れた（「本文なし」→「取得」）。首相官邸のビデオメッセージ4件・政府広報オンラインの動画2件は「本文が短いページ（34〜48字）」「動画が中心のページ（43・45字）」として記録された（本文のないページなので正しい。版 2 になったので、もう取り直さない）。首相官邸の残り2件は、要約済みの記事の取り直し（上の不具合）が1回15件の枠を使っていたため、次の更新に回った。
- 残った課題・注意点: 首相官邸のビデオメッセージ2件（2026-10-08 の分）は、次の更新で取り直す（本文のないページなので「本文が短いページ」になる見込み）。JavaScript でしか本文を出さず、構造化データ・埋め込みデータ・AMP 版もないページは取れない（ボット対策のすり抜けになるので、ブラウザを動かして取ることはしない）。取り出しは文の「。」などを手がかりにしているので、箇条書きや表だけの記事は短く取れることがある（2ページ目以降は文がなくてもつなげる）。

### 2026-10-09 AI要約・記事をスマホで使いやすく（手順の表示・下に固定の「次にやること」のボタン・貼り付けて確認・カードの確認結果）

- 依頼・目的: 運営者から「AI要約・記事の UI や配置を改善して。スマホだと結構使いづらい」。
- やったこと:
  - 直す前に、スマホ（390px）で「要約を作る」の流れ（選ぶ → コピー → 回答の貼り付け → 確認 → 保存）を実際に操作して撮り、使いづらい点を洗い出した: タブが3段で最初の手順まで 411px、選ぶ記事の一覧が枠の中でスクロールし（指で動かしにくい）「本文を貼る」のボタンで見出しが細い、「AI が開けない記事」の欄が手順1と2の間にあって流れを分ける、プロンプトの大きな欄と設定で「プロンプトをコピー」が 2,007px 下、回答は欄を長押しして貼ってから「確認」を探す、確認の結果が3列の表で要約が細い列に押し込まれ20件でページが 14,030px・保存のボタンが 13,852px 下、保存済みの編集欄が枠の中で狭い、など。
  - **手順の進み具合**（上）と**次にやることのボタン**（下に固定。`flow-bar`）: いまの状態から次の操作を決め（`flowState`）、ボタンが「プロンプトをコピー」→「回答を貼り付けて確認」→「N件を保存して公開」→（保存のあと）次の記事の「プロンプトをコピー」と変わる。スマホでは画面の幅いっぱいで、親指で押せる大きさ。手順の表示を押すとその手順のカードへ移る。コピーしたプロンプトの目印（`promptMark`）を作業中の内容（sessionStorage）に残すので、チャット AI のアプリに切り替えてページが読み込み直されても、手順3から続けられる。
  - **回答を貼り付けて確認**: クリップボードの回答を読んで、貼り付けと確認を一度に行う（読めないブラウザでは、回答の欄に移って長押しで貼り付けるよう案内する）。回答の欄に貼り付けたときもすぐに確認する。確認のあとで回答の欄を書き換えたら、確認し直すまで保存させない（保存するのは確認した内容なので、書き換えが保存されないまま保存してしまうのを防ぐ）。
  - **手順1**: 件数・カテゴリ・並び順を2列にまとめ、「選択中 N件」と「上から選び直す」を1行に。選んだ記事の一覧は「選んだ記事を見る・変える（N件）」に畳み（スマホでははじめ閉じる）、30件ずつ「もっと見る」で出す（選んでいる記事は必ず出す）。スマホでは枠の中でスクロールさせず、「本文を貼る」を見出しの下の小さなボタンにした。
  - **手順2**: 「プロンプトをコピー」をいちばん上に（スマホでは幅いっぱい）。設定（長さ・上限・回答のしかた・要点）は「設定: 標準・15,000字・…」の1行に畳み、プロンプトの中身も「プロンプトの中身を見る」に畳んだ（コピーできないブラウザでは開いて選択する）。
  - **手順3の結果**: 表をやめて記事ごとのカードに（チェック・見出し・状態・要約・要点・背景・キーワード・要確認）。スマホでは要約を3行までにして「全文を見る」「すべて全文を見る」で開く。要確認を直してもらう手順は「要確認 N件を AI に直してもらう（任意）」に畳んだ。スマホで 14,030 → 6,504px。
  - 「AI が開けない記事」の欄を手順4のあとに移した（例外の手順なので、1 → 4 の流れを分けないように）。ブックマークバーに登録するボタンの案内は、指で操作する端末では出さない（スマホでは使えないため）。
  - **保存済み**: 20件ずつ「もっと見る」で出す。スマホでは要約を3行までにし、要点・背景・キーワードは「編集」で見る。編集欄が右に64px空いて狭かったのを直し、入力欄を中身に合わせて高くした。
  - **タブ**: スマホでは1列に並べて横にスクロールする（3段 → 1段）。選んだタブが見える位置まで横に動かす。
  - 「概要」の名前が残っていた案内（サイトの更新が止まっているとき）を「ホーム」に直した。
- 主な変更ファイル: `src/pages/admin/summaries.astro`（手順の表示・下のボタン・畳む欄・カードの見た目・スマホの並び）、`src/scripts/admin.ts`（次にやること・貼り付けて確認・書き換えたら確認し直す・一覧と保存済みを少しずつ出す・カードの確認結果・編集欄の高さ）、`src/scripts/admin-tabs.ts`（横にスクロールするタブ）、`src/styles/admin.css`（スマホのタブ）、`README.md`、`docs/DEVLOG.md`
- 確認したこと: `npm test`（40ファイル・407件）、`npm run check`（エラー0）、`npm run build`。ビルドしたサイトを Playwright で（GitHub の API はまね。書き込みはしない）: スマホ（375px・390px）と PC（1280px）で、下のボタンだけでコピー → 貼り付けて確認 → 保存 → 次の記事のコピーまで進むこと（各12〜13項目）、欄への貼り付けですぐ確認・書き換えたら保存できない・読み込み直しても手順3から・クリップボードを読めないときの案内（9項目）、前回の E2E（メニュー・タブ・収集元・保存済みの20件ずつと絞り込み・SNS・はみ出しなし。92項目）、タブの中での要約の編集と非表示の設定の保存（16項目）、SNS の今すぐ投稿の4つの場面（25項目）。axe（全ページ・全タブ × ライト・ダーク × PC・スマホ、確認の結果・一覧を開いたところ・保存済みの編集）で違反なし。スマホの画面の高さ: 最初の画面でコピーのボタンが見える（2,007 → 751px）、20件の確認結果のページ 14,030 → 6,504px。
- 残った課題・注意点: クリップボードの読み取りは、ブラウザによって確認の表示（iPhone の「ペースト」など）が出る。運営者に実際のスマホで使ってもらい、分かりにくいところを直す。

### 2026-10-09 管理画面の整理（左のメニュー・ホーム・SNS 投稿のページ・AI要約・記事のタブ・スマホの見た目）

- 依頼・目的: 運営者から「管理画面がめちゃくちゃ使いづらいし見にくい。もっと整理したり使用しやすくして。」
- やったこと:
  - 整理の前に、全ページを PC（1280px）とスマホ（390px）で撮って確かめた。概要のページが長い（PC 5,620px・スマホ 8,054px。SNS の下書き・最近の実行・説明の文がすべて開いていた）、ページの切り替えが上のタブだけ（スマホでは横にはみ出す）、AI要約・記事のページは閉じた欄が縦に並んで探しにくく説明の文も長い、SNS の最近の投稿は URL だけで何を投稿したか分からない、スマホの収集元の表は列が1文字幅になる（17,722px）、など。
  - **メニュー**（`AdminLayout.astro`）: PC（960px 以上）は左に固定のメニュー、スマホは上のバーのボタン（いまのページ名を出す）で開くメニュー。「毎日の作業」（ホーム・AI要約・記事・トピック整理・SNS 投稿・ピックアップ・お知らせ）と「サイトの管理」（記事の非表示・収集元の状況・通知・アクセス解析）に分け、線のアイコンを付け、いまのページを強調する。スマホのメニューはリンク・メニューの外を押す・Esc で閉じる。スマホでは上のバーが狭くボタンが重なっていたので、ログイン中の表示とログアウトをメニューの中に移した。
  - **ホーム**（「概要」から改名。`index.astro`・`admin-dashboard.ts`）: 先頭の「対応が必要なこと」には警告だけを出し（件数のバッジ。なければ「なし」）、急がないものは下の「お知らせ・提案」に分けた。ほかは、きょうの数字・サイトの更新（最近の実行と説明は畳む）・SNS（最新の3件を題名で）。文を短くした。PC 5,620→1,363px、スマホ 8,054→2,157px。
  - **SNS 投稿のページ**（新設。`social.astro`・`admin-social.ts`）: 「今すぐ Bluesky に投稿」と結果、最近の投稿（種類・日時・題名（サイトのページへのリンク）・Bluesky で見る。はじめは10件、「もっと見る」で30件まで）、下書き（畳む）、自動投稿のしくみ。管理画面のデータ（`/admin/data.json`）の SNS の記録に、記事・要約の題名を付けた（`socialLog` の `title`。まとめの投稿は日付から題名を作る）。今すぐ投稿の処理は概要から移しただけで変えていない。
  - **AI要約・記事のタブ**（`summaries.astro`・`admin-tabs.ts`）: 要約を作る・自動要約・保存済み・記事の非表示・収集元の5つのタブに分け、件数や「要対応」のバッジをタブに出す。選んだタブは URL の #（`#auto`・`#saved`・`#hide`・`#sources`）に残し、再読み込みやほかのページからのリンクでも同じタブを開く（以前のリンク `#saved-card` なども受ける）。←→・Home・End で移れる（WAI-ARIA のタブの形）。メニューの「記事の非表示」「収集元の状況」はそのタブを開き、メニューでも強調する。開いたときはスクロールしない（上のバーに見出しが隠れないように）。スマホではタブを丸いボタンの形にして折り返す。
  - **収集元**: 確認が必要な収集元だけを先に出し、「正常な収集元も表示」で全部を出す。スマホでは収集元ごとに縦に並べる（17,722→901px）。
  - **説明の文**: 各ページの長い説明を「?」の付いた欄（「使い方」「〜のしくみ」）に畳み、ページの上の説明を1行にした（トピック整理・通知・アクセス解析・SNS 投稿も）。
  - 細かい直し: 保存済みの絞り込みのチェックの文が数字の前後で折り返していた、閉じた「使い方」に灰色の帯が出ていた、メニューとスマホのタブの強調の文字が背景と見分けにくかった（axe で検出。`--accent-strong` と `--accent-soft` にした）。
  - 保存・削除・投稿の依頼などの処理は変えていない（ページの構成と見た目だけ）。
- 主な変更ファイル: `src/layouts/AdminLayout.astro`（メニュー）、`src/pages/admin/index.astro`・`src/scripts/admin-dashboard.ts`（ホーム）、`src/pages/admin/social.astro`・`src/scripts/admin-social.ts`（SNS 投稿。新規）、`src/scripts/admin-tabs.ts`（タブ。新規）、`src/pages/admin/summaries.astro`・`src/scripts/admin.ts`（タブ・収集元の表）、`src/pages/admin/data.json.ts`（SNS の記録の題名）、`src/scripts/admin-shared.ts`（投稿の種類・題名・リンクの共通の処理）、`src/scripts/admin-common.ts`（メニューを閉じる）、`src/styles/admin.css`、`src/pages/admin/topics.astro`・`notify.astro`・`analytics.astro`（説明を畳む）、`README.md`、`docs/DEVLOG.md`
- 確認したこと: `npm test`（40ファイル・407件）、`npm run check`（エラー0）、`npm run build`。ビルドしたサイトを Playwright で開いて（GitHub の API はまね。書き込みはしない）: 新しい E2E（PC・スマホで計88項目。メニューの表示と強調・スマホのメニューの開閉と Esc・上のバーの部品が重ならない・メニューから収集元のタブを開く・開いたときにスクロールしない・収集元の絞り込み・タブのクリック／キーボード／# の変更／以前のリンク・保存済みの絞り込み・SNS の10件と「もっと見る」・題名の表示・メニューの中のログアウト・全ページで横にはみ出さない・画面のエラーなし）、今すぐ投稿の4つの場面（投稿できた・Secrets がない・処理中の依頼・保存の失敗）を SNS 投稿のページで、タブの中での要約の編集と非表示の設定の保存（PC・スマホ）。axe（ライト・ダーク × 1280px・390px、全ページ・全タブ・スマホのメニューを開いた状態）で違反なし。整理の前後の画面を撮って見比べた。
- 残った課題・注意点: 運営者に使ってもらい、分かりにくいところを直す。`summaries.astro` に `admin.css` と重複した見た目の指定が残っている（「未解決の課題」31）。

### 2026-10-09 自動要約を Qwen3.8 27B・考える量 xhigh に（chat.qwen.ai のスクレイピングは行わない）

- 依頼・目的: 運営者から「思考は高いのを使い、モデルは qwen3.8max を使用するように」、続けて「chat.qwen.ai の web 版をスクレイピングして使うように」。
- やったこと:
  - **chat.qwen.ai のスクレイピングは行わなかった**: 利用規約がボットでのアクセスと自動的な手段での取り出し・出力を禁じており、運営者のアカウントが止められるおそれがあり、ボット対策のすり抜けも必要になるため。Qwen3.8-Max は Alibaba Cloud（QwenCloud・Model Studio）の有料の API（入力100万トークンあたり2ドル・出力6ドル。考える量 `reasoning_effort` は low・medium・xhigh）だけで使え、Workers AI にはない。新規登録の無料分（モデルごとに約100万トークン・90日。「Free Quota Only」で使い切ったら止められる）は数十件で尽きる。これらを運営者に示した。
  - 無料で正当に使える範囲で依頼に近づけるため、既定のモデルを Workers AI の **Qwen3.8 27B**（`@cf/qwen/qwen3.8-27b`。Qwen 3.8 世代・推論つき・262K トークン。入力 40,909・出力 290,909 ニューロン/100万トークン）に、考える量を **xhigh**（`reasoning_effort`）にした。変数 `AUTO_SUMMARY_REASONING`（off・low・medium・xhigh。high は xhigh）で変えられる。
  - モデルごとの指定（`requestBody`。Qwen3.8 は `reasoning_effort`・`max_completion_tokens`、Qwen3 は考えないときだけ指示の末尾に `/no_think`、指定のしかたが分からないモデルには指定しない）、書かせる上限（考えるとき8,192・考えないとき2,048トークン。`outputLimit`）、考えるときの温度0.6と待ち時間180秒。
  - 考える量が多いと1件の使う量が10倍以上（1,500〜3,000ニューロン）になるので、(1) 依頼の前に、書かせる上限まで書いた場合の多めの見積もり（`reserveNeurons`。Qwen3.8 xhigh で3,038）を足しても1日の上限（8,000）を超えないかを確かめ、直しの依頼の前も確かめる（超えそうなら直しは頼まず保存しない）、(2) 使う量を1日の時間で均す（`pacedBudget`。UTC の0時台は1/24、23時台で上限まで。先に使いすぎていれば次の実行に回す。朝にまとめて使い切らず、1日に3件前後をばらして作る）、(3) 依頼に失敗したときは多めの見積もりを使ったことにする。
  - 自動更新タイマーは push のたびに60分を数え直すため、管理画面の保存が続くと定期の更新が来ず、自動要約が動かない（この日の本番でも、定期の更新の直前に運営者の push があった）。push のときも前回の自動要約から50分以上たっていれば動かす（`--min-interval`）。
  - ワークフローの「AI で自動要約」の制限時間を12分、build ジョブを25分にした。管理画面の「最後の実行」にモデルと考える量を出し、説明を書き直した。編集方針のモデル名を「Qwen シリーズ（現在は Qwen3.8）」にした。
- 主な変更ファイル: `scripts/lib/auto-summary.ts`（モデルの表・考える量・見積もり・均し）、`scripts/auto-summary.ts`（`AUTO_SUMMARY_REASONING`・`--min-interval`）、`src/lib/auto-summary-state.ts`（最後の実行のモデル）、`src/scripts/admin.ts`・`src/pages/admin/summaries.astro`（管理画面）、`src/pages/editorial.astro`、`.github/workflows/update.yml`、`tests/auto-summary.test.ts`、`README.md`、`docs/DEVLOG.md`
- 確認したこと: `npm test`（自動要約のテストを22件に。モデルごとの依頼の中身・多めの見積もり・時間での均し・直しの前の上限の確認・考える量の設定の読み取り）、`npm run check`、`npm run build`、actionlint。公開後の本番の実行（run #148、push のときの自動要約が動くことも確認）で、Qwen3.8 27B・xhigh への依頼が公開用のトークンでは HTTP 401（10000 Authentication error）になり、権限の問題として記録して止まること（使った量0・試した記事として数えない・管理画面に「要対応」・収集と公開は成功）を確かめた。
- 残った課題・注意点: 運営者が Workers AI のトークン（`CLOUDFLARE_AI_TOKEN`）を登録したあと、実際の使う量と1日の件数・考えすぎて書かせる上限で切れないかを確かめる（「未解決の課題」1・2）。

### 2026-10-09 AI の自動要約（Cloudflare Workers AI の無料枠で Qwen3）と、本文の取り出しの改善

- 依頼・目的: 運営者から「API は買えないので、chat.qwen.ai で手動ではなく自動で要約できるようにしてほしい」。
- やったこと:
  - **chat.qwen.ai の自動操作は採らなかった**: Qwen の利用規約（Service Usage Rules）が、ボットでのアクセスや、自動的・プログラム的な手段でのデータの取り出し・出力を禁じているため（ほかのチャット AI の画面も同じ）。代わりに、公式に API が提供されている Cloudflare Workers AI で同じ系統のモデル（Qwen3 30B-A3B）を、無料枠（1日1万ニューロン。UTC の0時に戻る）の中だけで使う。Workers の無料プランでは無料枠を超えた依頼はエラーになるだけで料金はかからないことを、Cloudflare の料金のページで確かめた（Qwen3 は入力100万トークンあたり4,625・出力30,475ニューロン）。さらに1日の見積もりを8,000ニューロン・60件、1回4件に抑える。
  - **自動要約**（`scripts/lib/auto-summary.ts`・`scripts/auto-summary.ts`・`src/lib/auto-summary-state.ts`）: 記事の選び方（要約のないトピックを報じた媒体の多い順 → 反応のよいジャンルの新しい記事。失敗した記事は7日間選ばない）、本文の取得（本文の自動取得と同じ決まり。`text-fetcher.ts` から `loadRobots`・`fetchArticleText` を切り出して共通にした。本文は保存しない。取り出した本文に見出しの言葉が少なければ使わない `focusOnTitle`）、管理画面と同じ本文入りのプロンプト（Qwen3 の考えるモードは `/no_think` で止める）、管理画面と同じ検証と、保存を止める注意（推測・宣伝・定型文・見出しの言い換え・書き出し・SNS・あいまいな日付）があれば同じ会話で1回だけ直させる処理、見出しと関係のない要約をはじく確認、使った量の見積もり（返ってきたトークン数と料金表から。なければ文字数から多めに）、権限がない・無料枠を使い切ったときは止めて記録する処理、依頼が続けて失敗したときの記録。
  - **ワークフロー**（`update.yml`）: 「AI で自動要約」を定期の更新と「今すぐ更新」（workflow_dispatch）のときだけ動かす（管理画面の保存などの push では待たせない。失敗しても収集・公開は続ける。4分を過ぎたら新しい記事に取りかからず、手順は9分で打ち切る）。トークンは Secrets の `CLOUDFLARE_AI_TOKEN`（なければ `CLOUDFLARE_API_TOKEN`）。「取得したデータをコミット」で、この実行で書き換えた記録（`data/auto-summary.json`）だけを上書きし、作った要約を `npm run summaries -- import --skip-existing` で取り込む（取り込みに失敗してもデータのコミットは続ける）。取り込みは、要約ごとの `generator`（モデル）を記録する。
  - **表示と開示**: 自動で作り運営者がまだ手直ししていない要約（`isAutoSummary`: `generator` があり `updatedAt` がない）は、要約の注記を「AIが元記事の本文をもとに自動で作成し、機械的な確認だけで掲載しています（運営者があとから確認・修正することがあります）」にした（それまでの「運営者が確認して掲載しています」は自動の要約には正しくないため）。編集方針（`/editorial/#auto-summary`。作り方・使うサービスとモデル・確認のしかた・読者の情報は渡さないこと）と about の「記事の本文の取得について」「10秒・30秒・2分で」も書き直した。
  - **管理画面**: 「AI要約・記事」に「AI の自動要約」の欄（最後の実行・今日の保存数と使った量の見積もり・直近24時間の結果・続いている問題と対処）、「保存済みの要約」に「自動」の印と「AI が自動で作り、まだ手直ししていない要約だけ表示」。「概要」のやることに、権限の問題（警告）と直近24時間に自動で作った数。あわせて、保存済みの要約の「背景」「キーワード」の行がチェックボックスの列に入り、スマホの幅で見出しが1文字ずつ折り返されていた表示の崩れを直した。
  - **本文の取り出しの改善**（`scripts/lib/article-text.ts`。本文の自動取得にも効く）: 自動要約の候補12件の確認で半分が取れなかったので、原因を調べて直した。(1) `<body class="news breadcrumb …">`（Impress Watch の各媒体）・`<div class="hidden_share post">`（Pouch）のように、ページや記事全体に付いたクラス名で本文ごと消していた → 見出し・本文の目印を含むまとまりと html・body・main、ページの文の半分以上を含むまとまりは消さない（nav・aside・footer は今までどおり消す）。(2) メニューやおすすめの見出しの一覧（ASCII.jp の「ピックアップ」、AUTOSPORT web のメニュー）を本文に選んでいた → リンクの文字は数えず、「。」などで終わる文を含まない短い文字は軽く数える。(3) タグの閉じ方の都合で本文が body の外に置かれるページ（ASCII.jp）→ ページ全体から探す。(4) 小見出しごとに同じ形のまとまりに分かれた本文（ケータイ Watch）の1つしか取れなかった → 同じ形のまとまりが親の文字の大半なら親に広げ、親が1.5倍以下なら記事全体に広げる。あわせて、見出しと本文の重なりの下限を0.5から0.25にした（実際のページで、正しく取れた本文は0.33以上・取り違えは0.13以下。くるまのニュース・Merkmal のような長い見出しの記事が使えるようになった）。
  - `CLAUDE.md` の方針に、自動要約は Workers AI の無料枠の中だけで使うという例外と、チャット AI の画面を自動で操作しないことを書き足した。README に「AI の自動要約」（仕組み・上限・料金・表示・管理画面・トークンの作り方・変数・コマンド）を書いた。
- 主な変更ファイル: `scripts/lib/auto-summary.ts`・`scripts/auto-summary.ts`・`src/lib/auto-summary-state.ts`（自動要約）、`scripts/lib/text-fetcher.ts`（本文の取得の切り出し）、`scripts/lib/article-text.ts`（本文の取り出し）、`scripts/summaries.ts`（`generator` の取り込み）、`src/lib/types.ts`（`SummaryRecord.generator`）、`src/lib/summary-view.ts`（`isAutoSummary`）、`src/components/SummaryLevels.astro`（注記）、`src/pages/editorial.astro`・`src/pages/about.astro`（開示）、`src/pages/admin/data.json.ts`・`src/pages/admin/summaries.astro`・`src/scripts/admin.ts`・`src/scripts/admin-dashboard.ts`・`src/scripts/admin-shared.ts`（管理画面）、`.github/workflows/update.yml`、`package.json`（`npm run auto-summary`）、`tests/auto-summary.test.ts`・`tests/article-text.test.ts`、`README.md`、`CLAUDE.md`、`docs/DEVLOG.md`
- 確認したこと: `npm test`（40ファイル・403件。自動要約の18件（設定・見積もり・記録・記事の選び方・返事の取り出し・本文の位置・1件の要約と直し・まとめての実行と上限・権限と失敗の記録・API の呼び方）と、本文の取り出しの7件）、`npm run check`（エラー0）、`npm run build`、actionlint。`npm run auto-summary -- --dry-run` で実際の記事を選んで本文を取得できること（AI には頼まない。記録も書かない）。本文の取り出しは、保存した16ページと、要約を載せられる58掲載元の最新の記事で確かめた（51掲載元で取得。取れない7つの理由は「未解決の課題」3）。取り込みは、テスト用の自動要約1件を一時的に `data/summaries/` に取り込んで、`generator` の記録・`--skip-existing` で二度目は上書きしないこと・要約のページの注記・ほかの要約の注記が変わらないこと・管理画面のデータ（`generator`・`autoSummary`）をビルドで確かめ、管理画面（GitHub API はまね）を Playwright で開いて「AI の自動要約」の欄・「自動」の印と絞り込み・「概要」のやること・画面のエラーがないことを、PC（ライト）とスマホの幅（ダーク）で確かめた（テスト用のデータはコミットしていない）。Workers AI への実際の依頼は、トークンがないため手元では行っていない。
- 残った課題・注意点: 本番で Workers AI の権限と実際の返事の形を確かめる（「未解決の課題」1）。自動で作った要約の見守り（同2）。本文が取れない掲載元・モデルの提供終了・同時実行のときの記録（同3）。

### 2026-10-09 集客の改善: ページ・投稿ごとの見出しのカード画像、Bluesky の投稿の中身、要約プロンプトの要点とキーワード

- 依頼・目的: 運営者から「人をより集めるためブルースカイの投稿内容やマーケティング方法やAIの要約プロンプト等を改善して」。
- 現状の分析: Bluesky はフォロワー4人・投稿49件。「いいね」は10秒でわかるニュース（26件中6件）・急上昇（11件中2件）に集まり、いま話題（5件）・まとめの投稿（朝・昼・夜・計6件）は0件。「いいね」の付いた9件のうち8件がテクノロジー・乗り物の話題。サイトの共有画像（OGP）はどのページも同じ1枚（`public/og.png`）で、タイムラインや検索結果で見分けがつかなかった。
- やったこと:
  - **ページごとの見出しのカード画像**（新規 `src/lib/og-image.ts`・`src/lib/og-cards.ts`・`src/pages/og/{topic,summary,daily}/`）: 話題・AI 要約・日別まとめのページに、見出しを大きく出したカード（「N媒体が報道」「AI要約」などの印・AI 要約の1文目・ジャンル。日別は上位5件）を作り、`og:image`・`twitter:image`（新たに出す）・`og:image:alt` に使う。記事の写真は著作権があるので使わない。satori で文字を図形にしてから sharp で PNG にする（フォントは Noto Sans JP の太字を日本語の範囲に絞って WOFF にしたもの約2.7MB を `assets/fonts` に置いた。OFL のライセンス文も同梱）。1枚約0.2秒（大半が PNG にする時間）かかるため、内容の同じ画像は `.cache/og` に残して使い回し、`update.yml` は `actions/cache@v6` で引き継ぐ（キャッシュがあればビルドは約13秒→約16秒、ないときは約2分15秒）。採らなかった案: 毎回すべて作り直す（ビルドが毎時2分長くなる）、Cloudflare の Worker で表示のたびに作る（日本語フォントが大きく無料枠の容量に収まらない）、resvg（試したところ sharp より遅かった）。
  - **Bluesky の投稿の中身**（`scripts/lib/social.ts`・`src/lib/social-source.ts`・`scripts/notify.ts`）: リンクカードの画像を投稿ごとの見出しのカードにした（「↑ 急上昇」「● いま話題」「AI要約」の印・報じた媒体の数・3時間の増加・ジャンル。まとめの投稿は上位5件の見出しを並べたカード。作れなければ共通の画像）。急上昇・いま話題の投稿に AI 要約の1文目（あれば）と報じたメディアの名前（「報じたメディア: A・B・C ほか2媒体」）、リンクカードの説明にも1文目かメディアの名前を入れた。10秒でわかるニュースに要点の箇条書き（2つまで。見出し・1文目と文字の組の重なりが大きい要点は省く `distinctPoints`）を入れた。ハッシュタグに AI 要約のキーワード（空白・記号のない2〜15字の固有名詞 `keywordHashtags`。例: `#ChatGPT`・`#大谷翔平`）を加え、大文字・小文字の違いをまとめて3つまで。見出しはサイト名などを除いたもの（`mainTitle`）。話題の投稿のあとは10秒でわかるニュースを先にして交互にし、10秒でわかるニュースはテクノロジー・ゲーム・サイエンスを少し優先（報じた媒体の数に1を足して並べる。`SOCIAL_LIMITS.preferredCategories`・`preferredBonus`）。`NOTIFY_PREVIEW_DIR` で、送信せずにカードの画像を書き出せるようにした。
  - **要約プロンプト**（`src/lib/summary-core.ts`）: 要点は SNS の投稿や共有のカードで単独で表示されることがあるので、前の文に頼る書き出し（「同社は」「これにより」「また」）にしないこと、キーワードの1つ目を記事の主役にすること（キーワードのページ・ハッシュタグに使う）を足した。「AI 要約内容 改善指示書」の基準は変えていない。品質の確認（`src/lib/summary-quality.ts`）に、前の文に頼る書き出しの要点への注意（`standalone`）を加えた。
  - README に「集客のためにできること（運営者の作業）」（AI 要約を毎日足す・Bluesky で人として反応する・手で共有する・独自ドメイン・効果を見る）を書いた。フォロー・いいね・返信の自動化は、スパム扱いやアカウント停止のおそれがあるので今までどおり行わない。
- 主な変更ファイル: `src/lib/og-image.ts`・`src/lib/og-cards.ts`・`src/pages/og/topic/[id].png.ts`・`src/pages/og/summary/[id].png.ts`・`src/pages/og/daily/[date].png.ts`（新規）、`assets/fonts/NotoSansJP-Bold.woff`・`assets/fonts/OFL.txt`（新規）、`src/layouts/BaseLayout.astro`（`image`・`twitter:image`）、`src/pages/topic/[id].astro`・`summary/[id].astro`・`daily/[date].astro`、`scripts/lib/social.ts`・`scripts/notify.ts`・`src/lib/social-source.ts`、`src/lib/summary-core.ts`・`src/lib/summary-quality.ts`、`.github/workflows/update.yml`（画像のキャッシュ）、`.gitignore`（`.cache/`）、`package.json`（`satori`・`sharp`）、`tests/og-image.test.ts`（新規）・`tests/social.test.ts`・`tests/summary-core.test.ts`・`tests/summary-quality.test.ts`、`README.md`
- 確認したこと: `npm test`（39ファイル・381件）・`npm run check`（エラー0）・`npm run build`（本番の URL で。ページ1230・画像611枚・ファイル1909。キャッシュなしで2分12秒、ありで16秒）・actionlint。実際のデータで、話題（7媒体のトピック）・要約・日別のカードと、急上昇・いま話題・10秒でわかるニュース・日別まとめの投稿の文面（どれも Bluesky の300字以内）を作って目で確かめ、`npm run notify` を送信なし（`NOTIFY_DRY_RUN=1`）で動かして次の投稿の文面とカードの画像ができることを確かめた。本番（push のあと、run #142）: キャッシュのない最初のビルドは「サイトをビルド」が2分13秒で、作った画像はキャッシュに保存された。話題のページの `og:image` が `/og/topic/<ID>.png` になり、画像（PNG・約36KB）と日別まとめの画像が配信されることを確かめた。14:04 の投稿だけの実行で、新しい形の10秒でわかるニュース（1文目・要点2つ・`#ニュース #Google #ちいかわ`）が投稿され、リンクカードの画像が見出しのカード（AI要約・5媒体が報道）になっていることを、Bluesky の公開 API と画像で確かめた。
- 残った課題・注意点: 未解決の課題の 8（反応を見て見直す）・27（カードの見た目の版・フォント・キャッシュ）。

### 2026-10-09 Search Console の確認コードを、タグ全体や DNS 用の形で入れても使えるように

- 依頼・目的: 運営者が Search Console に登録しようとして「所有権を証明できませんでした（ドメイン名プロバイダ・TXT レコードが見つからない）」となり、「できないからそっちで設定して」。運営者は「ドメイン」のプロパティで DNS の TXT レコード用の値（`google-site-verification=…`）を GitHub の変数 `PUBLIC_GOOGLE_SITE_VERIFICATION` に入れていて、サイトには `content="google-site-verification=…"` という形の正しくないタグが出ていた。
- やったこと:
  - 確認のコードを取り出す `verificationCodes`（新規 `src/lib/site-verification.ts`）: 変数にタグ全体（`<meta … content="…">`）・DNS の TXT レコードの形（`google-site-verification=…`、かぎかっこ付きも）・コードだけのどれを入れても、meta タグの content に入れるコードだけを取り出す。複数のコード（空白・カンマ・改行で区切る）にも対応し、HTML ファイルの名前やタグを壊す文字を含むものは出さない。Bing の確認コードにも使う。
  - `src/config/services.ts` の `googleSiteVerification`・`bingSiteVerification` をコードの配列にし、`BaseLayout.astro` はコードごとに meta タグを出す。運営者が GitHub の変数を設定できないときのために、リポジトリに書ける欄（`GOOGLE_SITE_VERIFICATION_IN_REPO`。確認のコードはページに出る公開の情報）を足した（いまは空）。
  - こちらから Search Console を操作することはできない（運営者の Google アカウントで「URL プレフィックス」のプロパティを作って「確認」を押す必要がある）。`pages.dev` は DNS を変えられないので「ドメイン」のプロパティは使えないことを、README の手順に書き足した。
- 主な変更ファイル: `src/lib/site-verification.ts`（新規）、`src/config/services.ts`、`src/layouts/BaseLayout.astro`、`tests/site-verification.test.ts`（新規）、`README.md`、`.env.example`
- 確認したこと: `npm test`（38ファイル・368件）・`npm run check`（エラー0）。いまの変数の値（`google-site-verification=3Ny1…`）でビルドし、すべてのページに `<meta name="google-site-verification" content="3Ny1…">`（コードだけ）が出ることを確かめた。
- 残った課題・注意点: 未解決の課題の 26（Search Console での確認は運営者の作業。DNS 用のコードと URL プレフィックスの HTML タグのコードが違う場合は、HTML タグのコードを入れ直す必要がある）。

### 2026-10-08 Bluesky の投稿を30分ごとに（更新の合間の投稿だけの実行・1回1件・上限の見直し）

- 依頼・目的: 運営者から「ブルースカイの投稿を30分に一回にして」。これまでは毎時の更新のあとに投稿し（急上昇などは前の投稿から1時間あける）、1日9〜12件ほどだった。
- やったこと:
  - **投稿の機会を30分ごとに**: 自動更新タイマー（`scripts/lib/timer.ts`）が、前回の更新から30分たったら SNS の投稿だけのワークフロー（新規 `.github/workflows/social.yml`）を実行する。`social.yml` は最新のデータで `scripts/notify.ts` を `NOTIFY_SKIP_PING=1` で動かし（検索エンジン・フィードへの通知は更新のあとだけ）、投稿の記録（`data/social.json`）をコミットする。収集・ビルド・公開はしない（投稿の内容は公開中のサイトと同じデータから決めるので、リンク先のページはすでにある）。更新の `notify` ジョブと同じ concurrency group（`notify`）で1つずつ動くので、同じ話題を二重に投稿しない。公開先の URL は `update.yml` と同じ順（Cloudflare の Secrets があれば変数 `SITE_URL` か Pages のプロジェクトの URL、なければ GitHub Pages）で調べ、わからなければ投稿しない。
  - タイマーの決めごと（`planCycle`・`nextSocialAt`）: 前回の更新・投稿だけの実行のうち遅い方から30分後（遅れていれば今）。深夜（0〜7時）は実行しない（更新の間隔が長いときは、深夜が明けてからの時刻にする）。次の更新まで20分（投稿の間隔の歯止めと同じ）を切っているときは実行せず、更新のあとの投稿に任せる。実行したことを覚えておき、実行の一覧に出てくる前に二重に実行しない。投稿だけの実行ができなくても（ワークフローがない・GitHub の不調など）、警告を出して更新は続ける。間隔はリポジトリの変数 `SOCIAL_INTERVAL_MINUTES`（15〜360分、既定30分、`0` でやめる）。
  - **投稿の決め方**（`scripts/lib/social.ts` の `planPosts`・`SOCIAL_LIMITS`）: 自動の投稿は1回1件にした（決まった時間のまとめが先で、話題の投稿は次の機会に回す。これまでは朝のまとめと話題が同時に出ることがあった）。前の投稿から間をあける対象を、まとめも含むすべての投稿にし、間隔を60分から20分にした（実行の時刻が数分ずれても30分ごとに投稿でき、管理画面から更新が続いても次々と投稿しない）。上限は24時間に40件（12件から。7〜24時に30分ごとで34件）、種類ごとに急上昇12（4）・いま話題12（4）・10秒でわかるニュース30（3）、「今すぐ投稿」を含めて50件（24）。「今すぐ投稿」の動きは変えていない。
  - 10秒でわかるニュースの候補から、記事の公開から48時間を過ぎたものを除いた（投稿が増えるので、古いニュースを投稿しないように。`src/lib/social-source.ts`）。
  - 採らなかった案: 更新そのものを30分ごとにする（`UPDATE_INTERVAL_MINUTES=30`）。投稿は30分ごとになるが、収集元へのアクセス・データのコミット・Cloudflare Pages への公開が倍になる（無料プランの公開の回数の上限に当たるおそれがある）ため、更新は1時間ごとのままにした。深夜（0〜7時）は読まれにくく、続けて投稿するとスパムと見られやすいので、今までどおり投稿しない。
  - 管理画面の「SNS（Bluesky）の自動投稿」の説明の数字を `SOCIAL_LIMITS` から出すようにした（ずれないように）。「今すぐ投稿」の上限の表示（`src/scripts/admin-dashboard.ts`）を50件に。README を更新。
- 主な変更ファイル: `.github/workflows/social.yml`（新規。投稿だけの実行）、`.github/workflows/timer.yml`（変数 `SOCIAL_INTERVAL_MINUTES`）、`scripts/lib/timer.ts`・`scripts/timer.ts`（更新の合間の投稿だけの実行）、`scripts/lib/social.ts`（1回1件・間隔・上限）、`src/lib/social-source.ts`（古い記事の要約を除く）、`src/pages/admin/index.astro`・`src/scripts/admin-dashboard.ts`・`src/pages/admin/data.json.ts`（説明）、`tests/social.test.ts`・`tests/timer.test.ts`、`README.md`
- 確認したこと: `npm test`（37ファイル・364件）・`npm run check`（エラー0）・actionlint（3つのワークフロー）。テストで、30分ごとの機会（10:02・10:31・11:08・11:31・12:03。11:41 は管理画面からの更新）に1件ずつ投稿され 11:41 は投稿しないこと、まとめと話題が重なると1件ずつになること、タイマーが更新の30分後に `social.yml` を実行してから60分後に更新すること・管理画面からの更新のあとはそこから30分後にすること・深夜は実行しないこと・失敗しても更新が続くことを確かめた。本番のデータで、これからの8時間の投稿を送信せずに試算し、約30分ごとに急上昇・いま話題・10秒でわかるニュースが1件ずつ出ることを確かめた。本番（push のあと）: 新しいコードの前に始まって待っていたタイマー（#51）を止め、新しいタイマー（#52）に切り替えた（Actions に「取り消し」の #51 が残るのはこのため）。push の更新（13:27）のあとに急上昇を1件（13:29）、タイマーが更新の30分後（13:57:42）に `social.yml` を実行し、いま話題を1件（13:57:59）投稿して記録をコミットした（`social.yml` の実行は約20秒）。投稿のリンク先の話題のページが開けること（HTTP 200）と、公開中の管理画面の説明が新しい数字になったことも確かめた。
- 残った課題・注意点: 未解決の課題の 8・25。

### 2026-10-08 AI 要約の内容の改善（「AI 要約内容 改善指示書」の基準でプロンプトを書き直し・要確認の注意・直してもらうプロンプト）

- 依頼・目的: 運営者の「トピあつめ AI要約内容 改善指示書」。AI が書く要約の内容・品質だけを改善する（AI のモデル・API・生成のしくみ・頻度・データの形は変えない。AI のニュースだけの特別な決まりも作らない）。目的は「記事を開かなくても、要約だけで何が起きたのかを短い時間で正確につかめる」こと。3原則は「重要な情報は残す・不要な情報は削る・記事にないことは書かない」。
- やったこと:
  - **プロンプトの書き直し**（`src/lib/summary-core.ts` の `summaryRules`）: 指示書の項目を「要約の目的」（優先順位・3原則・ジャンルで基準を変えない）・「summary の書き方」（1文目で核心・見出しの言い換えにしない・重要な順・5W1H は必要なものだけ・何が新しいか・結果と影響は記事の範囲・背景は必要な分・長さは情報量しだい）・「数字・名前・条件」（単位・名前は必要なもの・条件・対象・地域・日付）・「正確に書くための決まり」（推測しない・主張は「〜と発表した」・宣伝の言葉・不確定の情報・発表と発売の区別・否定・見出しより本文・続報・速報と障害・サービス終了・SNS）・「文章」（常体・1文40〜80字・接続詞・定型文と評価・繰り返し・脱線）・「ニュースの種類ごとの目安」にまとめた。出力前の確認も同じ観点に増やし、出力例の要約も基準に合わせた（日付・単位つきの価格・「明らかにしていない」）。
  - **文体**: 指示書の「サイト全体で採用している文体に統一」に従い、今までの要約と同じ常体（だ・である調）にそろえる（指示書の例は「です・ます」だが、今の要約と混ざらないようにした）。
  - **記事の公開日時を渡す**: 記事一覧に `published`（日本時間の「2026-10-07 10:30」）を入れ、「今日」「昨日」などを具体的な日付にしてもらう（`promptPublished`）。
  - **要確認の注意**（`src/lib/summary-quality.ts`・新規）: 文字の並びで見分けられる基準を機械的に確かめる。見出しの言い換え（要約の文字の組のうち見出しにない組が35%未満か12組未満。定型文・推測の文は数えない）・中身のない書き出し・宣伝や評価の言葉・定型文・推測の言い方・相対的な日付・です・ます・100字を超える文・単位のない数字の増減・長い引用・SNS の誇張・接続詞の多用。保存は止めない（本文どおりの言い方もあるため）。かぎかっこの中（作品名・発言）は言葉の当てはめから外し、天気や捜査の記事で使う「〜と予想される」「〜とみられる」は推測に入れない（既存の要約で誤検出を確かめて外した）。
  - **管理画面**（`src/scripts/admin.ts`・`src/pages/admin/summaries.astro`）: 回答の確認で要約ごとに注意を出し、「うち要確認 N件」の印と、「直してもらうプロンプトをコピー」（`buildFixPrompt`。要確認の要約と指摘を渡し、最初と同じ形式でその記事の分だけ直させる）・「直した回答を取り込む」（その要約だけを置き換えて確認し直す）を件数のすぐ下に置いた。「保存済みの要約」には要確認の印と注意・「要確認の要約だけ表示」、編集中は書きながら注意を更新する。CLI の取り込み（`npm run summaries -- import`）も注意を出す。
  - **AI 整理にも同じ基準**（`src/lib/topic-notes-core.ts`）: 共通の事実の1つ目で核心・同じ事実を繰り返さない・媒体で違う数字は1つにまとめず並べる・単位・具体的な日付・主張と事実・宣伝の言葉・整理・解釈に予想や評価を書かない、をプロンプトに足し、出力例の解釈から「注目が集まっている可能性がある」をなくした。回答の確認で要確認を出す（管理画面の「トピック整理」）。
  - 編集方針（`/editorial/`）の「AI要約の作り方」に、目的・3原則・書き方・機械的な確認を書いた。
  - 採らなかった案: 要確認の要約を保存できなくすること（誤検出があるため）。過去の要約を自動で書き直すこと（AI の生成は運営者の手作業のままにする方針のため。要確認の一覧から運営者が直す）。人物・企業などのキーワードの種類分け（データの形を変えないため）。
- 主な変更ファイル: `src/lib/summary-core.ts`（`summaryRules`・出力例・`promptPublished`・`outputFormatLines`・`buildFixPrompt`・注意の付与）, `src/lib/summary-quality.ts`（新規）, `src/lib/topic-notes-core.ts`, `src/scripts/admin.ts`, `src/scripts/admin-topics.ts`, `src/pages/admin/summaries.astro`, `src/pages/admin/topics.astro`, `scripts/summaries.ts`, `src/pages/editorial.astro`, `tests/summary-quality.test.ts`（新規）, `tests/summary-core.test.ts`, `tests/topic-notes.test.ts`, `README.md`
- 確認したこと: `npm test`（37ファイル・350件）・`npm run check`（0 errors）・`npm run build`。既存の要約に品質の確認をかけ、出た注意を1件ずつ見て誤検出の言葉を外した（作業中に運営者が要約を追加したので、最終的に314件中45件に注意。見出しの言い換えは0件）。管理画面は Playwright で GitHub API をまねて、新しいプロンプト（決まり・公開日時）→ 回答の確認で要確認（見出しの言い換え＋定型文＋要点の宣伝の言葉）→ 直してもらうプロンプトのコピー → 直した回答の取り込み（その要約だけ置き換わる）→ 保存、保存済みの要約の「要確認だけ」と編集中の注意の更新、トピック整理の要確認の表示を確かめた（axe の違反なし・ページのエラーなし、ライト/ダーク・幅390/1280）。
- 残った課題・注意点: 「未解決の課題」の23（要確認の要約を直す）・24（プロンプトが長くなった）。

### 2026-10-08 全面改善 Phase 4: トレンド（日ごとの集計・昨日との違い・急に現れた言葉・注目ワードの表・一緒に出始めた言葉・今週のトピあつめ・その日の分析）

- 依頼・目的: 運営者の「トピあつめ 全面改善指示書」の Phase 4（トレンド）。「ニュースを探すサイト」ではなく「ニュースの変化を理解するサイト」にする。指示書の 32（注目ワードの強化）・33（急に現れた言葉）・34（言葉の組み合わせ）・65（日別ページを「その日の分析」に）・66（週間ビュー）・67（昨日との違い）。
- やったこと:
  - **日ごとの集計**（`data/trends/YYYY-MM-DD.json`。`scripts/lib/trends.ts`・`src/lib/trend-core.ts` の `buildDayTrend`）: 記事は約10日で消えるので、日本時間の1日ごとに、記事・媒体・トピック（2媒体以上）の数、ジャンルごとの記事・トピック・温度（その日の終わりの熱さの合計）、見出しの言葉の数、その日のトピックの上位（最高話題度 `peakWithin`・その日に増えた媒体・3時間で増えた媒体の最大 `burstWithin`・初報の見出し／URL／媒体）を残す。毎時の収集（`fetch-feeds.ts`・`merge-items.ts`）で直近3日分を作り直し、変わらない日は書き直さない。トピックはサイトと同じ期間（`TOPIC_DAYS` を `topic-core.ts` に移して共通にした）・同じまとめ方（統合・分割）で、非表示の記事は数えない。表示のときも非表示の設定（記事・NG ワード）で外す。トピックのページがなくなった日のトピックは、初報の記事へリンクする。
  - **トレンドのページ**（`/trends/` を拡張）: 「昨日との違い」（急増・急減＝見出しの言葉の数とジャンルのトピックの数、新しく登場＝24時間以内に報じられ始めて3媒体以上、話題が収束＝昨日の同じ時刻に話題度40以上で新しい報道が12時間なく半分以下）・「急に現れた言葉」（7日間に1件以下→24時間で3件以上・2媒体以上。最初に出た時刻とトピック）・「注目ワード」の表（24時間・7日平均・増え方・24時間ごとの推移・トピック・一緒に出てくる言葉）・「一緒に出始めた言葉」（24時間に2媒体以上で一緒に出て、7日間は一緒に出なかった組。どちらも以前から出ていた言葉に限り、新しい出来事の名前どうしの組は出さない。同じトピックの組は1つだけ）・「ジャンルの変化」（温度とトピック・記事の数の昨日比の表）。今日、変化したこと・報じられ始めたトピックはそのまま残した。
  - **今週のトピあつめ**（`/weekly/`。新規）: 日ごとの集計から直近7日間の数字（記事の合計・1日あたりのトピック。平均は数え終わった日だけで出す）と日ごとのグラフ（押すとその日の分析）・今週のトップトピック（最高話題度の順）・速く広がったトピック・今週よく出てきた言葉・ジャンルの変化（前の7日間の集計があれば比べる）。集計が2日分ないうちは検索エンジンに出さない。Bluesky の週のまとめの投稿のリンクを `/ranking/#week` からここに変えた。
  - **その日の分析**（日別のページ。`src/components/DayAnalysis.astro`）: その日の数字（前の日との比較）・最も話題だったトピック（上位3件）・最も速く広がったトピック・最も広がったニュース・その日の注目ワード（前の日々の平均と比べる `dayWordTrends`）・その日のニュースの温度・ジャンル別の変化。集計のない日は出さない。
  - **注目ワードの「ふだん」を7日間に**（`WORD_BASELINE_DAYS`）: 指示書の「過去7日平均」に合わせ、それまでの6日間から7日間に変えた（記事は約10日分あるので足りる）。「新」の印は、7日間に1件以下（`isNewWord`）にそろえた（以前は0件のときだけで、1件だと「×10倍以上」になっていた）。候補の言葉の準備は `prepareVocabulary` にまとめ、注目ワードにしない言葉に「登場」「対応」「最大」「世界」「注目」「話題」を足した。
  - 採らなかった案: 集計を始める前の日（10月5日以前）を items.json からさかのぼって作ること（掲載元を増やす前の日で数が少なく、比べると誤解を招くため）。言葉を人物・企業に分けること（要約のキーワードに種類がなく、推測で分けると誤りが出るため。表では「一緒に出てくる言葉」で代える）。
  - about の「言葉の意味」（急に現れた言葉・一緒に出始めた言葉・昨日との違い）と「計算のしかた」（日ごとの集計）、フッター・日別アーカイブ・トレンドのページから今週のトピあつめへのリンク、サイトマップ（`/weekly/`）。
- 主な変更ファイル: `src/lib/trend-core.ts`（新規）・`src/lib/trends.ts`（新規）・`scripts/lib/trends.ts`（新規）・`scripts/fetch-feeds.ts`・`scripts/merge-items.ts`、`src/lib/topic-core.ts`（`prepareVocabulary`・`WORD_BASELINE_DAYS`・`isNewWord`・`TOPIC_DAYS`）・`topics.ts`・`words.ts`、`src/pages/trends.astro`・`weekly.astro`（新規）・`daily/[date].astro`・`daily/index.astro`・`about.astro`・`words.astro`・`word/[slug].astro`、`src/components/YesterdayDiff.astro`・`WordTable.astro`・`GenreChangeTable.astro`・`DayAnalysis.astro`（新規）・`TrendWords.astro`・`Footer.astro`、`scripts/lib/social.ts`、`astro.config.mjs`、`tests/trend-core.test.ts`（新規）・`topic-core.test.ts`・`social.test.ts`。
- 確認したこと: `npm test`（36ファイル・334件）・`npm run check`（0 errors）・`npm run build`（717ページ・約8.4秒）。本番の記事データで日ごとの集計を作り（4日分で約0.5秒・1日2〜12KB、2回目は書き直しなし）、トレンド・今週・日別のページを幅390/1280・ライト/ダークで表示して、はみ出し（表の中の横スクロールも360px まで）・コンソールのエラー・CLS（0）・axe（違反なし）・ページの中のリンク177件（すべて200）を確かめた。集計がないとき（今週は「まだ集計がありません」・日別は分析を出さない）も確かめた。確認に使った集計のファイルはコミットしていない（本番は公開後の最初の更新で作られる）。
- 残った課題・注意点: 「未解決の課題」の18（集計は公開後から・前の週との比較は14日後から・次の候補）・22（言葉の表記ゆれ）。

### 2026-10-08 全面改善 Phase 3: 探索（キーワードのページ・検索の作り直し・トピックのまとめ方の改善と管理画面での分割・統合）

- 依頼・目的: 運営者の「トピあつめ 全面改善指示書」の Phase 3（探索）。ニュースを単発で終わらせず、人物・企業・キーワードから関係をたどれるようにする。データの品質を最優先し、トピックのまとめ方の誤り（取りこぼし・混ざり）を減らし、運営者が直せるようにする。
- やったこと:
  - **トピックの分割・統合**（`src/lib/topic-overrides-core.ts`・`topic-overrides.ts`、`clusterTopics` の `mustLink`・`cannotLink`）: 運営者が管理画面の「トピック整理」の「まとめ方を直す」で、記事をトピックから外す（そのとき同じトピックだった記事とまとめない）・2つのトピックをまとめる（最初の記事どうしを必ずまとめる）・取り消すことができる。`data/topic-overrides.json` に記事の ID で保存し、サイトのビルド（`getTopics`）と日別まとめ（`scripts/fetch-feeds.ts`・`merge-items.ts`）の両方に反映する。まとめ方の中では、統合を先に行い、分割の組は同じまとまりに入らないように調べる（制約のある記事だけを覚えておくので速い）。最後の操作が優先（統合した2つを分割すると統合はやめる）。
  - **2段目のまとめ方**（`src/lib/related.ts` の `quoteMerge`。既定で使う）: かぎかっこ（「」『』“”""）の中の名前（3文字以上）が同じで、6時間以内に報じられ、見出しの似かたが0.3以上の、別の掲載元の記事をまとめる（その名前を前後6時間に含む見出しが8件を超えるありふれた名前は使わない）。本番のデータで、固有の言葉を2つ以上共有する組（136組）を1組ずつ見たところ、名前だけでは同じ製品・作品の別の話題をまとめてしまう（似かた0.25以上でも約16%が誤り）ので、時刻と似かたの条件を付けた。この条件で本番のデータに新たにできるまとまりは11（2媒体以上のトピックが88→93。リップルアイランド・Nano Banana 2.1・EmbeddingGemma 2・Switch 2 の選べるソフトセット・楽天ドライブの不正アクセスなど）で、すべて同じ出来事だった。処理時間は約0.1秒増えるだけ。
  - **キーワードのページ**（`/word/<言葉>/`・`src/lib/words.ts`）: AI 要約のキーワードとテーマの言葉から、直近8日間に3件・2媒体以上の見出しに出てくる言葉（136ページ）。7日間の記事の数（日ごとの棒）・24時間の件数とふだん（それまでの6日間の平均）との比較・その言葉のトピック（話題度の順）・一緒に出てくる言葉（同じ見出しに入っているほかのキーワード）・関連するテーマ・新着。記事が8件・3媒体以上でトピックもある言葉（32ページ）だけを検索エンジンとサイトマップに出す。同じ記事の組しか持たない言葉は1つにまとめる。一覧の `/words/`（いま増えている言葉・よく出てくる言葉）を追加し、ジャンル（読み方から探す）・トレンド・注目ワード・トピックのページ（このトピックの言葉。点線のチップ）・AI 要約のキーワードからたどれるようにした。
  - **言葉の当てはめ方の修正**（`containsWord`）: 英字の言葉が英字の続きの一部（「Gmail」の中の「ai」・「AM5」の中の「M5」）に当たっていたので、英数字の言葉は英数字の続きの中では当てはめないようにした（注目ワードの数え方も同じ）。
  - **検索の作り直し**（`src/pages/search.astro`・`src/lib/search-core.ts`）: 結果を「トピック」（最大5件。話題度・媒体の数・3時間の増加）・「キーワード」（キーワードのページへ）・「記事」に分けた。「今日 急上昇 AI」のような入力を、期間（今日・昨日・今週…）・並べ方（急上昇・話題・新着）・ジャンル名・AI 要約の条件と検索語に分け（`interpretQuery`）、「「今日」→ 24時間以内」のように、どう読んだかを出す（絞り込みの欄で選んだ条件を優先）。記事には一致した場所（見出し・AI 要約のキーワード・AI 要約・抜粋・掲載元）を出す。トピックとキーワードの小さな索引（`/search-topics.json`、57KB・圧縮して約20KB）をページを開いたときに読み、記事の索引（1.3MB）は検索したときだけ読むようにした（検索の候補も小さな索引のキーワードから出す）。
  - サイトマップ: キーワードのページは noindex のものを入れない（日本語の URL のファイルを読めるように直した）。トレンド・ジャンル・キーワード一覧も最終更新つきで入れる。
- 主な変更ファイル: `src/lib/related.ts`（`mustLink`・`cannotLink`・`quoteMerge`・`quotedNames`）、`src/lib/topic-overrides-core.ts`（新規）・`topic-overrides.ts`（新規）・`topics.ts`・`topic-core.ts`（`containsWord`）・`words.ts`（新規）・`search-core.ts`、`scripts/lib/daily.ts`・`scripts/fetch-feeds.ts`・`scripts/merge-items.ts`、`src/pages/word/[slug].astro`（新規）・`words.astro`（新規）・`search.astro`・`search-topics.json.ts`（新規）・`topic/[id].astro`・`genres.astro`・`trends.astro`、`src/components/TrendWords.astro`・`SummaryLevels.astro`、管理画面（`src/pages/admin/topics.astro`・`src/scripts/admin-topics.ts`・`src/pages/admin/data.json.ts`）、`astro.config.mjs`（サイトマップ）、テスト（`tests/related.test.ts`・`tests/topic-overrides.test.ts`（新規）・`tests/search-core.test.ts`・`tests/topic-core.test.ts`）、`README.md`
- 確認したこと: `npm test`（35ファイル・320件）・`npm run check`（0 errors）・`npm run build`（715ページ・約8.6秒）。まとめ方は本番の記事データで、2段目を入れる前と後のまとまりを比べ、変わった11件を1件ずつ確かめた。分割は、テスト用の一時ファイル（コミットしない）で「白猫GOLF」の記事を外してビルドし、コードギアスのトピックから外れることを確かめた。管理画面の「まとめ方を直す」は Playwright で GitHub API をまねて、外す（保存の中身・コミットの説明・外した印）・まとめる・これまでの手直し・取り消しを 1280px ライトと 390px ダークで確かめ、axe 違反なし・横のはみ出しなし・エラーなし。検索は Playwright で、開いたときは小さな索引だけを読むこと・トピックとキーワードの結果・キーワードのページへのリンク・一致した場所・「今日 急上昇」「テクノロジー 新着」を条件として読むこと（ジャンルで絞られる）・見つからないとき・URL に入力が残ることを確かめ、axe 違反なし。キーワードのページ・一覧・検索・トピックのページなど10ページ × 390/1280 × ライト/ダークで axe 違反なし。サイトマップに noindex のキーワードのページが入らないことを確かめた。
- 残った課題・注意点: 「未解決の課題」の6（まとめ方）・18（Phase 4）・21（白猫GOLF の分割は運営者の判断で）・22（キーワードの言葉の選び方）。

### 2026-10-08 全面改善 Phase 2: トピックのページの作り直し（概要・段階・なぜ話題？・各メディアの視点・タイムライン・広がり・推移）と AI 整理（管理画面の「トピック整理」）

- 依頼・目的: 運営者の「トピあつめ 全面改善指示書」の Phase 2（トピックの体験）。1つのページで「何が起きた → なぜ話題 → 各社はどう報じた → いつ・どう広がった → いまどの段階か」を理解できるようにし、同じニュースの報じ方の違いを見せる（最大の差別化）。費用のかかる AI API は使わない（運営者の方針）。
- やったこと:
  - **トピックのページ**（`src/pages/topic/[id].astro`）を作り直した。段階（発生・拡大・ピーク・減少）・急上昇中・NEW の印 → 見出し → **概要**（「いつ・どこが最初に報じ、どれくらいの時間で何媒体に広がり、いまどの段階か」を数字から機械的に書く2〜3文。`topicOverview`。ページの説明文にも使う）→ 数字（話題度と「なぜこの話題度？」の内訳・報じた媒体とジャンル・急上昇（直近3時間に増えた媒体と勢い。増えていなければそう書く）・初報）→ **なぜ話題？** → AI 要約の **10秒で把握・30秒で理解・2分で深掘り**（タブの名前を変えた）→ **各メディアの視点** → **報道タイムライン**（7件目からは折りたたむ）→ **報道の広がり**（1→2→3→5→10媒体…の節目の時刻と加わった媒体・ジャンルが加わった順・累計のグラフ）→ **話題度の推移**（最初の報道からいままで。どのトピックも0〜100の同じ目盛り。いまの段階と「段階の決め方」）→ 関連するトピック（見出しの似ているもの・同じテーマを先に。なければ「◯◯の話題のトピック」として別の見出しで出す）・**前後のニュース**（見出しの似ている記事）・ジャンルの新着。題名は「見出しの要点（40字まで）｜N媒体の報道を比較」。スマホではサイドバーの話題のトピックを出さない（ページが長くなりすぎるため）。
  - **各メディアの視点**: AI 整理があれば、共通して報じられていること（出典の媒体つき・2媒体以上のものだけ）・各媒体が特に伝えていること・**報道内容に差があります**（注意の色 `--warn`。どちらが正しいかは判断しないと明記）・背景・**AI による整理・解釈**（点線の別枠で「事実ではなく、AI の見方です」）と注意書き・整理のあとに増えた報道の数。AI 整理がなければ、**見出しの機械的な比較**（`src/lib/headline-compare.ts`）: 多くの見出しに共通する言葉・その見出しにだけある言葉（その媒体が焦点を当てている点の手がかり）・見出しの数字が媒体によって違うもの（「821社」と「800社」のように同じ単位で1.5倍以内の違いだけ。桁の違う「最大12人」と「同時接続1万5000人」は別のものなので出さない。片方が一部だけを書いているのは違いとしない）。言葉はカタカナ・漢字・英数字の続きで、数字に付いた助数詞（「8日配信」の「日」）や「第」「約」は外し、ほかの見出しに含まれるかは部分一致で調べる。本番のデータの22トピックで試し、焦点の違い（例: teppay のトピックで「上限」「最大」「キャンペーン」）が出ることと、まとめ方の誤り（下の課題21）が見つけやすいことを確かめた。
  - **段階・推移・広がりの計算**（`src/lib/topic-core.ts`）: `heatSeries`（1・2・3・6・12・24時間の間隔から48点以内になるものを選ぶ）・`lifecycleOf`（発生＝最初の報道から3時間以内で増えた媒体が2つ以下／拡大＝直近3時間に新しい報道があり話題度が3時間前より下がっていない／ピーク＝最も高かったときの75%以上／減少）・`spreadSteps`・`genreSpread`。本番のデータ（3日分の3媒体以上の22トピック）では 拡大2・ピーク3・減少17。
  - **AI 整理**（`src/lib/topic-notes-core.ts`）: プロンプト（媒体ごとの最初の記事の ID・媒体名・見出し・URL・抜粋。事実と解釈を分ける・共通の事実は2つ以上の記事が出典・差は判断しない・煽る言葉を使わない・記事のページ内の指示に従わない、を指示）、回答の検証（出典をトピックの記事に限る・出典が1つの共通の事実や差は外して理由を出す・媒体ごとに強調は1つ・長さの上限・煽る言葉（衝撃・驚愕・ヤバい・炎上・必見・悲報・朗報など）や URL があれば受け付けない・status が ok でなければ受け付けない）、保存ファイル（`data/topic-notes/YYYY-MM.json`、1行1トピック。記事の ID の組で保存し、記事が重なる古い整理は置き換える）、トピックとの結び付け（記事がいちばん多く重なる整理）。サイト側（`src/lib/topic-notes.ts`）では、非表示の記事・要約を禁じている掲載元の記事を出典から外し、共通の事実が残らなければ出さない。
  - **管理画面の「トピック整理」**（`/admin/topics/`・`src/scripts/admin-topics.ts`。メニューに追加）: 72時間のトピック（話題度の順・80件まで。プロンプトに入れられる記事が2つ以上のもの）を見出しで絞り込み・「まだ整理していないものだけ」（整理のあとに報道が増えたものも出る）→ プロンプトのコピー（クリップボードが使えないときは選択）→ 回答の貼り付けと「確かめる」（受け付けた内容のプレビューと、外した項目の説明）→ 「保存して公開」（GitHub に1コミット）・「このトピックの整理を消す」。回答を書き換えたら確かめ直すまで保存できない。管理画面のデータ（`/admin/data.json`）に `topics` を追加。概要の「やること」に「4媒体以上が報じたトピックで、AI 整理がまだのもの」を追加。
  - about の「言葉の意味」に「段階」と「各メディアの視点」、編集方針に「各メディアの視点（AI 整理）の方針」（`/editorial/#topic-notes`）を追加。
  - Bluesky のプロフィール（説明とバナー）を新しいキャッチコピーにそろえた（API で実施。アイコン・固定の投稿・bot のラベルはそのまま）。
- 主な変更ファイル: `src/pages/topic/[id].astro`、`src/components/ReportTimeline.astro`・`SpreadSteps.astro`・`HeatTrend.astro`・`HeadlineCompare.astro`・`TopicNotes.astro`（新規）・`SummaryLevels.astro`、`src/lib/topic-core.ts`・`topics.ts`・`headline-compare.ts`（新規）・`topic-notes-core.ts`（新規）・`topic-notes.ts`（新規）・`summary-view.ts`、`src/pages/admin/topics.astro`（新規）・`src/scripts/admin-topics.ts`（新規）・`src/pages/admin/data.json.ts`・`src/layouts/AdminLayout.astro`・`src/scripts/admin-dashboard.ts`、`src/pages/about.astro`・`editorial.astro`、`src/styles/global.css`（`--warn`）、テスト（`tests/topic-core.test.ts`・`tests/headline-compare.test.ts`（新規）・`tests/topic-notes.test.ts`（新規））、`README.md`
- 確認したこと: `npm test`（34ファイル・309件）・`npm run check`（0 errors）・`npm run build`（573ページ・約7秒）。トピックのページを Playwright で 390px・1280px × ライト・ダークで撮って見た（横のはみ出しなし・CLS 0）。AI 整理の表示は、テスト用の整理（コミットしない一時ファイル）を置いてビルドして確かめ、消してから作り直した。axe で12ページ（トップ・AI 要約・トピック4つ（AI 整理あり・なし）・急上昇・ランキング・about・編集方針・ジャンル・トレンド）× 390/1280 × ライト/ダークに違反なし（数字の欄の `<dl>` の中に `<p>`・`<details>` を置いていた違反を直した）。管理画面の「トピック整理」は Playwright で GitHub API をまねて、一覧・絞り込み・プロンプト（記事の ID と方針が入る）・クリップボードへのコピー・煽る言葉の回答を受け付けない・出典が1つの項目を外す・回答を変えたら確かめ直し・`data/topic-notes/2026-10.json` への保存とコミットの説明・整理済みの印・消す、を 1280px ライトと 390px ダークで確かめ、axe 違反なし・横のはみ出しなし・エラーなし。Bluesky のプロフィールは公開 API で説明とバナーが変わったことを確かめた。
- 残った課題・注意点: 「未解決の課題」の18（Phase 3〜4）・19（AI 整理を作る）・21（まとめ方の誤りの例）。AI 整理はまだ1件もない（運営者が作る）。見出しの比較は見出しだけを機械的に比べるので、記事の中身の違いは分からない（注意書きを出している）。

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
- 残った課題・注意点: 「未解決の課題」の6（トピックのまとめ方）・18（Phase 2〜4）・20（今日の数字の決め方）。Bluesky のバナーが前のコピーのままだった点は、次の記録（Phase 2）のときにそろえた。トピックのページの本格的な作り直し（なぜ話題？・タイムライン・推移・AI 整理）は Phase 2 で行う。

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
