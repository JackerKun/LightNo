/**
 * LIGHTNO · 设置视图
 */
import { $, $$, setText, formatBytes } from './dom.js';
import {
  getSettings,
  updateSettings,
  getRuntime,
  subscribe,
  resetSettings
} from '../core/state.js';
import { hasNativeCamera } from '../core/nativeCamera.js';
import { clearShots, countShots, storageEstimate } from '../core/store.js';
import { zoneRoman, formatAperture } from '../core/exposure.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';
import { hapticTap } from './haptic.js';
import {
  pickLens,
  pickTargetZone,
  openCalibration,
  openAlgorithmDoc
} from './pickers.js';

let getLiveEvFn = () => NaN;
let onClearedCb = null;
let onInstallCb = null;
let onEngineChangeCb = null;

function setSwitch(id, on) {
  const node = $(id);
  if (!node) return;
  node.classList.toggle('is-on', !!on);
  node.setAttribute('aria-checked', String(!!on));
}

function setSeg(selector, value) {
  $$(selector + ' button').forEach((btn) => {
    btn.classList.toggle('is-active', String(btn.dataset.value) === String(value));
  });
}

function renderCapability() {
  const rt = getRuntime();
  const badge = $('#capBadge');
  const note = $('#capNote');
  if (!badge || !note) return;
  badge.className = 'badge';

  if (rt.source === 'native') {
    badge.textContent = '原生测光';
    badge.classList.add('is-ok');
    note.textContent = '使用后置主摄的快门、ISO 和光圈';
  } else if (rt.source === 'hardware') {
    badge.textContent = '手动曝光';
    badge.classList.add('is-ok');
    note.textContent = '使用手机快门、ISO 和镜头固定光圈估算 EV';
  } else if (rt.source === 'exif') {
    badge.textContent = '自动 EXIF';
    badge.classList.add(rt.exifFailed ? 'is-warn' : 'is-ok');
    note.textContent = rt.exifStatus || '在取景时读取自动样本的曝光参数';
  } else if (rt.source === 'image' || rt.source === 'relative') {
    badge.textContent = '画面分析';
    badge.classList.add('is-ok');
    note.textContent = '查看画面明暗。计算胶片曝光可用拍照测光。';
  } else if (rt.source === 'demo') {
    badge.textContent = '演示模式';
    badge.classList.add('is-demo');
    note.textContent = '程序绘制场景，不代表真实亮度';
  } else if (rt.source === 'error') {
    badge.textContent = '相机异常';
    badge.classList.add('is-warn');
    note.textContent = (rt.cameraError && rt.cameraError.message) || '请检查相机权限';
  } else {
    badge.textContent = '检测中';
    note.textContent = '正在启动相机…';
  }
}

async function updateStorage() {
  if (hasNativeCamera) return;
  const note = $('#storageNote');
  if (!note) return;
  try {
    const count = await countShots();
    const est = await storageEstimate();
    let text = `${count} 条记录`;
    if (est) {
      text += ` · 已用 ${formatBytes(est.usage)}`;
      if (est.quota) text += ` / ${formatBytes(est.quota)}`;
    }
    note.textContent = text;
  } catch {
    note.textContent = '无法读取存储信息';
  }
}

function sync() {
  const s = getSettings();

  setText($('#setLensValue'), formatAperture(s.lensAperture));
  if (hasNativeCamera) setText($('#calibTitle'), '原生测光校准');
  const calibration = hasNativeCamera ? s.nativeCalibration : s.calibration;
  setText($('#setCalibValue'), `${calibration >= 0 ? '+' : ''}${calibration.toFixed(1)} EV`);
  const calibrationNote = hasNativeCamera ? '先在取景页测量同一张灰卡'
    : s.calibrated ? '已校准 · 点击可重新校准' : '硬件曝光读数可用时校准';
  setText($('#calibNote'), calibrationNote);
  setText($('#setTargetZoneValue'), 'ZONE ' + zoneRoman(s.targetZone));

  const spotRange = $('#rangeSpotSize');
  if (spotRange) {
    spotRange.value = String(Math.round(s.spotSize * 100));
    setText($('#setSpotSizeValue'), Math.round(s.spotSize * 100) + '%');
  }
  const smoothRange = $('#rangeSmoothing');
  if (smoothRange) smoothRange.value = String(Math.round(s.smoothing * 100));

  setSwitch('#swHistogram', s.showHistogram);
  setSwitch('#swZebra', s.showZebra);
  setSwitch('#swGrid', s.showGrid);
  setSwitch('#swWake', s.keepAwake);
  setSwitch('#swGeotag', s.geotag);

  setSeg('#segFps', s.fps);
  setSeg('#segQuality', s.quality);
  setSeg('#segEngine', s.engine);

  setText(
    $('#qualityNote'),
    Number(s.quality) >= 0.9 ? '高 · 约 600KB / 张' : '标准 · 约 350KB / 张'
  );

  renderCapability();
}

