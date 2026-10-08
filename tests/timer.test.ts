import { describe, expect, it } from 'vitest';
import {
  nextSocialAt,
  parseIntervalMinutes,
  parseSocialIntervalMinutes,
  planCycle,
  planWait,
  runTimer,
  waitBeforeUpdate,
  type SocialSlotInput,
  type TimerGitHub,
} from '../scripts/lib/timer.ts';

const MIN = 60 * 1000;

describe('parseIntervalMinutes', () => {
  it('既定は60分、15〜360分に収める', () => {
    expect(parseIntervalMinutes(undefined)).toBe(60);
    expect(parseIntervalMinutes('')).toBe(60);
    expect(parseIntervalMinutes('abc')).toBe(60);
    expect(parseIntervalMinutes('30')).toBe(30);
    expect(parseIntervalMinutes('5')).toBe(15);
    expect(parseIntervalMinutes('1000')).toBe(360);
  });
});

describe('parseSocialIntervalMinutes', () => {
  it('既定は30分、15〜360分に収める。0 以下なら投稿だけの実行をしない', () => {
    expect(parseSocialIntervalMinutes(undefined)).toBe(30);
    expect(parseSocialIntervalMinutes(' ')).toBe(30);
    expect(parseSocialIntervalMinutes('abc')).toBe(30);
    expect(parseSocialIntervalMinutes('45')).toBe(45);
    expect(parseSocialIntervalMinutes('10')).toBe(15);
    expect(parseSocialIntervalMinutes('1000')).toBe(360);
    expect(parseSocialIntervalMinutes('0')).toBe(0);
    expect(parseSocialIntervalMinutes('-5')).toBe(0);
  });
});

describe('nextSocialAt / planCycle（更新の合間の SNS の投稿）', () => {
  /** 前回の更新は 0 分。更新は60分ごと・投稿は30分ごと・次の更新の20分前より後には入れない */
  const slot = (extra: Partial<SocialSlotInput> = {}): SocialSlotInput => ({
    now: 5 * MIN,
    lastUpdateAt: 0,
    lastSocialAt: undefined,
    intervalMs: 60 * MIN,
    socialIntervalMs: 30 * MIN,
    socialMarginMs: 20 * MIN,
    socialAllowed: () => true,
    ...extra,
  });
  const cycle = (extra: Partial<SocialSlotInput> = {}) => planCycle({ ...slot(extra), elapsedMs: 0, maxJobWaitMs: 70 * MIN });

  it('前回の更新の30分後に投稿だけの実行をし、そのあとは次の更新を待つ', () => {
    expect(nextSocialAt(slot())).toBe(30 * MIN);
    expect(cycle()).toEqual({ action: 'wait', sleepMs: 25 * MIN, next: 'social', at: 30 * MIN });
    expect(cycle({ now: 30 * MIN })).toEqual({ action: 'social' });
    // 投稿だけの実行をしたあと（30分）は、次の更新（60分）まで待つ
    expect(nextSocialAt(slot({ now: 31 * MIN, lastSocialAt: 30 * MIN }))).toBeUndefined();
    expect(cycle({ now: 31 * MIN, lastSocialAt: 30 * MIN })).toEqual({ action: 'wait', sleepMs: 29 * MIN, next: 'update', at: 60 * MIN });
    expect(cycle({ now: 60 * MIN, lastSocialAt: 30 * MIN })).toEqual({ action: 'update' });
  });

  it('前回の更新から数え直す（管理画面からの更新のあとは、その30分後）。前の回の投稿だけの実行は数えない', () => {
    expect(nextSocialAt(slot({ now: 50 * MIN, lastUpdateAt: 45 * MIN, lastSocialAt: 30 * MIN }))).toBe(75 * MIN);
  });

  it('遅れたときはすぐに実行する。ただし次の更新の直前（20分前より後）なら、更新のあとの投稿に任せる', () => {
    expect(cycle({ now: 38 * MIN })).toEqual({ action: 'social' });
    expect(nextSocialAt(slot({ now: 41 * MIN }))).toBeUndefined();
    expect(cycle({ now: 41 * MIN })).toEqual({ action: 'wait', sleepMs: 19 * MIN, next: 'update', at: 60 * MIN });
  });

  it('深夜（投稿しない時間）は実行しない。更新の間隔が長ければ、深夜が明けてからの時刻にする', () => {
    expect(nextSocialAt(slot({ socialAllowed: () => false }))).toBeUndefined();
    const long = slot({ intervalMs: 180 * MIN, socialAllowed: (time) => time >= 100 * MIN });
    expect(nextSocialAt(long)).toBe(120 * MIN);
  });

  it('間隔が0・更新の記録がないときは、投稿だけの実行をしない', () => {
    expect(nextSocialAt(slot({ socialIntervalMs: 0 }))).toBeUndefined();
    expect(nextSocialAt(slot({ lastUpdateAt: undefined }))).toBeUndefined();
    expect(cycle({ lastUpdateAt: undefined })).toEqual({ action: 'update' });
  });

  it('次にすることがジョブで待てる時間より先なら、待てるだけ待ってから引き継ぐ', () => {
    expect(planCycle({ ...slot({ intervalMs: 360 * MIN, socialIntervalMs: 0, now: 0 }), elapsedMs: 0, maxJobWaitMs: 70 * MIN })).toEqual({
      action: 'handover',
      sleepMs: 70 * MIN,
      next: 'update',
      at: 360 * MIN,
    });
    expect(planCycle({ ...slot({ now: 0 }), elapsedMs: 60 * MIN, maxJobWaitMs: 70 * MIN })).toEqual({
      action: 'handover',
      sleepMs: 10 * MIN,
      next: 'social',
      at: 30 * MIN,
    });
  });
});

