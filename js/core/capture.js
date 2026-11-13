/**
 * LIGHTNO · 测光照片合成
 *
 * 把当前取景画面（含数码变焦裁切）绘制成照片，并烧录测光参数：
 * EV、模式、ISO、光圈、快门、ND、色温、测光框位置、时间、坐标。
 */

import {
  formatEv,
  formatShutter,
  formatAperture,
  formatCct,
  formatLuminance,
  ndLabel,
  ndDensity,
  zoneRoman,
  MID_GRAY,
  log2
} from './exposure.js';

const FONT = '"SF Pro Display","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const MONO = '"SF Mono","JetBrains Mono","Roboto Mono",Consolas,"Courier New",monospace';

const BRIGHT = '#eef4ff';
const MUTED = 'rgba(200,214,240,0.68)';
const ACCENT = '#37f2ff';
const VIOLET = '#a98bff';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function sourceSize(source) {
  return {
    width: source.videoWidth || source.width || 0,
    height: source.videoHeight || source.height || 0
  };
}

function drawVideoFrame(source, ctx, w, h, aspect, zoom) {
  const { width: sw0, height: sh0 } = sourceSize(source);
  if (!sw0 || !sh0) return false;
  let sw;
  let sh;
  if (sw0 / sh0 > aspect) {
    sh = sh0;
    sw = sh0 * aspect;
  } else {
    sw = sw0;
    sh = sw0 / aspect;
  }
  const z = Math.max(1, zoom || 1);
  sw /= z;
  sh /= z;
  const sx = (sw0 - sw) / 2;
  const sy = (sh0 - sh) / 2;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return true;
}

function drawZoneMarker(ctx, w, h, shot) {
  const zone = shot.zone;
  if (!zone) return;
  const s = w / 1200;
  const minDim = Math.min(w, h);
  const shape = zone.shape || 'circle';

  if (shape === 'full') {
    const inset = Math.min(w, h) * 0.06;
    ctx.save();
    ctx.strokeStyle = 'rgba(55,242,255,0.55)';
    ctx.lineWidth = 1.6 * s;
    ctx.setLineDash([10 * s, 8 * s]);
    ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    ctx.restore();
    return;
  }

  const r = Math.max(8 * s, (zone.size || 0.14) * minDim * 0.5);
  const cx = (zone.cx != null ? zone.cx : 0.5) * w;
  const cy = (zone.cy != null ? zone.cy : 0.5) * h;

  ctx.save();
  ctx.lineWidth = 2 * s;
  ctx.strokeStyle = 'rgba(55,242,255,0.95)';
  ctx.shadowColor = 'rgba(55,242,255,0.6)';
  ctx.shadowBlur = 12 * s;
  if (shape === 'rect') {
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // 中心十字
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.18, cy);
  ctx.lineTo(cx + r * 0.18, cy);
  ctx.moveTo(cx, cy - r * 0.18);
  ctx.lineTo(cx, cy + r * 0.18);
  ctx.strokeStyle = 'rgba(238,244,255,0.9)';
  ctx.lineWidth = 1.6 * s;
  ctx.stroke();
  ctx.restore();
}

