/**
 * LIGHTNO · 入口
 */
import { $, $$ } from './ui/dom.js';
import { getSettings, updateSettings, getRuntime, setRuntime } from './core/state.js';
import { createMeter } from './ui/meter.js';
import { createPhotoMeter } from './ui/photoMeter.js';
import { createHistory } from './ui/history.js';
import { createSettings } from './ui/settings.js';
import { openOnboarding, openCalibration } from './ui/pickers.js';
import { initPWA, promptInstall } from './pwa.js';
import { toast } from './ui/toast.js';

const VIEWS = ['meter', 'log', 'settings'];
const params = new URLSearchParams(window.location.search);
const preferDemo = params.get('demo') === '1';
const skipIntro = params.get('skipintro') === '1';
let currentView = 'meter';
let meter = null;
let history = null;
let settingsView = null;
let hintShown = false;

function setBadge(count) {
  const badge = $('#logBadge');
  if (!badge) return;
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = count > 99 ? '99+' : String(count);
  } else {
    badge.hidden = true;
  }
}

function showView(name = 'meter', userInitiated = false) {
  if (!VIEWS.includes(name)) name = 'meter';
  currentView = name;
  setRuntime({ view: name }, 'view');

  for (const view of VIEWS) {
    const section = document.getElementById('view-' + view);
    if (section) section.hidden = view !== name;
  }

  $$('.tab').forEach((tab) => {
    const active = tab.dataset.target === name;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  if (name === 'meter') {
    if (meter) meter.activate();
  } else if (meter) {
    meter.deactivate();
  }

  if (name === 'log' && history) history.refresh({ silent: !userInitiated });
  if (name === 'settings' && settingsView) settingsView.refresh();

  if (window.location.hash.replace('#', '') !== name) {
    try {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search + '#' + name
      );
    } catch {
      /* ignore */
    }
  }

  const viewport = $('#viewport');
  if (viewport) viewport.scrollTop = 0;
  window.scrollTo(0, 0);
}

function registerEvents() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.target === currentView) {
        if (currentView === 'meter' && meter && getRuntime().source === 'error') {
          meter.retryCamera();
        }
        return;
      }
      showView(tab.dataset.target, true);
    });
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-goto]');
    if (target) showView(target.dataset.goto, true);
  });

  document.addEventListener(
    'pointerdown',
    () => {
      const video = document.getElementById('camera');
      if (video && video.paused) video.play().catch(() => {});
    },
    { once: true }
  );

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return;
    if (currentView === 'meter' && meter) meter.activate();
  });

  window.addEventListener('hashchange', () => {
    const name = window.location.hash.replace('#', '');
    if (VIEWS.includes(name) && name !== currentView) showView(name, true);
  });
}

function scheduleCalibrationHint() {
  setTimeout(() => {
    if (hintShown) return;
    const s = getSettings();
    const rt = getRuntime();
    if (s.calibrated || !['hardware', 'auto', 'image'].includes(rt.source)) return;
    hintShown = true;
    toast('建议用 18% 灰卡校准一次，读数会更准', {
      type: 'info',
      duration: 6000,
      action: {
        label: '校准',
        onClick: () => openCalibration({ getLiveEv: () => (meter ? meter.getLiveEv() : NaN) })
      }
    });
  }, 15000);
}

function boot() {
  meter = createMeter({
    onSaved: () => {
      if (history) history.refresh();
    },
    onNavigate: showView
  });

  history = createHistory({ onCount: setBadge });
  createPhotoMeter({
    onSaved: () => {
      if (history) history.refresh();
    }
  });

  settingsView = createSettings({
    getLiveEv: () => (meter ? meter.getLiveEv() : NaN),
    onCleared: () => {
      if (history) history.refresh();
    },
    onInstall: promptInstall,
    onEngineChange: () => {
      if (meter) meter.retryCamera();
    }
  });

  initPWA();
  registerEvents();

  if (preferDemo) meter.startDemo();

  const initial = window.location.hash.replace('#', '');
  showView(VIEWS.includes(initial) ? initial : 'meter');
  setBadge(history.getCount());

  const settings = getSettings();
  if (!settings.onboarded && !skipIntro && !preferDemo) {
    setTimeout(() => {
      openOnboarding({
        onDone: () => {
          updateSettings({ onboarded: true });
          if (getRuntime().source === 'error' && meter) meter.retryCamera();
        }
      });
    }, 900);
  }

  scheduleCalibrationHint();

  window.addEventListener('pagehide', () => {
    if (meter) meter.deactivate();
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted && currentView === 'meter' && meter) meter.activate();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

window.addEventListener('error', (event) => {
  console.error('[LIGHTNO]', event.error || event.message);
});