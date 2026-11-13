/**
 * LIGHTNO · 抽屉式选择器 / 校准向导 / 说明
 */
import { openSheet, closeSheet } from './sheet.js';
import { getSettings, updateSettings } from '../core/state.js';
import {
  APERTURES,
  ISOS,
  SHUTTERS,
  ND_PRESETS,
  ndLabel,
  ndDensity,
  zoneRoman,
  formatEv,
  formatShutter,
  snapShutter,
  exposurePair,
  clamp
} from '../core/exposure.js';
import { toast } from './toast.js';
import { hapticTap } from './haptic.js';

function grid(items, current, render) {
  const wrap = document.createElement('div');
  wrap.className = 'picker-grid';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt' + (Math.abs((item.value ?? item) - current) < 1e-6 ? ' is-active' : '');
    btn.innerHTML = render(item);
    btn.dataset.value = String(item.value ?? item);
    wrap.appendChild(btn);
  }
  return wrap;
}

function note(html) {
  const p = document.createElement('p');
  p.className = 'picker-note';
  p.innerHTML = html;
  return p;
}

export function pickShutter(current, onSelect) {
  const snapped = snapShutter(current);
  const section = document.createElement('div');
  section.className = 'sheet-section';
  const wrap = grid(SHUTTERS, snapped, (t) => formatShutter(t));
  section.appendChild(wrap);
  section.appendChild(
    note(
      '选择后进入<b>快门优先</b>：快门由你固定，测光自动计算光圈。<br />也可以直接在测光页对快门单元上下滑动 / 滚轮切换。'
    )
  );
  const sheet = openSheet({
    title: '快门速度',
    subtitle: '点按选择；快门优先时光圈自动',
    content: section
  });
  wrap.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(Number(btn.dataset.value));
      hapticTap();
      sheet.close();
    });
  });
}

export function pickTargetZone(current, onSelect) {
  const zones = [
    { value: 3, title: 'III', desc: '深暗部细节' },
    { value: 4, title: 'IV', desc: '阴影' },
    { value: 5, title: 'V', desc: '中灰 · 默认' },
    { value: 6, title: 'VI', desc: '明亮肤色' },
    { value: 7, title: 'VII', desc: '浅色高光' },
    { value: 8, title: 'VIII', desc: '最亮高光' }
  ];
  const section = document.createElement('div');
  section.className = 'sheet-section';
  const wrap = grid(zones, current, (z) => `${z.title}<small>${z.desc}</small>`);
  section.appendChild(wrap);
  section.appendChild(
    note(
      'Zone 系统把亮度分成 11 档，V 为中灰。点测光把被测区域放在所选影调上：<br />选 <b>III</b> 会让画面整体变暗（保留暗部），选 <b>VIII</b> 会变亮（保留高光）。'
    )
  );
  const sheet = openSheet({
    title: '目标影调（Zone）',
    subtitle: '点测光 / 区域测光的结果落在哪个灰阶',
    content: section
  });
  wrap.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(Number(btn.dataset.value));
      hapticTap();
      sheet.close();
    });
  });
}

