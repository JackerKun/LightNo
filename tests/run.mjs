/**
 * 零依赖测试：node tests/run.mjs
 * 覆盖曝光换算、ND、格式化和纯函数测光统计。
 */
import * as X from '../js/core/exposure.js';
import { analyze } from '../js/core/sampler.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

function eq(actual, expected, tolerance = 1e-6, label = '') {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label || 'value'}: expected ${expected}, got ${actual}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function nearStr(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label}: expected "${expected}", got "${actual}"`);
}

console.log('\nEV / exposure math');

test('EV100 与亮度互为反函数', () => {
  for (const ev of [0, 5, 9.6, 12, 15, 18]) {
    eq(X.evFromLuminance(X.luminanceFromEv(ev)), ev, 1e-9);
  }
});

test('标准曝光：EV12 / f8 / ISO100 → 1/64 s', () => {
  eq(X.shutterFromEv({ ev100: 12, aperture: 8, iso: 100 }), 1 / 64, 1e-9);
});

test('ISO 400 所需曝光时间为 ISO 100 的 1/4', () => {
  const t100 = X.shutterFromEv({ ev100: 12, aperture: 8, iso: 100 });
  const t400 = X.shutterFromEv({ ev100: 12, aperture: 8, iso: 400 });
  eq(t400 / t100, 0.25, 1e-9);
});

test('ND16（4 档）让曝光时间 ×16', () => {
  const base = X.shutterFromEv({ ev100: 12, aperture: 8, iso: 100 });
  const nd = X.shutterFromEv({ ev100: 12, aperture: 8, iso: 100, ndStops: 4 });
  eq(nd / base, 16, 1e-9);
});

test('EV 与相机曝光设置一致', () => {
  const ev = X.evFromExposure({ aperture: 8, shutter: 1 / 64, iso: 100 });
  eq(ev, 12, 1e-9);
  const ev400 = X.evFromExposure({ aperture: 8, shutter: 1 / 64, iso: 400 });
  eq(ev400, 10, 1e-9, 'ISO400 same settings');
});

test('入射光换算：EV15 ≈ 82k lux', () => {
  eq(X.luxFromEv(15), 81920, 1e-6);
  eq(X.evFromLux(81920), 15, 1e-9);
});

test('Zone / ND 标签', () => {
  nearStr(X.ndLabel(4), 'ND16');
  nearStr(X.ndLabel(0), 'OFF');
  nearStr(X.ndDensity(4), '1.2');
  nearStr(X.zoneRoman(5), 'V');
  nearStr(X.zoneRoman(8), 'VIII');
});

test('快门格式化', () => {
  nearStr(X.formatShutter(1 / 64), '1/60');
  nearStr(X.formatShutter(0.5), '0.5s');
  nearStr(X.formatShutter(2.5), '2.5s');
  nearStr(X.formatShutter(180), '3min');
  nearStr(X.formatShutter(0), '—');
});

test('等效曝光阶梯：光圈越小，所需时间越长', () => {
  const ladder = X.exposureLadder({ ev100: 12, iso: 100, ndStops: 0 });
  ok(ladder.length > 8, 'ladder too short');
  for (let i = 1; i < ladder.length; i++) {
    ok(ladder[i].aperture > ladder[i - 1].aperture, 'aperture should grow');
    ok(ladder[i].shutter > ladder[i - 1].shutter, 'shutter should grow');
  }
});

test('色温估算：暖光 < 中性 < 冷光', () => {
  const cct = X.cctFromLinearRgb(1, 1, 1);
  ok(cct > 6000 && cct < 7000, 'D65 cct=' + cct);
  const warm = X.cctFromLinearRgb(1, 0.6, 0.3);
  const cool = X.cctFromLinearRgb(0.8, 0.9, 1);
  ok(warm < cct, 'warm should be lower: ' + warm);
  ok(cool > cct, 'cool should be higher: ' + cool);
});

test('曝光优先：光圈优先时由测光决定快门', () => {
  const pair = X.exposurePair({ ev100: 12, iso: 100, aperture: 8, priority: 'aperture' });
  eq(pair.shutter, 1 / 64, 1e-9);
  ok(pair.auto === 'shutter', 'shutter should be auto');
  ok(!pair.shutterOutOfRange, 'in range');
});

test('曝光优先：快门优先时由测光决定光圈', () => {
  const pair = X.exposurePair({ ev100: 12, iso: 100, shutter: 1 / 64, priority: 'shutter' });
  eq(pair.aperture, 8, 1e-9);
  eq(pair.apertureExact, 8, 1e-9);
  ok(pair.auto === 'aperture', 'aperture should be auto');
});

test('快门优先 + ND16：由光圈补偿减光', () => {
  const pair = X.exposurePair({ ev100: 12, iso: 100, ndStops: 4, shutter: 0.25, priority: 'shutter' });
  eq(pair.aperture, 8, 1e-9);
});

test('快门优先超出光圈范围会被标记', () => {
  const pair = X.exposurePair({ ev100: 12, iso: 100, shutter: 1 / 8000, priority: 'shutter' });
  ok(pair.apertureOutOfRange, 'should be out of range');
  ok(pair.aperture <= 1.0, 'clamped to wide aperture');
});

test('推荐快门显示：极快快门不强行取整', () => {
  nearStr(X.formatShutterRecommended(1 / 16000), '1/16000');
  nearStr(X.formatShutterRecommended(1 / 64), '1/60');
  nearStr(X.formatShutterRecommended(600), '10min');
});

console.log('\nMetering statistics');

/** 生成一张 64x64 的灰度 RGBA 画面：左半 18% 灰，右半纯白 */
function syntheticFrame(width = 64, height = 64) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = x < width / 2 ? 118 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test('全画面平均：亮暗各半的线性亮度', () => {
  const { data, width, height } = syntheticFrame();
  const res = analyze(data, width, height, { shape: 'full' });
  // 118/255 sRGB ≈ 0.18 线性，255 ≈ 1.0
  ok(res.frame.mean > 0.5 && res.frame.mean < 0.65, 'mean=' + res.frame.mean);
  ok(res.frame.p98 > 0.9, 'p98=' + res.frame.p98);
  ok(Math.abs(res.frame.clip - 0.5) < 0.05, 'clip=' + res.frame.clip);
});

test('圆形测光区只统计左半部分', () => {
  const { data, width, height } = syntheticFrame();
  const res = analyze(data, width, height, { shape: 'circle', cx: 0.25, cy: 0.5, r: 0.1 });
  ok(Math.abs(res.region.mean - 0.18) < 0.03, 'region mean=' + res.region.mean);
  ok(res.region.clip < 0.01, 'region clip=' + res.region.clip);
  ok(res.region.coverage > 0.005 && res.region.coverage < 0.06, 'coverage=' + res.region.coverage);
});

test('矩形框选统计正确', () => {
  const { data, width, height } = syntheticFrame();
  const res = analyze(data, width, height, { shape: 'rect', cx: 0.75, cy: 0.5, size: 0.2 });
  ok(res.region.mean > 0.9, 'rect mean=' + res.region.mean);
});

console.log('\n' + (failures.length ? 'FAILED' : 'All tests passed') + ` — ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(f.name, f.err.stack);
  process.exit(1);
}