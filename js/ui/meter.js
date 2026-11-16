/**
 * LIGHTNO · 测光视图
 *
 * 数据流：
 *   camera/video → FrameSampler（线性亮度）→ analyze（区域统计）
 *   → 求 EV（有效的相机曝光元数据）→ 平滑 → 读数 / 推荐曝光 / 记录
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
import { Camera, isAndroid } from '../core/camera.js';
import { hasNativeCamera, NativeCamera, setNativeKeepAwake } from '../core/nativeCamera.js';
import { estimateNativeExposure } from '../core/nativeExposure.js';
import { watchPreviewExif } from '../core/previewExif.js';
import { FrameSampler, analyze, LOG_MIN, LOG_RANGE, EXPOSURE_ZONE_GRID, sampleExposureZones } from '../core/sampler.js';
import { createDemoScene } from '../core/demo.js';
import { putShot } from '../core/store.js';
import { composePhoto } from '../core/capture.js';
import {
  MID_GRAY,
  evFromExposure,
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
import { openSheet, closeSheet, isSheetOpen } from './sheet.js';
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
  nativePreview: $('#nativePreview'),
  zebra: $('#zebra'),
  exposureZones: $('#exposureZones'),
  zoneToggle: $('#btnExposureZones'),
  zoneLegend: $('#zoneLegend'),
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
  evKey: $('#evKey'),
  evUnit: $('#evUnit'),
  filmMeter: $('#btnFilmMeter'),
  filmActions: $('#filmActions'),
  metricLumLabel: $('#metricLumLabel'),
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
const nativeAnchorSampler = hasNativeCamera ? new FrameSampler() : null;
let demo = null;
let sourceEl = null;
let running = false;
let startingCamera = null;
let stopExifWatch = null;
let exifSample = null;
let exifExpiry;
let exifContext = 0;
let exifSelectionWarning = '';
let hardwareSelectionWarning = '';
const NATIVE_SETTLE_GRACE_MS = 450;
let nativeWarning = '';
let nativeLastGoodAt = -Infinity;
const NATIVE_EXPOSURE_WARNINGS = {
  offset: '当前光线超出手机相机的测光范围',
  point: '当前相机无法指定测光点，请切换平均测光',
  metadata: '相机尚未提供有效的曝光参数',
  preview: '预览太亮或太暗，区域估算不稳定 · 可切换点测光'
};
let zoomPending = false;
const EXIF_MAX_AGE = 5000;
const appleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let rafId = null;
let usingVideoFrameCallback = false;
let lastSample = 0;
let lastUi = 0;
let lastAe = 0;
let stats = null;
let evSmooth = null;
let selectedLuma = null;
let lockSnapshot = null;
let cameraHwZoom = 1;
let digitalZoom = 1;
let shotBusy = false;
const LADDER_GRACE_MS = 1000;
const ladderItems = [];
let lastLadderReading = null;
let ladderRenderKey = '';
const zoneCells = [];
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
let hardwareSettledAfter = 0;

function stageAspect() {
  const rect = dom.stage.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return 3 / 4;
  return rect.width / rect.height;
}

function sourceLabel(source) {
  switch (source) {
    case 'hardware':
      return '硬件测光';
    case 'native':
      return '原生测光';
    case 'exif':
      return '自动 EXIF 测光';
    case 'image':
    case 'relative':
      return '画面分析';
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
  if (!running || startingCamera || document.visibilityState === 'hidden') return;
  stopCamera();
  const session = hasNativeCamera ? new NativeCamera(dom.nativePreview, {
    onFrame: () => {
      if (sourceEl !== dom.nativePreview || camera !== session) return;
      syncNativeMeterPoint();
      if (!lockSnapshot || getSettings().showExposureZones) onFrame(performance.now());
    },
    onStale: () => {
      if (camera !== session) return;
      dom.exposureZones.hidden = true;
      if (lockSnapshot) return;
      evSmooth = null;
      nativeLastGoodAt = -Infinity;
      nativeWarning = '等待原生相机读数…';
      updateReadout(true);
    },
    onError: (error) => {
      if (camera !== session) return;
      stopCamera();
      evSmooth = null;
      showCameraError(error);
      updateReadout(true);
    }
  }) : new Camera(dom.video);
  camera = session;
  startingCamera = session;
  if (lockSnapshot?.source === 'demo') {
    lockSnapshot = null;
    setRuntime({ locked: false });
  }
  unmountDemoLayer();
  lastSample = 0;
  nativeLastGoodAt = -Infinity;
  nativeWarning = '';
  evSmooth = null;
  stats = null;
  setRuntime({ source: 'init', cameraReady: false, cameraError: null });
  updateStatus();
  updateReadout(true);
  dom.fallback.hidden = true;

  try {
    const { engine, fps } = getSettings();
    const autoExif = !hasNativeCamera && engine === 'auto' && appleMobile;
    const allowManual = engine === 'hardware' || (engine === 'auto' && isAndroid);
    const result = await session.start({ allowManual, previewFps: lockSnapshot ? 4 : Math.round(fps) });
    if (camera !== session) return;

    const caps = result.capabilities;
    const source = hasNativeCamera ? 'native' : autoExif ? 'exif' : cameraExposure() ? 'hardware' : 'image';
    setRuntime({
      source,
      exifStatus: autoExif ? '正在读取自动曝光样本…' : null,
      exifFailed: false,
      manual: result.manual,
      cameraReady: true,
      hardwareZoomMax: result.hardwareZoomMax,
      capabilities: {
        exposureMode: caps.exposureMode || null,
        exposureTime: session.exposureRange,
        iso: session.isoRange,
        zoom: caps.zoom || null
      },
      cameraError: null
    });
    sourceEl = hasNativeCamera ? dom.nativePreview : dom.video;
    syncNativePreviewRate();
    cameraHwZoom = 1;
    updateZoomRange();
    updateStatus();
    await applyZoom(getSettings().zoom);
    if (camera !== session) return;

    if (lockSnapshot?.source === 'hardware' && lockSnapshot.cameraExposure && session.manual) {
      await session.setExposure(lockSnapshot.cameraExposure);
      if (camera !== session) return;
    }

    lastAe = 0;
    hardwareSettledAfter = performance.now() + 200;
    if (autoExif) startExifWatch(session);
    if (rafId == null) schedule();
  } catch (err) {
    if (camera !== session) return;
    stopCamera();
    showCameraError(err);
    updateReadout(true);
  } finally {
    if (startingCamera === session) startingCamera = null;
  }
}

function stopCamera() {
  dom.exposureZones.hidden = true;
  stopExifWatch?.();
  stopExifWatch = null;
  exifContext++;
  clearExifSample();
  startingCamera = null;
  zoomPending = false;
  exposureBusy = false;
  zoomToken++;
  if (camera) {
    camera.stop();
    camera = null;
  }
  if (sourceEl === dom.video || sourceEl === dom.nativePreview) {
    cancelLoop();
    sourceEl = null;
  }
}

function clearExifSample() {
  clearTimeout(exifExpiry);
  exifSample = null;
  exifSelectionWarning = '';
  if (getRuntime().source === 'exif') evSmooth = null;
}

function startExifWatch(session) {
  const report = (message, exifFailed = false) => {
    clearExifSample();
    if (exifFailed) stopExifWatch = null;
    setRuntime({ exifStatus: message, exifFailed });
    updateReadout(true);
  };
  if (typeof ImageCapture !== 'function' || typeof createImageBitmap !== 'function') {
    report('浏览器不支持自动取样', true);
    return;
  }
  try {
    stopExifWatch = watchPreviewExif(session.track, {
      getContext: () => camera === session && running && !zoomPending &&
        document.visibilityState === 'visible' && !isSheetOpen() && !lockSnapshot
        ? exifContext : null,
      onSample: (bitmap, exposure, sampledAt) => {
        const image = sampler.draw(bitmap, { aspect: stageAspect(), zoom: digitalZoom, width: 192 });
        const remaining = EXIF_MAX_AGE - (performance.now() - sampledAt);
        if (!image || remaining <= 0) throw new Error('自动取样已失效');

        clearTimeout(exifExpiry);
        exifSample = { image, exposure };
        exifExpiry = setTimeout(() => report('等待新曝光样本…'), remaining);
        setRuntime({ exifStatus: null });
        updateExifReading();
        updateReadout(true);
      },
      onError: (message) => report(message, true)
    });
  } catch {
    report('浏览器无法启动自动取样', true);
  }
}

function updateExifReading() {
  if (!exifSample || lockSnapshot) return;
  const { image, exposure } = exifSample;
  const s = getSettings();
  const result = analyze(image.data, image.width, image.height, buildRegion(s.mode));
  const measured = computeEv(result, s, exposure, s.autoExifCalibration);
  exifSelectionWarning = exposureSampleProblem(result, s.mode, measured.luma);
  evSmooth = exifSelectionWarning ? null : measured.ev;
  currentZoneValue = measured.zoneValue;
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
  dom.nativePreview.hidden = true;
}

function unmountDemoLayer() {
  if (demo && demo.canvas.isConnected) demo.canvas.hidden = true;
  dom.video.hidden = hasNativeCamera;
  dom.nativePreview.hidden = !hasNativeCamera;
}

function startDemo() {
  if (!demo) demo = createDemoScene();
  stopCamera();
  mountDemoLayer();
  lockSnapshot = null;
  stats = null;
  setRuntime({ source: 'demo', cameraReady: true, manual: false, locked: false, cameraError: null });
  sourceEl = demo.canvas;
  dom.fallback.hidden = true;
  evSmooth = null;
  lastAe = 0;
  updateStatus();
  toast('演示模式：程序绘制的场景，可直接体验测光', { duration: 3000 });
  running = true;
  if (rafId == null) schedule();
}

async function ensureSource() {
  const rt = getRuntime();
  if (rt.source === 'demo') {
    if (!demo) demo = createDemoScene();
    sourceEl = demo.canvas;
    return;
  }
  if (camera && camera.isActive) {
    sourceEl = hasNativeCamera ? dom.nativePreview : dom.video;
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

  if (getRuntime().source === 'exif' && target !== getSettings().zoom) {
    exifContext++;
    clearExifSample();
    if (stopExifWatch) setRuntime({ exifStatus: '正在读取自动曝光样本…' });
    updateReadout(true);
  }
  let hw = 1;
  if (camera && camera.isActive) {
    zoomPending = true;
    const res = await camera.setZoom(target);
    if (token !== zoomToken) return;
    zoomPending = false;
    if (res.hardware && camera?.manual) hardwareSettledAfter = performance.now() + 200;
    hw = res.hardware ? clamp(res.applied, 1, max) : 1;
  }

  cameraHwZoom = hw;
  digitalZoom = target / hw;
  updateSettings({ zoom: target }, { silent: true });
  setRuntime({ digitalZoom, hardwareApplied: hw, zoom: target });
  const visual = sourceEl;
  if (visual) {
    visual.style.transform = digitalZoom > 1.001 ? `scale(${digitalZoom.toFixed(4)})` : '';
  }
  dom.zoomInput.value = String(target);
  setText(dom.zoomValue, target.toFixed(1) + '×');
  dom.tagZoom.hidden = target <= 1.01;
  setText(dom.tagZoom, target.toFixed(1) + '×');
  updateZone();
  syncNativeMeterPoint();
}

async function syncWakeLock() {
  const want = running && getSettings().keepAwake;
  if (want === wakeActive) return;
  wakeActive = want;
  if (hasNativeCamera) {
    setNativeKeepAwake(want);
    return;
  }
  const ok = await setWakeLock(want);
  if (want && ok === false) {
    toast('此设备不支持屏幕常亮', { type: 'warn', duration: 2200 });
  }
}

function cameraExposure() {
  if (!camera?.isActive || !camera.manual) return null;
  return camera.getManualExposure();
}

function currentExposure() {
  if (getRuntime().source === 'exif') return exifSample?.exposure || null;
  if (getRuntime().source === 'native') return camera?.exposure || null;
  if (getRuntime().source === 'demo' && demo) return demo.exposure;
  return cameraExposure();
}

function buildRegion(mode) {
  const shape = MODE_META[mode].shape;
  if (shape === 'full') return { shape: 'full' };
  if (shape === 'center') return { shape: 'center', cx: 0.5, cy: 0.5, size: 0.52 };
  return { shape, cx: zone.cx, cy: zone.cy, size: zone.size };
}

function schedule() {
  if (!running || sourceEl === dom.nativePreview) return;
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

function computeEv(result, s, ex, calibration = s.calibration) {
  let luma = result.region.mean;
  let zoneValue = 5;
  if (s.mode === 'spot' || s.mode === 'area') {
    zoneValue = s.targetZone;
  } else if (s.mode === 'highlight') {
    luma = result.frame.p98;
    zoneValue = 8;
  } else if (s.mode === 'shadow') {
    luma = result.frame.p02;
    zoneValue = 3;
  }
  if (!ex) return { ev: null, zoneValue, luma };

  const cameraEv = evFromExposure({
    aperture: ex.aperture ?? s.lensAperture,
    shutter: ex.shutter,
    iso: ex.iso
  });
  const ev = cameraEv + log2(Math.max(luma, 1e-4) / MID_GRAY) + calibration - (zoneValue - 5);
  return { ev, zoneValue, luma };
}

function syncNativePreviewRate() {
  if (hasNativeCamera) camera?.setPreviewRate(lockSnapshot ? 4 : Math.round(getSettings().fps));
}

function syncNativeMeterPoint() {
  const preview = dom.nativePreview;
  if (sourceEl !== preview || !camera?.isActive || lockSnapshot || !preview.width || !preview.height) return;

  const mode = getSettings().mode;
  let x = 0.5;
  let y = 0.5;
  if (mode === 'spot' || mode === 'area') {
    const sourceAspect = preview.width / preview.height;
    const aspect = stageAspect();
    // Map the selection through the same centered crop and zoom as FrameSampler.
    x += (zone.cx - 0.5) * Math.min(1, aspect / sourceAspect) / digitalZoom;
    y += (zone.cy - 0.5) * Math.min(1, sourceAspect / aspect) / digitalZoom;
  }

  if (camera.setMeterPoint(x, y)) {
    evSmooth = null;
    nativeLastGoodAt = -Infinity;
    nativeWarning = '等待测光区曝光稳定…';
    updateReadout(true);
  }
}

function computeNativeEv(result, s, ex) {
  const measured = computeEv(result, s, null);
  const anchor = ex && !ex.adjusting && s.mode !== 'spot'
    ? nativeAnchorSampler.sampleAnchor(dom.nativePreview, camera.point)
    : null;
  const estimate = estimateNativeExposure({
    exposure: ex,
    mode: s.mode,
    luma: measured.luma,
    anchor,
    zoneValue: measured.zoneValue,
    calibration: s.nativeCalibration
  });
  nativeWarning = estimate.settling ? '曝光更新中…' : NATIVE_EXPOSURE_WARNINGS[estimate.reason] || '';
  return { ...measured, ...estimate };
}

function exposureSampleProblem(result, mode, luma) {
  if (luma < 0.005) return '测光区太暗 · 请调整测光区';
  const clipped = luma >= 0.95 || ((mode === 'spot' || mode === 'area' || mode === 'center') && result.region.clip > 0.05);
  return clipped ? '测光区高光裁切 · 请调整测光区' : '';
}

/** 去掉影调放置造成的曝光偏移，恢复用于对照的反射测光读数。 */
function referenceReading() {
  if (!lockSnapshot && getRuntime().source === 'native' && nativeWarning) return null;
  const ev = currentEv();
  const zoneValue = lockSnapshot?.zoneValue ?? currentZoneValue;
  return Number.isFinite(ev) ? ev + zoneValue - 5 : null;
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
  rafId = null;
  if (!running) return;
  const s = getSettings();
  const nativeSource = sourceEl === dom.nativePreview;
  const elapsed = now - lastSample;
  const interval = 1000 / (nativeSource ? Math.min(s.fps, 10) : clamp(s.fps, 4, 20));
  if (elapsed < interval * 0.85) {
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
    width: nativeSource ? (s.fps >= 15 ? 192 : 144) : (s.fps >= 15 ? 320 : 256)
  });
  if (!image) {
    schedule();
    return;
  }

  const exifSource = rt.source === 'exif';
  const ex = exifSource ? null : currentExposure();
  const adjustingHardware = !!camera?.manual &&
    (zoomPending || exposureBusy || now < hardwareSettledAfter);
  if (camera?.isActive && !exifSource && !nativeSource) {
    const source = ex ? 'hardware' : 'image';
    if (rt.source !== source) {
      evSmooth = null;
      setRuntime({ source });
      updateStatus();
    }
  }
  const result = analyze(image.data, image.width, image.height, buildRegion(s.mode), {
    clipMap: s.showZebra && !rt.locked
  });

  // ---- 相机自动曝光：把测光区压到可用范围，保证读数不溢出 ----
  if (camera?.manual && ex && !adjustingHardware && !rt.locked && !shotBusy && now - lastAe > 320) {
    const y = clamp(aeTargetLuma(result, s.mode), 0.001, 0.98);
    const err = log2(y / aeTargetValue(s.mode));
    if (Math.abs(err) > 0.42) {
      const tr = camera.exposureRange;
      const ir = camera.isoRange;
      const factor = Math.pow(2, -clamp(err, -3.5, 3.5) * 0.7);
      const targetT = ex.shutter * factor;
      const t = clamp(targetT, tr.min, tr.max);
      const iso = clamp(ex.iso * (targetT / t), ir.min, ir.max);
      if (Math.abs(t - ex.shutter) > 1e-5 || Math.abs(iso - ex.iso) > 1) {
        const session = camera;
        exposureBusy = true;
        session.setExposure({ shutter: t, iso }).catch(() => {}).finally(() => {
          if (camera !== session) return;
          hardwareSettledAfter = performance.now() + 200;
          exposureBusy = false;
        });
      }
      lastAe = now;
    }
  }

  // ---- 计算 EV ----
  const measured = nativeSource ? computeNativeEv(result, s, ex) : computeEv(result, s, ex);
  if (!rt.locked) {
    const waitingWithReading = nativeSource && measured.settling
      && Number.isFinite(evSmooth) && now - nativeLastGoodAt < NATIVE_SETTLE_GRACE_MS;
    if (!waitingWithReading) stats = result;
    hardwareSelectionWarning = rt.source === 'hardware'
      ? exposureSampleProblem(result, s.mode, measured.luma) : '';
    if (!waitingWithReading) {
      selectedLuma = measured.luma;
      if (hardwareSelectionWarning) {
        evSmooth = null;
      } else if (!exifSource && !adjustingHardware) {
        const smoothing = clamp(s.smoothing, 0.05, 1);
        const alpha = nativeSource ? 1 - (1 - smoothing) ** (Math.min(elapsed, 300) / 100) : smoothing;
        if (measured.ev === null || evSmooth === null) evSmooth = measured.ev;
        else evSmooth += (measured.ev - evSmooth) * alpha;
        if (nativeSource && Number.isFinite(measured.ev)) nativeLastGoodAt = now;
        currentZoneValue = measured.zoneValue;
      }
    }
  }

  updateExposureZones(image, measured, s);
  if (!rt.locked) {
    updateZebra(result, s);
    drawHistogram(result, s);
  }
  updateReadout();
  schedule();
}

