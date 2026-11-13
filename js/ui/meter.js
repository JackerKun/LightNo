/**
 * LIGHTNO · 测光视图
 *
 * 数据流：
 *   camera/video → FrameSampler（线性亮度）→ analyze（区域统计）
 *   → 求 EV（相机手动曝光 或 相对锚点）→ 平滑 → 读数 / 推荐曝光 / 记录
 */
import { $, setText, timeLabel, shortDate, uid } from './dom.js';
import {
  getSettings,
  updateSettings,
  getRuntime,
  setRuntime,
  subscribe,
  MODE_META
} from '../core/state.js';
import { Camera, translateError } from '../core/camera.js';
import { FrameSampler, analyze, LOG_MIN, LOG_RANGE } from '../core/sampler.js';
import { createDemoScene } from '../core/demo.js';
import { putShot } from '../core/store.js';
import { composePhoto } from '../core/capture.js';
import {
  MID_GRAY,
  log2,
  clamp,
  shutterFromEv,
  formatShutter,
  formatShutterExact,
  formatShutterRecommended,
  formatAperture,
  formatEv,
  formatLuminance,
  formatCct,
  ndLabel,
  ndDensity,
  zoneRoman,
  contrastStops,
  cctFromLinearRgb,
  luminanceFromEv,
  stepArray,
  exposurePair,
  APERTURES,
  ISOS,
  SHUTTERS
} from '../core/exposure.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';
import { hapticTap, hapticSave, hapticError } from './haptic.js';
import { attachStageGestures } from './gestures.js';
import {
  pickIso,
  pickAperture,
  pickShutter,
  pickNd,
  openCalibration,
  openMeterOptions
} from './pickers.js';
import { setWakeLock } from '../core/wake.js';

const dom = {
  stage: $('#stage'),
  video: $('#camera'),
  zebra: $('#zebra'),
  grid: $('#grid'),
  histogram: $('#histogram'),
  zone: $('#zone'),
  zoneLabel: $('#zoneLabel'),
  zoneGrip: $('#zoneGrip'),
  tagMode: $('#tagMode'),
  tagZoom: $('#tagZoom'),
  tagLock: $('#tagLock'),
  tagDemo: $('#tagDemo'),
  hudHint: $('#hudHint'),
  shutter: $('#btnCapture'),
  zoomInput: $('#zoomInput'),
  zoomValue: $('#zoomValue'),
  zoomMax: $('#zoomMax'),
  fallback: $('#stageFallback'),
  fallbackTitle: $('#fallbackTitle'),
  fallbackMsg: $('#fallbackMsg'),
  retry: $('#btnRetryCam'),
  demoBtn: $('#btnDemo'),
  evValue: $('#evValue'),
  evSub: $('#evSub'),
  evHold: $('#evHold'),
  evHoldText: $('#evHoldText'),
  evLockIcon: $('#evLockIcon'),
  readoutPanel: $('#readoutPanel'),
  metricLum: $('#metricLum'),
  metricDr: $('#metricDr'),
  metricCct: $('#metricCct'),
  metricZone: $('#metricZone'),
  cellIso: $('#cellIso'),
  cellAperture: $('#cellAperture'),
  cellShutter: $('#cellShutter'),
  cellNd: $('#cellNd'),
  autoAperture: $('#autoAperture'),
  autoShutter: $('#autoShutter'),
  valIso: $('#valIso'),
  valIsoNote: $('#valIsoNote'),
  valAperture: $('#valAperture'),
  valApertureNote: $('#valApertureNote'),
  valShutter: $('#valShutter'),
  valShutterNote: $('#valShutterNote'),
  valNd: $('#valNd'),
  valNdNote: $('#valNdNote'),
  dialWheel: $('#dialWheel'),
  dialWheelLabel: $('#dialWheelLabel'),
  dialWheelList: $('#dialWheelList'),
  ladder: $('#ladder'),
  modeRow: $('#modeRow'),
  btnOptions: $('#btnMeterOptions'),
  statusChip: $('#statusChip'),
  statusText: $('#statusText'),
  btnLock: $('#btnLock')
};

let camera = null;
const sampler = new FrameSampler();
let demo = null;
let sourceEl = null;
let running = false;
let cameraStarting = false;
let rafId = null;
let usingVideoFrameCallback = false;
let lastSample = 0;
let lastUi = 0;
let lastAe = 0;
let stats = null;
let evSmooth = null;
let lockSnapshot = null;
let cameraHwZoom = 1;
let digitalZoom = 1;
let shotBusy = false;
let ladderSignature = '';
let gestureCtl = null;
let wakeActive = false;
let started = false;
let onSavedCb = null;
let onNavigateCb = null;

const zone = {
  cx: getSettings().zone.cx,
  cy: getSettings().zone.cy,
  size: getSettings().spotSize
};

let zoomToken = 0;
let exposureBusy = false;

function stageAspect() {
  const rect = dom.stage.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return 3 / 4;
  return rect.width / rect.height;
}

function sourceLabel(source) {
  switch (source) {
    case 'hardware':
      return '硬件测光';
    case 'relative':
      return '相对测光';
    case 'demo':
      return '演示模式';
    case 'error':
      return '相机异常';
    default:
      return '启动中';
  }
}

function updateStatus() {
  const rt = getRuntime();
  dom.statusChip.dataset.source = rt.source;
  setText(dom.statusText, sourceLabel(rt.source));
  dom.tagDemo.hidden = rt.source !== 'demo';
  dom.tagLock.hidden = !rt.locked;
  syncHoldUI();
}

/** 同步 HOLD 视觉状态（EV 按钮 / 面板 / 顶栏锁 / 阶段标签） */
function syncHoldUI() {
  const locked = !!getRuntime().locked;
  if (dom.evHold) {
    dom.evHold.classList.toggle('is-held', locked);
    dom.evHold.setAttribute('aria-pressed', String(locked));
    dom.evHold.setAttribute('aria-label', locked ? '解除测光锁定' : '锁定测光读数');
  }
  if (dom.evHoldText) dom.evHoldText.textContent = locked ? '解除' : 'HOLD';
  if (dom.evLockIcon) dom.evLockIcon.hidden = !locked;
  if (dom.readoutPanel) dom.readoutPanel.classList.toggle('is-held', locked);
  if (dom.btnLock) {
    dom.btnLock.classList.toggle('is-held', locked);
    dom.btnLock.setAttribute('aria-pressed', String(locked));
    dom.btnLock.setAttribute('aria-label', locked ? '解除测光锁定' : '锁定测光');
  }
}