export function pickAnchor(current, onSelect) {
  const presets = [
    { ev: 15, label: '阳光直射' },
    { ev: 14, label: '明亮阴天' },
    { ev: 13, label: '多云' },
    { ev: 12, label: '阴天 / 日落' },
    { ev: 10, label: '室内明亮' },
    { ev: 8, label: '室内一般' },
    { ev: 6, label: '夜景街灯' }
  ];
  const section = document.createElement('div');
  section.className = 'sheet-section';
  section.innerHTML = `
    <div class="field">
      <label>场景平均 EV100</label>
      <input type="number" id="anchorInput" inputmode="decimal" step="0.1" min="-6" max="22" value="${Number(
        current
      ).toFixed(1)}" />
    </div>
  `;
  const presetWrap = document.createElement('div');
  presetWrap.className = 'picker-grid';
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt' + (Math.abs(p.ev - current) < 0.05 ? ' is-active' : '');
    btn.innerHTML = `${p.ev}<small>${p.label}</small>`;
    btn.addEventListener('click', () => {
      section.querySelector('#anchorInput').value = String(p.ev);
      presetWrap.querySelectorAll('.opt').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
    presetWrap.appendChild(btn);
  }
  section.appendChild(presetWrap);
  section.appendChild(
    note(
      '仅当设备不支持相机手动曝光时使用：以场景平均亮度为基准，再计算点 / 区域相对亮度。<br />数值来自其他测光表、晴天 16 法则或已知光照。'
    )
  );

  openSheet({
    title: '相对测光锚点',
    subtitle: '当前设备的降级测光基准',
    content: section,
    actions: [
      { label: '取消', kind: 'ghost', onClick: () => closeSheet() },
      {
        label: '保存锚点',
        kind: 'primary',
        onClick: () => {
          const input = section.querySelector('#anchorInput');
          const value = clamp(Number(input.value), -6, 22);
          onSelect(value);
          closeSheet();
        }
      }
    ]
  });
}

export function pickLens(current, onSelect) {
  const values = [1.4, 1.5, 1.6, 1.7, 1.8, 2.0, 2.2, 2.4, 2.8, 3.5];
  const section = document.createElement('div');
  section.className = 'sheet-section';
  section.appendChild(grid(values.map((value) => ({ value })), current, (v) => `f/${v}`));
  section.appendChild(
    note(
      '网页无法读取手机的物理光圈，这个值仅用于把画面亮度换算成 EV。校准会吸收该项误差，所以配合校准向导使用即可。'
    )
  );
  const sheet = openSheet({
    title: '镜头光圈',
    subtitle: '用于相机侧 EV 换算',
    content: section
  });
  section.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(Number(btn.dataset.value));
      hapticTap();
      sheet.close();
    });
  });
}

export function pickIso(current, onSelect) {
  const section = document.createElement('div');
  section.className = 'sheet-section';
  section.appendChild(
    grid(ISOS, current, (v) => `${v}${v === 100 ? '<small>基准</small>' : ''}`)
  );
  section.appendChild(note('ISO 只影响推荐快门，不会改变场景 EV。高 ISO 会带来更多噪点。'));
  const sheet = openSheet({
    title: 'ISO 感光度',
    subtitle: '选择你相机上设置的 ISO',
    content: section
  });
  section.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(Number(btn.dataset.value));
      hapticTap();
      sheet.close();
    });
  });
}

export function pickAperture(current, onSelect) {
  const list = APERTURES.filter((v) => v >= 0.95 && v <= 45);
  const section = document.createElement('div');
  section.className = 'sheet-section';
  section.appendChild(grid(list, current, (v) => `f/${v}`));
  section.appendChild(
    note('选择光圈后进入<b>光圈优先</b>：光圈由你固定，测光自动计算快门。')
  );
  const sheet = openSheet({
    title: '光圈',
    subtitle: '选择镜头光圈值',
    content: section
  });
  section.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(Number(btn.dataset.value));
      hapticTap();
      sheet.close();
    });
  });
}

export function pickNd(current, onSelect) {
  let customStops = current;
  const section = document.createElement('div');
  section.className = 'sheet-section';

  const info = document.createElement('div');
  info.className = 'calib-live';
  info.innerHTML = `
    <div>
      <div class="calib-live__label">当前减光</div>
      <b>${ndLabel(current)}</b>
    </div>
    <div class="calib-live__hint">${
      current > 0 ? `密度 ${ndDensity(current)} · ${Number(current).toFixed(1)} 档` : '未使用减光镜'
    }</div>
  `;
  section.appendChild(info);

  const gridWrap = grid(
    ND_PRESETS.map((p) => ({ ...p, value: p.stops })),
    current,
    (p) =>
      `${p.stops === 0 ? 'OFF' : p.label}<small>${
        p.stops === 0 ? '无减光' : `${p.stops} 档 · ${p.density}`
      }</small>`
  );
  section.appendChild(gridWrap);
  gridWrap.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(Number(btn.dataset.value));
      hapticTap();
      closeSheet();
    });
  });

  const block = document.createElement('div');
  block.className = 'range-block';
  block.innerHTML = `
    <header><span>自定义减光档数</span><b>${current.toFixed(1)} 档</b></header>
    <input type="range" min="0" max="45" step="1" value="${Math.round(current * 3)}" aria-label="自定义 ND 档数" />
  `;
  section.appendChild(block);
  const range = block.querySelector('input');
  const label = block.querySelector('b');
  range.addEventListener('input', () => {
    customStops = Number(range.value) / 3;
    label.textContent = customStops.toFixed(1) + ' 档';
  });

  section.appendChild(
    note(
      'ND 不改变场景 EV，只改变推荐曝光：<b>光圈优先时延长快门</b>，<b>快门优先时由光圈补偿</b>。<br />例如 EV 12、f/8、ISO 100 时基准快门 1/64s；加 <b>ND16（4 档）</b>后直接使用 <b>1/4s</b>。'
    )
  );

  openSheet({
    title: 'ND 减光镜',
    subtitle: '测光结果会自动叠加 ND',
    content: section,
    actions: [
      { label: '取消', kind: 'ghost', onClick: () => closeSheet() },
      {
        label: '应用自定义',
        kind: 'primary',
        onClick: () => {
          onSelect(customStops);
          hapticTap();
          closeSheet();
        }
      }
    ]
  });
}