function drawAnnotation(ctx, w, h, shot) {
  const s = w / 1200;
  const pad = 26 * s;
  const baseY = h - pad;

  // 顶部渐变
  let g = ctx.createLinearGradient(0, 0, 0, h * 0.2);
  g.addColorStop(0, 'rgba(3,6,12,0.84)');
  g.addColorStop(1, 'rgba(3,6,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h * 0.2);

  // 底部渐变
  g = ctx.createLinearGradient(0, h * 0.42, 0, h);
  g.addColorStop(0, 'rgba(3,6,12,0)');
  g.addColorStop(0.5, 'rgba(3,6,12,0.78)');
  g.addColorStop(1, 'rgba(2,4,9,0.96)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h * 0.42, w, h * 0.58);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // 品牌
  ctx.fillStyle = BRIGHT;
  ctx.font = `700 ${26 * s}px ${FONT}`;
  ctx.fillText('LIGHTNO', pad, pad + 22 * s);
  const brandW = ctx.measureText('LIGHTNO').width;
  ctx.fillStyle = ACCENT;
  ctx.font = `600 ${11 * s}px ${MONO}`;
  ctx.fillText('LIGHT METER', pad + brandW + 12 * s, pad + 22 * s);

  // 时间
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${13 * s}px ${MONO}`;
  ctx.fillText(shot.timeLabel || '', w - pad, pad + 18 * s);
  ctx.textAlign = 'left';

  // 模式标签
  const tag = shot.modeTag || 'SPOT';
  ctx.font = `600 ${12 * s}px ${MONO}`;
  const tagW = ctx.measureText(tag).width + 22 * s;
  const tagY = pad + 36 * s;
  ctx.fillStyle = 'rgba(55,242,255,0.13)';
  roundRect(ctx, pad, tagY, tagW, 23 * s, 6 * s);
  ctx.fill();
  ctx.strokeStyle = 'rgba(55,242,255,0.45)';
  ctx.lineWidth = 1 * s;
  ctx.stroke();
  ctx.fillStyle = ACCENT;
  ctx.fillText(tag, pad + 11 * s, tagY + 16 * s);

  // 溢出提示
  if (shot.clip > 0.02) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffc75c';
    ctx.font = `600 ${12 * s}px ${MONO}`;
    ctx.fillText('CLIP ' + (shot.clip * 100).toFixed(1) + '%', w - pad, pad + 42 * s);
    ctx.textAlign = 'left';
  }

  // 底部左侧：EV
  const evLabelY = baseY - 148 * s;
  const evBaseline = baseY - 48 * s;
  ctx.fillStyle = ACCENT;
  ctx.font = `600 ${13 * s}px ${MONO}`;
  ctx.fillText('EV 100', pad, evLabelY);

  ctx.font = `700 ${86 * s}px ${MONO}`;
  ctx.fillStyle = BRIGHT;
  ctx.shadowColor = 'rgba(55,242,255,0.35)';
  ctx.shadowBlur = 18 * s;
  ctx.fillText(formatEv(shot.ev, 1), pad - 3 * s, evBaseline);
  ctx.shadowBlur = 0;

  const zoneText = shot.zoneValue != null ? 'ZONE ' + zoneRoman(shot.zoneValue) : 'ZONE V';
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${14 * s}px ${MONO}`;
  ctx.fillText(
    `${formatLuminance(shot.luminance)} · ${zoneText} · ${formatCct(shot.cct)}`,
    pad,
    baseY - 22 * s
  );

  // 底部右侧：曝光参数
  const rows = [
    ['ISO', String(shot.iso)],
    ['光圈', formatAperture(shot.aperture)],
    ['快门', formatShutter(shot.shutterWithNd)],
    ['ND', shot.ndStops > 0 ? `${ndLabel(shot.ndStops)} · ${ndDensity(shot.ndStops)}` : 'OFF'],
    ['基准', formatShutter(shot.shutterBase)]
  ];
  const rightX = w - pad;
  const keyX = rightX - 150 * s;
  let rowY = evLabelY;
  for (const [key, value] of rows) {
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `500 ${13 * s}px ${MONO}`;
    ctx.fillText(key, keyX, rowY);

    ctx.textAlign = 'right';
    ctx.fillStyle = BRIGHT;
    ctx.font = `600 ${18 * s}px ${MONO}`;
    ctx.fillText(value, rightX, rowY + 1 * s);
    rowY += 26 * s;
  }
  ctx.textAlign = 'left';

  // 分隔线
  ctx.strokeStyle = 'rgba(55,242,255,0.22)';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(w * 0.565, evLabelY - 16 * s);
  ctx.lineTo(w * 0.565, baseY - 40 * s);
  ctx.stroke();

  // 最底部说明
  ctx.fillStyle = 'rgba(200,214,240,0.5)';
  ctx.font = `500 ${11 * s}px ${MONO}`;
  const foot = [
    shot.dateLabel,
    shot.coords,
    shot.calibrationText,
    shot.priorityText,
    shot.sourceText,
    'LIGHTNO · 本地生成'
  ]
    .filter(Boolean)
    .join('  ·  ');
  ctx.fillText(foot, pad, baseY);
}

/** 画布 → Blob */
function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('ENCODE_FAILED'))),
        'image/jpeg',
        quality
      );
      return;
    }
    try {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.split(',')[1];
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: 'image/jpeg' }));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 合成带参数的照片 + 缩略图
 * @param {HTMLVideoElement|HTMLCanvasElement} source
 * @param {{aspect:number, digitalZoom:number, shot:object, quality:number, maxWidth:number}} opts
 */
export async function composePhoto(
  source,
  { aspect = 3 / 4, digitalZoom = 1, shot, quality = 0.82, maxWidth = 1600 }
) {
  const { width: srcW } = sourceSize(source);
  const canvas = document.createElement('canvas');
  const baseW = srcW || 1280;
  const outW = Math.round(Math.min(maxWidth, Math.max(720, baseW / Math.max(1, digitalZoom || 1))));
  const outH = Math.round(outW / aspect);
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  if (!drawVideoFrame(source, ctx, outW, outH, aspect, digitalZoom)) {
    throw new Error('NO_FRAME');
  }

  drawZoneMarker(ctx, outW, outH, shot);
  drawAnnotation(ctx, outW, outH, shot);

  const blob = await toBlob(canvas, quality);

  const thumbW = 520;
  const thumbH = Math.round(thumbW / aspect);
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbW;
  thumbCanvas.height = thumbH;
  const tctx = thumbCanvas.getContext('2d');
  tctx.imageSmoothingQuality = 'medium';
  tctx.drawImage(canvas, 0, 0, thumbW, thumbH);
  const thumb = await toBlob(thumbCanvas, Math.min(0.75, quality));

  return { blob, thumb, width: outW, height: outH };
}

/** 生成可复制的参数文本 */
export function shotToText(shot) {
  const lines = [
    'LIGHTNO 测光记录',
    `EV100 ${formatEv(shot.ev, 1)}  ·  ${shot.modeLabel || shot.modeTag || ''}`,
    `ISO ${shot.iso}  ·  ${formatAperture(shot.aperture)}  ·  ${formatShutter(shot.shutterWithNd)}${
      shot.ndStops > 0 ? ' (含 ' + ndLabel(shot.ndStops) + ')' : ''
    }  ·  ${shot.priorityText || '光圈优先'}`,
    `亮度 ${formatLuminance(shot.luminance)}  ·  色温 ${formatCct(shot.cct)}`,
    shot.note ? `备注：${shot.note}` : '',
    shot.dateLabel || ''
  ];
  return lines.filter(Boolean).join('\n');
}

export { MID_GRAY, log2 };