# `egnss-capacitor` — usage guide

A one-page tour of every method exposed by the plugin and the data you get back.
For the architectural rationale see [`README.md`](./README.md); for a working
end-to-end consumer see [`../demo-app`](../demo-app).

> All three targets (web, Android, iOS) share the same TypeScript contract.
> Methods that cannot be honored on the current platform reject with a typed
> error code from [`EgnssErrorCode`](#error-codes).

---

## TL;DR — "I just want coordinates in my app"

If you remember one thing, it's this: **the plugin is the single named export
`Egnss`**, nothing else. Everything you see in `../demo-app` (the
`GnssController`, the antenna picker modal, the fix panel UI, …) is *demo
code*, not something you import from `egnss-capacitor`. The plugin is
deliberately low-level so you can bolt it to any UI framework.

```ts
import { Egnss } from 'egnss-capacitor';

// 1. Ask the OS for permission (once, ideally behind a user gesture).
await Egnss.requestPermissions();

// 2. Subscribe to position updates BEFORE starting the stream.
const sub = await Egnss.addListener('gnssUpdate', (fix) => {
  // fix is a `GnssFix` — see the shape in the section below.
  console.log(fix.lat, fix.lon, `±${fix.hAccuracy} m`, fix.integrityLevel);
});

// 3. Start the stream. You get fixes every ~1 s until you stop it.
await Egnss.startGnss({ preferredSource: 'AUTO', minAccuracyMeters: 10 });

// …later, when leaving the page / unmounting:
await Egnss.stopGnss();
await sub.remove();
```

That's the whole lifecycle. **Everything the plugin gives you is in one
object, `GnssFix`**, delivered via the `gnssUpdate` event:

| What you want                    | Field on `GnssFix`                         |
| -------------------------------- | ------------------------------------------ |
| Position                         | `lat`, `lon`, `alt`                        |
| How reliable is it               | `hAccuracy`, `vAccuracy` (meters)          |
| When it was measured             | `timestamp` (epoch ms)                     |
| Moving?                          | `speed` (m/s), `bearing` (°)               |
| Which constellations helped      | `satellitesUsed`, `constellations[]`       |
| Trust / anti-spoof               | `integrityLevel`, `osnmaStatus`, `isMockLocation` |
| Where it came from               | `source` (`INTERNAL_GNSS` \| `EXTERNAL_BT` \| `WEB_GEOLOC`) |
| Smoothed position (less jitter)  | `centroid?.lat`, `centroid?.lon`           |
| External antenna info            | `antenna?.name`, `antenna?.id`             |

Full field list and semantics in [`GnssFix`](#gnssfix) below.

### The four plugin methods you'll actually use

| Call                                   | What it does                                               |
| -------------------------------------- | ---------------------------------------------------------- |
| `Egnss.checkCapability()`              | Feature-detect the current device/browser (no side effects). |
| `Egnss.requestPermissions()`           | OS prompts (location + Bluetooth).                         |
| `Egnss.startGnss(opts)` / `stopGnss()` | Turn the stream on / off.                                  |
| `Egnss.addListener('gnssUpdate', cb)`  | Receive every `GnssFix`.                                   |

Optional (only if you want an external Bluetooth receiver for higher precision
/ OSNMA): `scanAntennas`, `connectAntenna`, `disconnectAntenna`,
`getConnectedAntenna`, plus the `antennaStatus` / `antennaScanResult` events.

### Vanilla JS (no bundler) works too

The demo app is plain HTML + JS. As long as you have a Capacitor project with
the plugin installed and synced (`npx cap sync`), the same import works:

```js
// from an ES module in vanilla JS
import { Egnss } from 'egnss-capacitor';
```

No React / Vue / framework required — we proved it in `../demo-app`.

---

## Plugin vs. demo-app — what's reusable and what isn't

| Lives in                                      | Part of the plugin? | Notes                                                   |
| --------------------------------------------- | ------------------- | ------------------------------------------------------- |
| `egnss-capacitor/src/**` (the `Egnss` object) | ✅ yes              | This is the only thing you `npm install`.               |
| `demo-app/src/gnss/gnss-controller.js`        | ❌ demo only        | Reactive wrapper (state + EventTarget). Copy if useful. |
| `demo-app/src/gnss/antenna-heuristic.js`      | ❌ demo only        | Name-based "likely GNSS" classifier for the picker.     |
| `demo-app/src/ui/antenna-picker.js`           | ❌ demo only        | Modal to pick the right Bluetooth device.               |
| `demo-app/src/ui/fix-panel.js`                | ❌ demo only        | Details panel rendering a `GnssFix`.                    |
| `demo-app/src/gnss/integrity-explain.js`      | ❌ demo only        | Human-readable reason for `integrityLevel`.             |

The plugin stays intentionally small and UI-free. The demo app is your menu
of optional building blocks — copy the files you like into your own project
and adapt them.

### Optional: the "reactive controller" pattern

If you want the convenience of `demo-app/src/gnss/gnss-controller.js` in your
own app (single source of truth, same events everywhere, less boilerplate
when you have more than one component), here is the minimal version you can
paste as-is:

```ts
import { Egnss, type GnssFix, type AntennaStatusEvent, type Capability } from 'egnss-capacitor';

export class GnssController extends EventTarget {
  capability: Capability | null = null;
  lastFix: GnssFix | null = null;
  antenna: AntennaStatusEvent['device'] | null = null;
  started = false;
  private handles: Array<{ remove: () => Promise<void> }> = [];

  async init() {
    this.capability = await Egnss.checkCapability();
    this.handles.push(await Egnss.addListener('gnssUpdate', (fix) => {
      const first = this.lastFix === null;
      this.lastFix = fix;
      if (first) this.dispatchEvent(new CustomEvent('firstFix', { detail: fix }));
      this.dispatchEvent(new CustomEvent('fix', { detail: fix }));
    }));
    this.handles.push(await Egnss.addListener('antennaStatus', (s) => {
      this.antenna = s.connected ? s.device ?? null : null;
      this.dispatchEvent(new CustomEvent('antenna', { detail: s }));
    }));
  }

  async start(opts = {}) {
    if (this.started) return;
    await Egnss.requestPermissions();
    await Egnss.startGnss({ preferredSource: 'AUTO', minAccuracyMeters: 10, ...opts });
    this.started = true;
  }

  async stop() {
    if (!this.started) return;
    await Egnss.stopGnss();
    this.started = false;
    this.lastFix = null;
  }

  async destroy() {
    for (const h of this.handles) await h.remove().catch(() => {});
    this.handles = [];
    if (this.started) await this.stop();
  }
}
```

Use it:

```ts
const gnss = new GnssController();
await gnss.init();
gnss.addEventListener('fix', (e) => console.log((e as CustomEvent<GnssFix>).detail));
await gnss.start();
```

The production version in `demo-app/src/gnss/gnss-controller.js` adds:

- a `state` event (`idle` | `starting` | `waiting` | `active` | `error`) so
  buttons can drive their spinners off a single stream,
- `startAntennaScan()` / `connectAntenna(id)` helpers that power the picker
  without auto-connecting to the first discovered device,
- a stored copy of the last `startGnss` options so integrity explanations
  know which thresholds were in effect.

Look at it if you want a head start on a real UI, but you are never required
to use it — the plugin works fine standalone.

---

## Install

Inside your Capacitor app:

```bash
npm install egnss-capacitor        # or: file:../egnss-capacitor in monorepo setups
npx cap sync
```

Permissions already declared by the plugin (you just surface them to the user):

| Platform | Permissions                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------- |
| Android  | `ACCESS_FINE_LOCATION`, `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (API 31+)                           |
| iOS      | `NSLocationWhenInUseUsageDescription`, `NSBluetoothAlwaysUsageDescription`                        |
| Web      | Granted at runtime via the browser's permission / device-chooser dialogs. Chromium browsers only. |

---

## The 30-second example

```ts
import { Egnss } from 'egnss-capacitor';

const cap = await Egnss.checkCapability();
console.log(cap);
// { platform: 'android', hasInternalGnss: true, supportsRawGnss: true,
//   supportsOsnmaInternal: false, supportsExternalAntenna: true,
//   bluetoothAvailable: true }

await Egnss.requestPermissions();

const sub = await Egnss.addListener('gnssUpdate', (fix) => {
  console.log('fix', fix.lat, fix.lon, `±${fix.hAccuracy}m`, fix.integrityLevel);
});

await Egnss.startGnss({ preferredSource: 'AUTO', minAccuracyMeters: 10 });

// …later
await Egnss.stopGnss();
await sub.remove();
```

---

## API reference

Every snippet below is a real return shape — not psuedo-code.

### `checkCapability()`

Probe what the current device / browser can do **before** you touch anything
else. Safe to call at any time.

```ts
const cap = await Egnss.checkCapability();
```

Resolves with:

```ts
interface Capability {
  platform: 'android' | 'ios' | 'web';
  hasInternalGnss: boolean;           // device has a GNSS chip / geoloc API
  supportsRawGnss: boolean;           // Android N+ only, else false
  supportsOsnmaInternal: boolean;     // Android with EGNSS4ALL AAR; false elsewhere
  supportsExternalAntenna: boolean;   // BT stack is usable on this target
  bluetoothAvailable: boolean;        // BT radio ON + permissions granted right now
}
```

**Use it to gate your UI** — for example hide the "Pair antenna" button on an
iPhone with Bluetooth turned off.

---

### `requestPermissions()`

Triggers the OS-level permission prompts in the right order. On the web this is
a no-op for Bluetooth (the chooser asks at scan time) but still requests
geolocation. Idempotent.

```ts
const p = await Egnss.requestPermissions();
```

Resolves with:

```ts
interface PermissionStatus {
  location:  'granted' | 'denied' | 'prompt';
  bluetooth: 'granted' | 'denied' | 'prompt' | 'not_required';
}
```

Android < 12 returns `bluetooth: 'not_required'` (legacy permission model).

---

### `startGnss(options?)`

Begins emitting `gnssUpdate` events. Must be followed by a matching
`stopGnss()`. Calling it twice rejects with `ALREADY_STARTED`.

```ts
await Egnss.startGnss({
  preferredSource: 'AUTO',      // default — pick external BT if connected, else internal
  minAccuracyMeters: 10,        // accuracy threshold used to tag integrity
  centroidSamples: 20,          // convex-hull buffer size; 0 disables the centroid
  requireOsnma: false,          // if true, integrity caps at STANDARD without OSNMA OK
});
```

```ts
type PreferredSource = 'AUTO' | 'INTERNAL' | 'EXTERNAL';
interface StartOptions {
  preferredSource?: PreferredSource;
  minAccuracyMeters?: number;
  centroidSamples?: number;
  requireOsnma?: boolean;
}
```

---

### `stopGnss()`

Stops the stream and frees the radio / geolocation subscription. Safe to call
when already stopped.

```ts
await Egnss.stopGnss();
```

---

### `getCurrentFix()`

Synchronous pull of the most recent fix. Useful right before taking an action
that needs a position (like saving a geotagged photo).

```ts
const { fix } = await Egnss.getCurrentFix();
if (fix) {
  console.log(fix.lat, fix.lon);
}
```

Resolves with:

```ts
{ fix: GnssFix | null }
```

---

### `scanAntennas(options?)`

Looks for external Bluetooth GNSS receivers.

- **Web**: opens the browser's device chooser. The returned `devices` array
  contains the user's choice (1 element) or is empty if they cancelled.
- **Android / iOS**: scans for `timeoutMs` milliseconds, emits each discovery
  live via `antennaScanResult`, and resolves with the complete list once the
  scan finishes.

```ts
const { devices } = await Egnss.scanAntennas({ timeoutMs: 8000 });
```

```ts
interface ScanOptions { timeoutMs?: number }   // default: 8000
interface AntennaDevice {
  id: string;        // MAC on Android, CBPeripheral UUID on iOS, Web Bluetooth id on web
  name: string;
  rssi?: number;     // dBm, only populated from a BLE scan
  isConnected: boolean;
}
```

You'll typically also subscribe to `antennaScanResult` for a progressive list:

```ts
const progress = await Egnss.addListener('antennaScanResult', (d) => {
  console.log('discovered', d.name, d.rssi);
});
const { devices } = await Egnss.scanAntennas({ timeoutMs: 8000 });
await progress.remove();
```

---

### `connectAntenna({ deviceId })`

Connects to a previously scanned receiver. Rejects with `DEVICE_NOT_FOUND` if
the id is unknown (always scan first, or cache the id between sessions — on
iOS `retrievePeripherals(withIdentifiers:)` is used under the hood).

```ts
await Egnss.connectAntenna({ deviceId: devices[0].id });
```

The final outcome is reported via the `antennaStatus` event:

```ts
await Egnss.addListener('antennaStatus', (s) => {
  console.log(s.connected, s.device?.name, s.error);
});
```

---

### `disconnectAntenna()`

Tear down the BT connection. Fires an `antennaStatus { connected: false }`.

```ts
await Egnss.disconnectAntenna();
```

---

### `getConnectedAntenna()`

Returns the currently connected antenna (if any) without re-scanning.

```ts
const { device } = await Egnss.getConnectedAntenna();
```

Resolves with `{ device: AntennaDevice | null }`.

---

## Events

Subscribe with `Egnss.addListener(name, cb)`; unsubscribe with `.remove()` on
the returned handle. Don't forget to remove listeners on page teardown.

| Event                | Payload                     | When it fires                                                                                                               |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `gnssUpdate`         | [`GnssFix`](#gnssfix)       | Every throttled position update (internal, external or web).                                                                |
| `antennaStatus`      | `AntennaStatusEvent`        | On connect, disconnect, or connection failure of the external antenna.                                                      |
| `antennaScanResult`  | `AntennaDevice`             | Each time a device is discovered during `scanAntennas`; on web it fires once with the chooser's selection.                  |

### `AntennaStatusEvent`

```ts
interface AntennaStatusEvent {
  connected: boolean;
  device?: AntennaDevice;
  error?: string;
}
```

---

## `GnssFix`

The single most important type: every position update conforms to this shape
regardless of the source.

```ts
interface GnssFix {
  lat: number;                  // decimal degrees, WGS84
  lon: number;                  // decimal degrees, WGS84
  alt: number;                  // meters above the WGS84 ellipsoid
  hAccuracy: number;            // horizontal accuracy (68% CEP), meters
  vAccuracy: number;            // vertical accuracy, meters; 0 = unknown
  timestamp: number;            // epoch ms

  speed?:   number;             // m/s
  bearing?: number;             // degrees from true north (0..360)

  satellitesUsed:    number;
  satellitesVisible: number;
  constellations: Array<
    'GPS' | 'GALILEO' | 'GLONASS' | 'BEIDOU' | 'QZSS' | 'SBAS' | 'IRNSS' | 'UNKNOWN'
  >;

  egnosActive: boolean;         // GGA quality flag == 2 (SBAS/EGNOS correction)
  osnmaStatus: 'OK' | 'KO' | 'UNKNOWN' | 'NOT_SUPPORTED';
  isMockLocation: boolean;      // platform-reported mock/spoof provider

  source: 'INTERNAL_GNSS' | 'EXTERNAL_BT' | 'WEB_GEOLOC';
  integrityLevel: 'HIGH' | 'STANDARD' | 'LOW' | 'UNTRUSTED';

  centroid?: {                  // when centroidSamples > 0
    lat: number;
    lon: number;
    samples: number;
  };

  antenna?: {                   // present when source === 'EXTERNAL_BT'
    id: string;
    name: string;
    rssi?: number;
  };
}
```

### Integrity level — how it is computed

Applied in this order (first match wins):

1. `isMockLocation === true` → `UNTRUSTED`
2. `osnmaStatus === 'KO'` → `UNTRUSTED`
3. `hAccuracy > minAccuracyMeters` → `LOW`
4. `osnmaStatus === 'OK'` → `HIGH`
5. `egnosActive === true` OR `source === 'EXTERNAL_BT'` → `STANDARD`
6. otherwise → `STANDARD`

When you pass `requireOsnma: true`, step 5/6 cap at `STANDARD` until an
OSNMA-authenticated fix arrives.

The same rules are implemented three times (TS, Kotlin, Swift) on purpose:
keeps the integrity label **stable across refactors** of any individual
backend. See `src/shared/integrity.ts` / `android/.../Integrity.kt` /
`ios/Plugin/Integrity.swift`.

### Convex-hull centroid

When `centroidSamples > 0` the plugin keeps a sliding window of the last N raw
points and emits `centroid` with the **centroid of their convex hull**. This
filters stray outliers while remaining robust to multi-path drift, at the
cost of a short lag (≈ `N / fix rate` seconds).

Useful when you want to drop a marker that "settles" instead of twitching with
every sample.

---

## Error codes

Every reject includes a stable `code` field:

| Code                     | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `UNSUPPORTED`            | The feature is not available on this platform / browser.                    |
| `PERMISSION_DENIED`      | The user denied a required runtime permission.                              |
| `BLUETOOTH_UNAVAILABLE`  | BT radio is off, missing, or the app lacks the required BT permissions.    |
| `DEVICE_NOT_FOUND`       | `connectAntenna` got a `deviceId` that was never scanned / retrieved.       |
| `CONNECTION_LOST`        | The antenna disconnected mid-stream (fired through `antennaStatus.error`).  |
| `ALREADY_STARTED`        | `startGnss` was called twice without a `stopGnss` in between.               |
| `NOT_STARTED`            | A method that requires a running stream was called before `startGnss`.     |
| `NOT_IMPLEMENTED`        | Placeholder; should never appear in 0.1+ outside of early milestones.       |

```ts
try {
  await Egnss.startGnss();
} catch (e) {
  if (e.code === 'PERMISSION_DENIED') { /* explain to the user */ }
  if (e.code === 'ALREADY_STARTED')   { /* ignore or log */ }
}
```

---

## Typical recipes

### 1. Live tracking on a map

```ts
await Egnss.requestPermissions();
await Egnss.startGnss({ minAccuracyMeters: 10, centroidSamples: 20 });
Egnss.addListener('gnssUpdate', (fix) => {
  mapMarker.setLngLat([fix.lon, fix.lat]);
  if (fix.centroid) centroidMarker.setLngLat([fix.centroid.lon, fix.centroid.lat]);
});
```

### 2. Gate a sensitive action behind integrity

```ts
const { fix } = await Egnss.getCurrentFix();
if (!fix) return toast('No fix yet');
if (fix.integrityLevel === 'UNTRUSTED') return toast('Possible spoofing');
if (fix.integrityLevel === 'LOW')       return toast(`Too inaccurate: ±${fix.hAccuracy} m`);
await savePhotoAt(fix);
```

### 3. Connect an external antenna and prefer it

```ts
const progress = await Egnss.addListener('antennaScanResult', (d) => refreshPicker(d));
const { devices } = await Egnss.scanAntennas({ timeoutMs: 6000 });
await progress.remove();

if (!devices.length) return toast('No antenna found');

await Egnss.connectAntenna({ deviceId: devices[0].id });
// Future fixes will have source === 'EXTERNAL_BT' automatically.
await Egnss.startGnss({ preferredSource: 'AUTO' });
```

---

## Platform quirks cheat sheet

| Concern                          | Android                                       | iOS                                         | Web                                          |
| -------------------------------- | --------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| OSNMA on the internal chip       | Requires EGNSS4ALL AAR drop-in                | Not exposed by CoreLocation                 | Not exposed by browsers                      |
| Classic SPP Bluetooth            | ✅ Paired device list auto-discovered         | ❌ Needs MFi cert per device (not possible) | ❌ Only BLE                                  |
| BLE UART (Nordic NUS)            | ✅                                            | ✅                                          | ✅ (Chromium)                                |
| Raw `GnssMeasurement` / NMEA     | ✅ since Android N                            | ❌                                          | ❌                                           |
| Mock-location detection          | ✅ `isFromMockProvider()`                     | ⚠ heuristic only                           | ❌                                           |
| Needed browser                   | —                                             | —                                           | Chromium (Chrome / Edge / Opera / Brave)     |

Safari and Firefox are explicitly unsupported on the web target; they lack
Web Bluetooth entirely.

---

## Tear-down checklist

To avoid leaking the radio when the page/activity closes:

```ts
await Egnss.stopGnss();
await Egnss.disconnectAntenna();      // safe even if no antenna is connected
await Egnss.removeAllListeners();
```

In `demo-app` this lives in `controller.destroy()` (wired to `pagehide`).
