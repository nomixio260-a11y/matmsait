/**
 * 記事のページ（HTML）から本文を取り出す（本文の自動取得・AI の自動要約で使う。管理画面のブックマークレットと同じ考え方）。
 *
 * 本文の候補をいくつかの方法で作り、いちばん本文らしいものを選ぶ:
 * - 構造化データ（JSON-LD の articleBody）
 * - ページに埋め込まれたデータ（Next.js の __NEXT_DATA__ などの、本文の HTML・文章）
 * - 本文の目印（itemprop="articleBody"）
 * - リンクでない文（「。」などで終わる文字）がいちばん多いまとまり
 * どの候補も、メニュー・関連記事・ランキング・共有ボタン・コメント・写真の説明・ダイアログ・リンクばかりのまとまりを除き、
 * 見出しより前（サイト名・メニュー）と、最後のフッター・著作権表示などの行を落としてから比べる。
 *
 * あわせて、記事の続き（「全文を読む」の先・2ページ目以降・AMP 版・WordPress の記事の API）や、
 * 本文がなく記事本体のページへリンクしているだけのページの、リンク先を見つけて返す（取りに行くのは text-fetcher.ts）
 */
import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

/** 本文とは関係ない部分 */
const JUNK = 'script,style,noscript,template,title,iframe,video,audio,canvas,svg,button,select,figure,nav,aside,footer,dialog';
/** 本文とは関係ないことが多い部分（ただし、ページの文の大半を含むまとまりは消さない） */
const SKIP =
  'form,[hidden],[aria-hidden="true"],[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="popup"],[class*="share"],[class*="related"],[class*="ranking"],[class*="recommend"],[class*="banner"],[class*="breadcrumb"],[class*="sns"],[class*="comment"],[id*="comment"],[class*="pagination"],[class*="pager"],[class*="social"],[id*="social"],[id*="share"],[id*="sns"]';
/** 文字を数えるまとまり */
const CONTAINERS = new Set(['ARTICLE', 'MAIN', 'SECTION', 'DIV', 'TD', 'BODY']);
/** これより短ければ本文が取れなかったとみなす */
export const MIN_TEXT_LENGTH = 200;

/** 本文の取り出し方 */
export type ExtractMethod = 'jsonld' | 'embedded' | 'marked' | 'densest';

/** 記事の続きなどの、たどれるリンク（すべて同じサイトの URL） */
export interface ArticleLinks {
  /** 「全文を読む」「続きを読む」の先（同じ記事の全文のページ） */
  more?: string;
  /** 2ページ目以降（ページ番号の順） */
  pages: string[];
  /** AMP 版（本文をスクリプトで出すページでも、AMP 版には本文があることが多い） */
  amp?: string;
  /** WordPress の記事の API（ページには途中までしかなくても、API には全文がある） */
  wpJson?: string;
  /** 本文がなく、記事本体のページへのリンクだけがあるページの、そのリンク（見出しと同じ文字のリンク） */
  stub?: string;
}

export interface ExtractedArticle {
  title: string;
  text: string;
  /** ページの meta robots の値（noai などの確認用） */
  robots: string[];
  method: ExtractMethod;
  links: ArticleLinks;
  /** 動画・画像が中心のページか（本文が短いときの理由の説明に使う） */
  media?: 'video' | 'images';
}

export interface ExtractOptions {
  /** ページの URL（リンクを見つけるため） */
  url?: string;
  /** 記事の最初のページの URL（2ページ目以降を取り出すときに、何ページ目かを数える基準。なければ url） */
  articleUrl?: string;
  /** 記事の見出し（フィードの見出し。なければページの見出しを使う） */
  title?: string;
}

