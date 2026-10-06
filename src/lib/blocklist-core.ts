/**
 * 記事の非表示（NGワード・サイト・個別の記事）。管理画面のブラウザとビルドの両方で使う。
 * 収集したデータからは消さず、表示するときに外すので、条件を消せば元に戻る
 */

export const BLOCKLIST_PATH = 'data/blocklist.json';

export interface Blocklist {
  /** 見出しにこの言葉を含む記事を非表示（大文字・小文字、全角・半角は区別しない） */
  words: string[];
  /** このサイト（サブドメインを含む）の記事を非表示 */
  hosts: string[];
  /** 個別に非表示にした記事の ID */
  ids: string[];
}

export const emptyBlocklist = (): Blocklist => ({ words: [], hosts: [], ids: [] });

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim();

function cleanList(values: unknown, transform: (value: string) => string = (value) => value.trim()): string[] {
  if (!Array.isArray(values)) return [];
  const result = values
    .filter((value): value is string => typeof value === 'string')
    .map(transform)
    .filter(Boolean);
  return [...new Set(result)].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** ドメイン名として正しい形（英数字とハイフンのラベルをドットでつないだもの。日本語ドメインは xn-- の形） */
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** 「https://www.example.com/path」のような書き方でもホスト名だけにする。ドメイン名でなければ空文字 */
export function normalizeHost(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text) return '';
  try {
    const host = new URL(text.includes('://') ? text : `https://${text}`).hostname.replace(/^www\./, '');
    return HOST_PATTERN.test(host) ? host : '';
  } catch {
    return '';
  }
}

/** ファイルの中身を読む。空・壊れている場合は空の設定 */
export function parseBlocklist(text: string | null | undefined): Blocklist {
  if (!text?.trim()) return emptyBlocklist();
  let data: Partial<Record<keyof Blocklist, unknown>>;
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error('非表示の設定ファイル（data/blocklist.json）が JSON として読めません');
  }
  return {
    words: cleanList(data.words),
    hosts: cleanList(data.hosts, normalizeHost),
    ids: cleanList(data.ids),
  };
}

export function serializeBlocklist(list: Blocklist): string {
  return `${JSON.stringify(parseBlocklist(JSON.stringify(list)), null, 2)}\n`;
}

/** 非表示にする理由。表示してよければ undefined */
export function blockReason(item: { id: string; title: string; url: string }, list: Blocklist): string | undefined {
  if (list.ids.includes(item.id)) return '個別に非表示';
  const title = normalize(item.title);
  const word = list.words.find((w) => title.includes(normalize(w)));
  if (word) return `NGワード「${word}」`;
  let host = '';
  try {
    host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // URL が壊れていればサイトでは判定しない
  }
  const blockedHost = host && list.hosts.find((h) => host === h || host.endsWith(`.${h}`));
  if (blockedHost) return `サイト ${blockedHost}`;
  return undefined;
}