function showCameraError(err) {
  const ce = err || {};
  setRuntime({
    source: 'error',
    cameraReady: false,
    cameraError: {
      code: ce.code || 'UNKNOWN',
      message: ce.message || '相机启动失败',
      hint: ce.hint || '请检查浏览器权限后重试'
    }
  });
  updateStatus();
  dom.fallback.hidden = false;
  setText(dom.fallbackTitle, ce.message || '相机启动失败');
  setText(dom.fallbackMsg, ce.hint || '请检查浏览器权限后重试。');
  hapticError();
}

async function startCamera() {
  if (cameraStarting) return;
  cameraStarting = true;
  unmountDemoLayer();
  if (!camera) camera = new Camera(dom.video);
  setRuntime({ source: 'init', cameraReady: false, cameraError: null });
  updateStatus();
  dom.fallback.hidden = true;

  try {
    const result = await camera.start();
    const caps = result.capabilities || {};
    setRuntime({
      source: result.manual ? 'hardware' : 'relative',
      manual: !!result.manual,
      cameraReady: true,
      hardwareZoomMax: result.hardwareZoomMax || 1,
      capabilities: {
        exposureMode: caps.exposureMode || null,
        exposureTime: caps.exposureTime ? { ...caps.exposureTime } : null,
        iso: caps.iso ? { ...caps.iso } : null,
        zoom: caps.zoom ? { ...caps.zoom } : null,
        torch: !!caps.torch
      },
      cameraError: null
    });
    sourceEl = dom.video;
    cameraHwZoom = 1;
    updateZoomRange();
    updateStatus();
    await applyZoom(getSettings().zoom);

    if (getRuntime().locked && lockSnapshot && lockSnapshot.cameraExposure && camera.manual) {
      try {
        await camera.setExposure(lockSnapshot.cameraExposure);
      } catch {
        /* ignore */
      }
    }

    lastAe = 0;

    if (!result.manual) {
      toast('此设备不支持相机手动曝光，已启用相对测光', {
        type: 'warn',
        duration: 4200,
        action: { label: '去设置', onClick: () => onNavigateCb && onNavigateCb('settings') }
      });
    }
  } catch (err) {
    showCameraError(err);
  } finally {
    cameraStarting = false;
  }
}

function stopCamera() {
  if (camera) {
    camera.stop();
    camera = null;
  }
  if (sourceEl === dom.video) sourceEl = null;
}

function mountDemoLayer() {
  if (!demo) demo = createDemoScene();
  const canvas = demo.canvas;
  canvas.classList.add('stage__video');
  canvas.setAttribute('aria-hidden', 'true');
  if (!canvas.isConnected) {
    dom.stage.insertBefore(canvas, dom.zebra);
  }
  canvas.hidden = false;
  dom.video.hidden = true;
}

function unmountDemoLayer() {
  if (demo && demo.canvas.isConnected) demo.canvas.hidden = true;
  dom.video.hidden = false;
}

function startDemo() {
  if (!demo) demo = createDemoScene();
  if (camera) {
    camera.stop();
    camera = null;
  }
  mountDemoLayer();
  setRuntime({ source: 'demo', cameraReady: true, manual: false, cameraError: null });
  sourceEl = demo.canvas;
  dom.fallback.hidden = true;
  evSmooth = null;
  lastAe = 0;
  updateStatus();
  toast('演示模式：程序绘制的场景，可直接体验测光', { duration: 3000 });
  if (!running) {
    running = true;
    schedule();
  }
}

async function ensureSource() {
  const rt = getRuntime();
  if (rt.source === 'demo') {
    if (!demo) demo = createDemoScene();
    sourceEl = demo.canvas;
    return;
  }
  if (camera && camera.isActive) {
    sourceEl = dom.video;
    return;
  }
  await startCamera();
}

function updateZoomRange() {
  const hw = camera ? camera.hardwareZoomMax : 1;
  const max = hw > 1.02 ? clamp(Math.ceil(hw * 2), 4, 12) : 8;
  dom.zoomInput.max = String(max);
  setText(dom.zoomMax, max.toFixed(0) + '×');
}

async function applyZoom(value) {
  const token = ++zoomToken;
  const max = Number(dom.zoomInput.max) || 8;
  const target = clamp(Number(value) || 1, 1, max);

  let hw = 1;
  if (camera && camera.isActive) {
    const res = await camera.setZoom(target);
    if (token !== zoomToken) return;
    hw = res.hardware ? clamp(res.applied, 1, max) : 1;
  }

  cameraHwZoom = hw;
  digitalZoom = target / hw;
  updateSettings({ zoom: target }, { silent: true });
  setRuntime({ digitalZoom, hardwareApplied: hw, zoom: target });
  const visual = sourceEl === dom.video ? dom.video : demo ? demo.canvas : null;
  if (visual) {
    visual.style.transform = digitalZoom > 1.001 ? `scale(${digitalZoom.toFixed(4)})` : '';
  }
  dom.zoomInput.value = String(target);
  setText(dom.zoomValue, target.toFixed(1) + '×');
  dom.tagZoom.hidden = target <= 1.01;
  setText(dom.tagZoom, target.toFixed(1) + '×');
  updateZone();
}

async function syncWakeLock() {
  const want = running && getSettings().keepAwake;
  if (want === wakeActive) return;
  wakeActive = want;
  const ok = await setWakeLock(want);
  if (want && ok === false) {
    toast('此设备不支持屏幕常亮', { type: 'warn', duration: 2200 });
  }
}

function currentExposure() {
  if (camera && camera.isActive) {
    const ex = camera.getExposure();
    if (Number.isFinite(ex.shutter) && Number.isFinite(ex.iso)) {
      return { shutter: ex.shutter, iso: ex.iso, manual: !!camera.manual };
    }
    return null;
  }
  if (demo) {
    return { shutter: demo.exposure.shutter, iso: demo.exposure.iso, manual: true };
  }
  return null;
}

