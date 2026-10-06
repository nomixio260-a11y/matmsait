import { describe, expect, it } from 'vitest';
import {
  IDLE_TIMEOUT,
  LEGACY_TOKEN_KEY,
  MAX_FAILURES,
  MAX_SESSION,
  SESSION_KEY,
  clearFailures,
  createVault,
  currentSession,
  deleteVault,
  endSession,
  loadVault,
  lockRemaining,
  openVault,
  passwordProblem,
  recordFailure,
  saveVault,
  startSession,
  touchSession,
  type KeyValueStore,
} from '../src/lib/admin-auth.ts';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

// テストでは鍵を作る回数を減らして速くする
const iterations = 1000;

describe('トークンの暗号化', () => {
  it('正しいパスワードでだけトークンを取り出せる', async () => {
    const vault = await createVault('github_pat_secret', 'correct horse battery', { iterations, login: 'operator' });
    expect(vault.data).not.toContain('secret');
    expect(vault.login).toBe('operator');
    expect(await openVault(vault, 'correct horse battery')).toEqual({ token: 'github_pat_secret' });
    await expect(openVault(vault, 'wrong password!!')).rejects.toThrow('パスワードが違います');
  });

  it('本文を読むための鍵もトークンと一緒に暗号化して保存し、取り出せる', async () => {
    const textKey = { kid: '0123456789abcdef', publicKey: 'PUBLIC', privateKey: 'PRIVATE-KEY' };
    const vault = await createVault({ token: 'github_pat_secret', textKey }, 'correct horse battery', { iterations });
    expect(vault.data).not.toContain('PRIVATE');
    expect(await openVault(vault, 'correct horse battery')).toEqual({ token: 'github_pat_secret', textKey });
  });

  it('同じトークンとパスワードでも、毎回違う暗号文になる（salt と iv が毎回違う）', async () => {
    const a = await createVault('token', 'password-1234', { iterations });
    const b = await createVault('token', 'password-1234', { iterations });
    expect(a.data).not.toBe(b.data);
    expect(a.salt).not.toBe(b.salt);
  });

  it('保存すると以前の暗号化していないトークンは消え、壊れたデータは読まない', async () => {
    const store = memoryStore();
    store.setItem(LEGACY_TOKEN_KEY, 'plain-token');
    saveVault(store, await createVault('token', 'password-1234', { iterations }));
    expect(store.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    expect(loadVault(store)?.v).toBe(1);
    deleteVault(store);
    expect(loadVault(store)).toBeUndefined();
    store.setItem('admin.vault', '{"v":1}');
    expect(loadVault(store)).toBeUndefined();
  });
});

describe('passwordProblem', () => {
  it('短すぎる・同じ文字だけ・確認と違うパスワードを断る', () => {
    expect(passwordProblem('short')).toMatch(/10文字以上/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/同じ文字/);
    expect(passwordProblem('long enough pass', 'different')).toMatch(/一致しません/);
    expect(passwordProblem('long enough pass', 'long enough pass')).toBeUndefined();
  });
});

describe('ログイン中の状態', () => {
  it('操作がないまま30分たつか、ログインから8時間たつとログアウトする', () => {
    const store = memoryStore();
    const start = 1_000_000;
    startSession(store, 'token', 'operator', start);
    expect(currentSession(store, start + IDLE_TIMEOUT - 1)?.token).toBe('token');
    expect(currentSession(store, start + IDLE_TIMEOUT + 1)).toBeUndefined();
    expect(store.getItem(SESSION_KEY)).toBeNull();

    startSession(store, 'token', undefined, start);
    let now = start;
    while (now < start + MAX_SESSION - IDLE_TIMEOUT) {
      now += IDLE_TIMEOUT / 2;
      expect(touchSession(store, now)).toBeDefined();
    }
    expect(currentSession(store, start + MAX_SESSION + 1)).toBeUndefined();
  });

  it('本文を読むための鍵もログイン中の状態に入れる', () => {
    const store = memoryStore();
    const textKey = { kid: 'k', publicKey: 'p', privateKey: 's' };
    startSession(store, 'token', 'operator', 0, textKey);
    expect(currentSession(store, 1)?.textKey).toEqual(textKey);
  });

  it('ログアウトすると状態を消す', () => {
    const store = memoryStore();
    startSession(store, 'token', undefined, 0);
    endSession(store);
    expect(currentSession(store, 1)).toBeUndefined();
  });
});

describe('続けて間違えたときの制限', () => {
  it(`${MAX_FAILURES}回続けて間違えるとしばらくログインできず、間違えるたびに待ち時間が延びる`, () => {
    const store = memoryStore();
    const now = 5_000_000;
    for (let n = 1; n < MAX_FAILURES; n++) recordFailure(store, now);
    expect(lockRemaining(store, now)).toBe(0);
    recordFailure(store, now);
    expect(lockRemaining(store, now)).toBe(30_000);
    recordFailure(store, now);
    expect(lockRemaining(store, now)).toBe(60_000);
    expect(lockRemaining(store, now + 60_000)).toBe(0);
    clearFailures(store);
    expect(lockRemaining(store, now)).toBe(0);
  });
});
