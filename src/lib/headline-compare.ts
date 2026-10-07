/**
 * 各媒体の見出しの比べ方（AI を使わない、機械的な比較）。
 * - 多くの媒体の見出しに共通する言葉
 * - その媒体の見出しにだけある言葉（どこに焦点を当てているかの手がかり）
 * - 見出しの数字が媒体によって違うもの（同じものを指しているとは限らないので、判断はしない）
 * 日本語は単語に区切れないので、カタカナ・漢字・英数字の続きを「言葉」とみなし、ほかの見出しに含まれるかは部分一致で調べる
 */
import { mainTitle } from './related.ts';

export interface HeadlineInput {
  id: string;
  title: string;
}

export interface NumberMention {
  /** 見出しに出てきた形（「821社」「3万円」） */
  text: string;
  /** その数字を見出しに入れた記事の ID */
  ids: string[];
}

export interface NumberDifference {
  /** 単位（社・円・人など） */
  unit: string;
  /** 違う値（2つ以上） */
  values: NumberMention[];
}

export interface HeadlineComparison {
  /** 多くの見出しに共通する言葉（多い順） */
  common: string[];
  /** 記事ごとの、その見出しにだけある言葉 */
  unique: Record<string, string[]>;
  /** 見出しの数字が媒体によって違うもの */
  numbers: NumberDifference[];
}

/** 言葉として数えない、ニュースの見出しによく出る言葉 */
const STOP_WORDS = new Set(['ニュース', '速報', '記事', 'まとめ', '動画', '写真', '画像', '公式', '情報', '最新', '今日', '本日', '話題', 'について', 'ついて', 'コラム', 'レビュー', 'インタビュー']);

/** 比べやすい形（全角・半角、大文字・小文字をそろえる） */
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

/** 数字のすぐあとに付く助数詞（「8日配信」の「日」）。言葉の頭から外す */
const COUNTER_HEAD = /^[日月年時分秒件人回位円万億兆本台社個点度倍歳週期弾話作号]/;
/** 数字のすぐ前に付く字（「東日本第1」の「第」・「最小約191MB」の「約」）。言葉の終わりから外す */
const NUMBER_TAIL = /[第約計全同毎]$/;

/** 見出しの中の「言葉」（カタカナ2文字以上（「スター・ウォーズ」のような中黒も含む）・漢字2文字以上・英数字2文字以上の続き） */
export function headlineWords(title: string): string[] {
  const text = mainTitle(title).normalize('NFKC');
  const pattern = /[ァ-ヴー]+(?:・[ァ-ヴー]+)+|[ァ-ヴー]{2,}|[一-龠々〆ヵヶ]{2,}|[A-Za-z][A-Za-z0-9+.'-]*[A-Za-z0-9+]|[A-Za-z0-9]{2,}/g;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(pattern)) {
    let word = match[0].replace(/^[.'-]+|[.'-]+$/g, '');
    const start = match.index ?? 0;
    // 漢字の言葉は、数字に付いた助数詞や「第」「約」を外す（「8日配信」→「配信」・「東日本第1」→「東日本」）
    if (/^[一-龠々〆ヵヶ]/.test(word)) {
      if (/\d/.test(text[start - 1] ?? '') && COUNTER_HEAD.test(word)) word = word.slice(1);
      if (/\d/.test(text[start + match[0].length] ?? '') && NUMBER_TAIL.test(word)) word = word.slice(0, -1);
    }
    const key = normalize(word);
    // 数字だけ・長音記号だけ・よく出る言葉は除く
    if (key.length < 2 || /^[\d.]+$/.test(key) || /^ー+$/.test(key) || STOP_WORDS.has(word) || seen.has(key)) continue;
    seen.add(key);
    result.push(word);
  }
  return result;
}

