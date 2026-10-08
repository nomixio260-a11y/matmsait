/**
 * 自動更新タイマーの計算（GitHub の定期実行に頼らず、前回の更新から一定時間ごとに更新するため）。
 * 更新の合間には、SNS の投稿だけの実行（social.yml）も入れる（更新は1時間ごと・投稿は30分ごと）
 */

const MINUTE = 60 * 1000;

/** 更新の間隔（分）。リポジトリの変数 UPDATE_INTERVAL_MINUTES で変えられる（15〜360分、既定60分） */
export function parseIntervalMinutes(value: string | undefined): number {
  const minutes = Math.round(Number(value));
  if (!value?.trim() || !Number.isFinite(minutes)) return 60;
  return Math.min(360, Math.max(15, minutes));
}

/**
 * SNS の投稿の間隔（分）。リポジトリの変数 SOCIAL_INTERVAL_MINUTES で変えられる（15〜360分、既定30分）。
 * 0 にすると、更新の合間の投稿だけの実行をやめる（投稿は毎回の更新のあとだけになる）
 */
export function parseSocialIntervalMinutes(value: string | undefined): number {
  const minutes = Math.round(Number(value));
  if (!value?.trim() || !Number.isFinite(minutes)) return 30;
  if (minutes <= 0) return 0;
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

export interface SocialSlotInput {
  now: number;
  /** 最後の収集・公開（update.yml）の実行が作られた日時 */
  lastUpdateAt: number | undefined;
  /** 最後の SNS の投稿だけの実行（social.yml）が作られた日時 */
  lastSocialAt: number | undefined;
  intervalMs: number;
  /** SNS の投稿の間隔（0 なら投稿だけの実行はしない） */
  socialIntervalMs: number;
  /** 次の更新の直前（この時間より後）には投稿だけの実行を入れない（更新のあとの投稿と続けて投稿しないように） */
  socialMarginMs: number;
  /** この時刻に投稿してよいか（深夜は投稿しないので、実行もしない） */
  socialAllowed: (time: number) => boolean;
}

/**
 * 次の SNS の投稿だけの実行の時刻。最後の更新・投稿だけの実行のうち遅い方から socialIntervalMs 後（過ぎていれば今）。
 * 次の更新の直前に当たるとき・深夜で次の更新までに投稿できる時刻がないときは undefined（更新のあとの投稿に任せる）
 */
export function nextSocialAt({
  now,
  lastUpdateAt,
  lastSocialAt,
  intervalMs,
  socialIntervalMs,
  socialMarginMs,
  socialAllowed,
}: SocialSlotInput): number | undefined {
  if (socialIntervalMs <= 0 || lastUpdateAt === undefined || Number.isNaN(lastUpdateAt)) return undefined;
  const latest = lastSocialAt !== undefined && !Number.isNaN(lastSocialAt) ? Math.max(lastUpdateAt, lastSocialAt) : lastUpdateAt;
  const limit = lastUpdateAt + intervalMs - socialMarginMs;
  let at = Math.max(latest + socialIntervalMs, now);
  while (at <= limit && !socialAllowed(at)) at += socialIntervalMs;
  return at <= limit ? at : undefined;
}

export type CyclePlan =
  /** すぐに更新する */
  | { action: 'update' }
  /** すぐに SNS の投稿だけの実行をする */
  | { action: 'social' }
  /** sleepMs 待ってから、もう一度確かめる（next: 次にすること、at: その時刻） */
  | { action: 'wait'; sleepMs: number; next: 'update' | 'social'; at: number }
  /** sleepMs 待ってから、次のタイマーに引き継ぐ */
  | { action: 'handover'; sleepMs: number; next: 'update' | 'social'; at: number };

/** 更新・SNS の投稿だけの実行・待つ・引き継ぐのどれをするか */
export function planCycle(input: SocialSlotInput & { elapsedMs: number; maxJobWaitMs: number }): CyclePlan {
  const updateWait = waitBeforeUpdate(input.lastUpdateAt, input.now, input.intervalMs);
  if (updateWait <= 0) return { action: 'update' };
  const socialAt = nextSocialAt(input);
  if (socialAt !== undefined && socialAt <= input.now) return { action: 'social' };
  const next = socialAt !== undefined ? 'social' : 'update';
  const at = socialAt ?? input.now + updateWait;
  const plan = planWait(at - input.now, input.elapsedMs, input.maxJobWaitMs);
  return plan.action === 'update' ? { action: next } : { ...plan, next, at };
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
  /** 更新の合間に SNS の投稿だけの実行（socialWorkflow）をする間隔（0・省略なら実行しない） */
  socialIntervalMs?: number;
  /** 次の更新の直前（この時間より後）には投稿だけの実行を入れない */
  socialMarginMs?: number;
  /** この時刻に投稿してよいか */
  socialAllowed?: (time: number) => boolean;
  socialWorkflow?: string;
}

export type TimerResult = 'updated' | 'handed-over' | 'private';

/**
 * 前回の更新から intervalMs たつまで待って更新を実行し、次のタイマーを予約する。
 * 待っている間に別の更新（管理画面の「今すぐ更新」など）があれば、そこからまた数え直す。
 * socialIntervalMs があれば、更新の合間（前回の更新から socialIntervalMs 後など）に SNS の投稿だけの実行もする
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
  socialIntervalMs = 0,
  socialMarginMs = 20 * MINUTE,
  socialAllowed = () => true,
  socialWorkflow = 'social.yml',
}: TimerOptions): Promise<TimerResult> {
  const started = now();
  const { defaultBranch, isPrivate } = await github.repository();
  if (isPrivate) {
    // 非公開リポジトリでは Actions の実行時間に上限（無料枠）があるので、待ち続ける仕組みは使わない
    log('::warning::非公開リポジトリのため、自動更新タイマーを止めました（公開リポジトリでだけ動きます）');
    return 'private';
  }

  let social = socialIntervalMs > 0;
  /** このジョブが投稿だけの実行をした日時（実行の一覧にすぐには出てこないことがあるので、二重に実行しないよう覚えておく） */
  let socialDispatchedAt: number | undefined;
  /** 投稿だけの実行がうまくいかなければ、このジョブでは投稿だけの実行をやめる（更新は続ける） */
  const stopSocial = (error: unknown) => {
    social = false;
    log(`::warning::SNS の投稿だけの実行（${socialWorkflow}）ができませんでした（更新は続けます）: ${error instanceof Error ? error.message : error}`);
  };

  for (;;) {
    // 既定ブランチで最後に作られた収集・公開の実行（タイマー・手動・push のどれでも）
    const [latest] = await github.listWorkflowRuns(updateWorkflow, 1, defaultBranch);
    const lastUpdateAt = latest ? Date.parse(latest.created_at) : undefined;
    let lastSocialAt = socialDispatchedAt;
    if (social) {
      try {
        const [run] = await github.listWorkflowRuns(socialWorkflow, 1, defaultBranch);
        const runAt = run ? Date.parse(run.created_at) : Number.NaN;
        if (!Number.isNaN(runAt)) lastSocialAt = Math.max(lastSocialAt ?? runAt, runAt);
      } catch (error) {
        stopSocial(error);
      }
    }
    const plan = planCycle({
      now: now(),
      lastUpdateAt,
      lastSocialAt,
      intervalMs,
      socialIntervalMs: social ? socialIntervalMs : 0,
      socialMarginMs,
      socialAllowed,
      elapsedMs: now() - started,
      maxJobWaitMs,
    });
    const nextUpdate = formatJst((lastUpdateAt ?? now()) + intervalMs);
    if (plan.action === 'update') break;
    if (plan.action === 'social') {
      try {
        await github.dispatchWorkflow(socialWorkflow, defaultBranch);
        log(`SNS の投稿（${socialWorkflow}）を実行しました。次の更新は ${nextUpdate} ごろです`);
      } catch (error) {
        stopSocial(error);
      }
      socialDispatchedAt = now();
      continue;
    }
    const what = plan.next === 'social' ? 'SNS の投稿' : '次の更新';
    if (plan.action === 'handover') {
      // 間隔が長いときは、このジョブで待てるだけ待ってから次のタイマーに任せる
      log(`${what}は ${formatJst(plan.at)} ごろ。${minutes(plan.sleepMs)}分待ってから次のタイマーに引き継ぎます`);
      await sleep(plan.sleepMs);
      await github.dispatchWorkflow(timerWorkflow, defaultBranch);
      log(`次のタイマーに引き継ぎました（${what}は ${formatJst(plan.at)} ごろ）`);
      return 'handed-over';
    }
    log(
      plan.next === 'social'
        ? `SNS の投稿まで、あと約${minutes(plan.sleepMs)}分待ちます（${formatJst(plan.at)} ごろ。次の更新は ${nextUpdate} ごろ）`
        : `前回の更新から${minutes(intervalMs)}分たつまで、あと約${minutes(plan.sleepMs)}分待ちます（${formatJst(plan.at)} ごろ）`,
    );
    await sleep(plan.sleepMs + jitter());
  }

  await github.dispatchWorkflow(updateWorkflow, defaultBranch);
  await github.dispatchWorkflow(timerWorkflow, defaultBranch);
  log(`収集・公開（${updateWorkflow}）を実行しました。次の更新は ${formatJst(now() + intervalMs)} ごろです`);
  return 'updated';
}
