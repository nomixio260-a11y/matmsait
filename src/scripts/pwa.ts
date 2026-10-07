/**
 * ホーム画面への追加（PWA）とサービスワーカーの登録。
 * - サービスワーカー（public/sw.js）: オフラインのときに前に見たページを出し、名前にハッシュの入るファイルを使い回して表示を速くする
 * - 「ホーム画面に追加」の案内: 2回目以降に来た人にだけ、画面の下に小さく出す（閉じたら30日は出さない）
 */
import { toast } from './personal.ts';
import { serviceWorkerUrl } from './sw-url.ts';

const INSTALL_KEY = 'matmsait:install';
/** 閉じたあと、もう一度案内するまでの日数 */
const SNOOZE_DAYS = 30;

/** ページの表示が終わってから、サービスワーカーを登録する（まだなら） */
export function registerServiceWorker(base: string, apiBase: string): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const script = serviceWorkerUrl(base, apiBase);
  const run = async () => {
    try {
      const existing = await navigator.serviceWorker.getRegistration(`${base}/`);
      if (existing?.active && new URL(existing.active.scriptURL).search === new URL(script, location.href).search) return;
      await navigator.serviceWorker.register(script, { scope: `${base}/` });
    } catch {
      // 登録できなくてもサイトはそのまま使える
    }
  };
  const later = () => setTimeout(() => void run(), 2000);
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}

function readDismissed(): number {
  try {
    const data = JSON.parse(localStorage.getItem(INSTALL_KEY) ?? '{}') as { dismissedAt?: unknown };
    return typeof data.dismissedAt === 'number' ? data.dismissedAt : 0;
  } catch {
    return Date.now();
  }
}

function dismiss(): void {
  try {
    localStorage.setItem(INSTALL_KEY, JSON.stringify({ dismissedAt: Date.now() }));
  } catch {
    // 保存できない環境では、このページの間だけ閉じる
  }
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** 画面の下に出す案内 */
function showBanner(text: string, action?: { label: string; run: () => void }): void {
  if (document.querySelector('.install-bar')) return;
  const bar = document.createElement('aside');
  bar.className = 'install-bar';
  bar.setAttribute('aria-label', 'ホーム画面に追加');
  const message = document.createElement('p');
  message.textContent = text;
  bar.append(message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn primary';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      bar.remove();
      action.run();
    });
    bar.append(button);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'install-close';
  close.setAttribute('aria-label', '案内を閉じる');
  close.textContent = '×';
  close.addEventListener('click', () => {
    dismiss();
    bar.remove();
  });
  bar.append(close);
  document.body.append(bar);
}

/**
 * 「ホーム画面に追加」の案内（前にも来た人だけ）。
 * Chrome などは追加の画面を出せる。iPhone・iPad の Safari は共有ボタンからの手順を案内する
 */
export function setupInstallPrompt(returning: boolean): void {
  if (isStandalone() || !returning) return;
  if (Date.now() - readDismissed() < SNOOZE_DAYS * 24 * 60 * 60 * 1000) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|Line\//.test(navigator.userAgent);
  if (ios && safari) {
    // 少し読んでから出す（開いてすぐに出すと邪魔になる）
    setTimeout(() => showBanner('共有ボタン（□と↑）から「ホーム画面に追加」すると、トピあつめをアプリのようにすぐ開けます。'), 15_000);
    return;
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    const install = event as InstallPromptEvent;
    setTimeout(
      () =>
        showBanner('ホーム画面に追加すると、話題のニュースをアプリのようにすぐ開けます。', {
          label: '追加する',
          run: () => {
            void install.prompt().then(async () => {
              const choice = await install.userChoice;
              if (choice.outcome === 'accepted') toast('ホーム画面に追加しました');
              else dismiss();
            });
          },
        }),
      15_000,
    );
  });
}