describe('waitBeforeUpdate / planWait', () => {
  it('前回の更新から間隔がたつまでの残り時間', () => {
    expect(waitBeforeUpdate(undefined, 1000, 60 * MIN)).toBe(0);
    expect(waitBeforeUpdate(0, 10 * MIN, 60 * MIN)).toBe(50 * MIN);
    expect(waitBeforeUpdate(0, 61 * MIN, 60 * MIN)).toBe(0);
  });

  it('待ちがジョブの上限を超えるときは、待てるだけ待ってから引き継ぐ（すぐには引き継がない）', () => {
    expect(planWait(0, 0, 70 * MIN)).toEqual({ action: 'update' });
    expect(planWait(50 * MIN, 0, 70 * MIN)).toEqual({ action: 'wait', sleepMs: 50 * MIN });
    expect(planWait(60 * MIN, 50 * MIN, 70 * MIN)).toEqual({ action: 'handover', sleepMs: 20 * MIN });
    expect(planWait(300 * MIN, 0, 70 * MIN)).toEqual({ action: 'handover', sleepMs: 70 * MIN });
  });
});

/** 時計を進める偽の sleep と、実行履歴を持つ偽の GitHub */
function harness({ runs = [] as number[], isPrivate = false, interval = 60, socialListed = true } = {}) {
  let clock = Date.parse('2026-10-06T09:00:00Z');
  const createdRuns = [...runs];
  const socialRuns: number[] = [];
  const dispatched: { workflow: string; at: number }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  /** sleep 中に起きること（管理画面の「今すぐ更新」など） */
  const during: ((at: number) => void)[] = [];
  /** 呼ばれると失敗する GitHub の操作（「list:social.yml」「dispatch:social.yml」など） */
  const failing = new Set<string>();
  const latest = (list: number[]) => [...list].sort((a, b) => b - a).slice(0, 1).map((at) => ({ created_at: new Date(at).toISOString() }));
  const github: TimerGitHub = {
    repository: async () => ({ defaultBranch: 'main', isPrivate }),
    listWorkflowRuns: async (workflow) => {
      if (failing.has(`list:${workflow}`)) throw new Error('HTTP 404');
      return latest(workflow === 'social.yml' ? socialRuns : createdRuns);
    },
    dispatchWorkflow: async (workflow) => {
      if (failing.has(`dispatch:${workflow}`)) throw new Error('HTTP 404');
      dispatched.push({ workflow, at: clock });
      if (workflow === 'update.yml') createdRuns.push(clock);
      // socialListed が false なら、実行の一覧にすぐには出てこない場合
      if (workflow === 'social.yml' && socialListed) socialRuns.push(clock);
    },
  };
  const options = {
    github,
    intervalMs: interval * MIN,
    maxJobWaitMs: 70 * MIN,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      const from = clock;
      clock += ms;
      for (const event of during) event(from);
    },
    jitter: () => 0,
    log: (message: string) => logs.push(message),
  };
  return {
    options,
    dispatched,
    sleeps,
    logs,
    createdRuns,
    socialRuns,
    failing,
    during,
    start: clock,
    addRun: (at: number) => createdRuns.push(at),
  };
}

