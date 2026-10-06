/**
 * 自動更新タイマーの計算（GitHub の定期実行に頼らず、前回の更新から一定時間ごとに更新するため）
 */

const MINUTE = 60 * 1000;

/** 更新の間隔（分）。リポジトリの変数 UPDATE_INTERVAL_MINUTES で変えられる（15〜360分、既定60分） */
export function parseIntervalMinutes(value: string | undefined): number {
  const minutes = Math.round(Number(value));
  if (!value?.trim() || !Number.isFinite(minutes)) return 60;
  return Math.min(360, Math.max(15, minutes));
}

/** 次の更新までの待ち時間（ミリ秒）。前回の更新がなければすぐ */
export function waitBeforeUpdate(lastUpdateAt: number | undefined, now: number, intervalMs: number): number {
  if (lastUpdateAt === undefined || Number.isNaN(lastUpdateAt)) return 0;
  return Math.max(0, lastUpdateAt + intervalMs - now);
}

export type TimerPlan =
  /** すぐに更新する */
  | { action: 'update' }
  /** sleepMs 待ってから、もう一度確かめる */
  | { action: 'wait'; sleepMs: number }
  /** sleepMs 待ってから、次のタイマー（新しい実行）に引き継ぐ */
  | { action: 'handover'; sleepMs: number };

/**
 * 次に何をするか。1つのジョブで待てる時間（maxJobWaitMs）を超える待ちは、待てるだけ待ってから
 * 次のタイマーに引き継ぐ（すぐに引き継ぐと、実行が短い間隔で次々に作られてしまうため）
 */
export function planWait(waitMs: number, elapsedMs: number, maxJobWaitMs: number): TimerPlan {
  if (waitMs <= 0) return { action: 'update' };
  const budget = Math.max(0, maxJobWaitMs - elapsedMs);
  return waitMs <= budget ? { action: 'wait', sleepMs: waitMs } : { action: 'handover', sleepMs: budget };
}

/** 日本時間の「10/6 18:23」 */
export function formatJst(time: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

export const minutes = (ms: number) => Math.round(ms / MINUTE);

export interface TimerGitHub {
  repository(): Promise<{ defaultBranch: string; isPrivate: boolean }>;
  listWorkflowRuns(workflow: string, perPage?: number, branch?: string): Promise<{ created_at: string }[]>;
  dispatchWorkflow(workflow: string, ref: string): Promise<void>;
}

export interface TimerOptions {
  github: TimerGitHub;
  intervalMs: number;
  /** 1つのジョブの中で待つ時間の上限 */
  maxJobWaitMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 毎回同じ時刻にならないようにずらす時間 */
  jitter: () => number;
  log: (message: string) => void;
  updateWorkflow?: string;
  timerWorkflow?: string;
}

export type TimerResult = 'updated' | 'handed-over' | 'private';

/**
 * 前回の更新から intervalMs たつまで待って更新を実行し、次のタイマーを予約する。
 * 待っている間に別の更新（管理画面の「今すぐ更新」など）があれば、そこからまた数え直す
 */
export async function runTimer({
  github,
  intervalMs,
  maxJobWaitMs,
  now,
  sleep,
  jitter,
  log,
  updateWorkflow = 'update.yml',
  timerWorkflow = 'timer.yml',
}: TimerOptions): Promise<TimerResult> {
  const started = now();
  const { defaultBranch, isPrivate } = await github.repository();
  if (isPrivate) {
    // 非公開リポジトリでは Actions の実行時間に上限（無料枠）があるので、待ち続ける仕組みは使わない
    log('::warning::非公開リポジトリのため、自動更新タイマーを止めました（公開リポジトリでだけ動きます）');
    return 'private';
  }

  for (;;) {
    // 既定ブランチで最後に作られた収集・公開の実行（タイマー・手動・push のどれでも）
    const [latest] = await github.listWorkflowRuns(updateWorkflow, 1, defaultBranch);
    const wait = waitBeforeUpdate(latest ? Date.parse(latest.created_at) : undefined, now(), intervalMs);
    const plan = planWait(wait, now() - started, maxJobWaitMs);
    if (plan.action === 'update') break;
    if (plan.action === 'handover') {
      // 間隔が長いときは、このジョブで待てるだけ待ってから次のタイマーに任せる
      log(`次の更新は ${formatJst(now() + wait)} ごろ。${minutes(plan.sleepMs)}分待ってから次のタイマーに引き継ぎます`);
      await sleep(plan.sleepMs);
      await github.dispatchWorkflow(timerWorkflow, defaultBranch);
      log(`次のタイマーに引き継ぎました（次の更新は ${formatJst(now() + wait - plan.sleepMs)} ごろ）`);
      return 'handed-over';
    }
    log(`前回の更新から${minutes(intervalMs)}分たつまで、あと約${minutes(wait)}分待ちます（${formatJst(now() + wait)} ごろ）`);
    await sleep(plan.sleepMs + jitter());
  }

  await github.dispatchWorkflow(updateWorkflow, defaultBranch);
  await github.dispatchWorkflow(timerWorkflow, defaultBranch);
  log(`収集・公開（${updateWorkflow}）を実行しました。次の更新は ${formatJst(now() + intervalMs)} ごろです`);
  return 'updated';
}
