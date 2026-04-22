import { WebPlugin } from '@capacitor/core';

import type {
  AntennaDevice,
  Capability,
  EgnssPlugin,
  FixSource,
  GnssFix,
  PermissionStatus,
  ScanOptions,
  StartOptions,
} from './definitions';
import { computeIntegrityLevel } from './shared/integrity';
import { innermostConvexHullCentroid } from './shared/convex-hull';
import { GeolocationSource } from './web/geolocation-source';
import { BluetoothSource } from './web/bluetooth-source';

interface NavigatorWithBluetooth {
  geolocation?: Geolocation;
  bluetooth?: {
    getAvailability?(): Promise<boolean>;
  };
}

const DEFAULT_OPTIONS: Required<StartOptions> = {
  preferredSource: 'AUTO',
  minAccuracyMeters: 10,
  centroidSamples: 20,
  requireOsnma: false,
};

/**
 * Web implementation of the Egnss plugin.
 *
 * Two cooperating sources:
 *  - {@link GeolocationSource}: `navigator.geolocation.watchPosition`.
 *  - {@link BluetoothSource}:   Web Bluetooth GATT + NMEA.
 *
 * When `preferredSource === 'AUTO'` (the default), a connected
 * external antenna wins over the browser's internal geolocation.
 * Events are throttled, enriched with integrity / centroid and
 * forwarded to the single `gnssUpdate` listener.
 */
export class EgnssWeb extends WebPlugin implements EgnssPlugin {
  private readonly geo = new GeolocationSource();
  private readonly bt = new BluetoothSource();

  private started = false;
  private activeSource: FixSource | null = null;
  private options: Required<StartOptions> = { ...DEFAULT_OPTIONS };
  private lastFix: GnssFix | null = null;
  private centroidBuffer: Array<{ lat: number; lon: number }> = [];

  constructor() {
    super();
    this.bt.onFix((partial) => this.ingestPartial(partial, 'EXTERNAL_BT'));
    this.bt.onDisconnect(() => {
      this.notifyListeners('antennaStatus', { connected: false });
      if (this.started && this.options.preferredSource === 'AUTO') {
        // Antenna gone; fall back to geolocation.
        this.activeSource = 'WEB_GEOLOC';
        this.geo.start(
          (partial) => this.ingestPartial(partial, 'WEB_GEOLOC'),
          (err) => this.notifyListeners('gnssError', { message: err.message }),
        );
      }
    });
  }

  // ------------------------------------------------------------------
  // Capability & permissions
  // ------------------------------------------------------------------

  async checkCapability(): Promise<Capability> {
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as
      | NavigatorWithBluetooth
      | undefined;
    const hasGeolocation = !!nav && 'geolocation' in nav;
    const hasWebBluetooth = !!nav && 'bluetooth' in nav && !!nav.bluetooth;

    let bluetoothAvailable = false;
    if (hasWebBluetooth && nav?.bluetooth?.getAvailability) {
      try {
        bluetoothAvailable = await nav.bluetooth.getAvailability();
      } catch {
        bluetoothAvailable = false;
      }
    }

    return {
      platform: 'web',
      hasInternalGnss: hasGeolocation,
      supportsRawGnss: false,
      supportsOsnmaInternal: false,
      supportsExternalAntenna: hasWebBluetooth,
      bluetoothAvailable,
    };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    return {
      location: 'prompt',
      bluetooth: 'not_required',
    };
  }

  // ------------------------------------------------------------------
  // External Bluetooth antenna
  // ------------------------------------------------------------------

  async scanAntennas(_options?: ScanOptions): Promise<{ devices: AntennaDevice[] }> {
    const devices = await this.bt.requestDevice();
    for (const d of devices) {
      this.notifyListeners('antennaScanResult', d);
    }
    return { devices };
  }

  async connectAntenna(_options: { deviceId: string }): Promise<void> {
    const device = await this.bt.connect();
    this.notifyListeners('antennaStatus', { connected: true, device });

    if (this.started && this.options.preferredSource !== 'INTERNAL') {
      // Switch source to the antenna.
      this.geo.stop();
      this.activeSource = 'EXTERNAL_BT';
    }
  }