export function openCalibration({ getLiveEv, onDone }) {
  const settings = getSettings();
  const initial = Number.isFinite(getLiveEv()) ? getLiveEv() : settings.anchorEv;
  const section = document.createElement('div');
  section.className = 'sheet-section';
  section.innerHTML = `
    <div class="calib-live">
      <div>
        <div class="calib-live__label">当前实时读数</div>
        <b id="calibLive">${formatEv(initial)}</b>
      </div>
      <div class="calib-live__hint">对准 18% 灰卡或均匀中灰表面，让灰卡充满测光框</div>
    </div>
    <div class="field">
      <label>参考 EV100</label>
      <input id="calibRef" type="number" inputmode="decimal" step="0.1" value="${initial.toFixed(1)}" />
    </div>
  `;

  const presets = [15, 14, 13, 12, 9];
  const labels = { 15: '阳光直射', 14: '明亮阴天', 13: '多云', 12: '阴天', 9: '室内' };
  const presetWrap = document.createElement('div');
  presetWrap.className = 'picker-grid';
  for (const ev of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';
    btn.innerHTML = `${ev}<small>${labels[ev]}</small>`;
    btn.addEventListener('click', () => {
      section.querySelector('#calibRef').value = String(ev);
      presetWrap.querySelectorAll('.opt').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
    presetWrap.appendChild(btn);
  }
  section.appendChild(presetWrap);
  section.appendChild(
    note(
      `如果读数本身已经准确，可直接点击「应用校准」（此时参考值 = 当前读数）。<br />当前偏移 <b>${settings.calibration.toFixed(
        1
      )} EV</b>，只会保存在本机。`
    )
  );

  const timer = setInterval(() => {
    const el = section.querySelector('#calibLive');
    if (!el) return;
    const live = getLiveEv();
    el.textContent = Number.isFinite(live) ? formatEv(live) : '--.-';
  }, 350);

  openSheet({
    title: '校准向导',
    subtitle: '用已知 EV 对齐这台设备的读数',
    content: section,
    onClose: () => clearInterval(timer),
    actions: [
      { label: '取消', kind: 'ghost', onClick: () => closeSheet() },
      {
        label: '应用校准',
        kind: 'primary',
        onClick: () => {
          const live = getLiveEv();
          if (!Number.isFinite(live)) {
            toast('还没有实时读数，请等待相机稳定', { type: 'warn' });
            return;
          }
          const input = section.querySelector('#calibRef');
          const ref = clamp(Number(input.value), -6, 22);
          const next = clamp(settings.calibration + (ref - live), -6, 6);
          updateSettings({ calibration: next, calibrated: true });
          toast(`已校准：偏移 ${next >= 0 ? '+' : ''}${next.toFixed(1)} EV`, {
            type: 'success',
            duration: 3200
          });
          if (onDone) onDone(next);
          closeSheet();
        }
      }
    ]
  });
}

export function openMeterOptions({ getEv } = {}) {
  const settings = getSettings();
  const section = document.createElement('div');
  section.className = 'sheet-section';

  function pairNow() {
    const s = getSettings();
    const ev = typeof getEv === 'function' ? getEv() : NaN;
    return Number.isFinite(ev)
      ? exposurePair({
          ev100: ev,
          iso: s.iso,
          ndStops: s.ndStops,
          priority: s.priority,
          aperture: s.aperture,
          shutter: s.shutter
        })
      : null;
  }

  section.innerHTML = `
    <div class="setrow" style="border-top:0">
      <div class="setrow__label"><b>曝光优先</b><span id="optPriorityNote">调光圈 → 测光决定快门</span></div>
      <div class="seg" id="optPriority">
        <button type="button" data-value="aperture">光圈优先</button>
        <button type="button" data-value="shutter">快门优先</button>
      </div>
    </div>
    <button class="setrow setrow--btn" id="optTargetZone" type="button" style="padding-left:0;padding-right:0">
      <span class="setrow__label"><b>点测光目标影调</b><span>Zone V = 18% 中灰</span></span>
      <span class="setrow__value" id="optZoneValue">ZONE ${zoneRoman(settings.targetZone)}</span>
      <span class="setrow__chev">›</span>
    </button>
    <div class="range-block">
      <header><span>测光框尺寸</span><b id="optSizeLabel">${Math.round(settings.spotSize * 100)}%</b></header>
      <input id="optSize" type="range" min="4" max="50" step="1" value="${Math.round(
        settings.spotSize * 100
      )}" aria-label="测光框尺寸" />
    </div>
    <div class="range-block">
      <header><span>读数平滑</span><b id="optSmoothLabel">${Math.round(
        settings.smoothing * 100
      )}%</b></header>
      <input id="optSmooth" type="range" min="5" max="100" step="5" value="${Math.round(
        settings.smoothing * 100
      )}" aria-label="读数平滑" />
    </div>
    <p class="picker-note">
      曝光单元都支持上下滑动 / 鼠标滚轮调整：调<b>快门</b>后由测光决定光圈，调<b>光圈</b>后由测光决定快门。<br />
      测光框也可以直接在画面里拖动；右下角手柄调整大小，双指捏合变焦。
    </p>
  `;

  const prioritySeg = section.querySelector('#optPriority');
  const priorityNote = section.querySelector('#optPriorityNote');
  function paintPriority() {
    const s = getSettings();
    prioritySeg.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.value === s.priority);
    });
    if (priorityNote) {
      priorityNote.textContent =
        s.priority === 'shutter' ? '调快门 → 测光决定光圈' : '调光圈 → 测光决定快门';
    }
  }
  prioritySeg.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    const s = getSettings();
    if (btn.dataset.value === s.priority) return;
    const pair = pairNow();
    if (btn.dataset.value === 'shutter') {
      updateSettings({ priority: 'shutter', shutter: pair ? pair.shutter : s.shutter });
    } else {
      updateSettings({ priority: 'aperture', aperture: pair ? pair.aperture : s.aperture });
    }
    paintPriority();
    hapticTap();
  });
  paintPriority();

  const sizeInput = section.querySelector('#optSize');
  const sizeLabel = section.querySelector('#optSizeLabel');
  sizeInput.addEventListener('input', () => {
    const pct = Number(sizeInput.value);
    sizeLabel.textContent = pct + '%';
    updateSettings({ spotSize: pct / 100 });
  });

  const smoothInput = section.querySelector('#optSmooth');
  const smoothLabel = section.querySelector('#optSmoothLabel');
  smoothInput.addEventListener('input', () => {
    const pct = Number(smoothInput.value);
    smoothLabel.textContent = pct + '%';
    updateSettings({ smoothing: pct / 100 });
  });

  section.querySelector('#optTargetZone').addEventListener('click', () => {
    pickTargetZone(settings.targetZone, (zone) => {
      updateSettings({ targetZone: zone });
      const valueEl = section.querySelector('#optZoneValue');
      if (valueEl) valueEl.textContent = 'ZONE ' + zoneRoman(zone);
      toast('目标影调已设为 ZONE ' + zoneRoman(zone), { duration: 1600 });
    });
  });

  openSheet({
    title: '测光选项',
    subtitle: '只影响测光方式，不改变相机画面',
    content: section,
    actions: [{ label: '完成', kind: 'primary', onClick: () => closeSheet() }]
  });
}