const clean = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/[ \t 　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function extractArticleText(html: string, options: ExtractOptions = {}): ExtractedArticle {
  const root = parse(html, { comment: false });
  const base = safeUrl(options.url);
  const robots = root
    .querySelectorAll('meta[name="robots"], meta[name="ROBOTS"]')
    .map((meta) => meta.getAttribute('content') ?? '');
  const h1 = root.querySelector('h1');
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
  const title = clean(h1?.text ?? '') || clean(ogTitle) || clean(root.querySelector('title')?.text ?? '');
  const reference = options.title?.trim() || title;

  // スクリプトを消す前に、構造化データ・埋め込みデータの本文と、記事の続きへのリンクを読む
  const jsonLd = jsonLdBody(root);
  const embedded = embeddedBody(root);
  const links: ArticleLinks = { pages: base ? pageLinks(root, base, safeUrl(options.articleUrl) ?? base) : [] };
  if (base) {
    links.more = readMoreLink(root, base);
    links.amp = sameSite(root.querySelector('link[rel="amphtml"]')?.getAttribute('href'), base);
    const wp = root
      .querySelectorAll('link[rel="alternate"][type="application/json"]')
      .map((link) => link.getAttribute('href') ?? '')
      .find((href) => /\/wp-json\/wp\/v2\/(?:posts|pages)\/\d+/.test(href));
    links.wpJson = sameSite(wp, base);
  }
  const media = mediaOf(root);

  for (const element of root.querySelectorAll(JUNK)) element.remove();
  // 見出し・本文の目印を含むまとまり、html・body・main、ページの文の大半を含むまとまりは、クラス名などが当てはまっても消さない
  // （<body class="news breadcrumb">・<div class="hidden_share post"> のように、ページや記事全体のクラス名に「breadcrumb」「share」などが入っているサイトや、
  // ページ全体を form で囲むサイトがある）
  const marked = root.querySelector('[itemprop="articleBody"]');
  const keep = new Set<Node>();
  for (const anchor of [h1, marked]) {
    for (let node: Node | null = anchor; node; node = node.parentNode) keep.add(node);
  }
  const sentences = sentenceLength(root);
  const protectedFrom = (element: HTMLElement) =>
    keep.has(element) || ['HTML', 'BODY', 'MAIN'].includes(element.tagName) || (sentences > 0 && sentenceLength(element) >= sentences * 0.5);
  for (const element of root.querySelectorAll(SKIP)) {
    if (!protectedFrom(element)) element.remove();
  }
  // リンクばかりのまとまり（記事の中の関連記事・タグ・ページ送り・メニューなど）も消す
  for (const element of root.querySelectorAll('ul,ol,dl,div,section,p,table')) {
    if (element.parentNode && !protectedFrom(element) && linkHeavy(element)) element.remove();
  }
  // 別のページへのリンクだけの段落（写真のページ・関連記事・「次ページ：〜」の案内など）も消す
  for (const element of root.querySelectorAll('p,li,dd,dt,figcaption,div')) {
    if (element.parentNode && !protectedFrom(element) && linkOnly(element, reference)) element.remove();
  }

  const candidates: { method: ExtractMethod; text: string }[] = [];
  if (jsonLd) candidates.push({ method: 'jsonld', text: jsonLd });
  if (embedded) candidates.push({ method: 'embedded', text: embedded });
  if (marked && clean(marked.structuredText).length >= 100) candidates.push({ method: 'marked', text: clean(marked.structuredText) });
  // タグの閉じ忘れなどで本文が body の外に置かれるページもあるので、body に限らずページ全体から探す
  const page = root.querySelector('html') ?? root;
  const container = densest(page);
  candidates.push({ method: 'densest', text: clean(container.structuredText) });

  // 選び方: サイトが付けた本文の目印は、文字の多いまとまりの半分以上の本文らしさがあれば優先する（目印の中が本文そのもの）。
  // 構造化データ・埋め込みデータは、ページから取ったものより明らかに本文らしいとき（本文をスクリプトで出すページなど）だけ使う
  //（記事の最初の段落だけを入れているサイトもあるため）
  const scored = candidates.map((candidate) => {
    const text = cleanArticleText(candidate.text, reference);
    return { method: candidate.method, text, score: textScore(text, reference) };
  });
  let best = scored.find((candidate) => candidate.method === 'densest')!;
  const markedCandidate = scored.find((candidate) => candidate.method === 'marked');
  if (markedCandidate && markedCandidate.score >= best.score * 0.5) best = markedCandidate;
  for (const candidate of scored) {
    if ((candidate.method === 'jsonld' || candidate.method === 'embedded') && candidate.score > best.score * 1.2 && candidate.score > 0) best = candidate;
  }
  // 本文がほとんどなく、見出しと同じ文字のリンク（記事本体のページへのリンク）があれば、それを返す
  if (base && Array.from(best.text).length < MIN_TEXT_LENGTH) links.stub = stubLink(page, base, reference);
  return { title, text: best.text, robots, method: best.method, links, ...(media ? { media } : {}) };
}

// ===== 本文らしさ =====

/** 文の終わり（本文の文章にはあり、見出しの一覧やラベルにはふつうない。「．」で文を終えるサイトもある） */
const SENTENCE = /[。．！？!?]/;

/** 文（「。」などを含む文字）の文字数。リンクの中は数えない */
function sentenceLength(node: Node, inLink = false): number {
  let sum = 0;
  for (const child of node.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      const text = child.text.trim();
      if (!inLink && SENTENCE.test(text)) sum += text.length;
    } else if (child instanceof HTMLElement) {
      sum += sentenceLength(child, inLink || child.tagName === 'A');
    }
  }
  return sum;
}