function buildRegion(mode, s) {
  const shape = MODE_META[mode].shape;
  if (shape === 'full') return { shape: 'full' };
  if (shape === 'center') return { shape: 'center', cx: 0.5, cy: 0.5, size: 0.52 };
  return { shape, cx: zone.cx, cy: zone.cy, size: zone.size };
}

function schedule() {
  if (!running) return;
  if (sourceEl === dom.video && dom.video.requestVideoFrameCallback) {
    usingVideoFrameCallback = true;
    rafId = dom.video.requestVideoFrameCallback(onFrame);
  } else {
    usingVideoFrameCallback = false;
    rafId = requestAnimationFrame(onFrame);
  }
}

function cancelLoop() {
  if (rafId == null) return;
  if (usingVideoFrameCallback && dom.video.cancelVideoFrameCallback) {
    dom.video.cancelVideoFrameCallback(rafId);
  } else {
    cancelAnimationFrame(rafId);
  }
  rafId = null;
}

function evForLuma(luma, s, ex) {
  const L = clamp(luma, 1e-4, 1);
  if (ex && ex.manual) {
    const n = s.lensAperture;
    return log2((n * n) / ex.shutter) - log2(ex.iso / 100) + log2(L / MID_GRAY) + s.calibration;
  }
  return s.anchorEv + log2(L / MID_GRAY) + s.calibration;
}

function computeEv(result, s, ex) {
  const mode = s.mode;
  if (mode === 'spot' || mode === 'area') {
    const luma = result.region.mean;
    return { ev: evForLuma(luma, s, ex) - (s.targetZone - 5), zoneValue: s.targetZone, luma };
  }
  if (mode === 'center') {
    const luma = result.region.mean;
    return { ev: evForLuma(luma, s, ex), zoneValue: 5, luma };
  }
  if (mode === 'highlight') {
    const luma = Math.max(result.frame.p98, 1e-5);
    return { ev: evForLuma(luma, s, ex) - 3, zoneValue: 8, luma };
  }
  if (mode === 'shadow') {
    const luma = Math.max(result.frame.p02, 1e-5);
    return { ev: evForLuma(luma, s, ex) + 2, zoneValue: 3, luma };
  }
  const luma = result.frame.mean;
  return { ev: evForLuma(luma, s, ex), zoneValue: 5, luma };
}

/** 依据当前曝光优先模式，求光圈 / 快门组合 */
function resolvePair(s, ev) {
  if (!Number.isFinite(ev)) return null;
  return exposurePair({
    ev100: ev,
    iso: s.iso,
    ndStops: s.ndStops,
    priority: s.priority,
    aperture: s.aperture,
    shutter: s.shutter
  });
}

/** 当前显示的 EV（锁定优先） */
function currentEv() {
  return lockSnapshot ? lockSnapshot.ev : evSmooth;
}

function aeTargetLuma(result, mode) {
  if (mode === 'average' || mode === 'highlight' || mode === 'shadow') return result.frame.mean;
  return result.region.mean;
}

function aeTargetValue(mode) {
  if (mode === 'highlight') return 0.1;
  if (mode === 'shadow') return 0.26;
  return MID_GRAY;
}

let currentZoneValue = 5;

function onFrame(now) {
  if (!running) return;
  const s = getSettings();
  const interval = 1000 / clamp(s.fps, 4, 20);
  if (now - lastSample < interval * 0.85) {
    schedule();
    return;
  }
  lastSample = now;

  const rt = getRuntime();
  if (rt.source === 'demo' && demo) {
    demo.render(performance.now());
    sourceEl = demo.canvas;
  }
  if (!sourceEl) {
    schedule();
    return;
  }

  const rect = dom.stage.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) {
    schedule();
    return;
  }

  const image = sampler.draw(sourceEl, {
    aspect: rect.width / rect.height,
    zoom: digitalZoom,
    width: s.fps >= 15 ? 320 : 256
  });
  if (!image) {
    schedule();
    return;
  }

  const ex = currentExposure();
  const result = analyze(image.data, image.width, image.height, buildRegion(s.mode, s));
  stats = result;

  // ---- 相机自动曝光：把测光区压到可用范围，保证读数不溢出 ----
  if (camera && camera.manual && ex && !rt.locked && !shotBusy && now - lastAe > 320) {
    const y = clamp(aeTargetLuma(result, s.mode), 0.001, 0.98);
    const err = log2(y / aeTargetValue(s.mode));
    if (Math.abs(err) > 0.42) {
      const tr = camera.exposureRange;
      const ir = camera.isoRange;
      const factor = Math.pow(2, -clamp(err, -3.5, 3.5) * 0.7);
      const targetT = ex.shutter * factor;
      const t = clamp(targetT, tr.min, tr.max);
      const iso = clamp(ex.iso * (targetT / t), ir.min, ir.max);
      if (!exposureBusy) {
        exposureBusy = true;
        camera
          .setExposure({ shutter: t, iso })
          .catch(() => {})
          .finally(() => {
            exposureBusy = false;
          });
      }
      lastAe = now;
    }
  }

  // ---- 计算 EV ----
  const measured = computeEv(result, s, ex);
  if (!rt.locked) {
    const alpha = clamp(s.smoothing, 0.05, 1);
    evSmooth = evSmooth == null ? measured.ev : evSmooth + (measured.ev - evSmooth) * alpha;
    currentZoneValue = measured.zoneValue;
  }

  if (!rt.locked) {
    updateZebra(result, s);
    drawHistogram(result, s);
  }
  updateReadout();
  schedule();
}

let ladderKey = '';