function updateExposureZones(image, measured, s) {
  if (!s.showExposureZones || !Number.isFinite(measured.luma)
      || (lockSnapshot && !Number.isFinite(measured.ev))) {
    dom.exposureZones.hidden = true;
    return;
  }

  // Expose the moving scene against the held exposure, even if the preview's AE changes.
  const displayEv = lockSnapshot?.ev ?? evSmooth;
  const delta = Number.isFinite(measured.ev) && Number.isFinite(displayEv)
    ? measured.ev - displayEv : 0;
  const zones = sampleExposureZones(image, measured.luma, measured.zoneValue + delta);
  zones.forEach((value, index) => {
    const cell = zoneCells[index];
    const tone = value <= 3 ? 'shadow' : value >= 7 ? 'highlight' : 'mid';
    if (cell.dataset.tone !== tone) cell.dataset.tone = tone;
    setText(cell, zoneRoman(value));
  });
  dom.exposureZones.hidden = false;
}

function updateZebra(result, s) {
  const canvas = dom.zebra;
  canvas.hidden = !s.showZebra || !result.frame.clip;
  if (canvas.hidden || !result.clipMap) return;
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
  dom.zoneLabel.hidden = shape === 'full';
  setText(dom.zoneLabel, meta.tag + zoneSuffix);
  dom.zoneGrip.hidden = !positionable;
  setText(dom.tagMode, meta.tag);
  dom.zone.classList.toggle('is-locked', !!getRuntime().locked);
}