/** リンクの文字が大半のまとまり（リンクが3つ以上で、文字の7割以上がリンク） */
function linkHeavy(element: HTMLElement): boolean {
  const anchors = element.querySelectorAll('a');
  if (anchors.length < 3) return false;
  const total = element.text.replace(/\s+/g, '').length;
  if (total === 0) return true;
  const linked = anchors.reduce((sum, anchor) => sum + anchor.text.replace(/\s+/g, '').length, 0);
  return linked / total >= 0.7;
}

/**
 * 文字がすべて別のページへのリンクの中にある、短いまとまり（「。」で終わる文や100字以上の文章は本文かもしれないので除く。
 * 見出しと同じ文字のリンクは、本文がなく記事本体へリンクしているだけのページの手がかりなので残す）
 */
function linkOnly(element: HTMLElement, title: string): boolean {
  const anchors = element.querySelectorAll('a[href]').filter((anchor) => !(anchor.getAttribute('href') ?? '').trim().startsWith('#'));
  if (anchors.length === 0) return false;
  const text = element.text.replace(/\s+/g, '');
  if (text.length === 0 || text.length >= 100 || /[。．]$/.test(text)) return false;
  const linked = anchors.reduce((sum, anchor) => sum + anchor.text.replace(/\s+/g, '').length, 0);
  if (linked < text.length) return false;
  return !(title && titleOverlap(title, text) >= 0.7 && titleOverlap(text, title) >= 0.7);
}

/** 見出しの2文字ずつの組のうち、本文に出てくる割合（取り出した本文が見出しの記事のものか） */
export function titleOverlap(title: string, text: string): number {
  const pairs = (value: string) => {
    const chars = Array.from(value.replace(/\s+/g, ''));
    const set = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
    return set;
  };
  const a = pairs(title);
  if (a.size === 0) return 1;
  const b = pairs(text);
  return [...a].filter((pair) => b.has(pair)).length / a.size;
}

/** 本文らしさの点（文の文字が多いほど高く、余計な行が多い・見出しと関係ない文字なら低い） */
function textScore(text: string, title: string): number {
  const lines = text.split('\n').filter(Boolean);
  const sentence = lines.filter((line) => SENTENCE.test(line)).reduce((sum, line) => sum + Array.from(line).length, 0);
  const junk = lines.filter((line) => line.length <= 60 && JUNK_LINE.test(line)).length;
  const overlap = title ? titleOverlap(title, text) : 1;
  return sentence * (overlap >= 0.3 ? 1 : 0.4 + overlap * 2) - junk * 40;
}