function updateZebra(result, s) {
  const canvas = dom.zebra;
  canvas.hidden = !s.showZebra;
  if (!s.showZebra || !result.clipMap) return;
  const map = result.clipMap;
  if (canvas.width !== map.width || canvas.height !== map.height) {
    canvas.width = map.width;
    canvas.height = map.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,70,150,0.9)';
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.data[y * map.width + x]) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function drawHistogram(result, s) {
  const canvas = dom.histogram;
  canvas.hidden = !s.showHistogram;
  if (!s.showHistogram) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bins = 64;
  const step = Math.max(1, Math.floor(result.hist.length / bins));
  const values = new Float32Array(bins);
  let max = 0;
  for (let i = 0; i < bins; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += result.hist[i * step + j] || 0;
    values[i] = sum;
    if (sum > max) max = sum;
  }
  if (!max) return;

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(55,242,255,0.35)');
  grad.addColorStop(0.55, 'rgba(55,242,255,0.9)');
  grad.addColorStop(1, 'rgba(168,139,255,0.95)');
  ctx.fillStyle = grad;
  const bw = w / bins;
  for (let i = 0; i < bins; i++) {
    const norm = Math.pow(values[i] / max, 0.55);
    const bh = Math.max(1, norm * (h - 6));
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.6), bh);
  }

  const midX = ((log2(MID_GRAY) - LOG_MIN) / LOG_RANGE) * w;
  ctx.fillStyle = 'rgba(255,199,92,0.6)';
  ctx.fillRect(midX, 0, 1, h);

  if (result.frame.clip > 0.005) {
    ctx.fillStyle = 'rgba(255,92,122,0.8)';
    ctx.fillRect(w - 4, 0, 4, h);
  }
}

function updateZone() {
  const s = getSettings();
  const meta = MODE_META[s.mode];
  const shape = meta.shape;
  const rect = dom.stage.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;
  const minDim = Math.min(rect.width, rect.height);
  const positionable = shape === 'circle' || shape === 'rect';

  dom.zone.hidden = false;
  dom.zone.dataset.shape = shape === 'center' ? 'circle' : shape;
  dom.zone.dataset.draggable = positionable ? 'true' : 'false';

  if (shape === 'full') {
    dom.zone.style.left = '50%';
    dom.zone.style.top = '50%';
    dom.zone.style.width = Math.round(rect.width * 0.9) + 'px';
    dom.zone.style.height = Math.round(rect.height * 0.86) + 'px';
  } else if (shape === 'center') {
    const size = Math.round(minDim * 0.44);
    dom.zone.style.left = '50%';
    dom.zone.style.top = '50%';
    dom.zone.style.width = size + 'px';
    dom.zone.style.height = size + 'px';
  } else {
    const size = Math.round(clamp(zone.size, 0.04, 0.94) * minDim);
    dom.zone.style.left = (zone.cx * 100).toFixed(2) + '%';
    dom.zone.style.top = (zone.cy * 100).toFixed(2) + '%';
    dom.zone.style.width = size + 'px';
    dom.zone.style.height = size + 'px';
  }

  const zoneSuffix =
    shape === 'circle' || shape === 'rect' ? ' · ZONE ' + zoneRoman(s.targetZone) : '';
  setText(dom.zoneLabel, meta.tag + zoneSuffix);
  dom.zoneGrip.hidden = !positionable;
  setText(dom.tagMode, meta.tag);
  dom.zone.classList.toggle('is-locked', !!getRuntime().locked);
}

function ladderApertures(aperture) {
  const list = APERTURES.filter((a) => a >= 1.2 && a <= 32);
  let idx = list.findIndex((a) => Math.abs(a - aperture) < 1e-6);
  if (idx < 0) {
    idx = list.reduce(
      (best, a, i) => (Math.abs(a - aperture) < Math.abs(list[best] - aperture) ? i : best),
      0
    );
  }
  const start = clamp(idx - 4, 0, Math.max(0, list.length - 9));
  return list.slice(start, start + 9);
}

function renderLadder(ev, s, activeAperture = s.aperture, activeShutter = null) {
  const apertures = ladderApertures(activeAperture);
  const key = apertures.join(',');
  if (key !== ladderKey) {
    ladderKey = key;
    dom.ladder.innerHTML = '';
    for (const a of apertures) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ladder__item';
      btn.dataset.aperture = String(a);
      btn.innerHTML = `<span>f/${a}</span><b>—</b>`;
      btn.addEventListener('click', () => {
        updateSettings({ aperture: a, priority: 'aperture' });
        hapticTap();
      });
      dom.ladder.appendChild(btn);
    }
  }

  dom.ladder.querySelectorAll('.ladder__item').forEach((btn) => {
    const a = Number(btn.dataset.aperture);
    const isActive = Math.abs(a - activeAperture) < 1e-6;
    const t = isActive && Number.isFinite(activeShutter)
      ? activeShutter
      : shutterFromEv({ ev100: ev, aperture: a, iso: s.iso, ndStops: s.ndStops });
    const label = btn.querySelector('b');
    if (label) label.textContent = formatShutterRecommended(t);
    btn.classList.toggle('is-active', isActive);
  });
}

