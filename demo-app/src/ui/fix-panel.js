import { controller } from '../gnss/gnss-controller.js';
import { explainIntegrity } from '../gnss/integrity-explain.js';

/**
 * Toggleable panel that shows every field of the most recent GnssFix
 * in a human-readable grid. Exists primarily for the demo — so the
 * reviewer can literally see the data the plugin emits.
 *
 * @param {{
 *   panel: HTMLElement,
 *   body: HTMLElement,
 *   toggle: HTMLButtonElement,
 *   closeBtn: HTMLButtonElement,
 * }} elements
 */
export function initFixPanel(elements) {
  const { panel, body, toggle, closeBtn } = elements;
  let open = false;
  let autoOpened = false;

  const setOpen = (value) => {
    open = value;
    if (value) {
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('fix-panel--visible'));
      toggle.setAttribute('aria-expanded', 'true');
      toggle.querySelector('.fix-panel-toggle__label').textContent = 'Hide';
    } else {
      panel.classList.remove('fix-panel--visible');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.querySelector('.fix-panel-toggle__label').textContent = 'Details';
      setTimeout(() => {
        if (!open) panel.hidden = true;
      }, 220);
    }
  };

  toggle.addEventListener('click', () => setOpen(!open));
  closeBtn.addEventListener('click', () => setOpen(false));

  const render = () => {
    if (controller.state === 'idle') {
      body.innerHTML =
        '<p class="fix-panel__empty">Press the <strong>G</strong> button to start the GNSS stream.</p>';
      return;
    }
    if (!controller.lastFix) {
      body.innerHTML = `
        <div class="fix-panel__waiting">
          <div class="fix-panel__spinner" aria-hidden="true"></div>
          <span>${controller.state === 'starting' ? 'Initializing GNSS…' : 'Waiting for first fix…'}</span>
          <span class="fix-panel__label">Outdoors or by a window speeds this up</span>
        </div>`;
      return;
    }
    body.innerHTML = renderFixGrid(controller.lastFix);
  };

  controller.addEventListener('state', () => {
    toggle.hidden = controller.state === 'idle';
    render();
  });
  controller.addEventListener('fix', render);
  controller.addEventListener('firstFix', () => {
    if (!open && !autoOpened) {
      autoOpened = true;
      setOpen(true);
    }
  });
  controller.addEventListener('stopped', () => {
    autoOpened = false;
    toggle.hidden = true;
    setOpen(false);
  });

  render();

  return { setOpen, toggle: () => setOpen(!open) };
}

function fmtNum(v, digits = 5) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return Number(v).toFixed(digits);
}

function fmtOptional(v, unit, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `${Number(v).toFixed(digits)} ${unit}`;
}

function fmtTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function osnmaBadge(status) {
  switch (status) {
    case 'OK':
      return '<span class="fix-panel__pill fix-panel__pill--ok">OSNMA OK</span>';
    case 'KO':
      return '<span class="fix-panel__pill fix-panel__pill--err">OSNMA KO</span>';
    case 'UNKNOWN':
      return '<span class="fix-panel__pill fix-panel__pill--warn">OSNMA ?</span>';
    default:
      return '<span class="fix-panel__pill">OSNMA n/a</span>';
  }
}

function egnosBadge(active) {
  return active
    ? '<span class="fix-panel__pill fix-panel__pill--ok">EGNOS</span>'
    : '<span class="fix-panel__pill">no EGNOS</span>';
}

function mockBadge(mock) {
  if (!mock) return '';
  return '<span class="fix-panel__pill fix-panel__pill--err">MOCK</span>';
}

function sourceLabel(source, antenna) {
  switch (source) {
    case 'EXTERNAL_BT':
      return antenna?.name ? `External BT (${antenna.name})` : 'External Bluetooth';
    case 'INTERNAL_GNSS':
      return 'Internal GNSS chip';
    case 'WEB_GEOLOC':
      return 'Browser geolocation';
    default:
      return source ?? '–';
  }
}