function initLadder() {
  for (const aperture of APERTURES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ladder__item';
    const name = document.createElement('span');
    name.textContent = formatAperture(aperture);
    const label = document.createElement('b');
    label.textContent = '—';
    button.append(name, label);
    button.addEventListener('click', () => {
      if (!Number.isFinite(currentEv()) || (!lockSnapshot && !stats)) {
        toast('还没有有效读数', { type: 'warn', duration: 1800 });
        return;
      }
      const s = getSettings();
      if (lockSnapshot && s.priority === 'aperture' && s.aperture === aperture) {
        toggleLock();
        return;
      }
      if (!lockSnapshot && !toggleLock()) return;
      updateSettings({ aperture, priority: 'aperture' });
    });
    dom.ladder.appendChild(button);
    ladderItems.push({ button, aperture, label });
  }
  revealLadderChoice(getSettings().aperture);
}

function revealLadderChoice(aperture) {
  const index = APERTURES.indexOf(aperture);
  if (index < 0) return;
  const { button } = ladderItems[index];
  const { scrollLeft, clientWidth } = dom.ladder;
  if (button.offsetLeft >= scrollLeft && button.offsetLeft + button.offsetWidth <= scrollLeft + clientWidth) return;
  const step = ladderItems[1].button.offsetLeft - ladderItems[0].button.offsetLeft;
  if (step <= 0 || !clientWidth) return;
  const first = Math.max(0, index - Math.floor(clientWidth / step / 2));
  dom.ladder.scrollLeft = ladderItems[first].button.offsetLeft;
}