function updateReadout(force = false) {
  const now = performance.now();
  if (!force && now - lastUi < 90) return;
  lastUi = now;

  const s = getSettings();
  const rt = getRuntime();
  const locked = rt.locked && lockSnapshot;
  const ev = locked ? lockSnapshot.ev : evSmooth;
  const data = locked ? lockSnapshot.stats : stats;
  const zoneValue = locked ? lockSnapshot.zoneValue : currentZoneValue;

  if (!Number.isFinite(ev) || !data) {
    setText(dom.evValue, '--.-');
    if (rt.source === 'error') setText(dom.evSub, '相机异常');
    else if (rt.source === 'init') setText(dom.evSub, '正在启动相机…');
    else setText(dom.evSub, '等待画面…');
    setText(dom.valIso, String(s.iso));
    setText(dom.valIsoNote, s.iso === 100 ? '基础 ISO' : '手动设定');
    setText(dom.valAperture, formatAperture(s.aperture));
    setText(dom.valApertureNote, s.priority === 'shutter' ? '自动 · 等待读数' : '手动设定');
    setText(dom.valShutter, '—');
    setText(dom.valShutterNote, s.priority === 'aperture' ? '自动 · 等待读数' : '手动设定');
    setText(dom.valNd, s.ndStops > 0 ? ndLabel(s.ndStops).replace(/\s+/g, '') : 'OFF');
    setText(dom.valNdNote, s.ndStops > 0 ? `${ndDensity(s.ndStops)} 密度` : '无减光');
    dom.valApertureNote.classList.remove('is-warn');
    dom.valShutterNote.classList.remove('is-warn');
    return;
  }

  setText(dom.evValue, formatEv(ev, 1));

  if (locked) {
    setText(dom.evSub, '已锁定 · 点按解除后重新测光');
  } else {
    setText(dom.evSub, `${MODE_META[s.mode].label} · ${sourceLabel(rt.source)}`);
  }

  setText(dom.metricLum, formatLuminance(luminanceFromEv(ev)));
  dom.metricLum.classList.toggle('is-warn', data.frame.clip > 0.02);

  const dr = contrastStops(Math.max(data.frame.p02, 1e-5), data.frame.p98);
  setText(dom.metricDr, Number.isFinite(dr) ? dr.toFixed(1) + ' EV' : '—');

  const cct = cctFromLinearRgb(data.frame.rgb[0], data.frame.rgb[1], data.frame.rgb[2]);
  setText(dom.metricCct, formatCct(cct));
  setText(dom.metricZone, 'ZONE ' + zoneRoman(zoneValue));

  const pair = resolvePair(s, ev);
  if (!pair) return;

  const nd = s.ndStops;
  const base = pair.shutter / Math.pow(2, nd);

  setText(dom.valIso, String(s.iso));
  setText(dom.valIsoNote, s.iso === 100 ? '基础 ISO' : '手动设定');
  setText(dom.valAperture, formatAperture(pair.aperture));
  setText(dom.valShutter, formatShutterRecommended(pair.shutter));

  if (pair.auto === 'aperture') {
    setText(
      dom.valApertureNote,
      pair.apertureOutOfRange ? '超出光圈范围' : `自动 · f/${pair.apertureExact.toFixed(1)}`
    );
  } else {
    setText(dom.valApertureNote, '手动设定');
  }

  if (pair.auto === 'shutter') {
    setText(
      dom.valShutterNote,
      nd > 0
        ? `自动 · 基准 ${formatShutterRecommended(base)}`
        : `自动 · 精确 ${formatShutterExact(pair.shutter)}`
    );
  } else {
    setText(
      dom.valShutterNote,
      nd > 0 ? `手动 · 基准 ${formatShutterRecommended(base)}` : '手动设定'
    );
  }

  dom.valApertureNote.classList.toggle('is-warn', !!pair.apertureOutOfRange);
  dom.valShutterNote.classList.toggle('is-warn', !!pair.shutterOutOfRange);

  setText(dom.valNd, nd > 0 ? ndLabel(nd).replace(/\s+/g, '') : 'OFF');
  setText(dom.valNdNote, nd > 0 ? `${ndDensity(nd)} 密度 · ${nd.toFixed(1)} 档` : '无减光');

  const clip = data.frame.clip;
  if (locked) {
    setText(dom.hudHint, 'HOLD · 移动手机不会改变读数');
  } else if (clip > 0.03) {
    setText(dom.hudHint, `高光溢出 ${(clip * 100).toFixed(1)}% · 试试高光优先或降低相机曝光`);
  } else {
    setText(dom.hudHint, MODE_META[s.mode].hint + ' · 双指缩放');
  }

  renderLadder(ev, s, pair.aperture, pair.shutter);
}

function syncControls() {
  const s = getSettings();
  dom.grid.hidden = !s.showGrid;
  dom.histogram.hidden = !s.showHistogram;
  dom.modeRow.querySelectorAll('.mode').forEach((btn) => {
    const active = btn.dataset.mode === s.mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const apertureAuto = s.priority === 'shutter';
  if (dom.autoAperture) dom.autoAperture.hidden = !apertureAuto;
  if (dom.autoShutter) dom.autoShutter.hidden = apertureAuto;
  if (dom.cellAperture) dom.cellAperture.classList.toggle('is-auto', apertureAuto);
  if (dom.cellShutter) dom.cellShutter.classList.toggle('is-auto', !apertureAuto);

  updateZone();
  updateStatus();
}

function toggleLock() {
  const rt = getRuntime();
  const next = !rt.locked;
  if (next) {
    if (!Number.isFinite(evSmooth) || !stats) {
      toast('还没有有效读数', { type: 'warn', duration: 1800 });
      return;
    }
    const ex = camera && camera.isActive ? camera.getExposure() : null;
    lockSnapshot = {
      ev: evSmooth,
      stats,
      zoneValue: currentZoneValue,
      cameraExposure:
        ex && Number.isFinite(ex.shutter) && Number.isFinite(ex.iso)
          ? { shutter: ex.shutter, iso: ex.iso }
          : null
    };
  } else if (lockSnapshot) {
    evSmooth = lockSnapshot.ev;
    lockSnapshot = null;
    lastAe = 0;
  }
  setRuntime({ locked: next });
  updateStatus();
  updateZone();
  updateReadout(true);
  hapticTap();
  toast(next ? '已锁定读数 · 可以移动手机设置相机' : '已解除锁定 · 继续测光', {
    duration: next ? 2600 : 1600
  });
}

function handleZoneChange(patch) {
  if (patch.cx != null) zone.cx = clamp(patch.cx, 0, 1);
  if (patch.cy != null) zone.cy = clamp(patch.cy, 0, 1);
  if (patch.size != null) zone.size = clamp(patch.size, 0.04, 0.94);
  updateZone();
}

function persistZone() {
  updateSettings({ zone: { cx: zone.cx, cy: zone.cy }, spotSize: zone.size }, { silent: true });
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 2600);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        finish({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
      () => finish(null),
      { enableHighAccuracy: false, timeout: 2400, maximumAge: 60000 }
    );
  });
}

