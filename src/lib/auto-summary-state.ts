/**
 * AI による自動要約の記録（data/auto-summary.json）。自動要約（scripts/lib/auto-summary.ts）と管理画面のデータ（admin/data.json）で共通。
 * Node 専用の機能は使わない。
 */

/** 記録のファイル（毎時の更新で書き換わる） */
export const AUTO_SUMMARY_STATE_PATH = 'data/auto-summary.json';

/** Workers AI の無料枠（1日のニューロン。UTC の0時に戻る） */
export const FREE_NEURONS_PER_DAY = 10_000;

export type AttemptResult =
  | 'saved'
  | 'quality'
  | 'unavailable'
  | 'invalid'
  | 'ai-error'
  | 'robots'
  | 'ai-optout'
  | 'blocked'
  | 'not-found'
  | 'no-text'
  | 'fetch-error';

export interface Attempt {
  id: string;
  at: string;
  result: AttemptResult;
  /** AI に依頼したときの、使ったニューロンの見積もり */
  neurons?: number;
  detail?: string;
}

/** 続けて起きている問題の種類（auth: 権限がない / quota: 無料枠を使い切った / other: AI への依頼が続けて失敗した） */
export type ProblemKind = 'auth' | 'quota' | 'other';

export interface AutoSummaryState {
  /** 使った量を数えている日（UTC の日付。無料枠は UTC の0時（日本時間の9時）に戻る） */
  day: string;
  /** その日に使ったニューロンの見積もり */
  neurons: number;
  /** その日に保存した要約の数 */
  saved: number;
  attempts: Attempt[];
  /** 最後の実行の結果（管理画面に出す） */
  lastRun?: { at: string; saved: number; tried: number; message?: string };
  /** 続けて起きている問題（管理画面に出す。要約を保存できたら消える） */
  problem?: { at: string; kind?: ProblemKind; message: string };
}

export const ATTEMPT_LABELS: Record<AttemptResult, string> = {
  saved: '要約を保存',
  quality: '要約の決まりに合わず保存せず',
  unavailable: 'AI が本文を要約できないと回答',
  invalid: 'AI の回答の形が正しくない',
  'ai-error': 'AI への依頼に失敗',
  robots: 'robots.txt で取得を断っている',
  'ai-optout': 'AI での利用を断っている',
  blocked: 'サイトが取得を拒否',
  'not-found': '記事のページがない',
  'no-text': '本文が見つからない',
  'fetch-error': '記事を取得できない',
};

const DAY = 24 * 60 * 60 * 1000;
export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export function parseAutoSummaryState(text: string | undefined, now: Date): AutoSummaryState {
  let state: Partial<AutoSummaryState> = {};
  try {
    state = text ? (JSON.parse(text) as Partial<AutoSummaryState>) : {};
  } catch {
    state = {};
  }
  const today = utcDay(now);
  const sameDay = state.day === today;
  // 無料枠を使い切った問題は、日が変われば（無料枠が戻れば）消す
  const problem = state.problem && !(state.problem.kind === 'quota' && !sameDay) ? state.problem : undefined;
  return {
    day: today,
    neurons: sameDay && Number.isFinite(state.neurons) ? Number(state.neurons) : 0,
    saved: sameDay && Number.isFinite(state.saved) ? Number(state.saved) : 0,
    // 14日より前の記録は捨てる
    attempts: (Array.isArray(state.attempts) ? state.attempts : []).filter(
      (attempt) => typeof attempt?.id === 'string' && now.getTime() - Date.parse(attempt.at) < 14 * DAY,
    ),
    ...(state.lastRun ? { lastRun: state.lastRun } : {}),
    ...(problem ? { problem } : {}),
  };
}

export function serializeAutoSummaryState(state: AutoSummaryState): string {
  return `${JSON.stringify(state, null, 1)}\n`;
}

/** 管理画面に出す自動要約の状況（試した記録の中身は渡さず、直近24時間の結果ごとの件数だけ） */
export interface AutoSummaryStatus {
  /** 使った量を数えている日（UTC） */
  day: string;
  saved: number;
  neurons: number;
  freeNeurons: number;
  lastRun?: AutoSummaryState['lastRun'];
  problem?: AutoSummaryState['problem'];
  /** 直近24時間に試した記事の結果（多い順） */
  recent: { result: AttemptResult; label: string; count: number }[];
}

export function autoSummaryStatus(state: AutoSummaryState, now: Date): AutoSummaryStatus {
  const counts = new Map<AttemptResult, number>();
  for (const attempt of state.attempts) {
    if (now.getTime() - Date.parse(attempt.at) >= DAY) continue;
    counts.set(attempt.result, (counts.get(attempt.result) ?? 0) + 1);
  }
  return {
    day: state.day,
    saved: state.saved,
    neurons: state.neurons,
    freeNeurons: FREE_NEURONS_PER_DAY,
    ...(state.lastRun ? { lastRun: state.lastRun } : {}),
    ...(state.problem ? { problem: state.problem } : {}),
    recent: [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([result, count]) => ({ result, label: ATTEMPT_LABELS[result] ?? result, count })),
  };
}
