# 収集元の利用条件の確認記録

収集元（`sources.yaml`）を登録する前に、各サイトの利用規約・RSS の利用条件・リンクポリシーを確認した結果です。
このサイトは広告を載せる予定（商用利用）なので、次のどれかに当たるサイトは**登録しません**。

- RSS・見出しの利用を「個人」「非営利」に限っている
- 営利目的のサイトからのリンクを自由なリンクの対象から外している、または事前の許可・契約・連絡が必要としている
- クローラーなどの自動的な取得や、まとめサイト・キュレーションサイトでの利用を禁じている

判定の見方:

| 判定 | 意味 |
| --- | --- |
| OK | RSS の利用を明示的に認めている、または RSS・リンクについての制限がなく、記事本文の無断転載を禁じる一般的な条項だけ |
| NG | 上の「登録しない」条件に当たる |
| 要確認 | 文言があいまい、または規約を確認できなかった（**登録しない**） |

- 掲載するのは見出し・約120字の抜粋・出典名・元記事へのリンクだけで、本文・画像は転載しません。
- 規約で記事の要約・改変・翻案を禁じているサイトは `summary: false`（管理画面の AI 要約の候補に出さない）、抜粋の掲載がはっきりしないサイトや、加工した場合にその旨の記載が必要な官公庁のサイトは `excerpt: false`（見出しとリンクだけ）にしています。
- **規約は変わることがあります。** 収益化の前（AdSense の申し込み前）と、その後も年に1回程度は運営者が見直してください。掲載停止の依頼があったら `sources.yaml` から削除します（次回の収集で、そのサイトの記事も一覧から消えます）。
- ここに書いた判定は、運営者が最終確認するための調査結果で、法的な助言ではありません。

確認日: 2026-10-06（根拠の文言は確認時点のもの）

## 記事のページの取得（本文の自動取得）について

収集は RSS が基本ですが、AI 要約を作るときにチャット AI が記事を開けなかった記事に限り、管理画面からの依頼で記事のページを1回だけ取得することがあります（`scripts/fetch-texts.ts`）。

- 通信はフィードの取得と同じブラウザ相当のヘッダーで行い、ボットの名前は名乗りません（2026-10-07 に運営者の判断で変更。名乗ると断られやすくなるため）。
- robots.txt でクローラー全般（`User-agent: *`）に断っているページ、主な AI のクローラー（GPTBot・ChatGPT-User・OAI-SearchBot・ClaudeBot・Claude-User・Claude-SearchBot・anthropic-ai・Google-Extended）を断っているページ、`noai` の指定（meta robots・X-Robots-Tag）があるページは取得しません。アクセスを拒否された（401・403・429・451・503）ら、再試行せずにやめます。
- 取得した本文は公開せず、運営者の公開鍵で暗号化して保管します。要約を作るためだけに使います。
- 管理画面に取得できなかった理由が出ます。サイトが断っている掲載元の記事を要約したいときは、その掲載元の扱いを見直してください（同じ話題の別の掲載元の記事に切り替える、要約しない `summary: false` にする、など）。
- 2026-10-06 に試した結果: カラパイア・GIGAZINE・4Gamer.net は取得できた。首相官邸・政府広報オンラインの試した記事は動画だけのページで、本文がなかった（AI が `unavailable` を返すのもこのため）。

## 登録しているサイト（66件）