// ===== 前後の余計な行を落とす =====

/** 本文の前後に出やすい、サイトの案内・メニュー・共有・著作権表示などの行 */
const JUNK_LINE =
  /©|\(c\)|copyright|all rights reserved|reserved\.|無断転載|無断転用|無断複製|利用規約|プライバシー|個人情報|お問い?合わ?せ|運営会社|会社概要|採用情報|サイトマップ|広告掲載|トップ(ページ)?(に|へ)(戻る)?|記事に戻る|ランキング|アーカイブ|follow @|tweets by|フォロー|シェア|ツイート|ブックマーク|この記事を|関連記事|あわせて読みたい|おすすめ|オススメ|お勧め|recommend|【pr】|^pr$|メルマガ|会員登録|新規登録|ログイン|ログアウト|記事一覧|一覧へ|一覧を見る|もっと見る|(続|つづ)きを(読む|よむ)|全文を(読む|よむ)|次の記事|前の記事|次のページ|前のページ|次ページ|前ページ|はこちら$|こちらから$|メインコンテンツ|本文へ|スキップ|削除してよろしいですか|下書き|コメント|写真を(もっと)?見る|画像を(もっと)?見る|(url|リンク|タイトル)を?コピー|優先(ソース|する(ニュース)?提供元)|^[\[［(（]?\d+\s*[/／]\s*\d+\s*(ページ|頁)?[\]］)）]?$|^(前へ\s*)?(\d+\s*)+(次へ)?$|^(前へ|次へ)$|^tags?$|^page$|^#\S+$|^\d{1,3}$/i;
/** 本文の後ろに付く、筆者紹介・画像の一覧・宣伝の見出し（ここから後ろは本文ではない） */
const TAIL_MARK =
  /^(writer|author|text|photo|ライター|筆者|著者|執筆者?|文|写真|取材・文|プロフィール)\s*[:：／/]|の記事一覧$|^画像ギャラリー|^【画像】|^フォトギャラリー|（pr|pr・外部リンク|^\[?ad\]?$|^sponsored/i;
/** 著作権表示・無断転載の禁止など（本文の最後の文のように見えても落とす） */
const COPYRIGHT = /©|copyright|all rights reserved|reserved\.|無断転載|無断転用|無断複製/i;
/** 日付・日時だけの行（記事の公開日・更新日。「2026年10月9日」「2026/10/09 15:31」「公開日：10月9日（木）」など） */
const DATE_LINE =
  /^((公開|更新|配信|掲載|投稿)(日|日時)?\s*[:：]?\s*)?((\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2})(\s*[（(][^（）()]{1,4}[）)])?(\s*\d{1,2}\s*[:：時]\s*\d{2}\s*分?)?(\s*(公開|更新|配信|掲載|投稿))?$/;
/** 日付の前の行が、日時の項目名（「開催日時」など。本文の案内なので落とさない） */
const DATE_LABEL = /(日時|日程|期間|日付|開催日|日|時)\s*[:：]?$|[:：]$/;
/** キーワード・タグ・カテゴリの項目名だけの行（次の行がその値） */
const LABEL_LINE = /^(関連)?(キーワード|タグ|tags?|カテゴリー?|ジャンル|分類)\s*[:：]?$/i;
/** キーワード・タグ・カテゴリの項目名と値の行（「キーワード : A • B」） */
const LABEL_VALUE_LINE = /^(関連)?(キーワード|タグ|tags?|カテゴリー?|ジャンル)\s*[:：]\s*\S/i;
/** 本文の最初に出やすい、サイトの案内・メニューの行 */
const HEAD_LINE = /メインコンテンツ|本文へ|スキップ|ログイン|新規登録|会員登録|メルマガ|フォロー|シェア|ツイート|^rss$|^english$|メニュー|^検索$|^ホーム$|^トップ$/i;

