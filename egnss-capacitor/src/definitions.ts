import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Known GNSS constellations. The plugin emits a constellation tag
 * for each visible / used satellite when the platform exposes it.
 */
export type Constellation = 'GPS' | 'GALILEO' | 'GLONASS' | 'BEIDOU' | 'QZSS' | 'SBAS' | 'IRNSS' | 'UNKNOWN';

/**
 * Where a fix is currently coming from.
 *
 * - INTERNAL_GNSS: on-device GNSS chip (Android LocationManager / iOS CLLocationManager).
 * - EXTERNAL_BT:   paired Bluetooth GNSS antenna (preferred when connected).
 * - WEB_GEOLOC:    browser `navigator.geolocation` API (web target only).
 */
export type FixSource = 'INTERNAL_GNSS' | 'EXTERNAL_BT' | 'WEB_GEOLOC';

/**
 * Preferred GNSS source when calling {@link EgnssPlugin.startGnss}.
 *
 * - AUTO (default): prefer EXTERNAL_BT if an antenna is connected, else internal, else web.
 * - INTERNAL:       force on-device chip; errors on web if no geolocation.
 * - EXTERNAL:       force external antenna; errors if none connected.
 */
export type PreferredSource = 'AUTO' | 'INTERNAL' | 'EXTERNAL';

/**
 * Status of Galileo OSNMA authentication.
 *
 * - OK:             the current fix has been authenticated by OSNMA.
 * - KO:             OSNMA data was received but authentication failed (possible spoofing).
 * - UNKNOWN:        OSNMA capable, but not enough data yet to decide.
 * - NOT_SUPPORTED:  hardware/platform cannot provide OSNMA (iOS internal, old Android chipsets, web).
 */
export type OsnmaStatus = 'OK' | 'KO' | 'UNKNOWN' | 'NOT_SUPPORTED';

/**
 * Integrity label computed locally by the plugin from the raw fix data.
 * The app uses this to decide whether the fix is trustworthy enough
 * to, for example, take a geotagged photo.
 *
 * - HIGH:       OSNMA OK AND horizontal accuracy within threshold.
 * - STANDARD:   EGNOS active or external antenna AND accuracy within threshold.
 * - LOW:        accuracy exceeds the configured threshold.
 * - UNTRUSTED:  mock-location detected or signature/integrity check failed.
 */
export type IntegrityLevel = 'HIGH' | 'STANDARD' | 'LOW' | 'UNTRUSTED';

/** A single position fix emitted by the plugin. */
export interface GnssFix {
  /** Latitude in decimal degrees, WGS84. */
  lat: number;
  /** Longitude in decimal degrees, WGS84. */
  lon: number;
  /** Altitude above the WGS84 ellipsoid, in meters. */
  alt: number;
  /** Horizontal accuracy, radius of ~68 % confidence, in meters. */
  hAccuracy: number;
  /** Vertical accuracy in meters, or `0` if unknown. */
  vAccuracy: number;
  /** Epoch time in milliseconds. */
  timestamp: number;
  /** Ground speed in m/s, if available. */
  speed?: number;
  /** Heading in degrees from true north (0–360), if available. */
  bearing?: number;
  /** Number of satellites actively used in this fix. */
  satellitesUsed: number;
  /** Number of satellites currently visible (tracked). */
  satellitesVisible: number;
  /** Distinct constellations contributing to the fix. */
  constellations: Constellation[];
  /** `true` when EGNOS / SBAS corrections are being applied (GGA quality = 2). */
  egnosActive: boolean;
  /** Current OSNMA authentication status; see {@link OsnmaStatus}. */
  osnmaStatus: OsnmaStatus;
  /** `true` when the platform reports the fix came from a mock-location provider. */
  isMockLocation: boolean;
  /** Source that produced the fix; see {@link FixSource}. */
  source: FixSource;
  /** Local trust label; see {@link IntegrityLevel}. */
  integrityLevel: IntegrityLevel;
  /** Optional convex-hull centroid computed from the last N samples, if enabled. */
  centroid?: {
    lat: number;
    lon: number;
    /** How many raw samples contributed to the centroid. */
    samples: number;
  };
  /** Info about the external antenna emitting the fix, when `source === 'EXTERNAL_BT'`. */
  antenna?: {
    id: string;
    name: string;
    rssi?: number;
  };
}

/** Result of {@link EgnssPlugin.checkCapability}. */
export interface Capability {
  /** Which runtime we are on. */
  platform: 'android' | 'ios' | 'web';
  /** Whether any on-device GNSS / geolocation is available. */
  hasInternalGnss: boolean;
  /** Android-only: the chip exposes raw `GnssMeasurement` data. */
  supportsRawGnss: boolean;
  /** Whether OSNMA authentication can be provided by the internal chip. */
  supportsOsnmaInternal: boolean;
  /** Whether the external Bluetooth antenna path is usable (BT stack + permissions). */
  supportsExternalAntenna: boolean;
  /** Whether Bluetooth hardware is currently powered on and permissions granted. */
  bluetoothAvailable: boolean;
}

/** Result of {@link EgnssPlugin.requestPermissions}. */
export interface PermissionStatus {
  location: 'granted' | 'denied' | 'prompt';
  bluetooth: 'granted' | 'denied' | 'prompt' | 'not_required';
}

