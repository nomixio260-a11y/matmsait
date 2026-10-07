/**
 * タグ（ジャンルをまたいだ話題のまとまり）。見出しや AI 要約のキーワードが pattern に当てはまる記事を、タグのページ（/tag/<slug>/）に集める。
 * タグを増やすときは、実際の見出しで当てはまり方を確かめてから足す（広すぎると関係ない記事が混ざる）
 */
export interface TagDefinition {
  slug: string;
  /** 表示名（短く） */
  name: string;
  /** ページの見出し（検索されやすい言葉を入れる） */
  title: string;
  /** ページの説明文（検索結果にも表示される） */
  description: string;
  /** 見出し・キーワード（NFKC で正規化したもの）に当てはまれば、このタグの記事とみなす */
  pattern: RegExp;
  /** 当てはまる記事を探すジャンル（指定しなければすべて） */
  categories?: string[];
  /** 注目ワードの候補にする言葉 */
  words: string[];
  /** SNS の投稿に付けるハッシュタグ（# なし。よく使われているものを1〜2個） */
  hashtags: string[];
}

/** 英字の単語として現れたときだけ当てはめる（「MAIL」の「AI」などを避ける） */
const word = (source: string) => `(?<![A-Za-z])(?:${source})(?![A-Za-z])`;

