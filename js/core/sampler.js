/**
 * LIGHTNO · 画面采样与亮度统计
 *
 * 说明：
 * - 相机预览是 sRGB 编码的，必须先解码到线性光再计算亮度，才能与 EV 对应；
 * - 统计使用 log2 亮度直方图，因此均值 / 百分位 / 反差都能直接换算成「档」；
 * - 测光区支持 点 / 圆、方形框选、全画面平均、中央重点（高斯权重）。
 */

export const HIST_BINS = 128;
export const LOG_MIN = -13;
export const LOG_RANGE = 13;
export const CLIP_THRESHOLD = 0.985;

/** sRGB 编码值 → 线性光 */
export const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

const clampInt = (v, min, max) => (v < min ? min : v > max ? max : v);

function binOf(luma) {
  const l = Math.max(luma, 2 ** LOG_MIN);
  const s = Math.log2(l);
  const t = (s - LOG_MIN) / LOG_RANGE;
  return clampInt(Math.round(t * (HIST_BINS - 1)), 0, HIST_BINS - 1);
}

/** 从 log2 直方图取百分位（q: 0..1） */
export function percentileFromHist(hist, total, q) {
  if (!total || !hist || total <= 0) return 0;
  const target = total * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    const count = hist[i];
    if (acc + count >= target) {
      const frac = count > 0 ? (target - acc) / count : 0;
      const s = LOG_MIN + ((i + frac) / hist.length) * LOG_RANGE;
      return Math.pow(2, s);
    }
    acc += count;
  }
  return Math.pow(2, LOG_MIN + LOG_RANGE);
}

function regionRadiusPx(region, minDim) {
  const size = region.size != null ? region.size : region.r != null ? region.r * 2 : 0.12;
  return Math.max(1, (size * minDim) / 2);
}

function makeStats(sum, weight, clip, hist, rgb) {
  const total = weight > 0 ? weight : 1;
  return {
    mean: sum / total,
    p02: percentileFromHist(hist, total, 0.02),
    p10: percentileFromHist(hist, total, 0.1),
    p50: percentileFromHist(hist, total, 0.5),
    p90: percentileFromHist(hist, total, 0.9),
    p98: percentileFromHist(hist, total, 0.98),
    clip: clip / total,
    rgb: [rgb[0] / total, rgb[1] / total, rgb[2] / total]
  };
}

/**
 * 分析一帧 RGBA 像素
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} width
 * @param {number} height
 * @param {{shape?:string, cx?:number, cy?:number, size?:number, feather?:number}} region
 */
export function analyze(data, width, height, region = {}, options = {}) {
  const lut = options.lut || SRGB_TO_LINEAR;
  const shape = region.shape || 'full';
  const full = shape === 'full';
  const minDim = Math.min(width, height);

  const cx = (region.cx != null ? region.cx : 0.5) * width;
  const cy = (region.cy != null ? region.cy : 0.5) * height;
  const radius = regionRadiusPx(region, minDim);
  const feather = shape === 'circle' ? Math.max(0, Math.min(0.8, region.feather ?? 0.12)) : 0;
  const gaussSigma = Math.max(2, (region.size != null ? region.size : 0.45) * minDim * 0.5);
  const inv2Sigma2 = 1 / (2 * gaussSigma * gaussSigma);

  const hist = new Float32Array(HIST_BINS);
  const regionHist = full ? hist : new Float32Array(HIST_BINS);
  const gridW = 80;
  const gridH = Math.max(1, Math.round((gridW * height) / width));
  const clipMap = options.clipMap === false ? null : new Uint8Array(gridW * gridH);
  const cellX = width / gridW;
  const cellY = height / gridH;

  let fSum = 0;
  let fCount = 0;
  let fClip = 0;
  let fr = 0;
  let fg = 0;
  let fb = 0;

  let rSum = 0;
  let rWeight = 0;
  let rClip = 0;
  let rr = 0;
  let rg = 0;
  let rb = 0;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    const gy = Math.min(gridH - 1, (y / cellY) | 0);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = lut[data[i]];
      const g = lut[data[i + 1]];
      const b = lut[data[i + 2]];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      fSum += luma;
      fCount++;
      fr += r;
      fg += g;
      fb += b;
      const clipped = luma >= CLIP_THRESHOLD;
      if (clipped) {
        fClip++;
        if (clipMap) clipMap[gy * gridW + Math.min(gridW - 1, (x / cellX) | 0)] = 1;
      }
      const bin = binOf(luma);
      hist[bin]++;
      if (full) continue;

      let wgt = 0;
      if (shape === 'circle' || shape === 'spot') {
        const dx = x + 0.5 - cx;
        const dy = py - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= radius) {
          if (feather > 0) {
            const edge = radius * (1 - feather);
            wgt = d <= edge ? 1 : 1 - (d - edge) / (radius - edge);
          } else {
            wgt = 1;
          }
        }
      } else if (shape === 'rect') {
        if (Math.abs(x + 0.5 - cx) <= radius && Math.abs(py - cy) <= radius) wgt = 1;
      } else if (shape === 'center') {
        const dx = x + 0.5 - cx;
        const dy = py - cy;
        wgt = Math.exp(-(dx * dx + dy * dy) * inv2Sigma2);
      } else {
        wgt = 1;
      }

      if (wgt > 0) {
        rSum += luma * wgt;
        rWeight += wgt;
        rr += r * wgt;
        rg += g * wgt;
        rb += b * wgt;
        if (clipped) rClip += wgt;
        regionHist[bin] += wgt;
      }
    }
  }

  const frame = makeStats(fSum, fCount, fClip, hist, [fr, fg, fb]);
  let regionStats;
  if (full) {
    regionStats = { ...frame, coverage: 1 };
  } else {
    regionStats = makeStats(rSum, rWeight, rClip, regionHist, [rr, rg, rb]);
    regionStats.coverage = rWeight / Math.max(1, fCount);
  }

  return {
    width,
    height,
    pixels: fCount,
    frame,
    region: regionStats,
    hist,
    regionHist,
    clipMap: clipMap && { width: gridW, height: gridH, data: clipMap }
  };
}

