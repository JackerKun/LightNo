/**
 * LIGHTNO · 拍照测光（iPhone 可用的绝对 EV 路径）
 *
 * 用系统相机拍一张照片 → 读取 JPEG EXIF 的快门/光圈/ISO →
 * 结合照片区域的图像亮度反推该区域的 EV。
 * 不依赖 getUserMedia 的曝光控制，也没有硬件限制。
 */
import { $, setText, uid, timeLabel, shortDate } from './dom.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';
import { hapticSave, hapticError } from './haptic.js';
import { parseJpegExif, hasExposureExif } from '../core/exif.js';
import { analyze } from '../core/sampler.js';
import { composePhoto } from '../core/capture.js';
import { putShot } from '../core/store.js';
import { getSettings, updateSettings } from '../core/state.js';
import {
  MID_GRAY,
  log2,
  clamp,
  evFromExposure,
  exposurePair,
  formatShutter,
  formatShutterRecommended,
  formatAperture,
  formatEv,
  formatLuminance,
  luminanceFromEv,
  formatCct,
  cctFromLinearRgb,
  contrastStops
} from '../core/exposure.js';

const ANALYSIS_MAX = 900;
const DISPLAY_W = 360;
const DISPLAY_H = 300;

let inputEl = null;
let onSavedCb = null;
let state = null;

export function createPhotoMeter({ onSaved } = {}) {
  onSavedCb = onSaved || null;
  inputEl = $('#photoInput');
  const btn = $('#btnPhotoMeter');
  if (btn && inputEl) {
    btn.addEventListener('click', () => inputEl.click());
  }
  if (inputEl) {
    inputEl.addEventListener('change', async () => {
      const file = inputEl.files && inputEl.files[0];
      inputEl.value = '';
      if (file) await openFile(file);
    });
  }
  return {
    open() {
      if (inputEl) inputEl.click();
    }
  };
}

function isHeic(file, buffer) {
  const type = (file.type || '').toLowerCase();
  if (type.includes('heic') || type.includes('heif')) return true;
  try {
    const head = new TextDecoder('ascii').decode(new Uint8Array(buffer, 4, 8));
    return head.startsWith('ftypheic') || head.startsWith('ftypheix') || head.startsWith('ftypmif1');
  } catch {
    return false;
  }
}

async function openFile(file) {
  if (!file.type || !file.type.startsWith('image/')) {
    toast('请选择照片文件', { type: 'warn' });
    return;
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    toast('无法读取照片', { type: 'error' });
    return;
  }

  const exif = parseJpegExif(buffer);

  if (!hasExposureExif(exif)) {
    const heic = isHeic(file, buffer);
    openSheet({
      title: '这张照片没有曝光信息',
      subtitle: '无法从 EXIF 读取快门 / 光圈 / ISO，因此不能计算绝对 EV',
      content: `<div class="doc">
        <p>请用 <b>系统相机</b> 拍摄照片（不要用截图、聊天软件转存的图片，它们通常会清除 EXIF）。</p>
        <h4>iPhone 设置</h4>
        <p>设置 → 相机 → 格式 → 选择「<b>兼容性最佳</b>」（JPEG）。如果当前是 HEIC，Safari 有时会丢失元数据。</p>
        <h4>Android</h4>
        <p>使用相机应用拍摄的 JPEG；部分机型/应用会移除 EXIF。</p>
        <p class="picker-note">${
          heic ? '检测到 HEIC/HEIF 文件，建议改用 JPEG 再试。' : '未找到 Exif 中的曝光三要素。'
        }</p>
      </div>`,
      actions: [
        { label: '关闭', kind: 'ghost', onClick: () => closeSheet() },
        {
          label: '重新拍摄',
          kind: 'primary',
          onClick: () => {
            closeSheet();
            if (inputEl) inputEl.click();
          }
        }
      ]
    });
    return;
  }

  let img;
  let url;
  try {
    url = URL.createObjectURL(file);
    img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('无法解码这张图片'));
      img.src = url;
    });
  } catch (err) {
    if (url) URL.revokeObjectURL(url);
    toast(err.message || '无法读取照片', { type: 'error' });
    return;
  }

  const scale = Math.min(1, ANALYSIS_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const aw = Math.max(1, Math.round(img.naturalWidth * scale));
  const ah = Math.max(1, Math.round(img.naturalHeight * scale));
  const analysis = document.createElement('canvas');
  analysis.width = aw;
  analysis.height = ah;
  const actx = analysis.getContext('2d', { willReadFrequently: true });
  actx.drawImage(img, 0, 0, aw, ah);
  let imageData;
  try {
    imageData = actx.getImageData(0, 0, aw, ah);
  } catch {
    URL.revokeObjectURL(url);
    toast('无法分析这张照片', { type: 'error' });
    return;
  }

  const cameraEv = evFromExposure({
    aperture: exif.fNumber,
    shutter: exif.exposureTime,
    iso: exif.iso
  });
  if (!Number.isFinite(cameraEv)) {
    URL.revokeObjectURL(url);
    toast('照片曝光参数无效', { type: 'error' });
    return;
  }

  state = {
    file,
    img,
    url,
    exif,
    cameraEv,
    analysis,
    imageData,
    region: {
      cx: 0.5,
      cy: 0.5,
      size: Math.max(0.12, getSettings().spotSize)
    },
    stats: null,
    ev: null,
    avgEv: null,
    saveBusy: false,
    raf: 0,
    dragging: false
  };

  showPhotoSheet(state);
}

