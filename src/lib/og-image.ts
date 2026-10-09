/**
 * 共有画像（OGP・Bluesky のリンクカードの画像。1200×630 の PNG）を作る。
 * どのページも同じ画像だとタイムラインや検索結果で見分けがつかないので、見出しを大きく出し、
 * 報じた媒体の数・ジャンル・「急上昇」「AI要約」などの印を添える（記事の写真は著作権があるので使わない）。
 * 文字は satori が図形（パス）に変えるので、PNG にするとき（sharp）にフォントは要らない。
 * フォントは assets/fonts の Noto Sans JP（太字。日本語の範囲に絞ったもの。SIL Open Font License）。
 * Node 専用（サイトのビルドと SNS の投稿の処理で使う）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const FONT_PATH = resolve(process.cwd(), 'assets/fonts/NotoSansJP-Bold.woff');
const FONT_NAME = 'Noto Sans JP';

/** サイトの色（src/styles/global.css と同じ） */
const COLORS = {
  bg: '#fff7f0',
  circle: '#ffe8d6',
  text: '#15171c',
  text2: '#3a3f4a',
  muted: '#5d6470',
  line: '#f3d9c6',
  accent: '#c2410c',
  accentSoft: '#ffe9db',
  heat: '#c0183f',
  heatSoft: '#ffe8ee',
  rise: '#6d28d9',
  riseSoft: '#f1eafe',
} as const;

export type CardTone = 'accent' | 'heat' | 'rise';

const TONES: Record<CardTone, { color: string; bg: string }> = {
  accent: { color: COLORS.accent, bg: COLORS.accentSoft },
  heat: { color: COLORS.heat, bg: COLORS.heatSoft },
  rise: { color: COLORS.rise, bg: COLORS.riseSoft },
};

/** 見出しのカード（話題・要約のページ、急上昇・いま話題・10秒でわかるニュースの投稿） */
export interface HeadlineCard {
  kind: 'headline';
  /** 右上の印（例: 「急上昇」「AI要約」） */
  label?: { text: string; tone: CardTone };
  title: string;
  /** 見出しの下の補足（要約の1文目など。2行まで） */
  sub?: string;
  /** 下の小さな印（例: 「5媒体が報道」「テクノロジー」） */
  chips?: readonly string[];
}

/** 見出しを並べたカード（今日の話題ニュース・今週のランキングなど） */
export interface ListCard {
  kind: 'list';
  label?: { text: string; tone: CardTone };
  heading: string;
  items: readonly string[];
}

export type CardSpec = HeadlineCard | ListCard;

export interface CardOptions {
  /** 右下に出すサイトのドメイン（例: topiatsume.pages.dev） */
  host: string;
  /** 左下に出すキャッチコピー */
  tagline: string;
  siteName: string;
}

/** satori に渡す要素（React の要素と同じ形） */
interface Node {
  type: string;
  props: { style?: Record<string, unknown>; children?: (Node | string)[] | Node | string };
}

const el = (type: string, style: Record<string, unknown>, children?: (Node | string)[] | Node | string): Node => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }) },
});

const chars = (text: string) => Array.from(text).length;

/** 長すぎる文字を切る（satori の行数の制限に加えて、極端に長い見出しで重くならないように） */
function clip(text: string, max: number): string {
  const list = Array.from(text.replace(/\s+/g, ' ').trim());
  return list.length > max ? `${list.slice(0, max - 1).join('')}…` : list.join('');
}

/** 見出しの文字の大きさ（短いほど大きく。3行に収まるように） */
export function titleFontSize(title: string, hasSub: boolean): number {
  const length = chars(title);
  if (length <= 20) return hasSub ? 64 : 72;
  if (length <= 34) return hasSub ? 56 : 62;
  if (length <= 50) return hasSub ? 50 : 54;
  return hasSub ? 44 : 48;
}

