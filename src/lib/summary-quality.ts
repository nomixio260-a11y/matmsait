/**
 * AI 要約の品質の確認（「AI 要約内容 改善指示書」の基準のうち、文字の並びから見分けられるもの）。
 * 管理画面の回答の確認・保存済みの要約・CLI・AI 整理で使う。Node 専用の機能は使わない。
 * どれも「注意」で、保存は止めない（記事の本文に書かれている言い方なら問題ないこともあるので、運営者が記事と見比べて決める）
 */

export type QualityKind =
  | 'title'
  | 'opening'
  | 'promo'
  | 'cliche'
  | 'guess'
  | 'date'
  | 'style'
  | 'length'
  | 'unit'
  | 'quote'
  | 'sns'
  | 'conjunction';

export interface QualityWarning {
  kind: QualityKind;
  /** どの欄の注意か */
  field: 'summary' | 'points' | 'background';
  /** 運営者向けの説明（何が・どう直すとよいか） */
  message: string;
}

export interface QualityInput {
  summary: string;
  points?: readonly string[];
  background?: string;
}

/** 宣伝・評価の言葉（具体的な機能・数字・変更点に置き換える） */
export const PROMOTIONAL_WORDS = [
  '革新的',
  '画期的',
  '圧倒的',
  '業界最高',
  '究極',
  '世界を変える',
  '最高峰',
  '唯一無二',
  '驚異的',
  '至高',
  '極上',
  '素晴らしい',
  'すばらしい',
  '魅力的な',
  '高い完成度',
  '完成度の高い',
  '必見',
  '見逃せない',
];

/** 中身のない締めの文・AI の評価（具体的な予定や事実がなければ書かない） */
export const CLICHE_PATTERN =
  /今後の(?:動向|展開|行方)(?:が|に)?(?:注目|期待|気にな)|注目され(?:る|ます|ている)|注目が集ま|注目を集め(?:そう|ている|る)|注目したい|期待が高ま|期待され(?:る|ます|ている)|話題(?:と|に)なりそう|目が離せな|重要なニュース|非常に注目|大きな影響を与え(?:る|そう)|発展するのか/;

/**
 * 推測・予想の言い方（記事にそう書かれていなければ書かない）。
 * 「〜と予想される」「〜とみられる」は天気予報や捜査の記事でよく使われる事実の書き方なので入れない
 */
const GUESS_PATTERN = /だろう|でしょう|と思われ|に違いない|可能性が高い|かもしれない|しそうだ/;

/** あとで読むと日付がずれる言い方（記事の公開日をもとに具体的な日付にする） */
const RELATIVE_DATE_PATTERN = /本日|今日|昨日|明日|明後日|一昨日|今朝|今夜|今晩|昨夜|昨晩|今週|来週|先週|今月|来月|先月/;

/** SNS・ネットの反応を大きく書く言い方、一部の意見の一般化 */
const SNS_PATTERN = /(?:SNS|ネット)(?:上)?で(?:大きな)?話題|話題を呼ん|反響を呼ん|大反響|大きな反響|大きな話題|物議を醸|世間では/;

/** 単位のない数字の増減（「30増加」） */
const BARE_NUMBER_PATTERN = /\d(?:増加|減少|上昇|低下|下落)/;

/** 「です・ます」で終わる文 */
const POLITE_ENDING = /(?:です|ます|ました|ません|でした|でしょう|ましょう)$/;

/** 文の始めの接続詞 */
const CONJUNCTION_START = /^(?:また|さらに|一方で|一方|なお|そして|これにより|このため|加えて)[、,]?/;

/** 1文の長さの上限（字）。指示書の目安は40〜80字で、これを超える文は分けてもらう */
export const MAX_SENTENCE_LENGTH = 100;
/** 長い引用とみなす、かぎかっこの中の長さ（字） */
const LONG_QUOTE_LENGTH = 40;
/** 接続詞で始まる文がこれ以上あれば注意する */
const MAX_CONJUNCTIONS = 3;

const FIELD_NAMES: Record<QualityWarning['field'], string> = { summary: '要約', points: '要点', background: '背景' };

const charLength = (text: string) => Array.from(text).length;

/** かぎかっこの中（作品名・製品名・発言など）を除く（言葉の当てはめで誤って拾わないように） */
function withoutQuotes(text: string): string {
  return text.replace(/「[^「」]*」|『[^『』]*』/g, '「」');
}

/** 文に分ける（。！？で区切る。かぎかっこの中の句点では区切らない） */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    current += char;
    if (char === '「' || char === '『') depth++;
    else if ((char === '」' || char === '』') && depth > 0) depth--;
    else if (depth === 0 && /[。！？!?]/.test(char)) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(Boolean);
}

