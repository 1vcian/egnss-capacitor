# egnss-capacitor

Universal Capacitor plugin that provides a **single JS/TS API** to read GNSS coordinates from:

- the **internal device GNSS chip** on Android (with [EGNSS4ALL](https://github.com/EGNSS4ALL/EGNSS4ALLAndroid) for OSNMA / EGNOS / multi-constellation) and iOS (`CLLocationManager` + ConvexHull port of [EGNSS4ALL-iOS](https://github.com/EGNSS4ALL/EGNSS4ALL-iOS));
- an **external Bluetooth GNSS antenna** on all three targets (u-blox, Bad Elf, ArduSimple, SparkFun RTK);
- the browser **Geolocation API** as a baseline on the web.

The plugin hides every platform difference: the consumer app calls the same methods, subscribes to the same `gnssUpdate` event, and reads a uniform `GnssFix` object regardless of where the data came from.

> **Status: pre-alpha.** Currently only the public API contract (milestone P1) is in place. All method bodies are stubs; implementation is being built following the [roadmap](../README.md#development-roadmap).

👉 For the day-to-day API reference (every method, every field of `GnssFix`, error codes, recipes) see [**USAGE.md**](./USAGE.md).

---

## Install

Inside your Capacitor app:

```bash
npm install egnss-capacitor
# Or, for local development against a checkout of this repo:
npm install file:../egnss-capacitor
npx cap sync
```

---

## Platform support

| Target                                | Internal GNSS         | External BT antenna |
| ------------------------------------- | --------------------- | ------------------- |
| Android (API 24+)                     | EGNSS4ALL             | BLE + SPP           |
| iOS (14+)                             | CoreLocation + ConvexHull | BLE (GATT)      |
| Web — Chrome / Edge / Opera / Brave   | `navigator.geolocation` | Web Bluetooth     |
| Web — Safari, Firefox, any iOS browser| Not supported         | Not supported       |

Safari (macOS and iOS) and Firefox are **not supported** because they do not implement Web Bluetooth. Use Chrome, Edge, Opera or any Chromium-based browser on desktop / Android, or use the native Capacitor app on iPhone/iPad.

---

## Quick usage

```ts
import { Egnss } from 'egnss-capacitor';

// 1. Inspect the environment.
const cap = await Egnss.checkCapability();
console.log(cap);
// { platform: 'web', hasInternalGnss: true, supportsExternalAntenna: true, ... }

// 2. Ask for permissions.
await Egnss.requestPermissions();

// 3. Optional: connect a Bluetooth antenna.
const devices = await Egnss.scanAntennas({ timeoutMs: 8000 });
if (devices.length > 0) {
  await Egnss.connectAntenna({ deviceId: devices[0].id });
}

// 4. Start streaming fixes.
await Egnss.startGnss({
  preferredSource: 'AUTO',
  minAccuracyMeters: 5,
  centroidSamples: 20,
});

const handle = await Egnss.addListener('gnssUpdate', (fix) => {
  console.log(
    fix.lat, fix.lon, fix.hAccuracy,
    fix.source,           // INTERNAL_GNSS | EXTERNAL_BT | WEB_GEOLOC
    fix.integrityLevel,   // HIGH | STANDARD | LOW | UNTRUSTED
    fix.osnmaStatus,      // OK | KO | UNKNOWN | NOT_SUPPORTED
  );
});

// 5. When done.
await handle.remove();
await Egnss.stopGnss();
```

---

## API reference

The full contract lives in [`src/definitions.ts`](./src/definitions.ts). Highlights:

### `checkCapability(): Promise<Capability>`

Returns what the current platform can do (internal GNSS, Web Bluetooth, OSNMA support, …). Safe to call before `requestPermissions`.

### `requestPermissions(): Promise<PermissionStatus>`

Requests the runtime permissions the plugin needs:

- Android: `ACCESS_FINE_LOCATION`, plus `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` on API 31+.
- iOS: `NSLocationWhenInUseUsageDescription`, `NSBluetoothAlwaysUsageDescription`.
- Web: no-op (browser asks on first `watchPosition`; Bluetooth is chooser-gated).

### `scanAntennas(options?)`, `connectAntenna({deviceId})`, `disconnectAntenna()`, `getConnectedAntenna()`

Manage the pairing with an external Bluetooth antenna. On web, `scanAntennas()` opens the browser's native device chooser (for privacy reasons Chrome does not allow silent BLE scanning).

### `startGnss(options?)`, `stopGnss()`, `getCurrentFix()`

Start / stop the GNSS stream and pull the latest fix synchronously. `startGnss` accepts:

| Option              | Default | Meaning |
| ------------------- | ------- | ------- |
| `preferredSource`   | `AUTO`  | `AUTO` / `INTERNAL` / `EXTERNAL` |
| `minAccuracyMeters` | `10`    | Fixes worse than this are downgraded to `LOW` integrity |
| `centroidSamples`   | `20`    | N samples for innermost-convex-hull centroid |
| `requireOsnma`      | `false` | If `true`, downgrade non-OSNMA fixes to `STANDARD` at most |

### Events

| Event name          | Payload                 |
| ------------------- | ----------------------- |
| `gnssUpdate`        | `GnssFix`               |
| `antennaStatus`     | `AntennaStatusEvent`    |
| `antennaScanResult` | `AntennaDevice`         |

### Integrity levels

The plugin computes an `integrityLevel` for every fix:

| Level     | Meaning |
| --------- | ------- |
| `HIGH`    | Accuracy within threshold AND `osnmaStatus === 'OK'` |
| `STANDARD`| Accuracy within threshold AND (EGNOS active OR external antenna) |
| `LOW`     | Accuracy exceeds `minAccuracyMeters` |
| `UNTRUSTED` | Mock-location provider detected, or OSNMA check failed |

Consumer apps typically enable "take photo" / "submit measurement" only when `integrityLevel` is `HIGH` or `STANDARD`.

---

## Project layout

```
egnss-capacitor/
├── src/                     # TypeScript public API + web implementation + shared utils
│   ├── index.ts
│   ├── definitions.ts
│   ├── web.ts
│   └── shared/              # NMEA parser, convex-hull, integrity rules (used by web)
├── android/                 # Android native plugin (Kotlin)
│   ├── build.gradle
│   ├── libs/                # AAR extracted from EGNSS4ALLAndroid (P5)
│   └── src/main/java/it/demo/egnss/
├── ios/                     # iOS native plugin (Swift)
│   └── Plugin/
├── dist/                    # Built output (generated, git-ignored)
├── EgnssCapacitor.podspec
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Build the TS + bundle
npm install
npm run build

# Watch mode for TS
npm run watch

# Check contract compiles without emitting
npm run lint
```

Changes to the TS API take effect in the consumer app after `npm run build` here plus `npx cap sync` in the consumer.

Native changes (Kotlin / Swift) require a `npx cap sync` in the consumer and a rebuild of the Android or iOS target.

---

## License

MIT. See [`LICENSE`](./LICENSE).

Embeds code derived from the EGNSS4ALL open-source projects. Licensing of the upstream code must be confirmed with the EGNSS4ALL maintainers before public redistribution; see the workspace [`README`](../README.md#licensing-and-third-party-code) for details.