export const EXPOSURE_ZONE_GRID = 4;

/** 将预览方格的线性亮度相对于测光区换算为 Zone 0～X。 */
export function sampleExposureZones({ data, width, height }, referenceLuma, referenceZone) {
  const size = EXPOSURE_ZONE_GRID;
  const zones = new Uint8Array(size * size);
  const reference = Math.max(referenceLuma, 1e-4);
  for (let row = 0; row < size; row++) {
    const top = Math.floor(row * height / size);
    const bottom = Math.floor((row + 1) * height / size);
    for (let col = 0; col < size; col++) {
      const left = Math.floor(col * width / size);
      const right = Math.floor((col + 1) * width / size);
      let sum = 0;
      let count = 0;
      for (let y = top; y < bottom; y += 3) {
        for (let x = left; x < right; x += 3) {
          const i = (y * width + x) * 4;
          sum += 0.2126 * SRGB_TO_LINEAR[data[i]]
            + 0.7152 * SRGB_TO_LINEAR[data[i + 1]]
            + 0.0722 * SRGB_TO_LINEAR[data[i + 2]];
          count++;
        }
      }
      const relativeEv = Math.log2(Math.max(sum / Math.max(count, 1), 1e-4) / reference);
      zones[row * size + col] = clampInt(Math.round(referenceZone + relativeEv), 0, 10);
    }
  }
  return zones;
}

/**
 * 从 <video> / <canvas> 采样：按显示比例裁切（含数码变焦），输出 RGBA
 */
export class FrameSampler {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }

  get width() {
    return this.canvas.width;
  }

  get height() {
    return this.canvas.height;
  }

  /** A small uncropped patch around the point sent to the native AE engine. */
  sampleAnchor(source, { x, y }) {
    const { width, height } = source;
    const size = Math.min(width, height) * 0.2;
    if (!(size > 0)) return null;
    const edge = 24;
    if (this.width !== edge || this.height !== edge) {
      this.canvas.width = this.canvas.height = edge;
    }
    const left = Math.max(0, Math.min(width - size, x * width - size / 2));
    const top = Math.max(0, Math.min(height - size, y * height - size / 2));
    this.ctx.drawImage(source, left, top, size, size, 0, 0, edge, edge);
    const { data } = this.ctx.getImageData(0, 0, edge, edge);
    let total = 0;
    let clipped = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * SRGB_TO_LINEAR[data[i]]
        + 0.7152 * SRGB_TO_LINEAR[data[i + 1]]
        + 0.0722 * SRGB_TO_LINEAR[data[i + 2]];
      total += luma;
      if (luma >= CLIP_THRESHOLD) clipped++;
    }
    return { mean: total / (edge * edge), clip: clipped / (edge * edge) };
  }

  /**
   * @param {HTMLVideoElement|HTMLCanvasElement} source
   * @param {{aspect?:number, zoom?:number, width?:number}} opts
   */
  draw(source, { aspect = 3 / 4, zoom = 1, width = 256 } = {}) {
    const sw0 = source.videoWidth || source.width || 0;
    const sh0 = source.videoHeight || source.height || 0;
    if (!sw0 || !sh0) return null;

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

    const w = Math.max(96, Math.round(width));
    const h = Math.max(96, Math.round(w / aspect));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    try {
      this.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
      return this.ctx.getImageData(0, 0, w, h);
    } catch {
      return null;
    }
  }
}