async function capture() {
  if (shotBusy) return;
  const s = getSettings();
  const rt = getRuntime();
  const locked = rt.locked && lockSnapshot;
  const ev = locked ? lockSnapshot.ev : evSmooth;
  const data = locked ? lockSnapshot.stats : stats;

  if (!Number.isFinite(ev) || !data || !sourceEl) {
    toast('还没有有效读数，请等待相机稳定', { type: 'warn' });
    hapticError();
    return;
  }

  shotBusy = true;
  dom.shutter.classList.add('is-busy');

  try {
    const now = Date.now();
    const nd = s.ndStops;
    const pair = resolvePair(s, ev);
    if (!pair) throw new Error('无法计算曝光组合');
    const shutterWithNd = pair.shutter;
    const shutterBase = pair.shutter / Math.pow(2, nd);
    const meta = MODE_META[s.mode];
    const loc = s.geotag ? await getLocation() : null;

    const shot = {
      id: uid(),
      createdAt: now,
      ev,
      mode: s.mode,
      modeLabel: meta.label,
      modeTag: meta.tag,
      iso: s.iso,
      aperture: pair.aperture,
      shutterWithNd,
      shutterBase,
      priority: s.priority,
      priorityText: s.priority === 'shutter' ? '快门优先' : '光圈优先',
      apertureAuto: pair.auto === 'aperture',
      apertureOutOfRange: !!pair.apertureOutOfRange,
      shutterOutOfRange: !!pair.shutterOutOfRange,
      ndStops: nd,
      luminance: luminanceFromEv(ev),
      contrast: contrastStops(Math.max(data.frame.p02, 1e-5), data.frame.p98),
      cct: cctFromLinearRgb(data.frame.rgb[0], data.frame.rgb[1], data.frame.rgb[2]),
      clip: data.frame.clip,
      zoneValue: locked ? lockSnapshot.zoneValue : currentZoneValue,
      zone: { shape: meta.shape, cx: zone.cx, cy: zone.cy, size: s.spotSize },
      cameraExposure: currentExposure(),
      source: rt.source,
      sourceText: sourceLabel(rt.source),
      zoom: s.zoom,
      lensAperture: s.lensAperture,
      calibration: s.calibration,
      location: loc,
      note: '',
      favorite: false,
      timeLabel: timeLabel(now),
      dateLabel: shortDate(now),
      coords: loc ? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}` : '',
      calibrationText:
        Math.abs(s.calibration) >= 0.05
          ? `CAL ${s.calibration >= 0 ? '+' : ''}${s.calibration.toFixed(1)}EV`
          : ''
    };

    const composed = await composePhoto(sourceEl, {
      aspect: stageAspect(),
      digitalZoom,
      shot,
      quality: s.quality
    });
    shot.photo = composed.blob;
    shot.thumb = composed.thumb;
    shot.width = composed.width;
    shot.height = composed.height;

    await putShot(shot);
    if (onSavedCb) onSavedCb(shot);
    setRuntime({ savedThisSession: getRuntime().savedThisSession + 1 });

    hapticSave();
    dom.shutter.classList.add('is-flash');
    setTimeout(() => dom.shutter.classList.remove('is-flash'), 520);

    toast(`已保存 · EV ${formatEv(ev, 1)} · ${formatShutterRecommended(shutterWithNd)}`, {
      type: 'success',
      duration: 2800,
      action: onNavigateCb ? { label: '查看', onClick: () => onNavigateCb('log') } : null
    });
  } catch (err) {
    console.error('[LIGHTNO] capture failed', err);
    toast('保存失败：' + (err && err.message ? err.message : '未知错误'), { type: 'error' });
    hapticError();
  } finally {
    shotBusy = false;
    dom.shutter.classList.remove('is-busy');
  }
}

const ND_DIAL_STOPS = Array.from({ length: 13 }, (_, i) => i);
let dialFlashTimer = null;

function flashDial(dial) {
  const cell = document.querySelector(`.exposure[data-dial="${dial}"]`);
  if (!cell) return;
  cell.classList.add('is-stepping');
  clearTimeout(dialFlashTimer);
  dialFlashTimer = setTimeout(() => cell.classList.remove('is-stepping'), 180);
}

/* ------------------------------------------------------------------ *
 * 拨盘浮层：滑动时显示当前值 + 上下相邻档位
 * ------------------------------------------------------------------ */
const DIAL_WHEEL_META = {
  iso: { label: 'ISO', values: ISOS, format: (v) => String(v) },
  aperture: { label: '光圈', values: APERTURES, format: (v) => 'f/' + v },
  shutter: { label: '快门', values: SHUTTERS, format: (v) => formatShutter(v) },
  nd: {
    label: 'ND 减光',
    values: ND_DIAL_STOPS,
    format: (v) => (v === 0 ? 'OFF' : ndLabel(v))
  }
};

let dialWheelHideTimer = null;
let dialWheelAnimTimer = null;

function currentDialValue(dial, s) {
  if (dial === 'iso') return s.iso;
  if (dial === 'nd') return s.ndStops;
  const ev = currentEv();
  const pair = Number.isFinite(ev) ? resolvePair(s, ev) : null;
  if (dial === 'aperture') {
    return s.priority === 'aperture' ? s.aperture : pair ? pair.aperture : s.aperture;
  }
  return s.priority === 'shutter' ? s.shutter : pair ? pair.shutter : s.shutter;
}

function hideDialWheel() {
  if (!dom.dialWheel) return;
  dom.dialWheel.classList.remove('is-open');
  clearTimeout(dialWheelHideTimer);
  dialWheelHideTimer = setTimeout(() => {
    if (dom.dialWheel && !dom.dialWheel.classList.contains('is-open')) {
      dom.dialWheel.hidden = true;
    }
  }, 200);
}

function showDialWheel(dial, direction = 0) {
  const meta = DIAL_WHEEL_META[dial];
  const cell = document.querySelector(`.exposure[data-dial="${dial}"]`);
  if (!meta || !cell || !dom.dialWheel) return;

  const s = getSettings();
  const actual = currentDialValue(dial, s);
  const list = meta.values;
  let index = list.findIndex((v) => Math.abs(v - actual) < 1e-6);
  if (index < 0) {
    index = list.reduce(
      (best, v, i) => (Math.abs(v - actual) < Math.abs(list[best] - actual) ? i : best),
      0
    );
  }

  const rows = [index - 2, index - 1, index, index + 1, index + 2];
  const items = dom.dialWheelList.querySelectorAll('li');
  items.forEach((li, i) => {
    const row = rows[i];
    const value = list[row];
    const has = row >= 0 && row < list.length && value !== undefined;
    li.textContent = has ? (i === 2 ? meta.format(actual) : meta.format(value)) : '';
    li.classList.toggle('is-center', i === 2 && has);
    li.classList.toggle('is-empty', !has);
  });
  dom.dialWheelLabel.textContent = meta.label;

  dom.dialWheel.hidden = false;
  const rect = cell.getBoundingClientRect();
  const wheelRect = dom.dialWheel.getBoundingClientRect();
  const width = wheelRect.width || 136;
  const height = wheelRect.height || 150;
  const margin = 10;

  let left = rect.left + rect.width / 2;
  left = clamp(left, margin + width / 2, window.innerWidth - margin - width / 2);

  let above = true;
  let top = rect.top - 10;
  if (top - height < margin) {
    above = false;
    top = Math.min(window.innerHeight - margin - height, rect.bottom + 10);
  }

  dom.dialWheel.style.left = left + 'px';
  dom.dialWheel.style.top = top + 'px';
  dom.dialWheel.style.transform = above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
  dom.dialWheel.classList.toggle('is-below', !above);
  dom.dialWheel.classList.add('is-open');

  const listEl = dom.dialWheelList;
  listEl.classList.remove('tick-up', 'tick-down');
  if (direction) {
    void listEl.offsetWidth;
    listEl.classList.add(direction > 0 ? 'tick-up' : 'tick-down');
  }
  clearTimeout(dialWheelAnimTimer);
  dialWheelAnimTimer = setTimeout(() => listEl.classList.remove('tick-up', 'tick-down'), 200);

  clearTimeout(dialWheelHideTimer);
  dialWheelHideTimer = setTimeout(hideDialWheel, 1600);
}

/**
 * 拨盘步进：
 * - ISO / ND 直接修改
 * - 光圈 → 进入光圈优先（测光决定快门）
 * - 快门 → 进入快门优先（测光决定光圈）
 */
function dialStep(dial, dir) {
  const s = getSettings();
  let patch = null;

  if (dial === 'iso') {
    const next = stepArray(ISOS, s.iso, dir);
    if (next !== s.iso) patch = { iso: next };
  } else if (dial === 'nd') {
    const next = stepArray(ND_DIAL_STOPS, s.ndStops, dir);
    if (Math.abs(next - s.ndStops) > 1e-6) patch = { ndStops: next };
  } else if (dial === 'aperture') {
    const ev = currentEv();
    const pair = Number.isFinite(ev) ? resolvePair(s, ev) : null;
    const base = s.priority === 'aperture' ? s.aperture : pair ? pair.aperture : s.aperture;
    const next = stepArray(APERTURES, base, dir);
    if (next !== s.aperture || s.priority !== 'aperture') {
      patch = { aperture: next, priority: 'aperture' };
    }
  } else if (dial === 'shutter') {
    const ev = currentEv();
    const pair = Number.isFinite(ev) ? resolvePair(s, ev) : null;
    const base = s.priority === 'shutter' ? s.shutter : pair ? pair.shutter : s.shutter;
    const next = stepArray(SHUTTERS, base, dir);
    if (Math.abs(next - s.shutter) > 1e-9 || s.priority !== 'shutter') {
      patch = { shutter: next, priority: 'shutter' };
    }
  }

  if (patch) {
    updateSettings(patch);
    hapticTap();
    flashDial(dial);
  }
  showDialWheel(dial, dir);
}

function bindDials() {
  const host = $('#exposures');
  if (!host) return;

  // 鼠标滚轮 / 触控板
  let wheelAcc = 0;
  let lastWheel = 0;
  host.addEventListener(
    'wheel',
    (event) => {
      const cell = event.target.closest && event.target.closest('[data-dial]');
      if (!cell) return;
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheel > 260) wheelAcc = 0;
      lastWheel = now;
      wheelAcc += -event.deltaY;
      const STEP = 90;
      let guard = 0;
      while (Math.abs(wheelAcc) >= STEP && guard++ < 6) {
        const dir = wheelAcc > 0 ? 1 : -1;
        wheelAcc -= dir * STEP;
        dialStep(cell.dataset.dial, dir);
      }
    },
    { passive: false }
  );

  // 触控上下滑动
  let swipe = null;
  let suppressUntil = 0;

  host.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest && event.target.closest('[data-dial]');
    if (!cell) return;
    swipe = {
      id: event.pointerId,
      cell,
      lastY: event.clientY,
      moved: false,
      captured: false
    };
  });

  host.addEventListener('pointermove', (event) => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const threshold = 24;
    const dy = event.clientY - swipe.lastY;
    if (Math.abs(dy) < threshold) return;
    if (!swipe.captured) {
      try {
        swipe.cell.setPointerCapture(event.pointerId);
        swipe.captured = true;
      } catch {
        /* ignore */
      }
    }
    const steps = Math.trunc(dy / threshold);
    swipe.lastY += steps * threshold;
    swipe.moved = true;
    const dir = steps < 0 ? 1 : -1;
    const count = Math.min(Math.abs(steps), 4);
    for (let i = 0; i < count; i++) dialStep(swipe.cell.dataset.dial, dir);
    suppressUntil = performance.now() + 420;
  });

  const endSwipe = (event) => {
    if (!swipe || event.pointerId !== swipe.id) return;
    if (swipe.moved) suppressUntil = performance.now() + 420;
    swipe = null;
  };
  host.addEventListener('pointerup', endSwipe);
  host.addEventListener('pointercancel', endSwipe);

  // 滑动结束后不要误触发点击（打开选择器）
  host.addEventListener(
    'click',
    (event) => {
      if (performance.now() < suppressUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  // 键盘上下键
  host.querySelectorAll('.exposure__main').forEach((btn) => {
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const cell = btn.closest('[data-dial]');
      if (cell) dialStep(cell.dataset.dial, event.key === 'ArrowUp' ? 1 : -1);
    });
  });

  window.addEventListener('resize', hideDialWheel);
  window.addEventListener('orientationchange', hideDialWheel);
}

function showEngineInfo() {
  const rt = getRuntime();
  const s = getSettings();
  const caps = rt.capabilities || {};
  const exposureRange = caps.exposureTime
    ? `${formatShutterExact(caps.exposureTime.min)} – ${formatShutter(caps.exposureTime.max, {
        snap: false
      })}`
    : '—';
  const rows = [
    ['数据来源', sourceLabel(rt.source)],
    ['手动曝光', rt.manual ? '已接管' : '不可用'],
    ['相机快门范围', exposureRange],
    ['相机 ISO 范围', caps.iso ? `${Math.round(caps.iso.min)} – ${Math.round(caps.iso.max)}` : '—'],
    ['硬件变焦', rt.hardwareZoomMax > 1.02 ? `1× – ${Number(rt.hardwareZoomMax).toFixed(1)}×` : '不支持'],
    ['换算光圈', formatAperture(s.lensAperture)],
    ['校准偏移', `${s.calibration >= 0 ? '+' : ''}${s.calibration.toFixed(1)} EV`],
    ['相对锚点', 'EV ' + s.anchorEv.toFixed(1)]
  ];
  const section = document.createElement('div');
  section.className = 'sheet-section';
  const grid = document.createElement('div');
  grid.className = 'param-grid';
  for (const [key, value] of rows) {
    const item = document.createElement('div');
    item.className = 'param';
    item.innerHTML = `<span>${key}</span><b>${value}</b>`;
    grid.appendChild(item);
  }
  section.appendChild(grid);
  const note = document.createElement('p');
  note.className = 'picker-note';
  note.innerHTML = rt.manual
    ? '当前设备支持相机手动曝光，LIGHTNO 会接管曝光并反推绝对 EV。'
    : '当前浏览器不允许网页修改相机曝光，已启用相对测光：请设置一个场景锚点 EV，或改用支持手动曝光的浏览器（如 Android Chrome）。';
  section.appendChild(note);

  openSheet({
    title: '测光引擎',
    subtitle: '当前设备能力与参数',
    content: section,
    actions:
      rt.source === 'demo'
        ? [
            { label: '关闭', kind: 'ghost', onClick: () => closeSheet() },
            {
              label: '使用相机',
              kind: 'primary',
              onClick: () => {
                closeSheet();
                setTimeout(() => startCamera(), 60);
              }
            }
          ]
        : [
            { label: '关闭', kind: 'ghost', onClick: () => closeSheet() },
            {
              label: '校准',
              kind: 'primary',
              onClick: () => {
                closeSheet();
                setTimeout(
                  () => openCalibration({ getLiveEv: () => (lockSnapshot ? lockSnapshot.ev : evSmooth) }),
                  60
                );
              }
            }
          ]
  });
}

function initInteractions() {
  gestureCtl = attachStageGestures(dom.stage, {
    getZone: () => ({
      cx: zone.cx,
      cy: zone.cy,
      size: zone.size,
      shape: MODE_META[getSettings().mode].shape
    }),
    isPositionable: () => {
      const shape = MODE_META[getSettings().mode].shape;
      return shape === 'circle' || shape === 'rect';
    },
    isResizable: () => {
      const shape = MODE_META[getSettings().mode].shape;
      return shape === 'circle' || shape === 'rect';
    },
    onZoneChange: handleZoneChange,
    onGestureEnd: persistZone,
    getZoom: () => Number(dom.zoomInput.value) || 1,
    maxZoom: () => Number(dom.zoomInput.max) || 8,
    onZoomChange: (z) => applyZoom(z),
    onDoubleTap: toggleLock
  });

  dom.zoomInput.addEventListener('input', () => {
    applyZoom(dom.zoomInput.value);
  });

  dom.btnLock.addEventListener('click', toggleLock);
  if (dom.evHold) dom.evHold.addEventListener('click', toggleLock);

  dom.modeRow.querySelectorAll('.mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!MODE_META[mode] || getSettings().mode === mode) return;
      evSmooth = null;
      if (lockSnapshot) lockSnapshot = null;
      setRuntime({ locked: false });
      dom.btnLock.setAttribute('aria-pressed', 'false');
      updateSettings({ mode });
      hapticTap();
    });
  });

  dom.btnOptions.addEventListener('click', () => openMeterOptions({ getEv: currentEv }));

  dom.cellIso.addEventListener('click', () => {
    hideDialWheel();
    pickIso(getSettings().iso, (v) => updateSettings({ iso: v }));
  });

  dom.cellAperture.addEventListener('click', () => {
    hideDialWheel();
    const s = getSettings();
    const ev = currentEv();
    const pair = Number.isFinite(ev) ? resolvePair(s, ev) : null;
    pickAperture(pair ? pair.aperture : s.aperture, (v) =>
      updateSettings({ aperture: v, priority: 'aperture' })
    );
  });

  dom.cellShutter.addEventListener('click', () => {
    hideDialWheel();
    const s = getSettings();
    const ev = currentEv();
    const pair = Number.isFinite(ev) ? resolvePair(s, ev) : null;
    pickShutter(pair ? pair.shutter : s.shutter, (v) =>
      updateSettings({ shutter: v, priority: 'shutter' })
    );
  });

  dom.cellNd.addEventListener('click', () => {
    hideDialWheel();
    pickNd(getSettings().ndStops, (v) => updateSettings({ ndStops: v }));
  });

  bindDials();

  dom.shutter.addEventListener('click', capture);
  dom.retry.addEventListener('click', () => startCamera());
  dom.demoBtn.addEventListener('click', startDemo);
  dom.statusChip.addEventListener('click', showEngineInfo);
}

export function createMeter({ onSaved, onNavigate } = {}) {
  onSavedCb = onSaved || null;
  onNavigateCb = onNavigate || null;

  initInteractions();
  syncControls();
  updateStatus();
  updateZoomRange();

  const unsubscribe = subscribe((event) => {
    if (event.type !== 'settings') return;
    const s = getSettings();
    if (Math.abs(s.spotSize - zone.size) > 1e-6) zone.size = s.spotSize;
    if (s.zone) {
      if (Math.abs(s.zone.cx - zone.cx) > 1e-4) zone.cx = s.zone.cx;
      if (Math.abs(s.zone.cy - zone.cy) > 1e-4) zone.cy = s.zone.cy;
    }
    syncControls();
    updateReadout(true);
    syncWakeLock();
  });

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => updateZone());
    ro.observe(dom.stage);
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible' && running && sourceEl && rafId == null) {
      lastSample = 0;
      schedule();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    async activate() {
      started = true;
      running = true;
      syncControls();
      await ensureSource();
      if (sourceEl && rafId == null) schedule();
      await syncWakeLock();
      updateReadout(true);
    },
    deactivate() {
      running = false;
      cancelLoop();
      stopCamera();
      hideDialWheel();
      syncWakeLock();
    },
    getLiveEv() {
      return currentEv();
    },
    startDemo,
    retryCamera: startCamera,
    destroy() {
      unsubscribe();
      running = false;
      cancelLoop();
      stopCamera();
      if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      if (gestureCtl) gestureCtl.destroy();
      setWakeLock(false);
    }
  };
}