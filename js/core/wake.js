/**
 * LIGHTNO · 屏幕常亮（Screen Wake Lock）
 */
let sentinel = null;
let enabled = false;

export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

async function acquire() {
  if (!isWakeLockSupported() || !enabled) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    return true;
  } catch {
    return false;
  }
}

export async function enableWakeLock() {
  enabled = true;
  return acquire();
}

export async function disableWakeLock() {
  enabled = false;
  if (sentinel) {
    try {
      await sentinel.release();
    } catch {
      /* ignore */
    }
    sentinel = null;
  }
}

export function setWakeLock(on) {
  return on ? enableWakeLock() : disableWakeLock();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled && !sentinel) acquire();
  });
}