# `egnss-capacitor/android/libs/`

Drop the EGNSS4ALL Android AAR in this folder to enable OSNMA / raw GNSS / EGNOS authentication features on Android.

The plugin works without the AAR — in that case it falls back to `LocationManager` + NMEA + `GnssStatus`, and `checkCapability().supportsOsnmaInternal` returns `false`.

## Build the AAR

```bash
git clone https://github.com/EGNSS4ALL/EGNSS4ALLAndroid.git
cd EGNSS4ALLAndroid

# The upstream repo is a multi-module Gradle project. The modules we care
# about are gnss_compare_core, gnss_scan, and convex_hull. Adjust the
# script depending on the upstream layout at clone time.
./gradlew :gnss_compare_core:assembleRelease
./gradlew :gnss_scan:assembleRelease
./gradlew :convex_hull:assembleRelease
```

The generated AAR files land in each module's `build/outputs/aar/` directory. Copy them here:

```bash
cp gnss_compare_core/build/outputs/aar/gnss_compare_core-release.aar  \
   gnss_scan/build/outputs/aar/gnss_scan-release.aar                   \
   convex_hull/build/outputs/aar/convex_hull-release.aar               \
   egnss-capacitor/android/libs/
```

## How the plugin picks it up

- `android/build.gradle` declares `implementation fileTree(include: ['*.jar', '*.aar'], dir: 'libs')`, so any AAR placed here is linked automatically.
- At runtime, `Egnss4AllBridge.kt` probes for well-known EGNSS4ALL class names via reflection. When found, the bridge:
  - flips `checkCapability().supportsOsnmaInternal` to `true`;
  - starts EGNSS4ALL's raw GNSS scanner alongside the standard `LocationManager` stream;
  - populates `osnmaStatus` on every emitted `GnssFix`.
- When no AAR is present, the bridge stays inert and the plugin reports `osnmaStatus: "NOT_SUPPORTED"`.

## Licensing note

The EGNSS4ALL upstream repository does not currently ship with a clear license file. Confirm the licensing terms with the maintainers before redistributing the AAR (for example, before publishing this plugin to npm). For local development and the demo app this is not a concern.
