/**
 * LIGHTNO · 全局状态（设置持久化 + 运行时状态 + 订阅）
 */
import { MIN_SHUTTER, MAX_SHUTTER } from './exposure.js';

const STORAGE_KEY = 'lightno.settings.v1';

export const MODES = ['spot', 'area', 'center', 'average', 'highlight', 'shadow'];

export const MODE_META = {
  spot: { label: '点测光', tag: 'SPOT', shape: 'circle', hint: '拖动圆框对准主体' },
  area: { label: '区域框选', tag: 'AREA', shape: 'rect', hint: '拖动方框选择区域' },
  center: { label: '中央重点', tag: 'CENTER', shape: 'center', hint: '画面中心权重最高' },
  average: { label: '平均测光', tag: 'AVERAGE', shape: 'full', hint: '整幅画面平均亮度' },
  highlight: { label: '高光优先', tag: 'HIGHLIGHT', shape: 'full', hint: '保护高光（ZONE VIII）' },
  shadow: { label: '暗部优先', tag: 'SHADOW', shape: 'full', hint: '保留暗部（ZONE III）' }
};

export const DEFAULT_SETTINGS = Object.freeze({
  // 曝光参数
  iso: 100,
  aperture: 8,
  priority: 'aperture',
  shutter: 1 / 125,
  ndStops: 0,
  // 测光
  mode: 'spot',
  spotSize: 0.14,
  targetZone: 5,
  zone: { cx: 0.5, cy: 0.5 },
  zoom: 1,
  // 引擎
  engine: 'image',
  lensAperture: 1.8,
  calibration: 0,
  anchorEv: 12,
  fps: 10,
  smoothing: 0.35,
  // 显示
  showHistogram: true,
  showZebra: true,
  showGrid: false,
  keepAwake: false,
  // 记录
  geotag: false,
  quality: 0.82,
  // 引导
  onboarded: false,
  calibrated: false
});

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function sanitize(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) };
  return {
    ...s,
    iso: clampNum(s.iso, 25, 102400, 100),
    aperture: clampNum(s.aperture, 0.95, 45, 8),
    priority: s.priority === 'shutter' ? 'shutter' : 'aperture',
    shutter: clampNum(s.shutter, MIN_SHUTTER, MAX_SHUTTER, 1 / 125),
    ndStops: clampNum(s.ndStops, 0, 20, 0),
    mode: MODES.includes(s.mode) ? s.mode : 'spot',
    spotSize: clampNum(s.spotSize, 0.04, 0.6, 0.14),
    targetZone: Math.round(clampNum(s.targetZone, 3, 8, 5)),
    zone: {
      cx: clampNum(s.zone?.cx, 0, 1, 0.5),
      cy: clampNum(s.zone?.cy, 0, 1, 0.5)
    },
    zoom: clampNum(s.zoom, 1, 12, 1),
    lensAperture: clampNum(s.lensAperture, 0.95, 5.6, 1.8),
    engine: s.engine === 'hardware' ? 'hardware' : 'image',
    calibration: clampNum(s.calibration, -6, 6, 0),
    anchorEv: clampNum(s.anchorEv, -6, 22, 12),
    fps: clampNum(s.fps, 4, 20, 10),
    smoothing: clampNum(s.smoothing, 0.05, 1, 0.35),
    quality: clampNum(s.quality, 0.5, 0.95, 0.82),
    showHistogram: !!s.showHistogram,
    showZebra: !!s.showZebra,
    showGrid: !!s.showGrid,
    keepAwake: !!s.keepAwake,
    geotag: !!s.geotag,
    onboarded: !!s.onboarded,
    calibrated: !!s.calibrated
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return sanitize(null);
    return sanitize(JSON.parse(raw));
  } catch {
    return sanitize(null);
  }
}

const state = {
  settings: load(),
  runtime: {
    view: 'meter',
    locked: false,
    source: 'init', // init | hardware | auto | image | demo | error
    cameraReady: false,
    manual: false,
    hardwareZoomMax: 1,
    digitalZoom: 1,
    capabilities: null,
    ev: null,
    shotCount: 0,
    savedThisSession: 0,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    installPrompt: null
  }
};

const listeners = new Set();
let persistTimer = null;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error('[LIGHTNO] listener error', err);
    }
  }
}

export function getSettings() {
  return state.settings;
}

export function getRuntime() {
  return state.runtime;
}

export function updateSettings(patch, { persist = true, silent = false } = {}) {
  state.settings = sanitize({ ...state.settings, ...patch });
  if (persist) schedulePersist();
  if (!silent) emit({ type: 'settings', patch });
  return state.settings;
}

export function setRuntime(patch, reason = 'runtime') {
  Object.assign(state.runtime, patch);
  emit({ type: 'runtime', patch, reason });
  return state.runtime;
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushSettings, 250);
}

export function flushSettings() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch (err) {
    console.warn('[LIGHTNO] 无法保存设置', err);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSettings);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSettings();
  });
}

export function resetSettings() {
  state.settings = sanitize(null);
  flushSettings();
  emit({ type: 'settings', patch: state.settings });
}