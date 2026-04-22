# demo-app

Capacitor showcase app for the [`egnss-capacitor`](../egnss-capacitor) plugin. Pure **HTML + vanilla JS + OpenLayers** wrapped by Capacitor for Android and iOS builds.

The sole purpose of this package is to exercise the plugin's public API in a real UI (map, GPS button, antenna pairing, camera). It is **not** a general-purpose mapping app.

---

## Stack

- **Vite** as dev server / bundler.
- **OpenLayers 10** for the map, with **Esri World Imagery** as the basemap (free tier, requires attribution which is rendered automatically).
- **`egnss-capacitor`** (linked via `file:../egnss-capacitor`) for GNSS + Bluetooth antennas.
- **`@capacitor/camera`**, **`@capacitor/filesystem`**, **`@capacitor/preferences`** for photo capture / storage.

## Run in a browser (primary dev loop, on macOS)

```bash
# One-time: build the plugin once so the file: dependency resolves.
cd ../egnss-capacitor && npm install && npm run build && cd ../demo-app

npm install
npm run dev
# → open http://localhost:5173 in Chrome / Edge / Opera / Brave
```

> Safari and Firefox will display a full-screen "Unsupported browser" message because the demo requires Web Bluetooth. This is the expected and documented behavior.

If Vite reports *Port 5173 is already in use*, a previous session is still running:

```bash
lsof -ti :5173 | xargs kill -9
```

## Build + run on Android

Capacitor does **not** produce an APK itself. `npx cap add android` scaffolds a
full Android Studio / Gradle project under `demo-app/android/`; Gradle then
compiles the APK.

> **Prereq — JDK 21.** Capacitor 8 / Android Gradle Plugin 8.x require JDK 21.
> `android/gradle.properties` points `org.gradle.java.home` at the default
> Homebrew install (`/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`).
> If your JDK lives elsewhere, install it with `brew install openjdk@21` or
> override the path:
>
> ```bash
> # One-off:
> ./gradlew assembleDebug -Porg.gradle.java.home=/path/to/jdk-21
> # Or edit demo-app/android/gradle.properties.
> ```

```bash
npm run sync
npx cap add android        # first time only, creates demo-app/android/
```

You now have **three ways** to get an APK:

### (a) Build a debug APK from CLI

```bash
npm run android:apk
# = npm run sync && cd android && ./gradlew assembleDebug
```

Output:

```
demo-app/android/app/build/outputs/apk/debug/app-debug.apk
```

### (b) Build + install on a connected device (USB debugging on)

```bash
npm run android:install
# = npm run sync && cd android && ./gradlew installDebug
```

### (c) Open Android Studio and build from GUI

```bash
npm run android            # opens Android Studio on the generated project
```

In Android Studio:

- **Build → Build Bundle(s) / APK(s) → Build APK(s)** → APK in `app/build/outputs/apk/debug/`
- **Build → Build Bundle(s) / APK(s) → Build Bundle(s)** → AAB (Play Store) in `app/build/outputs/bundle/release/`
- For a signed release APK: **Build → Generate Signed Bundle / APK** (you need a keystore).

Required Android permissions (declared in the plugin, surfaced by the consumer):

- `ACCESS_FINE_LOCATION`
- `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (API 31+)

## Build + run on iOS

Capacitor does **not** produce an IPA itself. `npx cap add ios` scaffolds an
Xcode workspace under `demo-app/ios/App/`; Xcode then archives and exports.

```bash
npm run sync
npx cap add ios            # first time only, creates demo-app/ios/App/
npm run ios:pods           # cd ios/App && pod install
npm run ios                # opens App.xcworkspace in Xcode
```

From Xcode:

### (a) Run on simulator (no Apple Developer account needed)

- Select any *iPhone XX Simulator* in the scheme bar → press **▶ Run**.
- Nothing is exported to disk; the app runs inside the simulator.

### (b) Run on a physical iPhone

- Connect the iPhone via USB and trust the computer.
- In Xcode, open the **App** target → **Signing & Capabilities** → choose your
  Apple ID under *Team* (a free Apple ID works for personal devices).
- Select the iPhone in the scheme bar → **▶ Run**. The app is installed on the
  device; no `.ipa` file is produced.

### (c) Produce a real `.ipa` (distribution)

1. Xcode menu **Product → Archive** (builds a Release archive).
2. The **Organizer** window opens automatically.
3. Click **Distribute App** and choose one of:
   - *App Store Connect* — for TestFlight / App Store
   - *Ad Hoc* — for UDID-registered test devices
   - *Development* — for devices on your dev team
   - *Enterprise* — only with Apple Developer Enterprise Program
4. Xcode asks where to save the `.ipa` (defaults to Desktop).

For full CLI automation see `xcodebuild archive` + `xcodebuild -exportArchive`
with an `ExportOptions.plist` — out of scope for this demo.

Required iOS `Info.plist` keys (auto-scaffolded by `cap add ios`, edit the
user-facing strings):

- `NSLocationWhenInUseUsageDescription`
- `NSBluetoothAlwaysUsageDescription`
- `NSCameraUsageDescription`
- `NSPhotoLibraryAddUsageDescription`

## Where do build artifacts end up? (cheat sheet)

| Platform | Command                                   | Artifact                                                    |
| -------- | ----------------------------------------- | ----------------------------------------------------------- |
| Web      | `npm run build`                           | `demo-app/dist/`                                            |
| Android  | `npm run android:apk`                     | `demo-app/android/app/build/outputs/apk/debug/app-debug.apk`|
| Android  | `./gradlew assembleRelease` (needs keystore) | `demo-app/android/app/build/outputs/apk/release/*.apk`   |
| Android  | Android Studio → Build Bundle(s)          | `demo-app/android/app/build/outputs/bundle/release/*.aab`   |
| iOS      | Xcode → Run (simulator / device)          | no file, installed in simulator or device                   |
| iOS      | Xcode → Product → Archive → Distribute    | `*.ipa` at the location you choose                          |

---

## Current state (W0 / P1 milestone)

The app shell is wired end-to-end but the plugin methods are mostly stubs:

| UI element                  | What it does now                                                   | Finished in |
| --------------------------- | ------------------------------------------------------------------ | ----------- |
| Full-screen browser gate    | Blocks Safari / Firefox / iOS browsers; shows capability dump      | Done (W0)   |
| OpenLayers map + Esri tiles | Renders basemap, default view on Rome                              | Done (W0)   |
| Status bar badges           | Show platform, source="idle", integrity="–" from `checkCapability`| Done (W0)   |
| GPS FAB (G)                 | Calls `checkCapability` + `startGnss`; surfaces NOT_IMPLEMENTED    | P2          |
| Antenna FAB (A)             | Calls `scanAntennas`; surfaces NOT_IMPLEMENTED                     | P3          |
| Camera FAB (C)              | Logs placeholder                                                   | A3          |

The plugin JS contract is fully typed and compiles. Check `src/main.js` to see the flow.

## Project layout

```
demo-app/
├── index.html
├── capacitor.config.ts
├── vite.config.js
├── package.json
├── public/
└── src/
    ├── main.js              # bootstrap + DOM wiring
    ├── ui/
    │   ├── browser-gate.js  # Safari / Firefox gate
    │   └── status-bar.js    # Top status badges
    ├── map/
    │   └── map.js           # OpenLayers + Esri
    ├── gnss/
    │   └── gnss-controls.js # Wires GPS + Antenna FABs to Egnss plugin
    ├── camera/
    │   └── camera-controls.js
    ├── storage/
    │   └── photo-store.js
    └── styles/
        └── main.css
```
