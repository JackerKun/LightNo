/**
 * LIGHTNO · 曝光数学核心
 *
 * 约定与标准：
 * - 反射式测光：EV100 = log2(L * 100 / K)，K = 12.5，L 单位 cd/m²
 *   => EV100 = log2(L) + 3
 * - 曝光方程：N² / t = L * S / K  => EV_S = log2(N²/t)，EV100 = EV_S - log2(S/100)
 * - 入射式测光：EV100 = log2(E * 100 / C)，C = 250（lux）
 * - 中灰：18% 反射率，线性亮度 0.18
 * - 感光区（Zone System）：ZONE V = 中灰，每 Zone 相差 1 EV
 */

export const MID_GRAY = 0.18;
export const K_REFLECTED = 12.5;
export const C_INCIDENT = 250;

/** 常见光圈（1/3 档） */
export const APERTURES = [
  0.95, 1.0, 1.1, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.5, 2.8, 3.2, 3.5, 4.0, 4.5,
  5.0, 5.6, 6.3, 7.1, 8.0, 9.0, 10.0, 11.0, 13.0, 14.0, 16.0, 18.0, 20.0,
  22.0, 25.0, 29.0, 32.0, 36.0, 40.0, 45.0
];

/** 常见 ISO（1/3 档） */
export const ISOS = [
  25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800,
  1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800,
  25600, 51200, 102400
];

/** 标准快门速度（秒，1/3 档） */
export const SHUTTERS = [
  1 / 8000, 1 / 6400, 1 / 5000, 1 / 4000, 1 / 3200, 1 / 2500, 1 / 2000,
  1 / 1600, 1 / 1250, 1 / 1000, 1 / 800, 1 / 640, 1 / 500, 1 / 400, 1 / 320,
  1 / 250, 1 / 200, 1 / 160, 1 / 125, 1 / 100, 1 / 80, 1 / 60, 1 / 50, 1 / 40,
  1 / 30, 1 / 25, 1 / 20, 1 / 15, 1 / 13, 1 / 10, 1 / 8, 1 / 6, 1 / 5, 1 / 4,
  0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6, 8, 10, 13, 15,
  20, 25, 30, 45, 60, 90, 120, 180, 240
];

/** ND 滤镜预设：stops = 减光档数，density = 光学密度 */
export const ND_PRESETS = [
  { stops: 0, label: 'OFF', density: '' },
  { stops: 1, label: 'ND2', density: '0.3' },
  { stops: 2, label: 'ND4', density: '0.6' },
  { stops: 3, label: 'ND8', density: '0.9' },
  { stops: 4, label: 'ND16', density: '1.2' },
  { stops: 5, label: 'ND32', density: '1.5' },
  { stops: 6, label: 'ND64', density: '1.8' },
  { stops: 7, label: 'ND128', density: '2.1' },
  { stops: 8, label: 'ND256', density: '2.4' },
  { stops: 9, label: 'ND512', density: '2.7' },
  { stops: 10, label: 'ND1000', density: '3.0' }
];

export const ZONE_ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export const MIN_SHUTTER = SHUTTERS[0];
export const MAX_SHUTTER = SHUTTERS[SHUTTERS.length - 1];

export const log2 = (x) => Math.log(x) * Math.LOG2E;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ------------------------------------------------------------------ *
 * 基础换算
 * ------------------------------------------------------------------ */

/** 场景亮度（cd/m²）→ EV100 */
export function evFromLuminance(cd) {
  return log2(Math.max(cd, 1e-5) * 8);
}

/** EV100 → 场景亮度（cd/m²） */
export function luminanceFromEv(ev) {
  return Math.pow(2, ev - 3);
}

/** 入射光（lux）→ EV100 */
export function evFromLux(lux) {
  return log2(Math.max(lux, 1e-4) * (100 / C_INCIDENT));
}

/** EV100 → 入射光（lux） */
export function luxFromEv(ev) {
  return Math.pow(2, ev) * (C_INCIDENT / 100);
}

/** 相机曝光档位 → EV100（N 光圈、t 秒、S ISO） */
export function evFromExposure({ aperture, shutter, iso = 100 }) {
  if (!isNum(aperture) || !isNum(shutter) || shutter <= 0) return NaN;
  return log2((aperture * aperture) / shutter) - log2(iso / 100);
}

/**
 * 由 EV100、ISO、光圈、ND 计算快门时间（秒）
 * ND 只会延长曝光时间，不改变场景 EV。
 */
