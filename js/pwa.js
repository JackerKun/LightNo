/**
 * LIGHTNO · PWA：Service Worker、安装提示、离线状态
 */
import { toast } from './ui/toast.js';

let installPrompt = null;

export function initPWA() {
  registerServiceWorker();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    toast('已安装到桌面 · 断网也能使用', { type: 'success', duration: 3000 });
  });

  window.addEventListener('offline', () => {
    toast('已离线 · 测光与记录仍然可用', { type: 'warn', duration: 2600 });
  });

  window.addEventListener('online', () => {
    toast('网络已恢复', { type: 'success', duration: 1800 });
  });
}

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export async function promptInstall() {
  if (isStandalone()) {
    toast('已经在独立窗口中运行', { duration: 2000 });
    return;
  }
  if (!installPrompt) {
    toast('请用浏览器菜单「添加到主屏幕 / 安装应用」', { duration: 3400 });
    return;
  }
  installPrompt.prompt();
  try {
    const choice = await installPrompt.userChoice;
    if (choice && choice.outcome === 'accepted') {
      toast('正在安装 LIGHTNO…', { type: 'success', duration: 2200 });
    }
  } catch {
    /* ignore */
  }
  installPrompt = null;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    toast('LIGHTNO 有新版本', {
      duration: 0,
      action: {
        label: '刷新',
        onClick: () => window.location.reload()
      }
    });
  });

  window.addEventListener('load', register);
  if (document.readyState === 'complete') register();

  function register() {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              toast('LIGHTNO 有新版本', {
                duration: 0,
                action: { label: '刷新', onClick: () => window.location.reload() }
              });
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[LIGHTNO] Service Worker 注册失败', err);
      });
  }
}