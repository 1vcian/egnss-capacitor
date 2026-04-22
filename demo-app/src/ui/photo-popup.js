import Overlay from 'ol/Overlay.js';

import { deletePhoto, readPhotoDataUrl } from '../storage/photo-store.js';
import { explainIntegrity } from '../gnss/integrity-explain.js';
import { toast } from './toast.js';

/**
 * Attach a click-to-popup behaviour to photo markers on the map.
 *
 * Each popup shows:
 *   - thumbnail preview,
 *   - timestamp,
 *   - "certificate" block with the entire GnssFix snapshot that was captured
 *     at shutter time (coordinates, altitude, accuracy, satellites,
 *     constellations, EGNOS/OSNMA, mock flag, source, integrity, centroid),
 *   - a human-readable explanation of the integrity level,
 *   - buttons to open the full photo in a lightbox or delete the record.
 *
 * @param {ReturnType<typeof import('../map/map.js').createMap>} mapCtx
 */
export function attachPhotoPopup(mapCtx) {
  const container = document.createElement('div');
  container.className = 'photo-popup';
  container.hidden = true;
  document.body.appendChild(container);

  const overlay = new Overlay({
    element: container,
    autoPan: { animation: { duration: 200 } },
    offset: [0, -36],
    positioning: 'bottom-center',
    stopEvent: true,
  });
  mapCtx.getMap().addOverlay(overlay);

  mapCtx.getMap().on('click', (event) => {
    const feature = mapCtx.getMap().forEachFeatureAtPixel(event.pixel, (f) => f);
    if (!feature || feature.get('kind') !== 'photo') {
      hide();
      return;
    }
    const record = feature.get('record');
    if (!record) return;
    render(record, feature);
    overlay.setPosition(feature.getGeometry().getCoordinates());
    container.hidden = false;
  });

  function render(record, feature) {
    container.innerHTML = renderPopup(record);
    const openBtn = container.querySelector('.photo-popup__open');
    const deleteBtn = container.querySelector('.photo-popup__delete');
    const closeBtn = container.querySelector('.photo-popup__close');
    openBtn?.addEventListener('click', () => openLightbox(record));
    deleteBtn?.addEventListener('click', async () => {
      await deletePhoto(record.id);
      mapCtx.markersSource.removeFeature(feature);
      hide();
      toast('Photo deleted', { level: 'info' });
    });
    closeBtn?.addEventListener('click', hide);
  }

  function hide() {
    container.hidden = true;
    overlay.setPosition(undefined);
  }
}

// ---------------------------------------------------------------------------
// Popup HTML
// ---------------------------------------------------------------------------

function renderPopup(record) {
  const fix = record.fix ?? record; // legacy records before fix-snapshot stored everything flat
  const opts = record.options ?? { minAccuracyMeters: 10, requireOsnma: false };
  const { reasons } = explainIntegrity(fix, opts);
  const date = new Date(record.timestamp).toLocaleString();

  return `
    <button type="button" class="photo-popup__close" aria-label="Close">×</button>
    ${record.thumbUri ? `<img src="${record.thumbUri}" alt="Photo preview" class="photo-popup__thumb" />` : ''}
    <div class="photo-popup__title">
      <strong>Geotagged photo</strong>
      <span class="fix-panel__pill fix-panel__pill--${levelPillClass(fix.integrityLevel)}">${fix.integrityLevel}</span>
    </div>
    <div class="photo-popup__meta">
      <div class="photo-popup__row"><span>Taken</span><span>${date}</span></div>
      ${renderCertificate(fix)}
    </div>
    <div class="photo-popup__why">
      <strong>Why ${fix.integrityLevel}?</strong>
      ${reasons.map((r) => `<div>${r}</div>`).join('')}
    </div>
    <div class="photo-popup__actions">
      <button type="button" class="photo-popup__open">View full photo</button>
      <button type="button" class="photo-popup__delete">Delete</button>
    </div>
  `;
}