/**
 * 取り出した文から、本文の前後の余計な行を落とす:
 * - 見出しの行が最初の方にあり、それより前に文がほとんどなければ、見出しまで（サイト名・メニューなど）を落とす
 * - 最初・最後の、サイトの案内・メニュー・共有・著作権表示・タグ・ページ番号などの短い行を落とす
 * - 続けて同じ行が出たら1つにする
 */
export function cleanArticleText(text: string, title: string): string {
  let lines = clean(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  lines = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
  if (title) {
    // 見出しの行: 見出しとほぼ同じ文字で（双方向に6割以上が重なる）、文で終わらない行
    // （見出しとほぼ同じ内容のリード文「〜を発表した。」は本文なので落とさない）
    const limit = Math.max(12, Math.ceil(lines.length * 0.4));
    const isTitle = (line: string) =>
      line.length <= title.length * 1.6 + 12 && !/[。．]$/.test(line) && titleOverlap(title, line) >= 0.6 && titleOverlap(line, title) >= 0.6;
    const at = lines.slice(0, limit).findIndex(isTitle);
    if (at >= 0) {
      const before = lines.slice(0, at).filter((line) => SENTENCE.test(line) && line.length >= 30).length;
      if (before === 0) lines = lines.slice(at + 1);
    }
  }
  // 見出しのすぐ後の、カテゴリ・日付などの行（最初の方の日付の行と、それより前の短い行）を落とす
  for (let round = 0; round < 2; round++) {
    const at = lines.slice(0, 6).findIndex((line) => DATE_LINE.test(line));
    if (at < 0 || (at > 0 && DATE_LABEL.test(lines[at - 1]))) break;
    if (!lines.slice(0, at).every((line) => line.length <= 30 && !SENTENCE.test(line))) break;
    lines = lines.slice(at + 1);
  }
  for (;;) {
    const first = lines[0] ?? '';
    // 「キーワード :」と、その値（短い、文でない行）
    if (LABEL_LINE.test(first)) lines.splice(0, lines.length > 1 && lines[1].length <= 40 && !SENTENCE.test(lines[1]) ? 2 : 1);
    else if (first && first.length <= 30 && (HEAD_LINE.test(first) || JUNK_LINE.test(first) || DATE_LINE.test(first))) lines.shift();
    // 筆者・キーワードの行（「著者 : 編集部」「キーワード : A • B」。続きのページの最初に出やすい）
    else if (first && first.length <= 60 && !SENTENCE.test(first) && (TAIL_MARK.test(first) || LABEL_VALUE_LINE.test(first))) lines.shift();
    else break;
  }
  // 最後の数行に筆者紹介・画像の一覧・宣伝の見出しがあれば、そこから後ろを落とす（筆者紹介の文は本文ではない）
  const tail = Math.max(0, lines.length - 8);
  const cut = lines.findIndex((line, i) => i >= tail && i > 0 && line.length <= 40 && TAIL_MARK.test(line));
  if (cut > 0) lines = lines.slice(0, cut);
  // 生の HTML のような行（コードの表示などで本文に紛れ込んだもの）は落とす
  lines = lines.filter((line) => !/^<[a-z][\w-]*[\s>][^]*<\/[a-z]/i.test(line));
  const shortLabel = (line: string) => line.length <= 12 && !SENTENCE.test(line) && (/^[\x20-\x7e]+$/.test(line) || /^[#＃]/.test(line));
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    // 文で終わる長めの行（本文の最後の文かもしれない）は、著作権表示などのはっきりしたものだけ落とす
    const sentence = /[。．！？」』）)]$/.test(last) && last.length >= 20;
    // 「ほかの記事の見出し - サイト名」のような、関連記事へのリンクの行
    const related = !sentence && last.length <= 120 && /\s[-–—|｜]\s*[^\s。．]{2,24}$/.test(last);
    const label = !sentence && last.length <= 60 && LABEL_VALUE_LINE.test(last);
    if ((sentence ? COPYRIGHT.test(last) : last.length <= 60 && JUNK_LINE.test(last)) || shortLabel(last) || related || label) lines.pop();
    else break;
  }
  return lines.join('\n');
}

// ===== 文字のいちばん多いまとまり =====

/** これより上には広げない */
const TOP = new Set(['BODY', 'HTML']);
/** 空白を除いた文字の数（リンクの文字も数える） */
const size = (element: HTMLElement) => element.structuredText.replace(/\s+/g, '').length;
/** まとまりの形（タグと最初のクラス名。小見出しごとに分かれた本文の、同じ形のまとまりを見分ける） */
const shape = (element: HTMLElement) => `${element.tagName}.${(element.getAttribute('class') ?? '').trim().split(/\s+/)[0]}`;

/**
 * 本文らしい文字がいちばん多いまとまり（小見出しごとに分かれていれば、大きすぎない範囲で記事全体に広げる）。
 * リンクの文字は数えず（メニュー・関連記事やおすすめの見出しの一覧は、ほとんどがリンク）、
 * 「。」などで終わる文を含まない文字（見出しの一覧・ラベル・日付など）は軽く数える
 */
function densest(page: HTMLElement): HTMLElement {
  const own = new Map<HTMLElement, number>();
  const walk = (node: Node, container: HTMLElement, inLink: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) {
        const text = child.text.trim();
        if (!inLink && text) own.set(container, (own.get(container) ?? 0) + text.length * (SENTENCE.test(text) ? 1 : 0.3));
      } else if (child instanceof HTMLElement) {
        walk(child, CONTAINERS.has(child.tagName) ? child : container, inLink || child.tagName === 'A');
      }
    }
  };
  walk(page, page, false);
  let best = page;
  let top = 0;
  for (const [element, count] of own) {
    if (count > top) {
      best = element;
      top = count;
    }
  }
  // 小見出しごとに同じ形のまとまりが並んでいて、それが親の文字の大半なら、親に広げる
  let result = best;
  const parent = best.parentNode;
  if (parent instanceof HTMLElement && parent.tagName && !TOP.has(parent.tagName)) {
    const same = parent.childNodes.filter((child): child is HTMLElement => child instanceof HTMLElement && shape(child) === shape(best));
    if (same.length >= 2 && same.reduce((sum, element) => sum + size(element), 0) >= size(parent) * 0.6) result = parent;
  }
  // さらに、親に広げて増える部分が本文らしければ（文が増え、文でない文字（メニュー・ラベル）やリンクがあまり増えなければ）広げる
  // （表の中に分かれた本文・広告をはさんで分かれた本文・小見出しごとの本文・リード文が別のまとまりにある記事など。
  // 横の欄・筆者紹介・フッターのように、文が少しあってもリンクやラベルの多い部分が増えるなら広げない。
  // body までは広げず、大きすぎる親にも広げない）
  let parts = textParts(result);
  const cap = size(best) * 4 + 400;
  for (let next = result.parentNode; next instanceof HTMLElement && next.tagName && !TOP.has(next.tagName); next = next.parentNode) {
    if (size(next) > cap) break;
    const nextParts = textParts(next);
    const sentence = nextParts.sentence - parts.sentence;
    const other = nextParts.other - parts.other;
    const linked = nextParts.linked - parts.linked;
    if (sentence > 0 && sentence >= other * 0.5 + linked) {
      result = next;
      parts = nextParts;
    }
  }
  return result;
}