function renderLadder(pair, ev, s, source, now, locked) {
  if (pair) lastLadderReading = { ev, source, at: now };
  const recent = lastLadderReading && lastLadderReading.source === source
    && now - lastLadderReading.at < LADDER_GRACE_MS;
  const ladderEv = pair ? ev : recent ? lastLadderReading.ev : null;
  const selected = pair?.aperture ?? s.aperture;
  const key = [ladderEv?.toFixed(2), selected, formatShutterRecommended(pair?.shutter), s.iso, s.ndStops, !!locked, !!pair].join(':');
  if (key === ladderRenderKey) return;
  ladderRenderKey = key;
  dom.ladder.classList.toggle('is-waiting', !pair);
  for (const { button, aperture, label } of ladderItems) {
    const active = selected === aperture;
    const time = active && pair ? pair.shutter
      : shutterFromEv({ ev100: ladderEv, aperture, iso: s.iso, ndStops: s.ndStops });
    setText(label, formatShutterRecommended(time));
    button.classList.toggle('is-active', active);
    const pressed = String(active && !!locked);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
  }
}

function updateReadout(force = false) {
  const now = performance.now();
  if (!force && now - lastUi < 110) return;
  lastUi = now;

  const s = getSettings();
  const rt = getRuntime();
  const locked = rt.locked && lockSnapshot;
  const ev = locked ? lockSnapshot.ev : evSmooth;
  const data = locked ? lockSnapshot.stats : stats;
  const zoneValue = locked ? lockSnapshot.zoneValue : currentZoneValue;

  const luma = locked ? lockSnapshot.luma : selectedLuma;
  const pair = data ? resolvePair(s, ev) : null;
  const relative = data && !pair;
  const nd = s.ndStops;
  const source = locked ? lockSnapshot.source : rt.source;

  const waitingForExif = source === 'exif' && !rt.exifFailed;
  dom.filmActions.hidden = hasNativeCamera || waitingForExif || (!!pair && source !== 'demo');
  dom.shutter.hidden = source === 'exif';
  renderLadder(pair, ev, s, source, now, locked);
  setText(dom.evKey, pair ? 'EV100 估算' : '画面亮度差');
  setText(dom.evUnit, pair ? 'EV' : '档');

  if (pair) {
    setText(dom.evValue, formatEv(ev, 1));
  } else if (relative) {
    const difference = log2(Math.max(luma, 1e-4) / Math.max(data.frame.mean, 1e-4));
    setText(dom.evValue, `${difference > 0.05 ? '+' : ''}${formatEv(difference, 1)}`);
  } else {
    setText(dom.evValue, '--.-');
  }

  if (locked) setText(dom.evSub, '已锁定 · 点按解除');
  else if (source === 'native' && nativeWarning) setText(dom.evSub, nativeWarning);
  else if (pair) setText(dom.evSub, `${MODE_META[s.mode].label} · ${sourceLabel(source)}`);
  else if (source === 'exif') setText(dom.evSub, exifSelectionWarning || rt.exifStatus || '等待新曝光样本…');
  else if (source === 'native') setText(dom.evSub, '等待原生相机读数…');
  else if (source === 'hardware') setText(dom.evSub, hardwareSelectionWarning || '等待硬件曝光稳定…');
  else if (relative) setText(dom.evSub, '测光区相对画面平均');
  else if (rt.source === 'error') setText(dom.evSub, '相机异常');
  else setText(dom.evSub, '等待画面…');

  setText(dom.metricLumLabel, pair ? '亮度估算' : '画面亮度');
  setText(dom.metricLum, pair
    ? formatLuminance(luminanceFromEv(ev + zoneValue - 5))
    : relative ? `${(luma * 100).toFixed(1)}%` : '—');
  const clip = data?.frame.clip || 0;
  dom.metricLum.classList.toggle('is-warn', clip > 0.02);

  const dr = data ? contrastStops(Math.max(data.frame.p02, 1e-5), data.frame.p98) : NaN;
  setText(dom.metricDr, Number.isFinite(dr) ? dr.toFixed(1) + ' 档' : '—');

  const cct = data ? cctFromLinearRgb(...data.frame.rgb) : NaN;
  setText(dom.metricCct, formatCct(cct));
  setText(dom.metricZone, pair ? 'ZONE ' + zoneRoman(zoneValue) : '—');

  setText(dom.valIso, String(s.iso));
  setText(dom.valIsoNote, '胶片 ISO');
  setText(dom.valNd, nd > 0 ? ndLabel(nd).replace(/\s+/g, '') : 'OFF');
  setText(dom.valNdNote, nd > 0 ? `减光 ${Number(nd.toFixed(1))} 档` : '无减光');

  if (locked) {
    setText(dom.hudHint, 'HOLD · 移动手机不会改变读数');
  } else if (clip > 0.03) {
    setText(dom.hudHint, `预览高光裁切 ${(clip * 100).toFixed(1)}%`);
  } else {
    setText(dom.hudHint, MODE_META[s.mode].hint + ' · 双指缩放');
  }

  if (!pair) {
    const aperturePriority = s.priority === 'aperture';
    setText(dom.valAperture, aperturePriority ? formatAperture(s.aperture) : '—');
    setText(dom.valShutter, aperturePriority ? '—' : formatShutterRecommended(s.shutter));
    const unavailable = waitingForExif ? '等待曝光样本' : '无曝光读数';
    setText(dom.valApertureNote, aperturePriority ? '胶片机设定' : unavailable);
    setText(dom.valShutterNote, aperturePriority ? unavailable : '胶片机设定');
    dom.valApertureNote.classList.remove('is-warn');
    dom.valShutterNote.classList.remove('is-warn');
    return;
  }

  const base = pair.shutter / Math.pow(2, nd);
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
        ? `无 ND ${formatShutterRecommended(base)}`
        : `自动 · 精确 ${formatShutterExact(pair.shutter)}`
    );
  } else {
    setText(
      dom.valShutterNote,
      nd > 0 ? `无 ND ${formatShutterRecommended(base)}` : '手动设定'
    );
  }

  dom.valApertureNote.classList.toggle('is-warn', !!pair.apertureOutOfRange);
  dom.valShutterNote.classList.toggle('is-warn', !!pair.shutterOutOfRange);
}