function showPhotoSheet(current) {
  const content = document.createElement('div');
  content.className = 'photo-meter';
  content.innerHTML = `
    <div class="photo-stage">
      <canvas id="photoCanvas" class="photo-canvas"></canvas>
      <span class="photo-stage__hint">拖动选择测光区</span>
    </div>
    <div class="photo-readout">
      <div class="photo-ev">
        <span>EV 100</span>
        <b id="photoEv">—</b>
        <i id="photoEvNote">中心测光区</i>
      </div>
      <div class="photo-params">
        <span id="photoExif">照片 —</span>
        <span id="photoCameraEv">相机 EV —</span>
        <span id="photoAvgEv">平均 EV —</span>
        <span id="photoCct">色温 —</span>
      </div>
    </div>
    <p class="picker-note">
      EV 由照片 EXIF 的快门 / 光圈 / ISO 与所选区域的图像亮度反推。拖动照片上的圆圈可以改变测光区。
    </p>
    <button class="btn btn--ghost photo-anchor" id="photoUseAnchor" type="button">
      将平均 EV 设为实时图像基准
    </button>
  `;

  const canvas = content.querySelector('#photoCanvas');
  const evEl = content.querySelector('#photoEv');
  const noteEl = content.querySelector('#photoEvNote');
  const exifEl = content.querySelector('#photoExif');
  const cameraEvEl = content.querySelector('#photoCameraEv');
  const avgEvEl = content.querySelector('#photoAvgEv');
  const cctEl = content.querySelector('#photoCct');
  const anchorBtn = content.querySelector('#photoUseAnchor');

  const imgW = current.analysis.width;
  const imgH = current.analysis.height;
  const displayScale = Math.min(DISPLAY_W / imgW, DISPLAY_H / imgH, 1);
  const dw = Math.max(1, Math.round(imgW * displayScale));
  const dh = Math.max(1, Math.round(imgH * displayScale));
  canvas.width = dw;
  canvas.height = dh;
  canvas.style.width = dw + 'px';
  const ctx = canvas.getContext('2d');

  const render = () => {
    const region = current.region;
    const stats = analyze(current.imageData.data, imgW, imgH, {
      shape: 'circle',
      cx: region.cx,
      cy: region.cy,
      size: region.size,
      feather: 0.1
    });
    const y = clamp(stats.region.mean, 1e-4, 1);
    const calibration = getSettings().calibration;
    const ev = current.cameraEv + log2(y / MID_GRAY) + calibration;
    const avgEv =
      current.cameraEv + log2(clamp(stats.frame.mean, 1e-4, 1) / MID_GRAY) + calibration;
    current.stats = stats;
    current.ev = ev;
    current.avgEv = avgEv;

    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(current.analysis, 0, 0, dw, dh);

    const cx = region.cx * dw;
    const cy = region.cy * dh;
    const r = Math.max(7, (region.size * Math.min(dw, dh)) / 2);
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(55, 242, 255, 0.95)';
    ctx.shadowColor = 'rgba(55, 242, 255, 0.55)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(238, 250, 255, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.restore();

    setText(evEl, formatEv(ev, 1));
    setText(noteEl, `点测光 · ${formatLuminance(luminanceFromEv(ev))}`);
    setText(
      exifEl,
      `照片 ${formatShutter(current.exif.exposureTime)} · ${formatAperture(
        current.exif.fNumber
      )} · ISO ${current.exif.iso}`
    );
    setText(cameraEvEl, `相机 EV ${formatEv(current.cameraEv, 1)}`);
    const dr = contrastStops(Math.max(stats.frame.p02, 1e-5), stats.frame.p98);
    setText(
      avgEvEl,
      `平均 EV ${formatEv(avgEv, 1)} · 反差 ${Number.isFinite(dr) ? dr.toFixed(1) : '—'} EV`
    );
    setText(
      cctEl,
      `色温 ${formatCct(
        cctFromLinearRgb(stats.region.rgb[0], stats.region.rgb[1], stats.region.rgb[2])
      )}`
    );
    if (anchorBtn) {
      if (!anchorBtn.disabled) {
        anchorBtn.textContent = `将平均 EV ${formatEv(avgEv, 1)} 设为实时图像基准`;
      }
    }
  };

  const scheduleRender = () => {
    if (current.raf) return;
    current.raf = requestAnimationFrame(() => {
      current.raf = 0;
      render();
    });
  };

  const updateFromPointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    current.region.cx = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    current.region.cy = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    scheduleRender();
  };

  canvas.addEventListener('pointerdown', (event) => {
    current.dragging = true;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    updateFromPointer(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (current.dragging) updateFromPointer(event);
  });
  const endDrag = () => {
    current.dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

async function save() {
    if (!Number.isFinite(current.ev) || current.saveBusy) return;
    current.saveBusy = true;
    try {
      const s = getSettings();
      const pair = exposurePair({
        ev100: current.ev,
        iso: s.iso,
        ndStops: s.ndStops,
        priority: s.priority,
        aperture: s.aperture,
        shutter: s.shutter
      });
      if (!pair) throw new Error('曝光组合计算失败');

      const nd = s.ndStops;
      const now = Date.now();
      const stats = current.stats;
      const exif = current.exif;
      const shot = {
        id: uid(),
        createdAt: now,
        ev: current.ev,
        mode: 'photo',
        modeLabel: '拍照测光',
        modeTag: 'PHOTO',
        iso: s.iso,
        aperture: pair.aperture,
        shutterWithNd: pair.shutter,
        shutterBase: pair.shutter / Math.pow(2, nd),
        priority: s.priority,
        priorityText: s.priority === 'shutter' ? '快门优先' : '光圈优先',
        apertureAuto: pair.auto === 'aperture',
        apertureOutOfRange: !!pair.apertureOutOfRange,
        shutterOutOfRange: !!pair.shutterOutOfRange,
        ndStops: nd,
        luminance: luminanceFromEv(current.ev),
        contrast: contrastStops(Math.max(stats.frame.p02, 1e-5), stats.frame.p98),
        cct: cctFromLinearRgb(
          stats.region.rgb[0],
          stats.region.rgb[1],
          stats.region.rgb[2]
        ),
        clip: stats.frame.clip,
        zoneValue: 5,
        zone: {
          shape: 'circle',
          cx: current.region.cx,
          cy: current.region.cy,
          size: current.region.size
        },
        cameraExposure: {
          aperture: exif.fNumber,
          shutter: exif.exposureTime,
          iso: exif.iso,
          source: 'exif'
        },
        source: 'photo',
        sourceText: '拍照测光 EXIF',
        zoom: 1,
        lensAperture: s.lensAperture,
        calibration: s.calibration,
        location: null,
        note: '',
        favorite: false,
        timeLabel: timeLabel(now),
        dateLabel: shortDate(now),
        coords: '',
        calibrationText:
          Math.abs(s.calibration) >= 0.05
            ? `CAL ${s.calibration >= 0 ? '+' : ''}${s.calibration.toFixed(1)}EV`
            : '',
        photoMeta: {
          make: exif.make || '',
          model: exif.model || '',
          dateTime: exif.dateTime || '',
          focalLength: exif.focalLength || null
        }
      };

      const composed = await composePhoto(current.img, {
        aspect: current.img.naturalWidth / current.img.naturalHeight,
        digitalZoom: 1,
        shot,
        quality: s.quality
      });
      shot.photo = composed.blob;
      shot.thumb = composed.thumb;
      shot.width = composed.width;
      shot.height = composed.height;

      await putShot(shot);
      if (onSavedCb) onSavedCb(shot);
      hapticSave();
      toast(
        `已保存 · EV ${formatEv(current.ev, 1)} · ${formatShutterRecommended(pair.shutter)}`,
        { type: 'success', duration: 2600 }
      );
      closeSheet();
    } catch (err) {
      console.error('[LIGHTNO] photo meter save failed', err);
      toast('保存失败：' + (err.message || err), { type: 'error' });
      hapticError();
    } finally {
      current.saveBusy = false;
    }
  }

  anchorBtn.addEventListener('click', () => {
    if (!Number.isFinite(current.avgEv)) return;
    // 实时图像公式会再加一次校准，这里存「未校准的场景平均 EV」，避免重复
    updateSettings({ anchorEv: current.avgEv - getSettings().calibration });
    toast(`实时图像基准已设为 EV ${formatEv(current.avgEv, 1)}`, {
      type: 'success',
      duration: 2600
    });
    anchorBtn.textContent = '已设为实时图像基准';
    anchorBtn.disabled = true;
  });

  render();

  openSheet({
    title: '拍照测光',
    subtitle: '读取照片 EXIF 的曝光参数，再结合图像亮度分析',
    content,
    actions: [
      {
        label: '重新拍摄',
        kind: 'ghost',
        onClick: () => {
          closeSheet();
          if (inputEl) inputEl.click();
        }
      },
      { label: '保存到记录', kind: 'primary', onClick: save }
    ],
    onClose: () => {
      if (current.raf) cancelAnimationFrame(current.raf);
      if (current.url) URL.revokeObjectURL(current.url);
      state = null;
    }
  });
}