/** 見出しのタグ（見出しの文字は、文として数えない） */
const HEADING = /^H[1-6]$/;

/**
 * まとまりの文字の内訳（文の文字・文でない文字・リンクの文字）。
 * 見出しは数えない（記事の見出しに「。」「？」が入っていると、見出しを含めるだけで本文らしくなってしまうため）
 */
function textParts(element: HTMLElement): { sentence: number; other: number; linked: number } {
  let sentence = 0;
  let other = 0;
  let linked = 0;
  const walk = (node: Node, inLink: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) {
        const length = child.text.replace(/\s+/g, '').length;
        if (inLink) linked += length;
        else if (SENTENCE.test(child.text)) sentence += length;
        else other += length;
      } else if (child instanceof HTMLElement && !HEADING.test(child.tagName)) {
        walk(child, inLink || child.tagName === 'A');
      }
    }
  };
  walk(element, false);
  return { sentence, other, linked };
}

// ===== 構造化データ・埋め込みデータ =====

/** HTML の断片を文にする（段落・改行を保つ） */
function htmlToText(fragment: string): string {
  const root = parse(`<div>${fragment}</div>`, { comment: false });
  for (const element of root.querySelectorAll(JUNK)) element.remove();
  return clean(root.structuredText);
}

/** JSON-LD の記事（NewsArticle・Article など）の articleBody */
function jsonLdBody(root: HTMLElement): string | undefined {
  let best = '';
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.articleBody === 'string') {
        const body = /<\/?(p|br|div)\b/i.test(record.articleBody) ? htmlToText(record.articleBody) : clean(record.articleBody);
        if (body.length > best.length) best = body;
      }
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) if (key in record) visit(record[key]);
    }
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.rawText));
    } catch {
      // 壊れた JSON-LD は使わない
    }
  }
  return best.length >= MIN_TEXT_LENGTH ? best : undefined;
}