export function openAlgorithmDoc() {
  const section = document.createElement('div');
  section.className = 'doc';
  section.innerHTML = `
    <h4>反射式测光</h4>
    <p>画面先解码为线性光，再按测光区统计亮度 <code>L</code>（0–1）。结合相机实际曝光反推场景亮度：</p>
    <p><code>EV100 = log2(N²/t) − log2(S/100) + log2(L/0.18) + 校准</code></p>
    <p>其中 <code>N</code> 是镜头光圈（设置项），<code>t</code>、<code>S</code> 是相机实际使用的快门与 ISO，0.18 为 18% 中灰。</p>

    <h4>数据来源</h4>
    <p>支持手动曝光的设备（多数 Android Chrome）由 LIGHTNO 接管相机曝光，并自动把测光区调整到中灰附近，因此得到绝对 EV。iOS Safari 等不开放手动曝光的浏览器会降级为「相对测光」，此时需要用锚点 EV 作为场景基准。</p>

    <h4>曝光优先</h4>
    <p>光圈优先：<code>t = N² / 2^(EV100 + log2(S/100) − ND)</code><br />
       快门优先：<code>N = √(t × 2^(EV100 + log2(S/100) − ND))</code></p>
    <p>调光圈后由测光决定快门；调快门后由测光决定光圈（ND 由光圈补偿）。</p>

    <h4>测光模式</h4>
    <ul>
      <li><b>点测光</b>：圆形区域，可拖动 / 缩放，默认放在 ZONE V</li>
      <li><b>区域框选</b>：方形区域平均，适合大面积中间调</li>
      <li><b>中央重点</b>：高斯加权，越靠近中心权重越高</li>
      <li><b>平均</b>：整幅画面等权平均</li>
      <li><b>高光优先</b>：取 98 百分位亮度放到 ZONE VIII</li>
      <li><b>暗部优先</b>：取 2 百分位亮度放到 ZONE III</li>
    </ul>

    <h4>ND 减光</h4>
    <p>ND 不改变场景 EV，只改变推荐曝光：光圈优先时 <code>t' = t × 2^ND档数</code>；快门优先时由光圈补偿。例如 EV 12、f/8、ISO 100 的基准快门是 1/64s，装 ND16（4 档）后直接使用 1/4s。</p>

    <h4>校准</h4>
    <p>不同手机预览的色彩曲线并不完全一致。对准 18% 灰卡，输入一个已知 EV，LIGHTNO 会把偏差写入本机，长期有效。</p>

    <h4>隐私</h4>
    <p>相机画面只在内存中处理；保存的照片与参数写入浏览器 IndexedDB，不上传到任何服务器。</p>
  `;
  openSheet({
    title: '测光算法说明',
    subtitle: '为什么这样算，以及哪些地方会不准',
    content: section,
    actions: [{ label: '知道了', kind: 'primary', onClick: () => closeSheet() }]
  });
}

