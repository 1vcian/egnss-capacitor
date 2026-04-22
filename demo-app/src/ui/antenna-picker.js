import { controller } from '../gnss/gnss-controller.js';
import { classifyAntenna, sortAntennas } from '../gnss/antenna-heuristic.js';
import { toast } from './toast.js';

/**
 * Open a modal picker that streams Bluetooth devices discovered during
 * the antenna scan and lets the user consciously pick the right one.
 *
 * Why not auto-pick the first result?
 *   Android returns *all* bonded classic devices (headphones, keyboards,
 *   paired phones, …) in addition to the BLE receivers found nearby.
 *   Picking `[0]` meant we sometimes connected to a WH-1000XM4 headset
 *   and reported it as "antenna connected" — clearly wrong.
 *
 * The picker:
 *   - starts a scan immediately and shows "Scanning…" with a spinner,
 *   - inserts each device as it appears, classifying it into
 *     likely-GNSS / unknown / non-GNSS,
 *   - lets the user tap any row to attempt the connection,
 *   - cleans up its listeners when closed.
 *
 * @returns {Promise<import('egnss-capacitor').AntennaDevice | null>}
 *          The connected device, or `null` if the user cancelled.
 */
export function openAntennaPicker() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'antenna-picker';
    overlay.innerHTML = `
      <div class="antenna-picker__panel" role="dialog" aria-modal="true" aria-label="Pair Bluetooth antenna">
        <header class="antenna-picker__header">
          <div>
            <h2>Pair Bluetooth antenna</h2>
            <p class="antenna-picker__subtitle">
              Pick your GNSS receiver from the list. Headphones, speakers
              and other Bluetooth peripherals are shown but flagged so you
              don't pair them by mistake.
            </p>
          </div>
          <button type="button" class="antenna-picker__close" aria-label="Close">×</button>
        </header>
        <div class="antenna-picker__status" data-status>
          <span class="antenna-picker__spinner" aria-hidden="true"></span>
          <span data-status-text>Scanning…</span>
        </div>
        <ul class="antenna-picker__list" data-list></ul>
        <footer class="antenna-picker__footer">
          <button type="button" class="antenna-picker__cancel">Cancel</button>
        </footer>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('[data-list]');
    const statusEl = overlay.querySelector('[data-status]');
    const statusTextEl = overlay.querySelector('[data-status-text]');
    const closeBtn = overlay.querySelector('.antenna-picker__close');
    const cancelBtn = overlay.querySelector('.antenna-picker__cancel');

    const seen = new Map();
    let connecting = false;
    let closed = false;

    const render = () => {
      const sorted = sortAntennas([...seen.values()]);
      listEl.innerHTML = sorted
        .map(({ device, meta }) => renderRow(device, meta))
        .join('');
    };

    const onDevice = (device) => {
      seen.set(device.id, device);
      render();
    };

    const scan = controller.startAntennaScan({ timeoutMs: 10000, onDevice });

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      try {
        await scan.cancel();
      } catch {
        /* ignore */
      }
      overlay.remove();
    };

    const finish = async (device) => {
      await cleanup();
      resolve(device ?? null);
    };

    listEl.addEventListener('click', async (event) => {
      if (connecting) return;
      const row = event.target.closest('[data-device-id]');
      if (!row) return;
      const id = row.dataset.deviceId;
      const device = seen.get(id);
      if (!device) return;

      const meta = classifyAntenna(device);
      if (meta.kind === 'non-gnss') {
        const ok = confirm(
          `"${device.name ?? id}" does not look like a GNSS receiver (${meta.hint}).\n\nTry to pair it anyway?`,
        );
        if (!ok) return;
      }

      connecting = true;
      row.classList.add('antenna-picker__row--connecting');
      statusTextEl.textContent = `Connecting to ${device.name ?? id}…`;
      statusEl.dataset.state = 'connecting';

      try {
        await controller.connectAntenna(id);
        toast(`Connected to ${device.name ?? id}`, { level: 'success' });
        await finish(device);
      } catch (err) {
        console.error('[antenna-picker] connect failed', err);
        connecting = false;
        row.classList.remove('antenna-picker__row--connecting');
        statusTextEl.textContent = err?.message ?? 'Connection failed';
        statusEl.dataset.state = 'error';
      }
    });

    closeBtn.addEventListener('click', () => finish(null));
    cancelBtn.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    scan.done
      .then(({ devices }) => {
        if (closed) return;
        if (devices.length === 0) {
          statusTextEl.textContent =
            'Scan finished — no Bluetooth devices found. Make sure your receiver is powered on and in pairing mode.';
        } else {
          const gnssCount = devices.filter((d) => classifyAntenna(d).kind === 'gnss').length;
          statusTextEl.textContent = gnssCount
            ? `Scan finished. Found ${gnssCount} likely GNSS device${gnssCount > 1 ? 's' : ''}.`
            : 'Scan finished. No device matched a known GNSS pattern — pick the right one manually.';
        }
        statusEl.dataset.state = 'done';
      })
      .catch((err) => {
        if (closed) return;
        console.error('[antenna-picker] scan failed', err);
        statusTextEl.textContent = err?.message ?? 'Scan failed';
        statusEl.dataset.state = 'error';
      });
  });
}

function renderRow(device, meta) {
  const name = escape(device.name ?? '(no name)');
  const id = escape(device.id);
  const rssi = typeof device.rssi === 'number' && device.rssi !== 0
    ? `<span class="antenna-picker__rssi">${device.rssi} dBm</span>`
    : '';
  const badge = badgeFor(meta.kind);
  return `
    <li class="antenna-picker__row antenna-picker__row--${meta.kind}" data-device-id="${id}">
      <div class="antenna-picker__row-main">
        <div class="antenna-picker__row-title">
          <span class="antenna-picker__name">${name}</span>
          ${badge}
        </div>
        <div class="antenna-picker__row-meta">
          <code>${id}</code>
          ${rssi}
        </div>
        <div class="antenna-picker__row-hint">${escape(meta.hint)}</div>
      </div>
      <span class="antenna-picker__cta" aria-hidden="true">→</span>
    </li>
  `;
}

function badgeFor(kind) {
  if (kind === 'gnss')
    return '<span class="antenna-picker__badge antenna-picker__badge--gnss">Likely GNSS</span>';
  if (kind === 'non-gnss')
    return '<span class="antenna-picker__badge antenna-picker__badge--bad">Not a GNSS receiver</span>';
  return '<span class="antenna-picker__badge antenna-picker__badge--unknown">Unknown</span>';
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
