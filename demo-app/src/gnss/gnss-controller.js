import { Egnss } from 'egnss-capacitor';

/**
 * Tiny reactive controller around the Egnss plugin so every UI piece
 * (map, status bar, antenna FAB) reacts to the same events without
 * having to subscribe to the plugin directly and worry about cleanup.
 *
 * Emits:
 *   - 'capability'   (detail: Capability)
 *   - 'antenna'      (detail: AntennaStatusEvent)
 *   - 'started'
 *   - 'stopped'
 *   - 'fix'          (detail: GnssFix) – every fix
 *   - 'firstFix'     (detail: GnssFix) – emitted once per start() when the
 *                                        first fix arrives
 *   - 'state'        (detail: {state, lastFix?, error?}) – composite state:
 *                                        'idle' | 'starting' | 'waiting' |
 *                                        'active' | 'error'
 *   - 'error'        (detail: Error)
 */
class GnssController extends EventTarget {
  constructor() {
    super();
    this.capability = null;
    this.lastFix = null;
    this.antenna = null;
    this.started = false;
    this.state = 'idle';
    /** Options last passed to startGnss, so explanations use the real thresholds. */
    this.options = {
      preferredSource: 'AUTO',
      minAccuracyMeters: 10,
      centroidSamples: 20,
      requireOsnma: false,
    };
    this._pluginListeners = [];
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(
      new CustomEvent('state', {
        detail: { state, lastFix: this.lastFix, ...extra },
      }),
    );
  }

  async init() {
    try {
      this.capability = await Egnss.checkCapability();
      this.dispatchEvent(new CustomEvent('capability', { detail: this.capability }));
    } catch (err) {
      console.error('[gnss] checkCapability failed', err);
    }

    const fixH = await Egnss.addListener('gnssUpdate', (fix) => {
      const isFirst = this.lastFix === null;
      this.lastFix = fix;
      if (isFirst) {
        this.dispatchEvent(new CustomEvent('firstFix', { detail: fix }));
      }
      this.dispatchEvent(new CustomEvent('fix', { detail: fix }));
      if (this.started) this._setState('active');
    });
    const antH = await Egnss.addListener('antennaStatus', (status) => {
      this.antenna = status.connected ? status.device ?? null : null;
      this.dispatchEvent(new CustomEvent('antenna', { detail: status }));
    });
    this._pluginListeners.push(fixH, antH);
  }

  async destroy() {
    for (const h of this._pluginListeners) {
      try {
        await h.remove();
      } catch {
        /* ignore */
      }
    }
    this._pluginListeners = [];
    if (this.started) {
      try {
        await Egnss.stopGnss();
      } catch {
        /* ignore */
      }
      this.started = false;
    }
  }

  async start(options = {}) {
    if (this.started) return;
    this._setState('starting');
    const merged = {
      preferredSource: 'AUTO',
      minAccuracyMeters: 10,
      centroidSamples: 20,
      requireOsnma: false,
      ...options,
    };
    try {
      await Egnss.requestPermissions();
      await Egnss.startGnss(merged);
    } catch (err) {
      this._setState('error', { error: err });
      throw err;
    }
    this.options = merged;
    this.started = true;
    this.lastFix = null;
    this._setState('waiting');
    this.dispatchEvent(new CustomEvent('started'));
  }

  async stop() {
    if (!this.started) return;
    await Egnss.stopGnss();
    this.started = false;
    this.lastFix = null;
    this._setState('idle');
    this.dispatchEvent(new CustomEvent('stopped'));
  }

  /**
   * Start an interactive antenna scan. The returned handle lets the UI
   * stream discovered devices to a picker and close / cancel the scan
   * without auto-connecting to the first result.
   *
   * We subscribe to `antennaScanResult` events AND wait for the
   * `scanAntennas` promise to resolve — on Chrome (web) the browser
   * chooser short-circuits this flow by returning exactly the one device
   * the user selected, which we surface too.
   *
   * @param {{timeoutMs?: number, onDevice?: (device) => void}} [opts]
   * @returns {{
   *   devices: Map<string, import('egnss-capacitor').AntennaDevice>,
   *   done: Promise<{devices: import('egnss-capacitor').AntennaDevice[], picked?: import('egnss-capacitor').AntennaDevice}>,
   *   cancel: () => Promise<void>,
   * }}
   */
  startAntennaScan({ timeoutMs = 10000, onDevice } = {}) {
    const devices = new Map();
    let scanListener = null;
    let pickedFromChooser;
    let cancelled = false;

    const done = (async () => {
      scanListener = await Egnss.addListener('antennaScanResult', (d) => {
        if (!d || !d.id) return;
        const existing = devices.get(d.id);
        devices.set(d.id, { ...existing, ...d });
        onDevice?.(devices.get(d.id));
      });
      try {
        const res = await Egnss.scanAntennas({ timeoutMs });
        // Normalize: accept { devices: [...] }, [...] or single device.
        let immediate = [];
        if (Array.isArray(res)) immediate = res;
        else if (res && Array.isArray(res.devices)) immediate = res.devices;
        else if (res && typeof res === 'object' && res.id) {
          immediate = [res];
          // Web backend returns the single device picked by the browser chooser:
          // we bubble it up so the UI can auto-select it.
          pickedFromChooser = res;
        }
        for (const d of immediate) {
          if (d && d.id) {
            devices.set(d.id, { ...devices.get(d.id), ...d });
            onDevice?.(devices.get(d.id));
          }
        }
        return {
          devices: [...devices.values()],
          picked: pickedFromChooser,
          cancelled,
        };
      } finally {
        try {
          await scanListener?.remove();
        } catch {
          /* ignore */
        }
      }
    })();

    return {
      devices,
      done,
      cancel: async () => {
        cancelled = true;
        try {
          await scanListener?.remove();
        } catch {
          /* ignore */
        }
      },
    };
  }

  /**
   * Connect to a specific antenna chosen by the user from the picker.
   * @param {string} deviceId
   */
  async connectAntenna(deviceId) {
    await Egnss.connectAntenna({ deviceId });
  }

  async unpairAntenna() {
    await Egnss.disconnectAntenna();
  }

  getLastFix() {
    return this.lastFix;
  }
}

/** Singleton shared by all UI components. */
export const controller = new GnssController();
