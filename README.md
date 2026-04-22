# demoPosition — universal GNSS Capacitor plugin + showcase app

This workspace contains **two independent packages**:

1. **[`egnss-capacitor/`](./egnss-capacitor)** — the actual product: a **universal Capacitor plugin** that exposes a single JS/TS API to read GNSS coordinates from:
   - the **internal device GNSS** on Android and iOS (powered by the open-source [EGNSS4ALL](https://github.com/EGNSS4ALL) libraries, with OSNMA / EGNOS / multi-constellation support where the hardware allows);
   - an **external Bluetooth GNSS antenna** (u-blox, Bad Elf, ArduSimple, SparkFun RTK, …) on all three targets;
   - the browser **Geolocation API** as a baseline on the web.
2. **[`demo-app/`](./demo-app)** — a minimal HTML + vanilla-JS + Capacitor consumer app that showcases the plugin with an OpenLayers map, Esri World Imagery basemap, a GPS recenter button, an antenna pairing button, and a "tap to take a geotagged photo" button.

The plugin is the primary deliverable. The demo exists only to prove the plugin works and to drive its API design from a real use case.

---

## TL;DR

```
demoPosition/
├── egnss-capacitor/   # the plugin (publishable package)
├── demo-app/          # the consumer app (uses egnss-capacitor via file:)
└── README.md          # this file
```

- **Plugin exposes a single API** (`EgnssPlugin`) with the same shape on Android / iOS / Web.
- **One field** tells the app which source is currently feeding the fix: `source: 'INTERNAL_GNSS' | 'EXTERNAL_BT' | 'WEB_GEOLOC'`.
- **One field** tells the app how much it can trust the fix: `integrityLevel: 'HIGH' | 'STANDARD' | 'LOW' | 'UNTRUSTED'`.
- The demo-app does **not** need to branch on the platform — the plugin handles all platform differences internally.




## Supported targets

### Mobile (Capacitor native)

- **Android** ≥ 7.0 (API 24). Full feature set including OSNMA on compatible chipsets (Snapdragon 845+, Exynos 9810+, and newer).
- **iOS** ≥ 13. `CLLocationManager` + external BLE antenna support. OSNMA is only available through the external antenna (Apple does not expose raw GNSS measurements).

### Web (browsers)

Only **Chromium-based browsers** are supported, because the External Bluetooth Antenna feature requires the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API):

| Browser                                | Desktop | Mobile | Notes                          |
| -------------------------------------- | :-----: | :----: | ------------------------------ |
| Google Chrome                          |   ✓    |   ✓   | Primary dev target on macOS    |
| Microsoft Edge                         |   ✓    |   ✓   | Fully supported                |
| Opera                                  |   ✓    |   ✓   | Fully supported                |
| Brave / Vivaldi / Arc                  |   ✓    |   ✓   | Fully supported                |

**Explicitly unsupported (by product choice):**

- **Safari** (macOS and iOS).
- **Any browser on iOS** — because Apple forces all iOS browsers to use WebKit, which does not implement Web Bluetooth.
- **Firefox** — Web Bluetooth is behind a disabled-by-default flag.

When the plugin detects an unsupported browser, the app displays a full-screen message ("Use Chrome, Edge, Opera, or a Chromium-based browser") and stops. No silent fallback.

> For iPhone/iPad users, the supported way to run the app is the **native Capacitor IPA**, not Safari. Inside the native app the plugin uses `CoreBluetooth` directly and does not hit the Web Bluetooth limitation.

---

## What the plugin gives you

A single promise-based API:

```ts
import { Egnss } from 'egnss-capacitor';

const cap = await Egnss.checkCapability();
await Egnss.requestPermissions();

// List nearby BT antennas (opens native/web chooser)
const devices = await Egnss.scanAntennas();
await Egnss.connectAntenna(devices[0].id);

await Egnss.startGnss({ preferredSource: 'AUTO', minAccuracyMeters: 5 });

Egnss.addListener('gnssUpdate', (fix) => {
  console.log(fix.lat, fix.lon, fix.hAccuracy,
              fix.source,             // INTERNAL_GNSS | EXTERNAL_BT | WEB_GEOLOC
              fix.integrityLevel,     // HIGH | STANDARD | LOW | UNTRUSTED
              fix.osnmaStatus);       // OK | KO | UNKNOWN | NOT_SUPPORTED
});
```

See [`egnss-capacitor/README.md`](./egnss-capacitor/README.md) for the full API reference.

---


## Requirements

To build and run everything you will need:

- **Node.js** ≥ 18 and **npm** ≥ 9.
- **macOS** (needed for iOS builds).
- **Xcode** ≥ 15 + an Apple Developer account for iOS device deployment.
- **Android Studio** Hedgehog+ (or Ladybug) with Android SDK API 34 and the NDK if building AARs from source.
- A **Chromium browser** for the web version.
- (optional but recommended) A **Bluetooth GNSS antenna** with BLE GATT support (Bad Elf GPS Pro+, u-blox + ArduSimple BLE, SparkFun RTK Surveyor, etc.).

---

## Getting started (work in progress — updated as milestones land)

```bash
# Clone the workspace
git clone <repo-url> demoPosition
cd demoPosition

# 1. Build the plugin once
cd egnss-capacitor
npm install
npm run build
cd ..

# 2. Install demo-app, which picks up the plugin via file: dependency
cd demo-app
npm install
npm run dev                # runs in Chrome on macOS
```

Mobile builds:

```bash
# From demo-app/ after `npm run build`
npx cap sync

# Android
npx cap open android
# run on a connected device / emulator from Android Studio

# iOS
npx cap open ios
# run on a connected iPhone / simulator from Xcode
```

Full step-by-step instructions will be added to [`demo-app/README.md`](./demo-app/README.md) once the first milestones land.

---

## Third-party code

- The plugin integrates source code derived from:
  - [`EGNSS4ALL/EGNSS4ALLAndroid`](https://github.com/EGNSS4ALL/EGNSS4ALLAndroid) (modules `gnss_scan`, `gnss_compare_core`, `convex_hull`) — the upstream repo does not yet declare a license file; its actual license must be confirmed with the maintainers before any public redistribution. This repository is a **demo** and is not redistributed publicly until that confirmation is obtained.
  - [`EGNSS4ALL/EGNSS4ALL-iOS`](https://github.com/EGNSS4ALL/EGNSS4ALL-iOS) (modules `ConvexHull`, `Satellite`, location-manager wrapper) — same caveat as above.
- The demo-app uses **Esri World Imagery** tiles under Esri's standard free-use terms. Attribution is displayed in-app. For commercial or high-volume usage, switch to an Esri plan or to OpenStreetMap-based tiles.

---

## Design document

All architectural decisions, trade-offs, platform matrices, and open questions are documented in detail in [`PIANO.md`](./PIANO.md) (Italian). Changes to the plan are tracked there first; this README is updated when a milestone is delivered.