export function openOnboarding({ onDone } = {}) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (onDone) onDone();
  };
  const section = document.createElement('div');
  section.innerHTML = `
    <div class="onboard">
      <div class="onboard__item">
        <span class="onboard__num">01</span>
        <div>
          <b>允许相机，直接测光</b>
          <p>画面中央的圆框就是测光区。拖动它对准主体；空白处点一下也能立刻移过去。双指捏合变焦，右下角手柄调整框大小。</p>
        </div>
      </div>
      <div class="onboard__item">
        <span class="onboard__num">02</span>
        <div>
          <b>校准一次，长期准确</b>
          <p>对准 18% 灰卡（或用另一台测光表），在「设置 → 校准向导」里输入参考 EV。不同机型会有系统偏差，校准会写入本机。</p>
        </div>
      </div>
      <div class="onboard__item">
        <span class="onboard__num">03</span>
        <div>
          <b>保存你的测光日志</b>
          <p>点取景框下方的保存键，会连同当前画面、EV、ISO、光圈、快门、ND、色温一起存档，可在「记录」里回看、备注、导出。</p>
        </div>
      </div>
      <div class="onboard__item">
        <span class="onboard__num">04</span>
        <div>
          <b>ND 直接算进快门</b>
          <p>在曝光栏点 ND，选择你正在使用的减光镜；推荐曝光会自动变成「装上 ND 后可直接使用」的数值。</p>
        </div>
      </div>
      <div class="onboard__item">
        <span class="onboard__num">05</span>
        <div>
          <b>上下滚动切换曝光</b>
          <p>ISO、光圈、快门、ND 都支持上下滑动 / 鼠标滚轮，滑动时会显示相邻档位。调<b>光圈</b>进入光圈优先，测光自动改快门；调<b>快门</b>进入快门优先，测光自动改光圈。</p>
        </div>
      </div>
    </div>
    <p class="picker-note" style="margin-top:14px">
      没有相机权限？可以在取景框的提示里进入演示模式，先熟悉界面与读数。
    </p>
  `;

  const sheet = openSheet({
    title: '欢迎使用 LIGHTNO',
    subtitle: '一个为摄影现场准备的移动测光表',
    content: section,
    dismissible: true,
    onClose: finish,
    actions: [
      {
        label: '开始测光',
        kind: 'primary',
        onClick: () => {
          finish();
          sheet.close();
        }
      }
    ]
  });
}