/** 文字の組（2文字）。見出しとの重なりを測る */
function bigrams(text: string): Set<string> {
  const chars = Array.from(text.normalize('NFKC').toLowerCase().replace(/[\s、。，．,.!！?？「」『』（）()【】[\]・:：;；"'“”‘’〜~\-–—…]/g, ''));
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

/**
 * 要約が見出しの言い換えだけになっていないか: 要約の文字の組のうち、見出しにない組の割合と数。
 * 見出しにない情報（数字・日付・条件など）が少ないと小さくなる
 */
export function titleNovelty(summary: string, title: string): { ratio: number; count: number } {
  const summaryGrams = bigrams(summary);
  const titleGrams = bigrams(title);
  const count = [...summaryGrams].filter((gram) => !titleGrams.has(gram)).length;
  return { ratio: summaryGrams.size > 0 ? count / summaryGrams.size : 0, count };
}

/** 見出しの言い換えとみなす境目（見出しにない文字の組の割合・数） */
const TITLE_NOVELTY_RATIO = 0.35;
const TITLE_NOVELTY_COUNT = 12;

/**
 * 1つの文章の言葉の注意（宣伝・評価の言葉・定型文・推測・あいまいな日付・SNS の誇張・単位のない数字・文体・長い引用）。
 * 要約のほか、AI 整理の各項目にも使う
 */
export function phraseWarnings(text: string): { kind: QualityKind; message: string }[] {
  const warnings: { kind: QualityKind; message: string }[] = [];
  const plain = withoutQuotes(text);
  const add = (kind: QualityKind, message: string) => warnings.push({ kind, message });
  const promo = PROMOTIONAL_WORDS.find((word) => plain.includes(word));
  if (promo) add('promo', `宣伝・評価の言葉「${promo}」があります。具体的な機能・数字・変更点に置き換えてください`);
  const cliche = plain.match(CLICHE_PATTERN)?.[0];
  if (cliche) add('cliche', `中身のない定型文・評価「${cliche}」があります。具体的な予定や事実がなければ削ってください`);
  const guess = plain.match(GUESS_PATTERN)?.[0];
  if (guess) add('guess', `推測の言い方「${guess}」があります。記事にそう書かれていなければ削ってください`);
  const relative = plain.match(RELATIVE_DATE_PATTERN)?.[0];
  if (relative) add('date', `「${relative}」は、あとで読むと日付がずれます。記事の公開日をもとに「10月7日」のような日付にしてください`);
  const sns = plain.match(SNS_PATTERN)?.[0];
  if (sns) add('sns', `SNS・ネットの反応を大きく書いていないか、一部の意見を一般化していないか確かめてください（「${sns}」）`);
  const bare = plain.match(BARE_NUMBER_PATTERN)?.[0];
  if (bare) add('unit', `単位のない数字（「${bare}」）があります。%・円・人などの単位を付けてください`);
  if (sentencesOf(text).some((sentence) => POLITE_ENDING.test(withoutQuotes(sentence).replace(/[。！？!?]+$/, '')))) {
    add('style', '「です・ます」の文があります。常体（だ・である調）にそろえてください');
  }
  const quote = [...text.matchAll(/「([^「」]+)」|『([^『』]+)』/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .find((inner) => charLength(inner) >= LONG_QUOTE_LENGTH && /[、。]/.test(inner));
  if (quote) add('quote', `長い引用（${charLength(quote)}字）があります。発言や本文は引用せず、要点を言い換えてください`);
  return warnings;
}

/** 要約・要点・背景の言葉の注意（要点・背景は欄の名前を前に付ける） */
function textWarnings(text: string, field: QualityWarning['field']): QualityWarning[] {
  const prefix = field === 'summary' ? '' : `${FIELD_NAMES[field]}: `;
  return phraseWarnings(text).map((warning) => ({ ...warning, field, message: `${prefix}${warning.message}` }));
}

/**
 * 要約の注意を返す（同じ種類・同じ欄の注意は1つにまとめる）。title があれば、見出しの言い換えだけになっていないかも見る
 */
export function summaryWarnings(input: QualityInput, { title }: { title?: string } = {}): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const summary = input.summary.trim();
  if (summary) {
    const sentences = sentencesOf(summary);
    if (title) {
      // 中身のない締めの文・推測の文は、見出しにない情報として数えない（言い換え＋定型文の要約を見落とさないように）
      const substance = sentences.filter((sentence) => !CLICHE_PATTERN.test(withoutQuotes(sentence)) && !GUESS_PATTERN.test(withoutQuotes(sentence)));
      const novelty = titleNovelty(substance.join(''), title);
      if (novelty.ratio < TITLE_NOVELTY_RATIO || novelty.count < TITLE_NOVELTY_COUNT) {
        warnings.push({
          kind: 'title',
          field: 'summary',
          message: '見出しの言い換えに近い要約です。本文から見出しにない重要な情報（数字・日付・条件・今後の予定など）を加えてください',
        });
      }
    }
    if (/について(?:の)?(?:新たな|新しい|最新の)?(?:情報|詳細)が(?:明らかに|公開|発表)/.test(sentences[0] ?? '')) {
      warnings.push({ kind: 'opening', field: 'summary', message: '1文目に中身がありません。1文目で「誰が・何を・どうした」を書いてください' });
    }
    warnings.push(...textWarnings(summary, 'summary'));
    const long = sentences.map(charLength).filter((length) => length > MAX_SENTENCE_LENGTH);
    if (long.length > 0) {
      warnings.push({
        kind: 'length',
        field: 'summary',
        message: `1文が長すぎます（${Math.max(...long)}字）。${MAX_SENTENCE_LENGTH}字以内の文に分けてください（目安は40〜80字）`,
      });
    }
    const conjunctions = sentences.filter((sentence) => CONJUNCTION_START.test(sentence)).length;
    if (conjunctions >= MAX_CONJUNCTIONS) {
      warnings.push({
        kind: 'conjunction',
        field: 'summary',
        message: `接続詞（「また」「さらに」など）で始まる文が${conjunctions}つあります。自然につながる文では省いてください`,
      });
    }
  }
  for (const point of input.points ?? []) warnings.push(...textWarnings(point, 'points'));
  if (input.background?.trim()) warnings.push(...textWarnings(input.background, 'background'));
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.field}:${warning.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