function renderCertificate(fix) {
  const rows = [
    ['Coordinates', `${fmt(fix.lat, 6)}°, ${fmt(fix.lon, 6)}°`],
    ['Altitude', `${fmtOpt(fix.alt, 'm')} (WGS84)`],
    ['Accuracy (h / v)', `±${fmtOpt(fix.hAccuracy, 'm')} / ±${fmtOpt(fix.vAccuracy, 'm')}`],
    ['Source', sourceLabel(fix.source, fix.antenna)],
    ['Satellites', `${fix.satellitesUsed ?? '–'} used / ${fix.satellitesVisible ?? '–'} visible`],
    ['Constellations', (fix.constellations ?? []).length ? fix.constellations.join(', ') : '–'],
    ['Corrections', fix.egnosActive ? 'EGNOS / SBAS active' : 'none'],
    ['OSNMA (Galileo)', osnmaLabel(fix.osnmaStatus)],
    ['Mock-location flag', fix.isMockLocation ? 'YES — OS marked as fake' : 'no'],
  ];
  if (fix.antenna) {
    rows.push(['Antenna', `${fix.antenna.name}${fix.antenna.rssi !== undefined ? ` (${fix.antenna.rssi} dBm)` : ''}`]);
  }
  if (fix.centroid) {
    rows.push(['Convex-hull centroid', `${fmt(fix.centroid.lat, 6)}, ${fmt(fix.centroid.lon, 6)} (n=${fix.centroid.samples})`]);
  }
  return rows
    .map(
      ([k, v]) =>
        `<div class="photo-popup__row"><span>${k}</span><span>${v}</span></div>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Full-screen lightbox
// ---------------------------------------------------------------------------

let lightboxEl = null;

async function openLightbox(record) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.hidden = true;
    document.body.appendChild(lightboxEl);
    lightboxEl.addEventListener('click', (e) => {
      if (e.target === lightboxEl || e.target.classList.contains('lightbox__close')) {
        closeLightbox();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });
  }

  const fix = record.fix ?? record;
  const opts = record.options ?? { minAccuracyMeters: 10, requireOsnma: false };
  const { reasons } = explainIntegrity(fix, opts);
  const date = new Date(record.timestamp).toLocaleString();

  // Initial skeleton while we load the full image from disk.
  lightboxEl.innerHTML = `
    <div class="lightbox__panel">
      <button type="button" class="lightbox__close" aria-label="Close">×</button>
      <div class="lightbox__image">
        <img alt="Full photo" src="${record.thumbUri ?? ''}" />
      </div>
      <div class="lightbox__meta">
        <h2>Geotagged photo
          <span class="fix-panel__pill fix-panel__pill--${levelPillClass(fix.integrityLevel)}">${fix.integrityLevel}</span>
        </h2>
        <div class="lightbox__row"><span>Taken</span><span>${date}</span></div>
        ${renderCertificate(fix)}
        <div class="lightbox__why">
          <strong>Why ${fix.integrityLevel}?</strong>
          ${reasons.map((r) => `<div>${r}</div>`).join('')}
        </div>
      </div>
    </div>
  `;
  lightboxEl.hidden = false;
  requestAnimationFrame(() => lightboxEl.classList.add('lightbox--visible'));

  // Swap the thumbnail for the real photo once loaded.
  try {
    const url = await readPhotoDataUrl(record);
    const img = lightboxEl.querySelector('.lightbox__image img');
    if (img) img.src = url;
  } catch (err) {
    console.error('[photo] readPhotoDataUrl failed', err);
  }
}

function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.classList.remove('lightbox--visible');
  setTimeout(() => {
    if (lightboxEl) lightboxEl.hidden = true;
  }, 180);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v, digits = 5) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return Number(v).toFixed(digits);
}
function fmtOpt(v, unit, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `${Number(v).toFixed(digits)} ${unit}`;
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
function osnmaLabel(status) {
  switch (status) {
    case 'OK':
      return 'OK — navigation data authenticated';
    case 'KO':
      return 'KO — signature failed (possible spoofing)';
    case 'UNKNOWN':
      return 'supported, no frame authenticated yet';
    case 'NOT_SUPPORTED':
      return 'not available on this platform';
    default:
      return status ?? '–';
  }
}
function levelPillClass(level) {
  switch (level) {
    case 'HIGH':
      return 'ok';
    case 'STANDARD':
      return '';
    case 'LOW':
      return 'warn';
    case 'UNTRUSTED':
      return 'err';
    default:
      return '';
  }
}