export function shutterFromEv({ ev100, aperture, iso = 100, ndStops = 0 }) {
  if (!isNum(ev100) || !isNum(aperture) || aperture <= 0) return NaN;
  // EV_S = EV100 + log2(S/100)：ISO 越高，所需曝光越短
  // ND 减光 → 有效 EV 降低 → 曝光时间 ×2^ndStops
  const evAtIso = ev100 + log2(iso / 100) - (ndStops || 0);
  return (aperture * aperture) / Math.pow(2, evAtIso);
}

/** 由 EV100 求「未装 ND」的快门（给界面显示基准值） */
export function baseShutterFromEv({ ev100, aperture, iso = 100 }) {
  return shutterFromEv({ ev100, aperture, iso, ndStops: 0 });
}

/** 光圈变化带来的 EV 差（用于参考） */
export function evDeltaAperture(from, to) {
  return 2 * log2(from / to);
}

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

/** 找到最接近的标准光圈值（按对数距离） */
export function nearestAperture(value, list = APERTURES) {
  if (!isNum(value) || value <= 0) return list[0];
  let best = list[0];
  let bestDist = Infinity;
  for (const aperture of list) {
    const dist = Math.abs(Math.log(aperture / value));
    if (dist < bestDist) {
      bestDist = dist;
      best = aperture;
    }
  }
  return best;
}

