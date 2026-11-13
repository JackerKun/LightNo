/** LIGHTNO · Toast 提示 */
import { el, onceTransition } from './dom.js';

let root = null;

function ensureRoot() {
  if (root && document.body.contains(root)) return root;
  root = el('<div class="toast-stack" id="toastRoot" aria-live="polite"></div>');
  document.body.appendChild(root);
  return root;
}

const ICONS = {
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.5h.01" stroke-linecap="round"/></svg>',
  success:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12.5l5 5L20 6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9.5 17h-19z" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.5h.01" stroke-linecap="round"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke-linecap="round"/></svg>'
};

/**
 * @param {string} message
 * @param {{type?:'info'|'success'|'warn'|'error', duration?:number, action?:{label:string, onClick:Function}}} opts
 */
export function toast(message, { type = 'info', duration = 2600, action = null } = {}) {
  const host = ensureRoot();
  const node = el(`
    <div class="toast toast--${type}" role="status">
      <span class="toast__icon">${ICONS[type] || ICONS.info}</span>
      <span class="toast__text"></span>
      ${action ? '<button class="toast__action" type="button"></button>' : ''}
    </div>
  `);
  node.querySelector('.toast__text').textContent = message;
  if (action) {
    const btn = node.querySelector('.toast__action');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      try {
        action.onClick();
      } finally {
        dismiss();
      }
    });
  }

  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-in'));

  let timer = duration > 0 ? setTimeout(dismiss, duration) : null;

  function dismiss() {
    if (timer) clearTimeout(timer);
    timer = null;
    node.classList.remove('is-in');
    onceTransition(node, 400).then(() => node.remove());
  }

  return { dismiss, node };
}

export function dismissAll() {
  if (!root) return;
  for (const node of Array.from(root.children)) {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 400);
  }
}