/** A Bluetooth GNSS antenna detected during a scan. */
export interface AntennaDevice {
  /**
   * Platform-stable identifier:
   * - Android: MAC address.
   * - iOS:     `CBPeripheral.identifier` (UUID).
   * - Web:     `BluetoothDevice.id` (UUID).
   */
  id: string;
  /** Advertised name of the device. */
  name: string;
  /** Signal strength at scan time, in dBm, when available. */
  rssi?: number;
  /** Whether we currently hold a live connection to this device. */
  isConnected: boolean;
}

/** Options accepted by {@link EgnssPlugin.startGnss}. */
export interface StartOptions {
  /** Which source to prefer. Defaults to `'AUTO'`. */
  preferredSource?: PreferredSource;
  /**
   * Horizontal accuracy threshold in meters used to compute
   * {@link IntegrityLevel}. Fixes worse than this are flagged LOW.
   * Default: `10`.
   */
  minAccuracyMeters?: number;
  /**
   * Number of samples fed into the innermost-convex-hull centroid.
   * Default: `20`. Set to `0` to disable centroid computation.
   */
  centroidSamples?: number;
  /**
   * When `true`, fixes that do not have `osnmaStatus === 'OK'` are
   * downgraded to at most STANDARD integrity. Default: `false`.
   */
  requireOsnma?: boolean;
}

/** Options for {@link EgnssPlugin.scanAntennas}. */
export interface ScanOptions {
  /** Scan timeout in milliseconds. Default: `8000`. */
  timeoutMs?: number;
}

/** Payload of the `antennaStatus` event. */
export interface AntennaStatusEvent {
  connected: boolean;
  device?: AntennaDevice;
  error?: string;
}

/**
 * Public contract of the Egnss plugin.
 *
 * Every method has the same shape on Android, iOS, and Web.
 * When a platform cannot honor a request (for instance, connecting
 * an antenna from iOS Safari), the call rejects with a typed error
 * whose `code` field belongs to {@link EgnssErrorCode}.
 */
export interface EgnssPlugin {
  /** Query what the current platform can do before calling anything else. */
  checkCapability(): Promise<Capability>;

  /**
   * Request runtime permissions required by the plugin.
   * On web, this resolves immediately with `'not_required'` for bluetooth.
   */
  requestPermissions(): Promise<PermissionStatus>;

  // --- External Bluetooth antenna -----------------------------------------

  /**
   * Scan for nearby Bluetooth GNSS antennas.
   *
   * On web, this opens the browser's native device chooser (Chrome) and
   * resolves with the single selected device (or an empty array if the
   * user cancelled).
   *
   * On Android and iOS, the plugin runs a background scan for up to
   * `options.timeoutMs` milliseconds and resolves with every device it
   * discovered. During the scan, each result is also emitted as an
   * `antennaScanResult` event so the UI can update progressively.
   */
  scanAntennas(options?: ScanOptions): Promise<{ devices: AntennaDevice[] }>;

  /** Connect to an antenna previously returned by {@link scanAntennas}. */
  connectAntenna(options: { deviceId: string }): Promise<void>;

  /** Disconnect the current antenna, if any. */
  disconnectAntenna(): Promise<void>;

  /** Return the currently connected antenna, or `null`. */
  getConnectedAntenna(): Promise<{ device: AntennaDevice | null }>;

  // --- GNSS streaming ------------------------------------------------------

  /** Start producing `gnssUpdate` events. */
  startGnss(options?: StartOptions): Promise<void>;

  /** Stop the current GNSS stream. */
  stopGnss(): Promise<void>;

  /** Pull the most recent fix synchronously, or `null` if none yet. */
  getCurrentFix(): Promise<{ fix: GnssFix | null }>;

  // --- Events --------------------------------------------------------------

  /** A new GNSS fix is available. */
  addListener(
    eventName: 'gnssUpdate',
    listenerFunc: (fix: GnssFix) => void,
  ): Promise<PluginListenerHandle>;

  /** The connection state of the external antenna changed. */
  addListener(
    eventName: 'antennaStatus',
    listenerFunc: (status: AntennaStatusEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** A device was discovered while scanning. */
  addListener(
    eventName: 'antennaScanResult',
    listenerFunc: (device: AntennaDevice) => void,
  ): Promise<PluginListenerHandle>;

  /** Remove all listeners registered on this plugin instance. */
  removeAllListeners(): Promise<void>;
}

/** Error codes rejected by the plugin methods. */
export const EgnssErrorCode = {
  /** The feature is not available on the current platform / browser. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** A required runtime permission was denied by the user. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Bluetooth hardware is off or inaccessible. */
  BLUETOOTH_UNAVAILABLE: 'BLUETOOTH_UNAVAILABLE',
  /** `connectAntenna` was called but no matching device was found. */
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  /** The connection to the external antenna was lost. */
  CONNECTION_LOST: 'CONNECTION_LOST',
  /** `startGnss` was called twice without a `stopGnss` in between. */
  ALREADY_STARTED: 'ALREADY_STARTED',
  /** A call that requires a running stream was made before `startGnss`. */
  NOT_STARTED: 'NOT_STARTED',
  /** Placeholder returned by stubbed methods during early milestones. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type EgnssErrorCode = (typeof EgnssErrorCode)[keyof typeof EgnssErrorCode];