/** 找到最接近的标准快门值 */
export function snapShutter(seconds) {
  if (!isNum(seconds) || seconds <= 0) return seconds;
  let best = SHUTTERS[0];
  let bestDist = Infinity;
  for (const s of SHUTTERS) {
    const d = Math.abs(Math.log(s / seconds));
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

function trimNumber(n, digits = 1) {
  return String(Number(n.toFixed(digits)));
}

/** 快门时间 → 摄影记法（1/125、2.5s、3.2min） */
export function formatShutter(seconds, { snap = true } = {}) {
  if (!isNum(seconds) || seconds <= 0) return '—';
  if (seconds >= 120) {
    const minutes = seconds / 60;
    return trimNumber(minutes, minutes < 10 ? 2 : 0) + 'min';
  }
  if (seconds >= 60) return Math.round(seconds) + 's';
  const t = snap ? snapShutter(seconds) : seconds;
  if (t >= 0.3) return trimNumber(t, 1) + 's';
  return '1/' + Math.round(1 / t);
}

/** 精确值（不合档位），用于详情 */
export function formatShutterExact(seconds) {
  if (!isNum(seconds) || seconds <= 0) return '—';
  if (seconds >= 1) return trimNumber(seconds, 2) + 's';
  return '1/' + Math.round(1 / seconds);
}

export function formatAperture(n) {
  if (!isNum(n)) return '—';
  return 'f/' + (Number.isInteger(n) ? n.toFixed(0) : String(n));
}

export function formatEv(ev, digits = 1) {
  if (!isNum(ev)) return '--.-';
  return ev.toFixed(digits);
}

export function formatLuminance(cd) {
  if (!isNum(cd) || cd <= 0) return '—';
  if (cd >= 1000) return Math.round(cd) + ' cd/m²';
  if (cd >= 100) return cd.toFixed(0) + ' cd/m²';
  if (cd >= 10) return cd.toFixed(1) + ' cd/m²';
  if (cd >= 1) return cd.toFixed(2) + ' cd/m²';
  return cd.toFixed(3) + ' cd/m²';
}

export function formatLux(lux) {
  if (!isNum(lux) || lux <= 0) return '—';
  if (lux >= 10000) return Math.round(lux / 1000) + 'k lx';
  if (lux >= 100) return Math.round(lux) + ' lx';
  return lux.toFixed(1) + ' lx';
}

export function formatCct(cct) {
  if (!isNum(cct)) return '—';
  return Math.round(cct / 100) * 100 + 'K';
}

/** ND 档数 → 名称（ND16 等） */
export function ndLabel(stops) {
  if (!isNum(stops) || stops <= 0) return 'OFF';
  const preset = ND_PRESETS.find((p) => Math.abs(p.stops - stops) < 0.05);
  if (preset) return preset.label;
  return 'ND ' + trimNumber(stops, 1) + '档';
}

/** ND 档数 → 光学密度 */
export function ndDensity(stops) {
  if (!isNum(stops) || stops <= 0) return '';
  return (stops * 0.3).toFixed(1);
}

export function zoneRoman(zone) {
  const z = Math.round(zone);
  if (z < 0) return '0';
  if (z >= ZONE_ROMAN.length) return 'X';
  return ZONE_ROMAN[z];
}

/** 某个亮度落在推荐曝光下的 Zone（5 = 中灰） */
export function zoneForEvDelta(deltaEv) {
  return clamp(5 + deltaEv, 0, 10);
}

/** 反差（档） */
export function contrastStops(lowLum, highLum) {
  if (!isNum(lowLum) || !isNum(highLum) || lowLum <= 0) return NaN;
  return log2(highLum / lowLum);
}

/* ------------------------------------------------------------------ *
 * 色温估算（McCamy 近似）
 * 输入为线性 RGB，返回色温 K 或 null
 * ------------------------------------------------------------------ */
export function cctFromLinearRgb(r, g, b) {
  if (!isNum(r) || !isNum(g) || !isNum(b)) return null;
  if (r + g + b <= 1e-6) return null;

  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const sum = X + Y + Z;
  if (sum <= 1e-6) return null;

  const x = X / sum;
  const y = Y / sum;
  if (y < 0.005) return null;

  const n = (x - 0.3320) / (0.1858 - y);
  const cct = 437 * n * n * n + 3601 * n * n + 6861 * n + 5517;
  if (!isNum(cct) || cct < 1200 || cct > 25000) return null;
  return cct;
}

/* ------------------------------------------------------------------ *
 * 等效曝光阶梯
 * ------------------------------------------------------------------ */
/**
 * 根据「曝光优先」求解光圈 / 快门组合
 * - priority = 'aperture'：光圈由用户设定，快门由测光计算
 * - priority = 'shutter' ：快门由用户设定，光圈由测光计算（ND 由光圈补偿）
 */
export function exposurePair({
  ev100,
  iso = 100,
  ndStops = 0,
  priority = 'aperture',
  aperture = 8,
  shutter = 1 / 125,
  apertures = APERTURES
}) {
  if (!isNum(ev100)) return null;
  const nd = ndStops || 0;

  if (priority === 'shutter') {
    const evAtIso = ev100 + log2(iso / 100) - nd;
    const exact = Math.sqrt(Math.max(1e-9, shutter) * Math.pow(2, evAtIso));
    const snapped = nearestAperture(exact, apertures);
    return {
      priority,
      auto: 'aperture',
      aperture: snapped,
      apertureExact: exact,
      shutter,
      apertureOutOfRange: exact < apertures[0] || exact > apertures[apertures.length - 1]
    };
  }

  const t = shutterFromEv({ ev100, aperture, iso, ndStops: nd });
  return {
    priority: 'aperture',
    auto: 'shutter',
    aperture,
    shutter: t,
    shutterOutOfRange: !isNum(t) || t < MIN_SHUTTER || t > MAX_SHUTTER
  };
}

/**
 * 在 EV100 / ISO 固定时，给出各光圈对应的快门（含 ND）
 * @returns {{aperture:number, shutter:number, label:string}[]}
 */
export function exposureLadder({ ev100, iso = 100, ndStops = 0, apertures = APERTURES, maxShutter = 3600 }) {
  if (!isNum(ev100)) return [];
  const out = [];
  for (const aperture of apertures) {
    const shutter = shutterFromEv({ ev100, aperture, iso, ndStops });
    if (!isNum(shutter) || shutter <= 0) continue;
    if (shutter > maxShutter) continue;
    if (shutter < 1 / 9000) continue;
    out.push({ aperture, shutter, label: formatShutter(shutter) });
  }
  return out;
}

/** 推荐的快门显示：超出常见相机档位时显示精确值，不强行取整 */
export function formatShutterRecommended(seconds) {
  if (!isNum(seconds) || seconds <= 0) return '—';
  if (seconds < MIN_SHUTTER) return formatShutterExact(seconds);
  return formatShutter(seconds);
}

/** ISO / 光圈 / 快门 的相邻档（1/3 档） */
export function stepArray(list, current, dir) {
  if (!Array.isArray(list) || !list.length) return current;
  let index = list.findIndex((v) => Math.abs(v - current) < 1e-6);
  if (index === -1) {
    index = list.reduce(
      (best, v, i) => (Math.abs(Math.log(v / current)) < Math.abs(Math.log(list[best] / current)) ? i : best),
      0
    );
  }
  const next = clamp(index + (dir > 0 ? 1 : -1), 0, list.length - 1);
  return list[next];
}