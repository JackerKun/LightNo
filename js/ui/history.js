/**
 * LIGHTNO · 测光记录
 * 列表 / 详情 / 备注 / 收藏 / 单张下载 / JSON 备份导入导出
 */
import {
  $,
  setText,
  relativeTime,
  shortDate,
  hhmm,
  downloadBlob,
  blobToDataUrl,
  dataUrlToBlob,
  debounce
} from './dom.js';
import { listShots, putShot, deleteShot } from '../core/store.js';
import {
  formatEv,
  formatAperture,
  formatShutter,
  formatLuminance,
  formatCct,
  ndLabel,
  zoneRoman
} from '../core/exposure.js';
import { shotToText } from '../core/capture.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { hapticTap } from './haptic.js';

const SOURCE_LABELS = {
  hardware: '硬件测光',
  auto: '自动测光',
  image: '图像测光',
  relative: '图像测光',
  photo: '拍照测光',
  demo: '演示模式',
  error: '相机异常'
};

const state = {
  shots: [],
  filter: 'all',
  urls: new Map()
};

let onCountCb = null;

function objectUrl(shot, kind) {
  const key = shot.id + ':' + kind;
  if (state.urls.has(key)) return state.urls.get(key);
  const blob = kind === 'photo' ? shot.photo : shot.thumb || shot.photo;
  if (!blob) return '';
  const url = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
  state.urls.set(key, url);
  return url;
}