/** サイトのアイコン（オレンジの角丸に3本の線と点） */
function brandIcon(size: number): Node {
  const unit = size / 64;
  const bar = (width: number, color: string, top: number) =>
    el('div', {
      position: 'absolute',
      left: 14 * unit,
      top: top * unit,
      width: width * unit,
      height: 8 * unit,
      borderRadius: 4 * unit,
      background: color,
    });
  return el('div', { position: 'relative', display: 'flex', width: size, height: size, borderRadius: 16 * unit, background: COLORS.accent }, [
    bar(36, '#ffffff', 16),
    bar(26, '#ffd8c2', 28),
    bar(16, '#ffb994', 40),
    el('div', { position: 'absolute', left: 40 * unit, top: 38 * unit, width: 12 * unit, height: 12 * unit, borderRadius: 6 * unit, background: '#ffffff' }),
  ]);
}

function labelChip(label: { text: string; tone: CardTone }): Node {
  const tone = TONES[label.tone];
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      paddingTop: 6,
      paddingBottom: 6,
      paddingLeft: 20,
      paddingRight: 20,
      borderRadius: 999,
      border: `3px solid ${tone.color}`,
      background: '#ffffff',
      color: tone.color,
      fontSize: 30,
    },
    clip(label.text, 16),
  );
}

function header(options: CardOptions, label?: { text: string; tone: CardTone }): Node {
  return el('div', { display: 'flex', alignItems: 'center', flexShrink: 0, width: '100%' }, [
    brandIcon(56),
    el('div', { display: 'flex', marginLeft: 16, fontSize: 34, color: COLORS.text }, options.siteName),
    el('div', { display: 'flex', flexGrow: 1 }),
    ...(label ? [labelChip(label)] : []),
  ]);
}

function footer(options: CardOptions): Node {
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      flexShrink: 0,
      paddingTop: 18,
      borderTop: `3px solid ${COLORS.line}`,
      fontSize: 26,
    },
    [el('div', { display: 'flex', color: COLORS.accent }, clip(options.tagline, 30)), el('div', { display: 'flex', color: COLORS.muted }, options.host)],
  );
}

/** 外側の余白（satori は余白を幅・高さに含めないので、内側の領域の大きさを直接決める） */
const PADDING = { top: 48, right: 72, bottom: 40, left: 72 };

function frame(children: Node[]): Node {
  return el(
    'div',
    {
      position: 'relative',
      display: 'flex',
      width: OG_WIDTH,
      height: OG_HEIGHT,
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: FONT_NAME,
      overflow: 'hidden',
    },
    [
      el('div', { position: 'absolute', right: -170, top: -230, width: 560, height: 560, borderRadius: 280, background: COLORS.circle }),
      el(
        'div',
        {
          position: 'absolute',
          top: PADDING.top,
          left: PADDING.left,
          display: 'flex',
          flexDirection: 'column',
          width: OG_WIDTH - PADDING.left - PADDING.right,
          height: OG_HEIGHT - PADDING.top - PADDING.bottom,
        },
        children,
      ),
    ],
  );
}

function headlineTree(card: HeadlineCard, options: CardOptions): Node {
  const title = clip(card.title, 90);
  const sub = card.sub ? clip(card.sub, 80) : undefined;
  const chips = (card.chips ?? []).filter(Boolean).slice(0, 3);
  return frame([
    header(options, card.label),
    el('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1, flexShrink: 1, minHeight: 0, width: '100%' }, [
      el('div', { display: 'block', width: '100%', fontSize: titleFontSize(title, Boolean(sub)), lineHeight: 1.32, lineClamp: 3, color: COLORS.text }, title),
      ...(sub ? [el('div', { display: 'block', width: '100%', marginTop: 14, fontSize: 30, lineHeight: 1.45, lineClamp: 2, color: COLORS.text2 }, sub)] : []),
      ...(chips.length > 0
        ? [
            el(
              'div',
              { display: 'flex', marginTop: 22 },
              chips.map((chip) =>
                el(
                  'div',
                  {
                    display: 'flex',
                    marginRight: 12,
                    paddingTop: 4,
                    paddingBottom: 4,
                    paddingLeft: 18,
                    paddingRight: 18,
                    borderRadius: 999,
                    border: `2px solid ${COLORS.line}`,
                    background: '#ffffff',
                    color: COLORS.text2,
                    fontSize: 26,
                  },
                  clip(chip, 20),
                ),
              ),
            ),
          ]
        : []),
    ]),
    footer(options),
  ]);
}