function syncControls() {
  const s = getSettings();
  dom.grid.hidden = !s.showGrid;
  dom.zoneToggle.setAttribute('aria-pressed', String(s.showExposureZones));
  dom.zoneLegend.hidden = !s.showExposureZones;
  if (!s.showExposureZones) dom.exposureZones.hidden = true;
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
    const { mode } = getSettings();
    if (!stats || (['exif', 'hardware', 'native'].includes(rt.source) && !Number.isFinite(evSmooth))
        || (rt.source === 'native' && nativeWarning)) {
      toast('等测光稳定后再锁定', { type: 'warn', duration: 1800 });
      return false;
    }
    const ex = currentExposure();
    lockSnapshot = {
      ev: evSmooth,
      stats,
      luma: selectedLuma,
      source: rt.source,
      zoneValue: currentZoneValue,
      zone: buildRegion(mode),
      cameraExposure: ex
    };
  } else if (lockSnapshot) {
    if (lockSnapshot.source !== rt.source) {
      evSmooth = null;
      stats = null;
    }
    lockSnapshot = null;
    lastAe = 0;
  }
  setRuntime({ locked: next });
  syncNativePreviewRate();
  if (rt.source === 'native' && !next) {
    evSmooth = null;
    nativeLastGoodAt = -Infinity;
    syncNativeMeterPoint();
  }
  if (rt.source === 'exif') {
    exifContext++;
    if (!next) clearExifSample();
  }
  updateStatus();
  updateZone();
  updateReadout(true);
  hapticTap();
  toast(next ? '已锁定读数 · 可以移动手机设置相机' : '已解除锁定 · 继续测光', {
    duration: next ? 2600 : 1600
  });
  return true;
}