function revokeUrls() {
  for (const url of state.urls.values()) {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  state.urls.clear();
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function applyFilter(shots) {
  if (state.filter === 'today') {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return shots.filter((s) => s.createdAt >= start);
  }
  if (state.filter === 'week') {
    return shots.filter((s) => s.createdAt >= Date.now() - 7 * 86400000);
  }
  if (state.filter === 'favorite') {
    return shots.filter((s) => s.favorite);
  }
  return shots;
}

function render() {
  const list = $('#logList');
  if (!list) return;
  revokeUrls();
  list.innerHTML = '';

  const visible = applyFilter(state.shots);
  setText($('#logSummary'), state.shots.length ? `${state.shots.length} 条记录 · 本地保存` : '0 条记录');
  $('#logEmpty').hidden = visible.length > 0;

  for (const shot of visible) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'log-card';
    card.dataset.id = shot.id;
    const thumbUrl = objectUrl(shot, 'thumb');
    card.innerHTML = `
      ${
        thumbUrl
          ? `<img class="log-card__thumb" alt="" loading="lazy" src="${thumbUrl}" />`
          : '<span class="log-card__thumb log-card__thumb--empty">NO<br />PHOTO</span>'
      }
      <span class="log-card__body">
        <span class="log-card__top">
          <span class="log-card__ev">${formatEv(shot.ev, 1)}</span>
          <span class="log-card__mode">${escapeHtml(shot.modeTag || shot.mode || '')}${
            shot.zoneValue != null ? ' · Z' + zoneRoman(shot.zoneValue) : ''
          }</span>
        </span>
        <span class="log-card__params">ISO ${shot.iso} · ${formatAperture(shot.aperture)} · ${formatShutter(
          shot.shutterWithNd
        )}${shot.ndStops > 0 ? ' · ' + ndLabel(shot.ndStops) : ''}</span>
        <span class="log-card__meta">${relativeTime(shot.createdAt)} · ${formatCct(shot.cct)}</span>
      </span>
      <span class="log-card__side">
        <span class="log-card__date">${shortDate(shot.createdAt).slice(5)} ${hhmm(shot.createdAt)}</span>
        ${shot.favorite ? '<span class="log-card__fav">★</span>' : ''}
      </span>
    `;
    card.addEventListener('click', () => openDetail(shot));
    list.appendChild(card);
  }
}

export async function refresh({ silent = false } = {}) {
  try {
    state.shots = await listShots();
  } catch (err) {
    console.error('[LIGHTNO] listShots failed', err);
    state.shots = [];
    if (!silent) {
      toast('无法读取本地记录：' + (err.message || err), { type: 'error', duration: 3200 });
    }
  }
  render();
  if (onCountCb) onCountCb(state.shots.length);
  return state.shots.length;
}

function openDetail(shot) {
  const isBlob = shot.photo && typeof shot.photo !== 'string';
  const detailUrl = shot.photo ? (isBlob ? URL.createObjectURL(shot.photo) : shot.photo) : '';
  const content = document.createElement('div');
  content.className = 'shot-detail';
  const rows = [
    ['EV 100', formatEv(shot.ev, 1)],
    ['测光模式', shot.modeLabel || shot.modeTag || '—'],
    ['曝光优先', shot.priority === 'shutter' ? '快门优先（光圈自动）' : '光圈优先（快门自动）'],
    ['ISO', String(shot.iso)],
    ['光圈', formatAperture(shot.aperture) + (shot.apertureOutOfRange ? ' · 超范围' : '')],
    ['快门（含 ND）', formatShutter(shot.shutterWithNd) + (shot.shutterOutOfRange ? ' · 超范围' : '')],
    ['基准快门', formatShutter(shot.shutterBase)],
    ['ND', shot.ndStops > 0 ? `${ndLabel(shot.ndStops)} · ${Number(shot.ndStops).toFixed(1)} 档` : 'OFF'],
    ['场景亮度', formatLuminance(shot.luminance)],
    ['场景反差', Number.isFinite(shot.contrast) ? shot.contrast.toFixed(1) + ' EV' : '—'],
    ['色温估算', formatCct(shot.cct)],
    ['目标影调', shot.zoneValue != null ? 'ZONE ' + zoneRoman(shot.zoneValue) : '—'],
    ['数据来源', SOURCE_LABELS[shot.source] || '—'],
    ['校准偏移', `${shot.calibration >= 0 ? '+' : ''}${Number(shot.calibration || 0).toFixed(1)} EV`],
    ['时间', shot.timeLabel || '—']
  ];
  if (shot.cameraExposure && shot.cameraExposure.source === 'exif') {
    const ce = shot.cameraExposure;
    rows.push([
      '照片曝光',
      `${formatShutter(ce.shutter)} · ${formatAperture(ce.aperture)} · ISO ${ce.iso}`
    ]);
    if (shot.photoMeta && shot.photoMeta.model) {
      rows.push(['拍摄设备', shot.photoMeta.model]);
    }
  }
  if (shot.coords) rows.push(['坐标', shot.coords]);

  content.innerHTML = `
    <img class="shot-detail__image" src="${detailUrl}" alt="测光记录" />
    <div class="param-grid">
      ${rows
        .map(([k, v]) => `<div class="param"><span>${k}</span><b>${escapeHtml(v)}</b></div>`)
        .join('')}
    </div>
    <div class="field">
      <label>备注</label>
      <textarea class="note-field" id="shotNote" placeholder="例如：逆光人像，测脸部高光；下次加 0.3EV">${escapeHtml(
        shot.note || ''
      )}</textarea>
    </div>
    <div class="detail-actions">
      <button class="btn btn--ghost" id="shotCopy" type="button">复制参数</button>
      <button class="btn btn--ghost" id="shotFav" type="button">${
        shot.favorite ? '取消收藏' : '收藏'
      }</button>
      <button class="btn btn--danger" id="shotDelete" type="button">删除</button>
    </div>
    <button class="btn btn--ghost btn--full" id="shotDownload" type="button">下载带参数照片</button>
  `;

  const noteEl = content.querySelector('#shotNote');
  const saveNote = debounce(async () => {
    const value = noteEl.value.trim();
    if (value === (shot.note || '')) return;
    shot.note = value;
    try {
      await putShot(shot);
      const idx = state.shots.findIndex((s) => s.id === shot.id);
      if (idx >= 0) state.shots[idx].note = value;
    } catch {
      toast('备注保存失败', { type: 'error' });
    }
  }, 500);
  noteEl.addEventListener('input', saveNote);
  noteEl.addEventListener('blur', () => saveNote());

  content.querySelector('#shotCopy').addEventListener('click', async () => {
    const text = shotToText(shot);
    try {
      await navigator.clipboard.writeText(text);
      toast('参数已复制', { type: 'success', duration: 1600 });
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast('参数已复制', { type: 'success', duration: 1600 });
      } catch {
        toast('复制失败，请手动选择文本', { type: 'warn' });
      }
      ta.remove();
    }
  });

  const favBtn = content.querySelector('#shotFav');
  favBtn.addEventListener('click', async () => {
    shot.favorite = !shot.favorite;
    try {
      await putShot(shot);
      const idx = state.shots.findIndex((s) => s.id === shot.id);
      if (idx >= 0) state.shots[idx].favorite = shot.favorite;
      favBtn.textContent = shot.favorite ? '取消收藏' : '收藏';
      render();
      hapticTap();
    } catch {
      toast('收藏失败', { type: 'error' });
    }
  });

  content.querySelector('#shotDownload').addEventListener('click', () => {
    if (!shot.photo) {
      toast('这条记录没有照片', { type: 'warn' });
      return;
    }
    downloadBlob(
      shot.photo,
      `LIGHTNO_${shortDate(shot.createdAt)}_${hhmm(shot.createdAt).replace(':', '')}.jpg`
    );
  });

  content.querySelector('#shotDelete').addEventListener('click', async () => {
    const btn = content.querySelector('#shotDelete');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '再点一次确认删除';
      btn.classList.add('is-armed');
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = '删除';
        btn.classList.remove('is-armed');
      }, 3200);
      return;
    }
    try {
      await deleteShot(shot.id);
      state.shots = state.shots.filter((s) => s.id !== shot.id);
      detail.close();
      render();
      if (onCountCb) onCountCb(state.shots.length);
      toast('记录已删除', { type: 'success', duration: 1800 });
    } catch {
      toast('删除失败', { type: 'error' });
    }
  });

  const detail = openSheet({
    title: '测光记录',
    subtitle: shot.timeLabel || '',
    content,
    onClose: () => {
      saveNote();
      if (isBlob && detailUrl) URL.revokeObjectURL(detailUrl);
    }
  });
}

