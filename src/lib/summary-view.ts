/**
 * AI 要約の見せ方（10秒で読む・30秒で読む・2分で理解）。Node 専用の機能は使わない。
 * 要約のプロンプトでは「1文目で『誰が（何が）・何を・どうした』を書く」よう指示しているので、1文目をそのまま「10秒で読む」に使う
 */

const OPEN = '「『（(【［[〈《“';
const CLOSE = '」』）)】］]〉》”';

/** 文の終わり（かっこの中の「。」では切らない） */
function sentenceEnd(text: string): number {
  let depth = 0;
  const chars = Array.from(text);
  let index = 0;
  for (const char of chars) {
    if (OPEN.includes(char)) depth++;
    else if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === '。' || char === '！' || char === '？')) return index + 1;
    index++;
  }
  return -1;
}

/** 文章の1文目（見つからなければ全体。長すぎるときは max 字で切る） */
export function firstSentence(text: string, max = 120): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  const end = sentenceEnd(trimmed);
  const sentence = end > 0 ? chars.slice(0, end) : chars;
  return sentence.length > max ? `${sentence.slice(0, max - 1).join('')}…` : sentence.join('');
}

/** 1文目のあとの文（「30秒で読む」で1文目と重ねて見せないときに使う） */
export function restSentences(text: string): string {
  const trimmed = text.trim();
  const end = sentenceEnd(trimmed);
  return end > 0 ? Array.from(trimmed).slice(end).join('').trim() : '';
}

/** 日本語の文章を読むのにかかる秒数の目安（1分に約500字） */
export function readingSeconds(text: string): number {
  return Math.max(5, Math.round((Array.from(text.replace(/\s+/g, '')).length / 500) * 60));
}
