/** 触感反馈（支持的设备） */
export function haptic(pattern = 10) {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

export function hapticTap() {
  haptic(8);
}

export function hapticSave() {
  haptic([6, 28, 14]);
}

export function hapticError() {
  haptic([18, 40, 18]);
}