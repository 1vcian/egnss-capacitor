import { Capacitor } from '@capacitor/core';
import { controller } from '../gnss/gnss-controller.js';

let els = null;

const STATE_LABELS = {
  idle: 'GNSS: idle',
  starting: 'GNSS: starting…',
  waiting: 'GNSS: waiting for fix…',
  active: 'GNSS: fix OK',
  error: 'GNSS: error',
};

/**
 * Wire the top status bar to the GNSS controller.
 * Reacts to capability, antenna, state and fix events.
 *
 * @param {{
 *   platform: HTMLElement,
 *   state: HTMLElement,
 *   source: HTMLElement,
 *   integrity: HTMLElement,
 *   accuracy: HTMLElement,
 * }} elements
 */
export function initStatusBar(elements) {
  els = elements;
  els.platform.textContent = `platform: ${Capacitor.getPlatform()}`;
  renderState('idle');

  if (controller.capability) {
    renderCapability(controller.capability);
  }

  controller.addEventListener('capability', (e) => renderCapability(e.detail));
  controller.addEventListener('state', (e) => renderState(e.detail.state));
  controller.addEventListener('antenna', (e) => {
    if (!controller.lastFix) {
      els.source.textContent = e.detail.connected
        ? `source: antenna ready (${e.detail.device?.name ?? 'BT'})`
        : 'source: idle';
    }
  });
  controller.addEventListener('fix', (e) => renderFix(e.detail));
  controller.addEventListener('stopped', () => {
    els.source.textContent = 'source: idle';
    els.integrity.textContent = 'integrity: –';
    els.integrity.dataset.level = '';
    els.accuracy.textContent = '±? m';
  });
}

function renderState(state) {
  if (!els?.state) return;
  els.state.dataset.state = state;
  els.state.textContent = STATE_LABELS[state] ?? `GNSS: ${state}`;
}

function renderCapability(cap) {
  if (!els) return;
  const bits = [];
  if (cap.hasInternalGnss) bits.push('internal GNSS');
  if (cap.supportsExternalAntenna) bits.push('BT');
  if (cap.supportsRawGnss) bits.push('raw');
  if (cap.supportsOsnmaInternal) bits.push('OSNMA');
  els.source.textContent = bits.length ? `source: idle (${bits.join(', ')})` : 'source: unavailable';
}

/** Render the top bar from a GnssFix. */
export function renderFix(fix) {
  if (!els) return;
  const srcLabel =
    fix.source === 'EXTERNAL_BT'
      ? `source: antenna${fix.antenna?.name ? ` (${fix.antenna.name})` : ''}`
      : fix.source === 'INTERNAL_GNSS'
        ? 'source: internal GNSS'
        : 'source: browser geoloc';
  els.source.textContent = srcLabel;

  els.integrity.textContent = `integrity: ${fix.integrityLevel}`;
  els.integrity.dataset.level = fix.integrityLevel;

  els.accuracy.textContent = `±${fix.hAccuracy.toFixed(1)} m`;
}
