// 自動更新タイマー（.github/workflows/timer.yml から実行）
//
// 前回の収集・公開（update.yml）から一定時間（既定60分）たつまで待ち、update.yml を実行してから、
// 自分自身（timer.yml）を次に予約する。これを繰り返して定期的に更新する。
// GitHub の定期実行（schedule）は新しいリポジトリだと動かないことがあるため、この仕組みを使う。
//
// 環境変数: GITHUB_TOKEN（Actions の読み書き）、GITHUB_REPOSITORY（owner/repo）、UPDATE_INTERVAL_MINUTES（任意）
import { appendFileSync } from 'node:fs';
import { createGitHubClient } from '../src/lib/github-commit.ts';
import { parseIntervalMinutes, runTimer } from './lib/timer.ts';
import { jitter, sleep } from './lib/timing.ts';

/** 1つのジョブの中で待つ時間の上限（ワークフローのジョブの制限時間 80分より短く） */
const MAX_JOB_WAIT = 70 * 60 * 1000;

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');

try {
  if (!token || !owner || !repo) throw new Error('GITHUB_TOKEN と GITHUB_REPOSITORY が必要です');
  await runTimer({
    github: createGitHubClient(token, { owner, repo }),
    intervalMs: parseIntervalMinutes(process.env.UPDATE_INTERVAL_MINUTES) * 60 * 1000,
    maxJobWaitMs: MAX_JOB_WAIT,
    now: Date.now,
    sleep,
    jitter: () => jitter(5_000, 90_000),
    log: (message) => {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
    },
  });
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