/** 量を表す単位（日付・時刻・順位のような、違っていて当たり前の数字は比べない） */
const UNITS = ['円', 'ドル', 'ユーロ', '人', '名', '件', '社', '団体', '台', '店舗', '%', '倍', '票', '奪三振', '本塁打', '安打', '打点', '失点', '得点', 'mAh', 'GB', 'TB', 'インチ'];
// 「2万9800円」のように、万・億・兆のあとに続く数字も1つの値として読む
const UNIT_PATTERN = new RegExp(
  `(\\d+(?:[.,]\\d+)*)(?:(万|億|兆)(\\d+(?:[.,]\\d+)*)?)?(${UNITS.map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  'g',
);
const MULTIPLIERS: Record<string, number> = { 万: 1e4, 億: 1e8, 兆: 1e12 };
/** 見出しの数字の違いとして挙げる、値の差の上限（大きいほうが小さいほうの何倍まで） */
const MAX_NUMBER_RATIO = 1.5;

/** 見出しの中の「数字＋単位」（例: 821社・3万円・10奪三振） */
export function headlineNumbers(title: string): { text: string; unit: string; value: number }[] {
  const text = mainTitle(title).normalize('NFKC').replace(/％/g, '%');
  const result: { text: string; unit: string; value: number }[] = [];
  for (const match of text.matchAll(UNIT_PATTERN)) {
    const [whole, digits, multiplier, rest, unit] = match;
    // 「第3位」「3人目」「2社目」のような順番は量ではないので除く
    const after = text.slice((match.index ?? 0) + whole.length, (match.index ?? 0) + whole.length + 1);
    const before = text.slice(Math.max(0, (match.index ?? 0) - 1), match.index ?? 0);
    if (after === '目' || before === '第') continue;
    const value = Number(digits.replace(/,/g, '')) * (multiplier ? MULTIPLIERS[multiplier] : 1) + (rest ? Number(rest.replace(/,/g, '')) : 0);
    if (!Number.isFinite(value)) continue;
    result.push({ text: whole, unit, value });
  }
  return result;
}

/**
 * 見出しを比べる。headlines は媒体ごとに1件（各媒体の最初の記事）を渡す。
 * common は minShare（割合）以上かつ2つ以上の見出しに含まれる言葉。長い言葉に含まれる短い言葉は、同じ数の見出しに出るなら長いほうだけ残す
 */
export function compareHeadlines(
  headlines: readonly HeadlineInput[],
  { minShare = 0.5, maxCommon = 8, maxUnique = 4 }: { minShare?: number; maxCommon?: number; maxUnique?: number } = {},
): HeadlineComparison {
  const texts = headlines.map((headline) => normalize(mainTitle(headline.title)));
  const wordsOf = headlines.map((headline) => headlineWords(headline.title));
  // 言葉ごとに、含んでいる見出しの数（部分一致。「東京理科大」は「東京理科大学」を含む見出しにもあるとみなす）
  const counts = new Map<string, { word: string; count: number }>();
  for (const words of wordsOf) {
    for (const word of words) {
      const key = normalize(word);
      if (counts.has(key)) continue;
      counts.set(key, { word, count: texts.filter((text) => text.includes(key)).length });
    }
  }
  const threshold = Math.max(2, Math.ceil(headlines.length * minShare));
  const commonEntries = [...counts.entries()]
    .filter(([, entry]) => entry.count >= threshold)
    .sort((a, b) => b[1].count - a[1].count || b[0].length - a[0].length);
  // ほかの共通の言葉に含まれる短い言葉は省く（「大谷」と「大谷翔平」なら「大谷翔平」だけ）
  const commonPicked = commonEntries.filter(([key]) => !commonEntries.some(([other]) => other !== key && other.includes(key)));
  const common = commonPicked.slice(0, maxCommon).map(([, entry]) => entry.word);
  const commonKeys = commonEntries.map(([key]) => key);
  const unique: Record<string, string[]> = {};
  headlines.forEach((headline, index) => {
    unique[headline.id] = wordsOf[index]
      // ほかの見出しにない言葉（共通の言葉を含む長い言葉は、焦点の違いとは言えないので除く）
      .filter((word) => (counts.get(normalize(word))?.count ?? 0) === 1 && !commonKeys.some((key) => normalize(word).includes(key)))
      .sort((a, b) => b.length - a.length)
      .slice(0, maxUnique);
  });

  // 数字: 同じ単位の数字を入れた見出しどうしで、どちらの値の組もほかを含まないとき（821社と800社）。
  // 片方がもう片方の一部だけを書いている（「3万円と5万円」と「3万円」）のは違いとみなさない
  const byUnit = new Map<string, Map<number, NumberMention>>();
  const valueSets = new Map<string, Map<string, Set<number>>>();
  headlines.forEach((headline) => {
    for (const number of headlineNumbers(headline.title)) {
      const values = byUnit.get(number.unit) ?? new Map<number, NumberMention>();
      const mention = values.get(number.value) ?? { text: number.text, ids: [] };
      if (!mention.ids.includes(headline.id)) mention.ids.push(headline.id);
      values.set(number.value, mention);
      byUnit.set(number.unit, values);
      const sets = valueSets.get(number.unit) ?? new Map<string, Set<number>>();
      sets.set(headline.id, (sets.get(headline.id) ?? new Set<number>()).add(number.value));
      valueSets.set(number.unit, sets);
    }
  });
  const contains = (a: Set<number>, b: Set<number>) => [...b].every((value) => a.has(value));
  // 桁が大きく違う数字（「最大12人」と「同時接続1万5000人」）は別のものを指していることが多いので、近い値（1.5倍以内）の違いだけを挙げる
  const close = (a: Set<number>, b: Set<number>) => [...a].some((x) => [...b].some((y) => x !== y && Math.max(x, y) <= Math.min(x, y) * MAX_NUMBER_RATIO));
  const numbers: NumberDifference[] = [];
  for (const [unit, values] of byUnit) {
    const sets = [...(valueSets.get(unit)?.values() ?? [])];
    const differs = sets.some((a, i) => sets.some((b, j) => i < j && !contains(a, b) && !contains(b, a) && close(a, b)));
    if (differs) numbers.push({ unit, values: [...values.values()] });
  }
  return { common, unique, numbers };
}
