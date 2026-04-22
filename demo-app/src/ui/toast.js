let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

/**
 * Show a transient toast message near the bottom of the screen.
 * @param {string} message
 * @param {{level?: 'info' | 'success' | 'warn' | 'error', durationMs?: number}} [opts]
 */
export function toast(message, { level = 'info', durationMs = 3200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast--${level}`;
  el.textContent = message;
  ensureContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--visible'));

  setTimeout(() => {
    el.classList.remove('toast--visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, durationMs);
}