| サイト | カテゴリ | 判定の根拠 | 設定・条件 |
| --- | --- | --- | --- |
| FNNプライムオンライン | ニュース | RSS・リンクの制限なし。著作権の一般条項のみ（[about](https://www.fnn.jp/list/about)） | `limit: 10`（1日に数百件を配信するため） |
| 文春オンライン | ニュース | 「当ウェブサイトへのリンクは原則自由です」（[サイトポリシー](https://bunshun.jp/list/sitepolicy)） | |
| デイリー新潮 | ニュース | 「『デイリー新潮』はリンクフリーです。…事前のご連絡は不要です」（[著作権](https://www.dailyshincho.jp/copyright/)） | |
| AERA DIGITAL | ニュース | RSS のページは購読の案内だけで制限なし（[RSS](https://dot.asahi.com/list/rss)） | `summary: false`（「記事を要約して利用することも、原則として著作権者の許諾が必要」） |
| 日刊SPA! | ニュース | RSS・リンクの規定なし、無断転載禁止の一般条項（[著作権](https://nikkan-spa.jp/copyright)） | `summary: false`（出版物の要約の掲載も禁止） |
| 首相官邸 | ニュース | 公共データ利用規約（PDL1.0）で商用利用可（[利用規約](https://www.kantei.go.jp/jp/terms.html)） | `excerpt: false`（加工した場合はその旨の記載が必要なため見出しとリンクだけ）。出典として名称を表示 |
| 外務省 海外安全ホームページ | ニュース | PDL1.0、リンクは自由（[法的事項](https://www.anzen.mofa.go.jp/c_info/legalmatters.html)） | `excerpt: false`。出典として名称を表示 |
| PRESIDENT Online | 経済 | 「PRESIDENT Onlineへのリンクは自由です」（[about](https://president.jp/list/about)） | |
| Business Journal | 経済 | RSS・リンクの規定なし、一般条項（[規約](https://biz-journal.jp/rule)） | |
| 財経新聞 | 経済 | RSS のページで「どうぞご利用下さい」、出典明記のリンク・一部引用は連絡不要（[RSS](https://www.zaikei.co.jp/rss/)、[記事使用](https://corp.zaikei.co.jp/advertising/article-use-rule/)） | 媒体名を表示 |
| MarkeZine | 経済 | RSS のページで「どなたでも無料でご利用可能」（[RSS](https://markezine.jp/help/rss)） | `summary: false`（生成 AI で創作的表現が感得できるものを作ることを禁止） |
| GIGAZINE | テクノロジー | サイト本体に利用規約・RSS の制限なし | |
| Publickey | テクノロジー | 利用規約・RSS の規定なし | |
| Impress Watch・PC Watch・ケータイ Watch・AV Watch・INTERNET Watch・窓の杜・GAME Watch・Car Watch・トラベル Watch・家電 Watch・Think IT（インプレス） | テクノロジー ほか | リンクは「連絡することなく自由に」、無断転載禁止の一般条項（[サイトポリシー](https://www.impress.co.jp/sitepolicy.html)） | |
| ASCII.jp | テクノロジー | RSS のページに制限なし、「トップページへのリンクは、自由に設定できます」（[サイトポリシー](https://ascii.jp/info/site_policy.html)） | `limit: 8`（1日に数百件を配信するため） |
| gihyo.jp | テクノロジー | RSS のページで「自分のサイトに他サイトのRSSを取り込んだりして使用します」と案内（[案内](https://gihyo.jp/about/information)） | |
| CodeZine | テクノロジー | RSS のページで「どなたでも無料でご利用可能」（[RSS](https://codezine.jp/help/rss)） | `summary: false`（翔泳社の生成 AI の条項） |
| DevelopersIO | テクノロジー | 利用規約・RSS の規定なし | |
| Security NEXT | テクノロジー | RSS の規定なし。ただし「許可なく引用、転載…を堅く禁止」（[著作権](https://www.security-next.com/copyright)） | `excerpt: false`・`summary: false` |
| デジタル庁 | テクノロジー | PDL1.0（[著作権](https://www.digital.go.jp/copyright-policy)） | `excerpt: false`。出典として名称を表示 |
| Zenn | テクノロジー | 一般的な無断転載禁止の条項のみ（[規約](https://zenn.dev/terms)） | |
| Qiita | テクノロジー | 一般的な条項のみ（[規約](https://qiita.com/terms)） | |
| ナゾロジー | サイエンス | 「自由にリンクを行うことが可能です」（[ガイドライン](https://nazology.kusuguru.co.jp/guideline)） | サイト名と記事へのリンクを表示 |
| カラパイア | サイエンス | 「URLリンクは原則的に自由です」（[規約](https://karapaia.com/terms)） | |
| JAXA | サイエンス | リンクは基本的に自由、一般条項（[サイトポリシー](https://www.jaxa.jp/policy_j.html)） | 出典として名称を表示 |
| 国立天文台 | サイエンス | ウェブサイトでの情報発信（「ページ内の広告の有無は問いません」）は自由に利用可（[著作権](https://www.nao.ac.jp/terms/copyright.html)） | クレジットとして名称を表示 |
| 理化学研究所 | サイエンス | リンクは理研へのリンクと明記すれば自由、一般条項（[利用規約](https://www.riken.jp/terms/)） | |
| Science Portal（科学技術振興機構） | サイエンス | リンクは許可不要。抜粋の扱いがはっきりしない（[サイトポリシー](https://scienceportal.jst.go.jp/site_policy/)） | `excerpt: false`・`summary: false` |
| シネマトゥデイ | エンタメ | 一般的な著作権の条項のみ（[規約](https://www.cinematoday.jp/pub/terms)） | |
| Real Sound | エンタメ | 利用規約なし | |
| ENCOUNT | エンタメ | 一般条項のみ（[サイトポリシー](https://encount.press/sitepolicy/)） | `summary: false`（改編・翻案の禁止） |
| ガジェット通信 | エンタメ | 「クレジット表示を入れていただくことでご利用いただけます」（[about](https://getnews.jp/about)） | 名称を表示 |
| ロケットニュース24 | エンタメ | RSS の制限なし、一般条項（[規約](https://rocketnews24.com/terms/)） | |
| デイリーポータルZ | エンタメ | 利用規約なし | |
| Pouch［ポーチ］ | ライフ | ロケットニュース24 と同じ運営会社の規約（[規約](https://youpouch.com/terms/)） | |
| 4Gamer.net | ゲーム・アニメ | RSS のページで「営利目的のサービス内…で利用していただいても問題ありません」（[RSS](https://www.4gamer.net/rss/rss.shtml)） | 営利で使う場合は事後の一報を歓迎とのこと |
| AUTOMATON | ゲーム・アニメ | 「本ウェブサイトへのリンクは原則としてすべて自由です」（[規約](https://automaton-media.com/terms-of-use/)） | `summary: false`（内容の改変を一切認めない） |
| 電ファミニコゲーマー | ゲーム・アニメ | 利用規約なし | |
| KAI-YOU | ゲーム・アニメ | コンテンツポリシーの一般条項のみ（[ポリシー](https://kai-you.net/contents_policy)） | |
| マグミクス | ゲーム・アニメ | 「無断転用・複製を禁止します」のみ（[about](https://magmix.jp/about)） | |
| おたくま経済新聞 | ゲーム・アニメ | 「リンクについては自由です。事前の連絡は必要ございません」（[about](https://otakuma.net/about)） | 出典元へのリンクを明記 |
| FOOTBALL ZONE・Full-Count・THE ANSWER（Creative2） | スポーツ | 一般条項のみ（[Full-Count](https://full-count.jp/sitepolicy/)） | |
| Qoly | スポーツ | 利用規約なし | |
| ベースボールチャンネル | スポーツ | 「許可無く転載することを固く禁じます」のみ（[about](https://www.baseballchannel.jp/about/)） | |
| THE DIGEST | スポーツ | 「当ウェブサイトへのリンクは原則自由です」（[サイトポリシー](https://thedigestweb.com/sitepolicy/)） | |
| AUTOSPORT web | スポーツ | 一般条項のみ（[規約](https://www.as-web.jp/rules)） | |
| くるまのニュース・VAGUE・バイクのニュース・Merkmal（メディア・ヴァーグ） | 乗り物 | 「無断転用・複製を禁止します」のみ（[くるまのニュース](https://kuruma-news.jp/about)） | |
| WEB CARTOP | 乗り物 | 一般条項のみ（[規約](https://www.webcartop.jp/terms/)） | |
| 鉄道ファン railf.jp | 乗り物 | 「リンク設定は…どのページからも可能です」（[サイトについて](https://railf.jp/about_site/)） | リンクしたら一報を歓迎とのこと |
| 政府広報オンライン | ライフ | 公共データ利用規約（[利用規約](https://www.gov-online.go.jp/tos/)） | `excerpt: false`。出典として名称を表示 |
| 消費者庁 | ライフ | PDL1.0（[利用規約](https://www.caa.go.jp/terms_of_use/)） | `excerpt: false`。出典として名称を表示 |

## 登録を見送ったサイト

### 以前は登録していたが、確認の結果外したサイト

| サイト | 判定 | 理由（規約の該当箇所） |
| --- | --- | --- |
| ITmedia | NG | 利用規約7条で「営利を目的としたものである場合」は自由にリンクできない。RSS 利用条件で「RSSの一部削除等の改変」を禁止（[利用規約](https://www.itmedia.co.jp/info/rule/)、[RSS 利用条件](https://corp.itmedia.co.jp/media/rss_condition/)） |
| ライフハッカー・ジャパン | NG | 「入手したいかなる情報も…私的利用の範囲を超えて使用することができない」、リンクの禁止に「営利を目的としたものである場合」（[利用規約](https://www.mediagene.co.jp/info/lifehacker_kiyaku/)） |
| BBCニュース 日本語版 | NG | 「For business use of our RSS feeds you'll need to get our permission」（[BBC 利用規約](https://www.bbc.co.uk/usingthebbc/terms-of-use/)） |
| 東洋経済オンライン | NG | リンクは「営利や勧誘を目的としないご利用であること」と事前の連絡が条件。クローラー等による収集を禁止（[リンク](https://toyokeizai.net/sp/about-service/contents/)、[利用規約](https://toyokeizai.net/list/base-terms)） |
| ゲキサカ | NG | 「当社ウェブサイトまたは本サービスを営利目的のために利用する行為」を禁止（[利用規約](https://web.gekisaka.jp/agreement)） |
| ハフポスト日本版 | 要確認 | 明示的に許可された場合を除き、コンテンツの「データベースへの組み込み、表示…その他の方法で利用することはできません」（[利用規約](https://www.huffingtonpost.jp/static/huffingtonpostjp-terms-and-conditions)） |
| J-CASTニュース | 要確認 | 「記事、見出し…」をコンテンツとし、事前の承諾なしの転載・公衆送信等を禁止（[規約](https://www.j-cast.com/etc/kiyaku.html)） |
| はてなブックマーク（ホットエントリー8カテゴリ）とブックマーク数の API | NG | ホットエントリーの RSS とブックマーク数の API（`bookmark.hatenaapis.com/count/entries`）は Hatena Developer Center の提供物で、[利用規約](https://developer.hatena.ne.jp/license/)が「宣伝や商用を目的とした内容。ただし当社が特別に許諾を行った場合を除きます」の利用を認めていない。広告を載せるサイトでは使えないため、2026-10-06 に収集元とブックマーク数の取得（はてブ数のランキング・「users」の表示）をやめた。人気の目安は、同じ出来事を報じた掲載元の数（「N社が報道」）に置き換えた |

### 今回の候補で見送ったサイト

| サイト | 判定 | 理由 |
| --- | --- | --- |
| TBS NEWS DIG | NG | 自由なリンクの対象から「本サイトへのリンク設定を営利目的とするサイト」を除外 |
| ニッポン放送 NEWS ONLINE | NG | 私的利用のためだけに提供、リンクには連絡が必要 |
| 現代ビジネス | NG | 営利目的での利用と、クローラー等による収集を禁止 |
| 沖縄タイムス | NG | 営利目的のリンク共有は許諾の申請が必要 |
| CNN.co.jp | 要確認 | 商業的な利用は CNN の明示の許可が必要 |
| NewSphere | NG | 営利を目的とする場合はリンク不可 |
| ハンギョレ日本語版 | NG | 自動化ツールによる収集・活用は非営利でも事前の同意が必要 |
| 聯合ニュース 日本語版 | NG | 営利・非営利の情報サービスは書面の事前承諾が必要 |
| AFPBB News | NG | RSS は個人・非営利目的に限る |
| JETRO ビジネス短信 | NG | 記事タイトルの定期的な掲載も事前の許諾が必要 |
| WEDGE Infinity | NG | 商業的な利用は事前の話し合いが必要 |
| ASEAN PORTAL | NG | 私的使用の範囲を超える利用は不可 |
| Global News View | NG | CC BY-NC-SA（非営利のみ） |
| Global Voices 日本語 | 見送り | CC BY 3.0 で利用可だが、著者名・翻訳者名の表示が必要（表示する仕組みがない） |
| Arab News Japan | 要確認 | 日本版の規約が読めず、発行元の規約は商用利用に書面の許可が必要 |
| Business Insider Japan・ギズモード・ジャパン・ROOMIE（メディアジーン） | NG | 私的利用の範囲を超える使用の禁止、営利目的のリンクの禁止 |
| JBpress | NG | 商業的な利用は事前の話し合いが必要 |
| ダイヤモンド・オンライン | NG | 営利目的のリンクは対象外、クローリングを禁止 |
| ZUU online | NG | 営利目的での利用を禁止 |
| マイナビニュース | NG | 営利目的での RSS の利用は事前の相談が必要 |
| iPhone Mania | NG | 私的利用の範囲を超える使用の禁止、営利目的のリンクの禁止 |
| BRIDGE | 要確認 | 「本サービスを商業目的で使用する行為」を禁止 |
| WIRED.jp | 要確認 | 会員向け以外の規約が見つからず、運営会社の規約は家庭内での使用以外の複製を禁止 |
| GetNavi web | 見送り | リンク・サイト名の掲載には運営会社への連絡が必要 |
| イードのメディア（RBB TODAY・レスポンス・Game*Spark・インサイド・アニメ！アニメ！・ScanNetSecurity） | NG | 「記事・見出し…の無断転載を禁じます」、私的利用の範囲内でのみ利用可 |
| モデルプレス | NG | RSS の営利目的での利用を禁止、まとめサイト等での引用も禁止 |
| IGN Japan | 要確認 | 運営会社の規約が私的利用限定の方向 |
| PlayStation.Blog | 要確認 | 営利を目的とする行為を禁止 |
| 大学ジャーナル | NG | 非営利かつ利用者自身で利用する場合に限る |
| sorae | 要確認 | 他のホームページへの転用・要約は許諾が必要 |
| アニメハック（映画.com） | NG | 営利を目的とした行為への利用を禁止 |
| GDO ゴルフニュース | NG | 私的かつ非営利目的に限る |
| 女性自身・Smart FLASH（光文社） | NG | リンクは営利を目的としない場合に限り、事前の連絡が必要 |
| リスアニ！WEB | 見送り | サイト独自の規約がなく、運営会社の規約は営利目的の行為を禁止 |
| gamebiz | NG | 商用利用のリンクは自由なリンクの対象外 |
| サッカーキング・BASEBALL KING・バスケットボールキング・バレーボールキング | 要確認 | 運営会社の規約で、事前の承諾なく自動化された手段で取得することを禁止 |
| motorsport.com 日本版 | NG | 広告収入目的の利用は書面の許可が必要 |
| フットボールチャンネル | NG | ニュースサイト等での一部引用も禁止（無断掲載は有料） |
| ラグビーリパブリック | 要確認 | 営利を目的とする行為の禁止 |
| Aviation Wire | NG | 営利目的の利用は有料会員のみ |
| ESSE online | 要確認 | 規約を確認できなかった |
| TRAICY | 要確認 | 営利目的の行為の禁止、無断使用に高額の賠償の条項 |
| ベストカーWeb | 要確認 | コンテンツの利用についての規約が見つからない |
| AUTOCAR JAPAN | 見送り | 規約上は問題ないが、robots.txt でフィードの自動取得を拒否している |
| NHK・Yahoo!ニュース | NG | RSS は個人・非営利目的に限る（最初の構築時に確認） |