/** ページに埋め込まれたデータ（Next.js の __NEXT_DATA__ など）にある、本文らしい HTML・文章 */
function embeddedBody(root: HTMLElement): string | undefined {
  const scripts = root.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]');
  let best = '';
  const visit = (value: unknown, key: string, depth: number) => {
    if (depth > 12) return;
    if (typeof value === 'string') {
      if (value.length < MIN_TEXT_LENGTH || !/body|content|text|html|article/i.test(key)) return;
      const text = /<\/?(p|br|div|h\d)\b/i.test(value) ? htmlToText(value) : clean(value);
      // 本文の文章らしいもの（文の終わりが何度も出てくる日本語）だけ
      const sentences = (text.match(/[。．！？]/g) ?? []).length;
      if (sentences >= 3 && text.length > best.length) best = text;
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) visit(entry, name, depth + 1);
    }
  };
  for (const script of scripts) {
    const raw = script.rawText;
    if (raw.length < MIN_TEXT_LENGTH || raw.length > 3_000_000) continue;
    try {
      visit(JSON.parse(raw), '', 0);
    } catch {
      // JSON でなければ使わない
    }
  }
  return best.length >= MIN_TEXT_LENGTH ? best : undefined;
}

// ===== 動画・画像が中心のページ =====

function mediaOf(root: HTMLElement): ExtractedArticle['media'] {
  const ogType = root.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? '';
  const video =
    /^video/i.test(ogType) ||
    !!root.querySelector('meta[property="og:video"], meta[property="og:video:url"], video') ||
    root.querySelectorAll('iframe').some((frame) => /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|nicovideo|tver\.jp/i.test(frame.getAttribute('src') ?? ''));
  if (video) return 'video';
  const area = root.querySelector('article') ?? root.querySelector('main');
  if (area && area.querySelectorAll('img').length >= 6) return 'images';
  return undefined;
}

// ===== たどれるリンク =====

function safeUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** 同じサイト（同じホスト）の URL ならその絶対 URL（# は外す） */
function sameSite(href: string | undefined | null, base: URL): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.hostname !== base.hostname) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** 末尾の / と .html などを除いたパス */
const stem = (path: string) => path.replace(/\/+$/, '').replace(/\.(html?|php|aspx?)$/i, '');