function wireSwitch(id, key) {
  const node = $(id);
  if (!node) return;
  node.addEventListener('click', () => {
    const next = !getSettings()[key];
    updateSettings({ [key]: next });
    hapticTap();
  });
}

export function createSettings({
  getLiveEv,
  onCleared,
  onInstall,
  onEngineChange
} = {}) {
  getLiveEvFn = getLiveEv || (() => NaN);
  onClearedCb = onCleared || null;
  onInstallCb = onInstall || null;
  onEngineChangeCb = onEngineChange || null;

  wireSwitch('#swHistogram', 'showHistogram');
  wireSwitch('#swZebra', 'showZebra');
  wireSwitch('#swGrid', 'showGrid');
  wireSwitch('#swWake', 'keepAwake');
  wireSwitch('#swGeotag', 'geotag');

  $$('#segFps button').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateSettings({ fps: Number(btn.dataset.value) });
      hapticTap();
    });
  });

  $$('#segQuality button').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateSettings({ quality: Number(btn.dataset.value) });
      hapticTap();
    });
  });

  const spotRange = $('#rangeSpotSize');
  if (spotRange) {
    spotRange.addEventListener('input', () => {
      updateSettings({ spotSize: Number(spotRange.value) / 100 });
      setText($('#setSpotSizeValue'), spotRange.value + '%');
    });
  }

  const smoothRange = $('#rangeSmoothing');
  if (smoothRange) {
    smoothRange.addEventListener('input', () => {
      updateSettings({ smoothing: Number(smoothRange.value) / 100 });
    });
  }

  const lensBtn = $('#btnLens');
  if (lensBtn) {
    lensBtn.addEventListener('click', () => {
      pickLens(getSettings().lensAperture, (v) => updateSettings({ lensAperture: v }));
    });
  }

  const engineSeg = $('#segEngine');
  if (engineSeg) {
    engineSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-value]');
      if (!btn || getSettings().engine === btn.dataset.value) return;
      updateSettings({ engine: btn.dataset.value });
      sync();
      hapticTap();
      if (onEngineChangeCb) onEngineChangeCb(btn.dataset.value);
    });
  }

  const calibBtn = $('#btnCalibrate');
  if (calibBtn) {
    calibBtn.addEventListener('click', () => {
      openCalibration({ getLiveEv: () => getLiveEvFn(), source: hasNativeCamera ? 'native' : 'hardware' });
    });
  }

  const zoneBtn = $('#btnTargetZone');
  if (zoneBtn) {
    zoneBtn.addEventListener('click', () => {
      pickTargetZone(getSettings().targetZone, (v) => updateSettings({ targetZone: v }));
    });
  }

  const algoBtn = $('#btnAlgorithm');
  if (algoBtn) algoBtn.addEventListener('click', openAlgorithmDoc);

  const installBtn = $('#btnInstall');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (onInstallCb) onInstallCb();
    });
  }

  const clearBtn = $('#btnClearShots');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      openSheet({
        title: '清空全部测光记录？',
        subtitle: '照片与参数会从本机永久删除，无法恢复。建议先导出备份。',
        actions: [
          { label: '取消', kind: 'ghost', onClick: () => closeSheet() },
          {
            label: '清空',
            kind: 'danger',
            onClick: async () => {
              try {
                await clearShots();
                closeSheet();
                toast('记录已清空', { type: 'success' });
                if (onClearedCb) onClearedCb();
                updateStorage();
              } catch {
                toast('清空失败', { type: 'error' });
              }
            }
          }
        ]
      });
    });
  }

  const resetBtn = $('#btnReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      openSheet({
        title: '恢复默认设置？',
        subtitle: '相机参数、校准、显示与记录选项都会恢复默认；已有测光记录不会被删除。',
        actions: [
          { label: '取消', kind: 'ghost', onClick: () => closeSheet() },
          {
            label: '恢复默认',
            kind: 'danger',
            onClick: () => {
              resetSettings();
              sync();
              closeSheet();
              toast('设置已恢复默认', { type: 'success' });
            }
          }
        ]
      });
    });
  }

  subscribe((event) => {
    if (event.type === 'settings') sync();
    else if (event.type === 'runtime') renderCapability();
  });

  const installNote = $('#installNote');
  if (installNote) {
    installNote.textContent = window.matchMedia('(display-mode: standalone)').matches
      ? '已在独立窗口中运行'
      : '离线可用，像 App 一样启动';
  }

  sync();
  updateStorage();

  return {
    refresh() {
      sync();
      updateStorage();
    }
  };
}