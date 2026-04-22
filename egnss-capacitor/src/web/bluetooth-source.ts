import type { AntennaDevice, Constellation, GnssFix } from '../definitions';
import { parseNmeaSentence, splitNmeaStream } from '../shared/nmea-parser';

/**
 * Common BLE services exposed by consumer GNSS receivers.
 *
 * 1. **Nordic UART Service (NUS)** — used by most generic BLE GNSS
 *    receivers to stream NMEA as raw bytes (SparkFun RTK, ArduSimple BLE,
 *    many custom ESP32 adapters).
 * 2. **Serial Port over BLE (SPBLE)** — Bad Elf and a few others.
 *
 * We request both by default; the browser picks whichever the device advertises.
 */
const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BAD_ELF_SERVICE = '00001101-0000-1000-8000-00805f9b34fb';

export const SUPPORTED_GNSS_SERVICES = [NORDIC_UART_SERVICE, BAD_ELF_SERVICE];

/**
 * Minimal shape we need from the Web Bluetooth types; declaring it
 * locally avoids pulling `@types/web-bluetooth` as a dependency.
 */
interface WBDevice {
  id: string;
  name?: string;
  gatt?: {
    connected: boolean;
    connect(): Promise<WBServer>;
    disconnect(): void;
  };
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}
interface WBServer {
  getPrimaryService(uuid: string): Promise<WBService>;
  getPrimaryServices(): Promise<WBService[]>;
}
interface WBService {
  uuid: string;
  getCharacteristics(): Promise<WBCharacteristic[]>;
}
interface WBCharacteristic {
  uuid: string;
  properties: { notify: boolean; read: boolean };
  startNotifications(): Promise<WBCharacteristic>;
  stopNotifications(): Promise<WBCharacteristic>;
  addEventListener(type: 'characteristicvaluechanged', listener: (e: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (e: Event) => void): void;
  value?: DataView;
}
interface WBNavigator {
  bluetooth: {
    requestDevice(opts: {
      acceptAllDevices?: boolean;
      filters?: Array<{ services?: string[]; namePrefix?: string }>;
      optionalServices?: string[];
    }): Promise<WBDevice>;
  };
}

export class BluetoothSource {
  private device: WBDevice | null = null;
  private characteristic: WBCharacteristic | null = null;
  private carryBuffer = '';
  private decoder = new TextDecoder('utf-8');

  /** Track the last GGA/RMC so we only emit when position is fresh. */
  private lastGga: ReturnType<typeof parseNmeaSentence> | null = null;
  private lastEmitTs = 0;
  private onDisconnectCallback: (() => void) | null = null;
  private onFixCallback: ((f: Partial<GnssFix>) => void) | null = null;

