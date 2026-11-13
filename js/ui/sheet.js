/** LIGHTNO · 底部抽屉 */
import { el, onceTransition } from './dom.js';

let active = null;

/**
 * @param {{
 *  title?:string, subtitle?:string, content?:string|Node,
 *  actions?:{label:string, kind?:'primary'|'ghost'|'danger', onClick?:Function}[],
 *  dismissible?:boolean, className?:string, onMount?:(body:HTMLElement)=>void,
 *  onClose?:Function
 * }} opts
 */
export function openSheet(opts = {}) {
  closeSheet(true);

  const {
    title = '',
    subtitle = '',
    content = '',
    actions = [],
    dismissible = true,
    className = '',
    onMount,
    onClose
  } = opts;

  const backdrop = el(`
    <div class="sheet-backdrop" role="presentation">
      <section class="sheet ${className}" role="dialog" aria-modal="true" aria-label="${escapeAttr(
        title || '面板'
      )}" tabindex="-1">
        <div class="sheet__handle" aria-hidden="true"></div>
        <header class="sheet__head">
          <div class="sheet__titles">
            ${title ? '<h3 class="sheet__title"></h3>' : ''}
            ${subtitle ? '<p class="sheet__subtitle"></p>' : ''}
          </div>
          ${
            dismissible
              ? '<button class="icon-btn sheet__close" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>'
              : ''
          }
        </header>
        <div class="sheet__body"></div>
        ${actions.length ? '<footer class="sheet__foot"></footer>' : ''}
      </section>
    </div>
  `);

  if (title) backdrop.querySelector('.sheet__title').textContent = title;
  if (subtitle) backdrop.querySelector('.sheet__subtitle').textContent = subtitle;

  const body = backdrop.querySelector('.sheet__body');
  if (typeof content === 'string') body.innerHTML = content;
  else if (content instanceof Node) body.appendChild(content);

  const footer = backdrop.querySelector('.sheet__foot');
  if (footer) {
    for (const action of actions) {
      const btn = el(
        `<button type="button" class="btn btn--${action.kind || 'ghost'}">${escapeHtml(
          action.label
        )}</button>`
      );
      btn.addEventListener('click', () => {
        if (action.onClick) action.onClick(api);
      });
      footer.appendChild(btn);
    }
  }

  const sheet = backdrop.querySelector('.sheet');

  function requestClose(fromCode = false) {
    if (!dismissible && !fromCode) return;
    closeSheet();
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') requestClose(true);
  };

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) requestClose();
  });
  const closeBtn = backdrop.querySelector('.sheet__close');
  if (closeBtn) closeBtn.addEventListener('click', () => requestClose());

  document.body.appendChild(backdrop);
  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', onKeyDown);

  const api = {
    el: backdrop,
    sheet,
    body,
    close: () => closeSheet(),
    setTitle(text) {
      const node = backdrop.querySelector('.sheet__title');
      if (node) node.textContent = text;
    },
    setSubtitle(text) {
      const node = backdrop.querySelector('.sheet__subtitle');
      if (node) node.textContent = text;
    }
  };

  active = { api, backdrop, onClose, onKeyDown };

  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    sheet.focus({ preventScroll: true });
  });

  if (onMount) {
    try {
      onMount(body);
    } catch (err) {
      console.error('[LIGHTNO] sheet onMount error', err);
    }
  }

  return api;
}

export function closeSheet(immediate = false) {
  if (!active) return;
  const { backdrop, onClose, onKeyDown } = active;
  active = null;
  document.removeEventListener('keydown', onKeyDown);
  if (immediate) {
    backdrop.remove();
  } else {
    backdrop.classList.remove('is-open');
    onceTransition(backdrop, 380).then(() => backdrop.remove());
  }
  if (!document.querySelector('.sheet-backdrop:not([data-closing])')) {
    document.body.classList.remove('sheet-open');
  }
  if (typeof onClose === 'function') {
    try {
      onClose();
    } catch (err) {
      console.error('[LIGHTNO] sheet onClose error', err);
    }
  }
}

export function isSheetOpen() {
  return !!active;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => {
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

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, '&#96;');
}