export const tags: TagDefinition[] = [
  {
    slug: 'ai',
    name: 'AI',
    title: 'AIニュースランキング・生成AIの最新ニュース',
    description:
      '生成AI・ChatGPT・Gemini・Claude など、AI（人工知能）の最新ニュースを、多くのメディアが報じた順のランキングと新着でまとめています。',
    pattern: new RegExp(
      `生成AI|人工知能|大規模言語モデル|機械学習|ディープラーニング|AIエージェント|${word(
        'AI|ChatGPT|OpenAI|Gemini|Claude|Anthropic|Copilot|LLM|GPT-?\\d[\\w.-]*|Grok|xAI|Llama|Mistral|Perplexity|DeepSeek|Qwen|Midjourney|Stable Diffusion|NotebookLM',
      )}`,
      'i',
    ),
    words: ['生成AI', 'ChatGPT', 'OpenAI', 'Gemini', 'Claude', 'Anthropic', 'Copilot', 'AIエージェント', 'DeepSeek'],
    hashtags: ['AI', '生成AI'],
  },
  {
    slug: 'apple',
    name: 'Apple・iPhone',
    title: 'Apple・iPhoneの最新ニュース',
    description: 'iPhone・iPad・Mac・Apple Watch・AirPods など、Apple（アップル）の新製品やサービスの最新ニュースまとめ。',
    pattern: new RegExp(`アップル|${word('Apple|iPhone|iPad|MacBook|iMac|Mac mini|Mac Studio|AirPods|Apple Watch|iOS|iPadOS|macOS|visionOS|Vision Pro')}`),
    categories: ['tech', 'economy', 'life', 'game'],
    words: ['iPhone', 'iPad', 'MacBook', 'AirPods', 'Apple Watch', 'iOS'],
    hashtags: ['Apple', 'iPhone'],
  },
  {
    slug: 'google',
    name: 'Google',
    title: 'Google（グーグル）の最新ニュース',
    description: 'Google の検索・Android・Pixel・Chrome・Gemini など、グーグルの製品とサービスの最新ニュースまとめ。',
    pattern: new RegExp(`グーグル|${word('Google|Android|Pixel|Chrome|Chromebook|Gmail|Gemini')}`),
    // 政治・芸能の記事の「YouTube で公開」などを拾わないよう、ジャンルを絞る
    categories: ['tech', 'economy', 'life', 'game'],
    words: ['Google', 'グーグル', 'Android', 'Pixel', 'Chrome'],
    hashtags: ['Google'],
  },
  {
    slug: 'microsoft',
    name: 'Microsoft',
    title: 'Microsoft・Windowsの最新ニュース',
    description: 'Windows・Office・Xbox・Copilot など、Microsoft（マイクロソフト）の最新ニュースまとめ。',
    pattern: new RegExp(`マイクロソフト|${word('Microsoft|Windows|Xbox|Microsoft 365')}`),
    categories: ['tech', 'economy', 'game'],
    words: ['Microsoft', 'マイクロソフト', 'Windows', 'Xbox'],
    hashtags: ['Microsoft'],
  },
  {
    slug: 'nintendo',
    name: '任天堂',
    title: '任天堂・Nintendo Switchの最新ニュース',
    description: 'Nintendo Switch 2 などのゲーム機や新作ソフト、任天堂の最新ニュースまとめ。',
    pattern: new RegExp(`任天堂|ニンテンドー|${word('Nintendo|Switch ?2')}`),
    words: ['任天堂', 'Nintendo Switch 2', 'Switch 2'],
    hashtags: ['任天堂', 'NintendoSwitch2'],
  },
  {
    slug: 'playstation',
    name: 'PlayStation',
    title: 'PlayStation（PS5）の最新ニュース',
    description: 'PS5 などの PlayStation のゲーム機・新作ソフト・サービスの最新ニュースまとめ。',
    pattern: new RegExp(`プレイステーション|プレステ|${word('PlayStation|PS5|PS4|PS Plus')}`),
    // 野球の「PS（ポストシーズン）5連勝」などを拾わないよう、スポーツは除く
    categories: ['game', 'tech', 'economy', 'entertainment', 'life'],
    words: ['PlayStation', 'PS5', 'PS Plus'],
    hashtags: ['PS5'],
  },
  {
    slug: 'mlb',
    name: 'MLB・大谷翔平',
    title: '大谷翔平・MLB（メジャーリーグ）の最新ニュース',
    description: '大谷翔平・山本由伸・ドジャースなど、MLB（メジャーリーグ）と日本人選手の最新ニュースまとめ。',
    pattern: new RegExp(`大谷翔平|山本由伸|佐々木朗希|ドジャース|メジャーリーグ|ワールドシリーズ|${word('MLB')}`),
    categories: ['sports', 'news', 'entertainment'],
    words: ['大谷翔平', '山本由伸', '佐々木朗希', 'ドジャース', 'MLB'],
    hashtags: ['MLB', '大谷翔平'],
  },
  {
    slug: 'security',
    name: 'セキュリティ',
    title: 'サイバー攻撃・情報漏えい・セキュリティの最新ニュース',
    description: '不正アクセス・ランサムウェア・情報漏えい・脆弱性など、サイバーセキュリティの最新ニュースまとめ。',
    pattern: /不正アクセス|サイバー攻撃|ランサムウェア|脆弱性|情報漏えい|情報漏洩|個人情報.{0,6}(?:流出|漏えい|漏洩)|フィッシング|マルウェア|サイバーセキュリティ/,
    words: ['不正アクセス', 'ランサムウェア', '脆弱性', 'サイバー攻撃'],
    hashtags: ['セキュリティ'],
  },
  {
    slug: 'semiconductor',
    name: '半導体',
    title: '半導体・CPU・GPUの最新ニュース',
    description: 'TSMC・NVIDIA・Intel・AMD・Rapidus など、半導体とチップ（CPU・GPU）の最新ニュースまとめ。',
    pattern: new RegExp(`半導体|エヌビディア|ラピダス|インテル|クアルコム|${word('TSMC|NVIDIA|GeForce|Rapidus|Intel|AMD|Ryzen|Radeon|Qualcomm|Snapdragon')}`),
    categories: ['tech', 'economy', 'game', 'news'],
    words: ['半導体', 'NVIDIA', 'TSMC', 'Ryzen', 'GeForce', 'Snapdragon'],
    hashtags: ['半導体'],
  },
  {
    slug: 'ev',
    name: 'EV・自動運転',
    title: 'EV（電気自動車）・自動運転の最新ニュース',
    description: 'EV（電気自動車）・自動運転・充電インフラなど、次世代のクルマの最新ニュースまとめ。',
    pattern: new RegExp(`電気自動車|自動運転|テスラ|${word('EV|BEV|PHEV|Tesla|BYD')}`),
    categories: ['mobility', 'tech', 'economy', 'news'],
    words: ['EV', '電気自動車', '自動運転', 'テスラ', 'BYD'],
    hashtags: ['EV'],
  },
  {
    slug: 'disaster',
    name: '地震・災害',
    title: '地震・台風・大雨など災害の最新ニュース',
    description: '地震・津波・台風・大雨・噴火など、災害と防災の最新ニュースまとめ。',
    pattern: /地震|津波|台風|大雨|豪雨|線状降水帯|噴火|土砂災害|洪水|大雪|暴風|避難指示|緊急地震速報|防災/,
    categories: ['news', 'life', 'science', 'mobility'],
    words: ['地震', '津波', '台風', '大雨', '線状降水帯', '噴火'],
    hashtags: ['防災'],
  },
  {
    slug: 'politics',
    name: '政治',
    title: '政治・選挙の最新ニュース',
    description: '首相・内閣・国会・選挙・各政党の動きなど、日本の政治の最新ニュースまとめ。',
    pattern: /首相|総理|内閣|国会|衆院|参院|衆議院|参議院|総選挙|選挙|自民党|立憲|公明党|維新|国民民主|政権|与党|野党|官房長官|大臣/,
    categories: ['news', 'economy'],
    words: ['高市総理', '首相', '国会', '総選挙', '自民党'],
    hashtags: ['政治'],
  },
  {
    slug: 'market',
    name: '株価・為替',
    title: '株価・為替（円安・円高）の最新ニュース',
    description: '日経平均株価・円相場・金利・日銀の金融政策など、マーケットとお金の最新ニュースまとめ。',
    pattern: new RegExp(`株価|日経平均|円安|円高|円相場|為替|金利|日銀|利上げ|利下げ|${word('NISA|iDeCo')}`),
    categories: ['economy', 'news', 'life'],
    words: ['日経平均', '円安', '円高', '日銀', '利上げ', 'NISA'],
    hashtags: ['株価', '為替'],
  },
];

export function getTag(slug: string): TagDefinition | undefined {
  return tags.find((tag) => tag.slug === slug);
}