function renderReason(fix) {
  const { reasons } = explainIntegrity(fix, controller.options);
  return reasons.map((r) => `<div>${r}</div>`).join('');
}

function renderFixGrid(fix) {
  const constellations = (fix.constellations ?? []).length
    ? fix.constellations
        .map((c) => `<span class="fix-panel__pill">${c}</span>`)
        .join('')
    : '<span class="fix-panel__label">–</span>';

  const centroid = fix.centroid
    ? `${fmtNum(fix.centroid.lat, 6)}, ${fmtNum(fix.centroid.lon, 6)} <span class="fix-panel__label">(n=${fix.centroid.samples})</span>`
    : '–';

  return `
    <div class="fix-panel__grid">
      <div class="fix-panel__row">
        <span class="fix-panel__label">Source</span>
        <span class="fix-panel__value">${sourceLabel(fix.source, fix.antenna)}</span>
      </div>
      <div class="fix-panel__row">
        <span class="fix-panel__label">Integrity</span>
        <span class="fix-panel__value" data-level="${fix.integrityLevel}">
          ${fix.integrityLevel}
          ${mockBadge(fix.isMockLocation)}
        </span>
      </div>

      <div class="fix-panel__row fix-panel__row--wide">
        <span class="fix-panel__label">Why ${fix.integrityLevel}?</span>
        <span class="fix-panel__value fix-panel__reason">${renderReason(fix)}</span>
      </div>

      <div class="fix-panel__row">
        <span class="fix-panel__label">Latitude</span>
        <span class="fix-panel__value fix-panel__value--mono">${fmtNum(fix.lat, 6)}°</span>
      </div>
      <div class="fix-panel__row">
        <span class="fix-panel__label">Longitude</span>
        <span class="fix-panel__value fix-panel__value--mono">${fmtNum(fix.lon, 6)}°</span>
      </div>

      <div class="fix-panel__row">
        <span class="fix-panel__label">Altitude (WGS84)</span>
        <span class="fix-panel__value">${fmtOptional(fix.alt, 'm')}</span>
      </div>
      <div class="fix-panel__row">
        <span class="fix-panel__label">Accuracy (h / v)</span>
        <span class="fix-panel__value">±${fmtOptional(fix.hAccuracy, 'm')} / ±${fmtOptional(fix.vAccuracy, 'm')}</span>
      </div>

      <div class="fix-panel__row">
        <span class="fix-panel__label">Speed</span>
        <span class="fix-panel__value">${fix.speed !== undefined ? fmtOptional(fix.speed, 'm/s') : '–'}</span>
      </div>
      <div class="fix-panel__row">
        <span class="fix-panel__label">Heading</span>
        <span class="fix-panel__value">${fix.bearing !== undefined ? fmtOptional(fix.bearing, '°') : '–'}</span>
      </div>

      <div class="fix-panel__row">
        <span class="fix-panel__label">Satellites</span>
        <span class="fix-panel__value">${fix.satellitesUsed ?? '–'} used / ${fix.satellitesVisible ?? '–'} visible</span>
      </div>
      <div class="fix-panel__row">
        <span class="fix-panel__label">Timestamp</span>
        <span class="fix-panel__value fix-panel__value--mono">${fmtTime(fix.timestamp)}</span>
      </div>

      <div class="fix-panel__row" style="grid-column: span 2">
        <span class="fix-panel__label">Constellations</span>
        <span class="fix-panel__value">${constellations}</span>
      </div>

      <div class="fix-panel__row" style="grid-column: span 2">
        <span class="fix-panel__label">Corrections / authentication</span>
        <span class="fix-panel__value">
          ${egnosBadge(fix.egnosActive)}
          ${osnmaBadge(fix.osnmaStatus)}
        </span>
      </div>

      <div class="fix-panel__row" style="grid-column: span 2">
        <span class="fix-panel__label">Convex-hull centroid</span>
        <span class="fix-panel__value fix-panel__value--mono">${centroid}</span>
      </div>
    </div>
  `;
}
