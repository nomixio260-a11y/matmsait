import { describe, expect, it } from 'vitest';
import { parseIntervalMinutes, planWait, runTimer, waitBeforeUpdate, type TimerGitHub } from '../scripts/lib/timer.ts';

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
function harness({ runs = [] as number[], isPrivate = false, interval = 60 } = {}) {
  let clock = Date.parse('2026-10-06T09:00:00Z');
  const createdRuns = [...runs];
  const dispatched: { workflow: string; at: number }[] = [];
  const sleeps: number[] = [];
  /** sleep 中に起きること（管理画面の「今すぐ更新」など） */
  const during: ((at: number) => void)[] = [];
  const github: TimerGitHub = {
    repository: async () => ({ defaultBranch: 'main', isPrivate }),
    listWorkflowRuns: async () =>
      [...createdRuns].sort((a, b) => b - a).slice(0, 1).map((at) => ({ created_at: new Date(at).toISOString() })),
    dispatchWorkflow: async (workflow) => {
      dispatched.push({ workflow, at: clock });
      if (workflow === 'update.yml') createdRuns.push(clock);
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
    log: () => {},
  };
  return { options, dispatched, sleeps, createdRuns, during, start: clock, addRun: (at: number) => createdRuns.push(at) };
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

  it('非公開リポジトリでは何もしない', async () => {
    const h = harness({ isPrivate: true });
    expect(await runTimer(h.options)).toBe('private');
    expect(h.dispatched).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });
});
