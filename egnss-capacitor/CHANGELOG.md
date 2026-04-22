# Changelog

All notable changes to `egnss-capacitor` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project (so far) aligns with Capacitor 8.

## [Unreleased]

### Changed

- `scanAntennas()` now resolves with `{ devices: AntennaDevice[] }` on **all**
  platforms (was previously `AntennaDevice[]` on web and `{ devices: [] }` on
  native because Capacitor always wraps native results).
- On Android and iOS, `scanAntennas()` now collects every device discovered
  during the timeout and resolves with the full list when the scan ends.
  Individual results are still pushed live via `antennaScanResult` events.

### Fixed

- Android `JSONArray.NULL` → `JSONObject.NULL` (compile error).
- demo-app `pairAntenna()` no longer crashes with `Cannot read properties of undefined (reading 'id')` when the user taps the antenna FAB.

## [0.1.0] — unreleased

### Added

- Public API contract (`src/definitions.ts`) with `GnssFix`, `Capability`, `AntennaDevice`, `EgnssPlugin`, and typed error codes.
- Shared utilities used by the web and native backends:
  - `shared/nmea-parser.ts`: NMEA 0183 parser (GGA, RMC, GSA, GSV) with checksum validation.
  - `shared/convex-hull.ts`: innermost convex-hull centroid (Andrew's monotone chain).
  - `shared/integrity.ts`: `IntegrityLevel` rules shared across all targets.
- **Web** implementation:
  - `web/geolocation-source.ts`: `navigator.geolocation.watchPosition` pipe.
  - `web/bluetooth-source.ts`: Web Bluetooth GATT + NMEA streaming (Nordic UART Service + Bad Elf/SPBLE fallback).
  - Chromium-only gating; Safari / Firefox / iOS browsers are explicitly unsupported.
- **Android** implementation (`android/src/main/java/it/demo/egnss/`):
  - `GnssManager`: `LocationManager` + `OnNmeaMessageListener` + `GnssStatus.Callback` + mock-location detection.
  - `BluetoothManager`: classic SPP (RFCOMM) + BLE UART (NUS) + paired-device discovery.
  - `NmeaParser`: Kotlin mirror of the shared JS parser.
  - `ConvexHull`, `Integrity`: Kotlin ports of the shared JS utilities.
  - `Egnss4AllBridge`: reflection-based optional bridge to the EGNSS4ALL Android AAR (OSNMA / raw GNSS).
- **iOS** implementation (`ios/Plugin/`):
  - `GnssService`: `CLLocationManager` with `kCLLocationAccuracyBestForNavigation`.
  - `BluetoothService`: `CoreBluetooth` BLE scan + connect + GATT notify.
  - `NmeaParser`, `ConvexHull`, `Integrity`: Swift ports of the shared utilities.

### Known limitations

- **iOS** cannot expose raw GNSS measurements or OSNMA on the internal chip (Apple API limitation). OSNMA is therefore only reachable through a certified external antenna connected via BLE.
- **iOS classic Bluetooth** (SPP) requires MFi certification per device, which is not possible from a third-party plugin. Only BLE peripherals are supported.
- **Web OSNMA** is never available regardless of the receiver, because OSNMA authentication requires real-time Galileo navigation messages that the Web Bluetooth path does not decode.
- EGNSS4ALL AAR must be produced and copied into `android/libs/` manually; it is not redistributed in this repo until upstream licensing is clarified.

## [0.0.1] — scaffolding

- Initial Capacitor 8 plugin scaffold (package.json, tsconfig, rollup, podspec, Android + iOS skeletons) with `checkCapability` returning a real response and every other method stubbed with `NOT_IMPLEMENTED`.