/**
 * 記事の何ページ目か（同じ記事の続きのページでなければ undefined）。
 * 同じサイトで、元の URL のパスの後ろに「/2」「-2.html」「_2」が付いたもの、または page=2 などのクエリだけが違うもの。
 * 「次の記事」のように別の記事を指すリンクは含めない
 */
export function pageNumber(base: URL, candidate: URL): number | undefined {
  if (candidate.hostname !== base.hostname) return undefined;
  const basePath = stem(base.pathname);
  const path = stem(candidate.pathname);
  const fromPath = path.startsWith(basePath) ? path.slice(basePath.length).match(/^(?:\/|-|_|\/page\/?|\/p)(\d{1,2})$/)?.[1] : undefined;
  if (fromPath && candidate.search === base.search) return Number(fromPath);
  if (path === basePath) {
    const params = new URLSearchParams(candidate.search);
    for (const name of ['page', 'p', 'pg', 'pn', 'pageno', 'pagenum']) {
      const value = params.get(name);
      if (!value || !/^\d{1,2}$/.test(value)) continue;
      params.delete(name);
      const rest = new URLSearchParams(base.search);
      rest.delete(name);
      if (params.toString() === rest.toString()) return Number(value);
    }
  }
  return undefined;
}

/** 2ページ目以降の URL（ページ番号の順。10ページまで。page は今のページ、article は記事の最初のページ） */
function pageLinks(root: HTMLElement, page: URL, article: URL): string[] {
  const found = new Map<number, string>();
  const current = pageNumber(article, page) ?? 1;
  for (const element of root.querySelectorAll('a[href], link[rel="next"]')) {
    const href = sameSite(element.getAttribute('href'), page);
    if (!href) continue;
    const number = pageNumber(article, new URL(href));
    if (number && number > current && number <= 10 && !found.has(number)) found.set(number, href);
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([, href]) => href);
}

/** 「全文を読む」などのリンクの文字 */
const READ_MORE = /全文を?(読む|よむ|表示|見る|みる)|記事全文|全文はこちら|(続|つづ)きを(読む|よむ|見る|みる)|(続|つづ)きはこちら|記事の(続|つづ)き|もっと読む|read more|continue reading/i;

/** 「全文を読む」「続きを読む」の先（同じ記事の、クエリだけ違うページか、同じパスの下のページ） */
function readMoreLink(root: HTMLElement, base: URL): string | undefined {
  for (const anchor of root.querySelectorAll('a[href]')) {
    if (!READ_MORE.test(anchor.text.trim()) || anchor.text.trim().length > 20) continue;
    const href = sameSite(anchor.getAttribute('href'), base);
    if (!href) continue;
    const url = new URL(href);
    if (url.toString() === new URL(base.toString().replace(/#.*$/, '')).toString()) continue;
    const basePath = stem(base.pathname);
    if (stem(url.pathname) === basePath || stem(url.pathname).startsWith(`${basePath}/`)) return href;
  }
  return undefined;
}

/**
 * 本文がなく記事本体のページへリンクしているだけのページ（お知らせの一覧の1件のページなど）の、そのリンク。
 * 見出しとほぼ同じ文字のリンクで、同じサイトの別のページを指すもの
 */
function stubLink(page: HTMLElement, base: URL, title: string): string | undefined {
  if (!title) return undefined;
  for (const anchor of page.querySelectorAll('a[href]')) {
    const text = clean(anchor.text);
    if (text.length < 6 || titleOverlap(title, text) < 0.7 || titleOverlap(text, title) < 0.7) continue;
    const href = sameSite(anchor.getAttribute('href'), base);
    if (!href) continue;
    const url = new URL(href);
    if (stem(url.pathname) === stem(base.pathname) || url.pathname === '/') continue;
    return href;
  }
  return undefined;
}