function handleZoneChange(patch) {
  if (patch.cx != null) zone.cx = clamp(patch.cx, 0, 1);
  if (patch.cy != null) zone.cy = clamp(patch.cy, 0, 1);
  if (patch.size != null) zone.size = clamp(patch.size, 0.04, 0.94);
  updateZone();
  updateExifReading();
  syncNativeMeterPoint();
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
  if ((locked ? lockSnapshot.source : rt.source) === 'exif') return;
  const ev = locked ? lockSnapshot.ev : evSmooth;
  const data = locked ? lockSnapshot.stats : stats;

  if (!Number.isFinite(ev) || !data || !sourceEl || (rt.source === 'native' && !locked && nativeWarning)) {
    const message = data && !Number.isFinite(ev) && !hasNativeCamera
      ? '请先拍照测光，再保存胶片曝光组合' : '还没有有效读数，请等待相机稳定';
    toast(message, { type: 'warn' });
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
    const source = locked ? lockSnapshot.source : rt.source;
    const calibration = source === 'native' ? s.nativeCalibration : s.calibration;
    const aspect = stageAspect();
    const zoom = digitalZoom;
    const zoneValue = locked ? lockSnapshot.zoneValue : currentZoneValue;
    const shotZone = locked ? lockSnapshot.zone : buildRegion(s.mode);
    const cameraExposureAtTap = locked ? lockSnapshot.cameraExposure : currentExposure();
    let frame = sourceEl;
    let loc = null;
    if (s.geotag && !hasNativeCamera) {
      // Requesting location is asynchronous. Keep the image from the tap.
      frame = document.createElement('canvas');
      frame.width = sourceEl.videoWidth || sourceEl.width;
      frame.height = sourceEl.videoHeight || sourceEl.height;
      frame.getContext('2d').drawImage(sourceEl, 0, 0);
      loc = await getLocation();
    }

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
      luminance: luminanceFromEv(ev + zoneValue - 5),
      contrast: contrastStops(Math.max(data.frame.p02, 1e-5), data.frame.p98),
      cct: cctFromLinearRgb(data.frame.rgb[0], data.frame.rgb[1], data.frame.rgb[2]),
      clip: data.frame.clip,
      zoneValue,
      zone: shotZone,
      cameraExposure: cameraExposureAtTap,
      source,
      sourceText: sourceLabel(source),
      zoom: s.zoom,
      lensAperture: s.lensAperture,
      calibration,
      location: loc,
      note: '',
      favorite: false,
      timeLabel: timeLabel(now),
      dateLabel: shortDate(now),
      coords: loc ? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}` : '',
      calibrationText:
        Math.abs(calibration) >= 0.05
          ? `CAL ${calibration >= 0 ? '+' : ''}${calibration.toFixed(1)}EV`
          : ''
    };

    const composed = await composePhoto(frame, {
      aspect,
      digitalZoom: zoom,
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
  const ex = lockSnapshot?.cameraExposure ?? currentExposure();
  const reference = referenceReading();
  const referenceSource = lockSnapshot?.source ?? rt.source;
  const canCompare = Number.isFinite(reference) && ['exif', 'hardware', 'native'].includes(referenceSource);
  const pair = resolvePair(s, currentEv());
  const base = pair?.shutter / 2 ** s.ndStops;
  const cameraEv = ['exif', 'native'].includes(referenceSource) && ex
    ? evFromExposure(ex) : null;
  const exposureRange = caps.exposureTime
    ? `${formatShutterExact(caps.exposureTime.min)} – ${formatShutter(caps.exposureTime.max, {
        snap: false
      })}`
    : '—';
  const manualCap = Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual');
  const rows = [
    ['数据来源', sourceLabel(rt.source)],
    ['手机曝光', ex ? `${formatShutterExact(ex.shutter)} · ISO ${Math.round(ex.iso)}` : '未提供'],
    ['胶片快门（无 ND）', Number.isFinite(base) ? `${formatShutterRecommended(base)} · 精确 ${formatShutterExact(base)}` : '—'],
    ['手动曝光', rt.manual ? '已接管' : manualCap ? '设备支持 · 未启用' : '不支持'],
    ['相机快门范围', exposureRange],
    ['相机 ISO 范围', caps.iso ? `${Math.round(caps.iso.min)} – ${Math.round(caps.iso.max)}` : '—'],
    ['硬件变焦', rt.hardwareZoomMax > 1.02 ? `1× – ${Number(rt.hardwareZoomMax).toFixed(1)}×` : '不支持'],
    ['手机镜头光圈', hasNativeCamera || rt.source === 'exif' ? formatAperture(ex?.aperture) : formatAperture(s.lensAperture)],
    ['校准偏移', `${(hasNativeCamera ? s.nativeCalibration : rt.source === 'exif' ? s.autoExifCalibration : s.calibration).toFixed(1)} EV`]
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
  let noteText;
  if (rt.source === 'demo') {
    noteText = '演示场景：曝光参数由程序生成，仅用于体验界面与算法。';
  } else if (hasNativeCamera) {
    noteText = '点测光使用主摄的测光点。平均、框选和其他区域模式通过预览亮度相对测光点估算。对照时请使用相同取景范围和测光区域。';
  } else if (rt.source === 'error') {
    noteText = '相机未运行。你仍可使用「拍照测光」读取照片 EXIF，或进入演示模式。';
  } else if (rt.source === 'exif') {
    noteText = rt.exifStatus || '取景时约每两秒取样一次，曝光数据在本机读取，样本照片不会保存。';
  } else if (rt.manual) {
    noteText = '手动曝光时，LIGHTNO 用相机快门、ISO 和手机镜头光圈估算 EV。';
  } else {
    noteText =
      '相机预览会自动调整曝光。要计算胶片曝光，请用「拍照计算胶片曝光」读取当下场景的照片。';
  }
  note.innerHTML = noteText;
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
              label: canCompare ? '对照测光表' : hasNativeCamera ? '重试相机' : rt.source === 'exif' ? '重新取样' : '拍照测光',
              kind: 'primary',
              onClick: () => {
                if (canCompare) {
                  openCalibration({ getLiveEv: () => reference, source: referenceSource, cameraEv });
                  return;
                }
                closeSheet();
                if (hasNativeCamera || rt.source === 'exif') startCamera();
                else dom.filmMeter.click();
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

  dom.zoneToggle.addEventListener('click', () => {
    updateSettings({ showExposureZones: !getSettings().showExposureZones });
  });
  dom.shutter.addEventListener('click', capture);
  dom.retry.addEventListener('click', () => startCamera());
  dom.demoBtn.addEventListener('click', startDemo);
  dom.statusChip.addEventListener('click', showEngineInfo);
}

export function createMeter({ onSaved, onNavigate } = {}) {
  onSavedCb = onSaved || null;
  onNavigateCb = onNavigate || null;

  initLadder();
  for (let i = 0; i < EXPOSURE_ZONE_GRID ** 2; i++) {
    const cell = document.createElement('span');
    cell.className = 'exposure-zones__cell';
    dom.exposureZones.appendChild(cell);
    zoneCells.push(cell);
  }
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
    if (event.patch.aperture != null) revealLadderChoice(s.aperture);
    if (event.patch.fps != null || event.patch.mode != null) syncNativePreviewRate();
    updateExifReading();
    syncNativeMeterPoint();
    updateReadout(true);
    syncWakeLock();
  });

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => updateZone());
    ro.observe(dom.stage);
  }

  const onVisible = () => {
    if (document.visibilityState === 'hidden' && (hasNativeCamera || getRuntime().source === 'exif')) {
      stopCamera();
      stats = null;
      setRuntime({ exifStatus: '返回取景后重新取样' });
      updateReadout(true);
    }
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
      const source = lockSnapshot?.source ?? getRuntime().source;
      return ['hardware', 'native'].includes(source) ? referenceReading() : null;
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
      if (hasNativeCamera) setNativeKeepAwake(false);
      else setWakeLock(false);
    }
  };
}