  /** Ask the browser to show the device chooser. Returns 1 device or [] if the user cancels. */
  async requestDevice(): Promise<AntennaDevice[]> {
    const nav = (globalThis.navigator ?? {}) as unknown as WBNavigator;
    if (!('bluetooth' in (globalThis.navigator ?? {}))) {
      throw Object.assign(new Error('Web Bluetooth not available'), { code: 'UNSUPPORTED' });
    }
    try {
      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: SUPPORTED_GNSS_SERVICES,
      });
      return [
        {
          id: device.id,
          name: device.name ?? 'Unknown GNSS device',
          isConnected: device.gatt?.connected ?? false,
        },
      ];
    } catch (err) {
      // User cancelled → empty list. Any other error propagates.
      if ((err as Error).name === 'NotFoundError') return [];
      throw err;
    }
  }

  /**
   * Connect to the previously-selected device (the browser caches the selection
   * inside the `WBDevice` we resolved from requestDevice). For simplicity we
   * re-use whatever device the last requestDevice call returned: the demo-app
   * passes the same device object back through `deviceId`.
   *
   * Because the JS bridge only transports `deviceId` (string), we ask the
   * browser again to reveal the device when needed.
   */
  async connect(): Promise<AntennaDevice> {
    if (!this.device) {
      // We don't have a cached reference; the caller must have called
      // requestDevice first. Re-prompt with the same filters.
      const nav = (globalThis.navigator ?? {}) as unknown as WBNavigator;
      this.device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: SUPPORTED_GNSS_SERVICES,
      });
    }
    if (!this.device.gatt) {
      throw new Error('Device has no GATT server');
    }

    const server = await this.device.gatt.connect();
    const services = await server.getPrimaryServices();

    let rxChar: WBCharacteristic | null = null;
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const c of chars) {
        if (c.properties.notify) {
          rxChar = c;
          break;
        }
      }
      if (rxChar) break;
    }

    if (!rxChar) {
      throw Object.assign(new Error('No notify characteristic found on device'), {
        code: 'UNSUPPORTED',
      });
    }

    this.characteristic = rxChar;
    await rxChar.startNotifications();
    rxChar.addEventListener('characteristicvaluechanged', this.handleValue);
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);

    return {
      id: this.device.id,
      name: this.device.name ?? 'GNSS device',
      isConnected: true,
    };
  }

  async disconnect(): Promise<void> {
    try {
      if (this.characteristic) {
        this.characteristic.removeEventListener('characteristicvaluechanged', this.handleValue);
        await this.characteristic.stopNotifications().catch(() => {});
      }
    } finally {
      this.characteristic = null;
      if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
      this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
      this.device = null;
      this.carryBuffer = '';
    }
  }

  getConnected(): AntennaDevice | null {
    if (!this.device?.gatt?.connected) return null;
    return {
      id: this.device.id,
      name: this.device.name ?? 'GNSS device',
      isConnected: true,
    };
  }

  onFix(cb: (f: Partial<GnssFix>) => void): void {
    this.onFixCallback = cb;
  }

  onDisconnect(cb: () => void): void {
    this.onDisconnectCallback = cb;
  }

  // --- internal event handlers ---

  private handleDisconnect = (): void => {
    this.characteristic = null;
    this.onDisconnectCallback?.();
  };

  private handleValue = (event: Event): void => {
    const target = event.target as unknown as WBCharacteristic;
    const value = target.value;
    if (!value) return;

    const chunk = this.decoder.decode(value.buffer);
    const { sentences, carry } = splitNmeaStream(chunk, this.carryBuffer);
    this.carryBuffer = carry;

    let gga: ReturnType<typeof parseNmeaSentence> | null = null;
    let rmc: ReturnType<typeof parseNmeaSentence> | null = null;
    let gsa: ReturnType<typeof parseNmeaSentence> | null = null;
    const constellationSet = new Set<Constellation>();

    for (const raw of sentences) {
      const parsed = parseNmeaSentence(raw);
      if (!parsed) continue;
      if (parsed.type === 'GGA') gga = parsed;
      else if (parsed.type === 'RMC') rmc = parsed;
      else if (parsed.type === 'GSA') gsa = parsed;
      else if (parsed.type === 'GSV') constellationSet.add(parsed.data.talker);
    }

    // Emit at most once per 500 ms, and only when we have a fresh position.
    const now = Date.now();
    const freshGga = gga && gga.type === 'GGA' && gga.data.fixQuality > 0;
    if (freshGga && now - this.lastEmitTs > 400) {
      this.lastEmitTs = now;
      this.lastGga = gga;
      this.emit(gga, rmc, gsa, [...constellationSet]);
    } else if (!freshGga && rmc && rmc.type === 'RMC' && rmc.data.active && this.lastGga) {
      // Fall back to last GGA + new RMC (for speed/bearing).
      this.emit(this.lastGga, rmc, gsa, [...constellationSet]);
    }
  };

  private emit(
    gga: ReturnType<typeof parseNmeaSentence>,
    rmc: ReturnType<typeof parseNmeaSentence>,
    gsa: ReturnType<typeof parseNmeaSentence>,
    constellations: Constellation[],
  ): void {
    if (!gga || gga.type !== 'GGA') return;

    const hdop = gsa?.type === 'GSA' ? gsa.data.hdop : gga.data.hdop;
    // Rough horizontal accuracy estimate: HDOP * UERE (User-Equivalent Range Error).
    // 4 m UERE is a conservative civilian GPS value; when EGNOS is active we
    // halve it; when in RTK we drop it to 10 cm. This keeps accuracy roughly
    // aligned with what the device reports natively.
    let uere = 4;
    if (gga.data.fixQuality === 2) uere = 2;
    else if (gga.data.fixQuality === 4) uere = 0.1;
    else if (gga.data.fixQuality === 5) uere = 0.5;
    const hAccuracy = hdop > 0 ? hdop * uere : 4;

    const partial: Partial<GnssFix> = {
      lat: gga.data.latitude,
      lon: gga.data.longitude,
      alt: gga.data.altitude,
      hAccuracy,
      vAccuracy: 0,
      timestamp: Date.now(),
      speed: rmc && rmc.type === 'RMC' ? rmc.data.speed : undefined,
      bearing: rmc && rmc.type === 'RMC' ? rmc.data.bearing : undefined,
      satellitesUsed: gga.data.satellites,
      satellitesVisible: gga.data.satellites, // best effort from GGA
      constellations: constellations.length > 0 ? constellations : ['UNKNOWN'],
      egnosActive: gga.data.fixQuality === 2,
      osnmaStatus: 'UNKNOWN',
      isMockLocation: false,
      source: 'EXTERNAL_BT',
      antenna: this.device
        ? { id: this.device.id, name: this.device.name ?? 'GNSS device' }
        : undefined,
    };

    this.onFixCallback?.(partial);
  }
}