describe('runTimer', () => {
  it('前回の更新から60分たってから更新し、次のタイマーを予約する', async () => {
    const h = harness();
    h.addRun(h.start - 10 * MIN);
    expect(await runTimer(h.options)).toBe('updated');
    expect(h.sleeps).toEqual([50 * MIN]);
    expect(h.dispatched.map((d) => d.workflow)).toEqual(['update.yml', 'timer.yml']);
    expect(h.dispatched[0].at - (h.start - 10 * MIN)).toBe(60 * MIN);
  });

  it('更新の記録がなければすぐに更新する', async () => {
    const h = harness();
    expect(await runTimer(h.options)).toBe('updated');
    expect(h.sleeps).toEqual([]);
    expect(h.dispatched.map((d) => d.workflow)).toEqual(['update.yml', 'timer.yml']);
  });

  it('待っている間に別の更新があれば、そこから数え直す（同じ時間帯に二重に更新しない）', async () => {
    const h = harness();
    h.addRun(h.start - 10 * MIN);
    // 待ち始めて30分後に「今すぐ更新」が押された
    let added = false;
    h.during.push((from) => {
      if (!added) {
        added = true;
        h.addRun(from + 30 * MIN);
      }
    });
    expect(await runTimer(h.options)).toBe('handed-over');
    // 50分待ったあと、手動更新から60分後まではこのジョブで待てない（上限70分）ので引き継ぐ
    expect(h.sleeps).toEqual([50 * MIN, 20 * MIN]);
    expect(h.dispatched.map((d) => d.workflow)).toEqual(['timer.yml']);
  });

  it('間隔が長くても、実行を次々に作らない（1回あたりジョブの上限まで待つ）', async () => {
    const h = harness({ interval: 360 });
    h.addRun(h.start);
    expect(await runTimer(h.options)).toBe('handed-over');
    expect(h.sleeps).toEqual([70 * MIN]);
    expect(h.dispatched).toEqual([{ workflow: 'timer.yml', at: h.start + 70 * MIN }]);
  });

  it('更新の合間（前回の更新の30分後）に SNS の投稿だけの実行をしてから、60分後に更新する', async () => {
    const h = harness();
    h.addRun(h.start - 10 * MIN);
    expect(await runTimer({ ...h.options, socialIntervalMs: 30 * MIN })).toBe('updated');
    expect(h.sleeps).toEqual([20 * MIN, 30 * MIN]);
    expect(h.dispatched).toEqual([
      { workflow: 'social.yml', at: h.start + 20 * MIN },
      { workflow: 'update.yml', at: h.start + 50 * MIN },
      { workflow: 'timer.yml', at: h.start + 50 * MIN },
    ]);
    expect(h.logs[0]).toMatch(/^SNS の投稿まで、あと約20分待ちます/);
  });

  it('投稿だけの実行が一覧にまだ出てこなくても、二重に実行しない', async () => {
    const h = harness({ socialListed: false });
    h.addRun(h.start - 10 * MIN);
    await runTimer({ ...h.options, socialIntervalMs: 30 * MIN });
    expect(h.dispatched.map((d) => d.workflow)).toEqual(['social.yml', 'update.yml', 'timer.yml']);
  });

  it('前の回の投稿だけの実行のあとに更新があれば、その更新から30分後に実行する', async () => {
    const h = harness();
    h.addRun(h.start - 25 * MIN);
    h.socialRuns.push(h.start - 50 * MIN);
    await runTimer({ ...h.options, socialIntervalMs: 30 * MIN });
    expect(h.dispatched.map((d) => `${d.workflow} ${(d.at - h.start) / MIN}`)).toEqual(['social.yml 5', 'update.yml 35', 'timer.yml 35']);
  });

  it('深夜は投稿だけの実行をしない', async () => {
    const h = harness();
    h.addRun(h.start - 10 * MIN);
    await runTimer({ ...h.options, socialIntervalMs: 30 * MIN, socialAllowed: () => false });
    expect(h.sleeps).toEqual([50 * MIN]);
    expect(h.dispatched.map((d) => d.workflow)).toEqual(['update.yml', 'timer.yml']);
  });

  it('投稿だけの実行ができなくても（ワークフローがないなど）、更新は続ける', async () => {
    for (const operation of ['list:social.yml', 'dispatch:social.yml']) {
      const h = harness();
      h.addRun(h.start - 10 * MIN);
      h.failing.add(operation);
      expect(await runTimer({ ...h.options, socialIntervalMs: 30 * MIN })).toBe('updated');
      expect(h.dispatched.map((d) => d.workflow)).toEqual(['update.yml', 'timer.yml']);
      expect(h.dispatched[0].at).toBe(h.start + 50 * MIN);
      expect(h.logs.some((log) => log.startsWith('::warning::SNS の投稿だけの実行'))).toBe(true);
    }
  });

  it('非公開リポジトリでは何もしない', async () => {
    const h = harness({ isPrivate: true });
    expect(await runTimer(h.options)).toBe('private');
    expect(h.dispatched).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });
});