  async disconnectAntenna(): Promise<void> {
    await this.bt.disconnect();
    // The 'antennaStatus' event is also emitted via the gattserverdisconnected
    // handler, but we emit here as well to cover the explicit-disconnect path.
    this.notifyListeners('antennaStatus', { connected: false });
  }

  async getConnectedAntenna(): Promise<{ device: AntennaDevice | null }> {
    return { device: this.bt.getConnected() };
  }

  // ------------------------------------------------------------------
  // GNSS stream
  // ------------------------------------------------------------------

  async startGnss(options?: StartOptions): Promise<void> {
    if (this.started) {
      throw this.toTypedError('ALREADY_STARTED', 'startGnss called twice');
    }
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.centroidBuffer = [];
    this.started = true;

    const pref = this.options.preferredSource;
    const hasAntenna = !!this.bt.getConnected();

    if (pref === 'EXTERNAL') {
      if (!hasAntenna) {
        this.started = false;
        throw this.toTypedError(
          'DEVICE_NOT_FOUND',
          'preferredSource=EXTERNAL but no antenna is connected. Call scanAntennas + connectAntenna first.',
        );
      }
      this.activeSource = 'EXTERNAL_BT';
      return;
    }

    if (pref === 'INTERNAL' || !hasAntenna) {
      this.activeSource = 'WEB_GEOLOC';
      this.geo.start(
        (partial) => this.ingestPartial(partial, 'WEB_GEOLOC'),
        (err) => this.notifyListeners('gnssError', { message: err.message }),
      );
      return;
    }

    // AUTO with antenna connected.
    this.activeSource = 'EXTERNAL_BT';
  }

  async stopGnss(): Promise<void> {
    this.geo.stop();
    this.started = false;
    this.activeSource = null;
    this.centroidBuffer = [];
  }

  async getCurrentFix(): Promise<{ fix: GnssFix | null }> {
    return { fix: this.lastFix };
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private ingestPartial(partial: Partial<GnssFix>, source: FixSource): void {
    if (!this.started) return;
    // When AUTO + BT connected but user wanted INTERNAL, ignore BT updates.
    if (this.options.preferredSource === 'INTERNAL' && source === 'EXTERNAL_BT') return;
    // When BT is active, ignore geolocation updates that may still come in briefly.
    if (this.activeSource === 'EXTERNAL_BT' && source === 'WEB_GEOLOC') return;

    const base: Omit<GnssFix, 'integrityLevel' | 'centroid'> = {
      lat: partial.lat ?? 0,
      lon: partial.lon ?? 0,
      alt: partial.alt ?? 0,
      hAccuracy: partial.hAccuracy ?? 0,
      vAccuracy: partial.vAccuracy ?? 0,
      timestamp: partial.timestamp ?? Date.now(),
      speed: partial.speed,
      bearing: partial.bearing,
      satellitesUsed: partial.satellitesUsed ?? 0,
      satellitesVisible: partial.satellitesVisible ?? 0,
      constellations: partial.constellations ?? ['UNKNOWN'],
      egnosActive: partial.egnosActive ?? false,
      osnmaStatus: partial.osnmaStatus ?? 'NOT_SUPPORTED',
      isMockLocation: partial.isMockLocation ?? false,
      source,
      antenna: partial.antenna,
    };

    // Centroid from last N samples.
    let centroid: GnssFix['centroid'];
    if (this.options.centroidSamples > 0) {
      this.centroidBuffer.push({ lat: base.lat, lon: base.lon });
      if (this.centroidBuffer.length > this.options.centroidSamples) {
        this.centroidBuffer.shift();
      }
      const c = innermostConvexHullCentroid(this.centroidBuffer);
      if (c) {
        centroid = { lat: c.lat, lon: c.lon, samples: this.centroidBuffer.length };
      }
    }

    const integrityLevel = computeIntegrityLevel(base, {
      minAccuracyMeters: this.options.minAccuracyMeters,
      requireOsnma: this.options.requireOsnma,
    });

    const fix: GnssFix = { ...base, integrityLevel, centroid };
    this.lastFix = fix;
    this.activeSource = source;
    this.notifyListeners('gnssUpdate', fix);
  }

  private toTypedError(code: string, message: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
  }
}