async function exportBackup() {
  if (!state.shots.length) {
    toast('还没有记录可以导出', { type: 'warn' });
    return;
  }
  const includePhotos = state.shots.length <= 120;
  toast(includePhotos ? '正在打包照片与参数…' : '记录较多，本次仅导出参数…', { duration: 1800 });
  try {
    const payload = { app: 'LIGHTNO', version: 1, exportedAt: Date.now(), shots: [] };
    for (const shot of state.shots) {
      const item = { ...shot };
      if (shot.photo && includePhotos) item.photo = await blobToDataUrl(shot.photo);
      else delete item.photo;
      if (shot.thumb && includePhotos) item.thumb = await blobToDataUrl(shot.thumb);
      else delete item.thumb;
      payload.shots.push(item);
    }
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    downloadBlob(
      blob,
      `lightno-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
        d.getHours()
      )}${pad(d.getMinutes())}.json`
    );
    toast(`已导出 ${payload.shots.length} 条记录`, { type: 'success', duration: 3000 });
  } catch (err) {
    console.error('[LIGHTNO] export failed', err);
    toast('导出失败：' + (err.message || err), { type: 'error' });
  }
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const shots = Array.isArray(data) ? data : data && data.shots;
    if (!Array.isArray(shots)) throw new Error('不是 LIGHTNO 备份文件');
    let added = 0;
    for (const raw of shots) {
      if (!raw || !raw.id || !Number.isFinite(raw.createdAt)) continue;
      const shot = { ...raw };
      if (typeof shot.photo === 'string') shot.photo = dataUrlToBlob(shot.photo);
      if (typeof shot.thumb === 'string') shot.thumb = dataUrlToBlob(shot.thumb);
      await putShot(shot);
      added++;
    }
    await refresh();
    toast(`已导入 ${added} 条记录`, { type: 'success', duration: 2600 });
  } catch (err) {
    console.error('[LIGHTNO] import failed', err);
    toast('导入失败：' + (err.message || err), { type: 'error', duration: 3200 });
  }
}

export function createHistory({ onCount } = {}) {
  onCountCb = onCount || null;

  const filters = $('#logFilters');
  if (filters) {
    filters.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-filter]');
      if (!btn) return;
      state.filter = btn.dataset.filter;
      filters.querySelectorAll('.filter').forEach((b) => b.classList.toggle('is-active', b === btn));
      render();
      hapticTap();
    });
  }

  const exportBtn = $('#btnExport');
  if (exportBtn) exportBtn.addEventListener('click', exportBackup);

  const importBtn = $('#btnImport');
  const importInput = $('#importFile');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) await importBackup(file);
    });
  }

  refresh({ silent: true });

  return {
    refresh,
    getCount: () => state.shots.length
  };
}