function listTree(card: ListCard, options: CardOptions): Node {
  const items = card.items.slice(0, 5);
  return frame([
    header(options, card.label),
    el('div', { display: 'flex', marginTop: 26, fontSize: 44, color: COLORS.text }, clip(card.heading, 28)),
    el(
      'div',
      { display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1, flexShrink: 1, minHeight: 0, width: '100%' },
      items.map((item, index) =>
        el('div', { display: 'flex', alignItems: 'center', width: '100%', marginBottom: 12 }, [
          el(
            'div',
            {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              width: 46,
              height: 46,
              borderRadius: 23,
              marginRight: 18,
              background: index === 0 ? COLORS.accent : COLORS.accentSoft,
              color: index === 0 ? '#ffffff' : COLORS.accent,
              fontSize: 26,
            },
            String(index + 1),
          ),
          el('div', { display: 'block', flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 30, lineHeight: 1.3, lineClamp: 1, color: COLORS.text }, clip(item, 60)),
        ]),
      ),
    ),
    footer(options),
  ]);
}

let fonts: { name: string; data: Buffer; weight: 700; style: 'normal' }[] | undefined;
/** フォントは1回だけ読む（satori は同じ配列を渡すと読み込んだフォントを使い回す） */
const loadFonts = () => (fonts ??= [{ name: FONT_NAME, data: readFileSync(FONT_PATH), weight: 700, style: 'normal' }]);

/** カードの SVG（文字は図形になっている） */
export async function renderCardSvg(card: CardSpec, options: CardOptions): Promise<string> {
  const tree = card.kind === 'list' ? listTree(card, options) : headlineTree(card, options);
  return satori(tree as unknown as Parameters<typeof satori>[0], { width: OG_WIDTH, height: OG_HEIGHT, fonts: loadFonts() });
}

/** カードの PNG（色数を絞って小さくする。1枚50〜100KB ほど） */
export async function renderCardPng(card: CardSpec, options: CardOptions): Promise<Buffer> {
  const svg = await renderCardSvg(card, options);
  return sharp(Buffer.from(svg)).png({ palette: true, quality: 90, compressionLevel: 9, effort: 7 }).toBuffer();
}

// ===== 作った画像の使い回し（毎時のビルドで、内容の変わらない画像を作り直さないように） =====

/** カードの見た目を変えたら上げる（古い画像を使い回さないように） */
const RENDER_VERSION = 1;
/** 作った画像を置く場所（.gitignore。GitHub Actions では actions/cache で次のビルドに引き継ぐ） */
const CACHE_DIR = resolve(process.cwd(), '.cache/og');
/** この日数のあいだ使われなかった画像は消す */
const CACHE_KEEP_DAYS = 3;

let pruned = false;
function pruneCache(now: number) {
  pruned = true;
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      const file = join(CACHE_DIR, name);
      if (now - statSync(file).mtimeMs > CACHE_KEEP_DAYS * 24 * 60 * 60 * 1000) unlinkSync(file);
    }
  } catch {
    // まだ置き場がない
  }
}

/** カードの PNG（同じ内容の画像を作ったことがあれば、それを使う） */
export async function cachedCardPng(card: CardSpec, options: CardOptions): Promise<Buffer> {
  const now = Date.now();
  if (!pruned) pruneCache(now);
  const key = createHash('sha1').update(JSON.stringify([RENDER_VERSION, card, options])).digest('hex');
  const file = join(CACHE_DIR, `${key}.png`);
  try {
    const data = readFileSync(file);
    // 使った印（しばらく使われない画像だけを消すため）
    utimesSync(file, now / 1000, now / 1000);
    return data;
  } catch {
    // まだ作っていない
  }
  const png = await renderCardPng(card, options);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, png);
  return png;
}
