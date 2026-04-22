import Foundation
import Capacitor
import CoreLocation
import CoreBluetooth

/**
 * iOS entry point of the Egnss plugin.
 *
 * Orchestrates:
 *   - [GnssService]       — internal GNSS via CLLocationManager.
 *   - [BluetoothService]  — external BT antenna via CoreBluetooth (BLE only; MFi required for classic SPP).
 *   - [NmeaParser]        — swift NMEA parser used on the BT path.
 *
 * iOS cannot expose OSNMA on the internal chip, so `supportsOsnmaInternal`
 * is always false; OSNMA becomes available only via an external antenna
 * that performs the authentication on-device (e.g. u-blox with OSNMA firmware).
 * In that case we currently still report `osnmaStatus: "UNKNOWN"` because we
 * do not yet parse manufacturer-specific PUBX/UBX messages — it's a future
 * extension slot.
 */
@objc(EgnssPlugin)
public class EgnssPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EgnssPlugin"
    public let jsName = "Egnss"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkCapability",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanAntennas",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectAntenna",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnectAntenna",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConnectedAntenna", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startGnss",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopGnss",            returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentFix",       returnType: CAPPluginReturnPromise)
    ]

    private let gnss = GnssService()
    private let bluetooth = BluetoothService()

    private var started = false
    private var preferredSource = "AUTO"
    private var minAccuracyMeters: Double = 10
    private var centroidSamples: Int = 20
    private var requireOsnma = false
    private var centroidBuffer: [ConvexHull.P] = []
    private var carry = ""
    private var lastFix: [String: Any]?

    // Scan bookkeeping: collect discovered devices during a scan so we can
    // resolve `scanAntennas` with the full list when the timeout elapses.
    private var scanCall: CAPPluginCall?
    private var scanResults: [String: [String: Any]] = [:]
    private var scanOrder: [String] = []

    public override func load() {
        super.load()
        gnss.onFix = { [weak self] fix in self?.handleInternalFix(fix) }
        gnss.onError = { [weak self] msg in
            self?.notifyListeners("gnssError", data: ["message": msg])
        }
        bluetooth.onSentence = { [weak self] s in self?.handleNmeaSentence(s) }
        bluetooth.onStatus = { [weak self] connected, device, error in
            var payload: [String: Any] = ["connected": connected]
            if let d = device {
                payload["device"] = [
                    "id": d.id,
                    "name": d.name,
                    "isConnected": connected
                ]
            }
            if let e = error { payload["error"] = e }
            self?.notifyListeners("antennaStatus", data: payload)
        }
        bluetooth.onScanResult = { [weak self] d in
            guard let self = self else { return }
            var payload: [String: Any] = [
                "id": d.id,
                "name": d.name,
                "isConnected": false
            ]
            if let r = d.rssi { payload["rssi"] = r }
            if self.scanResults[d.id] == nil {
                self.scanOrder.append(d.id)
            }
            self.scanResults[d.id] = payload
            self.notifyListeners("antennaScanResult", data: payload)
        }
        bluetooth.onScanFinished = { [weak self] in self?.resolveScanCall() }
    }

    private func resolveScanCall() {
        guard let call = scanCall else { return }
        scanCall = nil
        let devices: [[String: Any]] = scanOrder.compactMap { scanResults[$0] }
        call.resolve(["devices": devices])
    }

    // MARK: - Capability & permissions

    @objc func checkCapability(_ call: CAPPluginCall) {
        call.resolve([
            "platform": "ios",
            "hasInternalGnss": true,
            "supportsRawGnss": false,
            "supportsOsnmaInternal": false,
            "supportsExternalAntenna": true,
            "bluetoothAvailable": bluetooth.isAvailable()
        ])
    }

    @objc func requestPermissions(_ call: CAPPluginCall) {
        gnss.requestPermission()
        // Bluetooth on iOS requests at first CBCentralManager usage; nothing to
        // trigger explicitly here. We return "prompt" until the OS resolves it
        // through the first scan call, at which point iOS shows the system prompt.
        let btStatus: String
        if #available(iOS 13.1, *) {
            switch CBCentralManagerImmediateAuthorization.current {
            case .allowedAlways: btStatus = "granted"
            case .denied, .restricted: btStatus = "denied"
            default: btStatus = "prompt"
            }
        } else {
            btStatus = "prompt"
        }
        call.resolve([
            "location": gnss.authorizationStatus(),
            "bluetooth": btStatus
        ])
    }

    // MARK: - Bluetooth antenna

    @objc func scanAntennas(_ call: CAPPluginCall) {
        let timeout = call.getInt("timeoutMs") ?? 8000
        guard bluetooth.isAvailable() else {
            call.reject("Bluetooth unavailable or turned off", "BLUETOOTH_UNAVAILABLE")
            return
        }
        resolveScanCall()
        scanResults.removeAll()
        scanOrder.removeAll()
        scanCall = call
        bluetooth.startScan(timeoutMs: timeout)
    }

    @objc func connectAntenna(_ call: CAPPluginCall) {
        guard let deviceId = call.getString("deviceId"), !deviceId.isEmpty else {
            call.reject("deviceId is required", "DEVICE_NOT_FOUND")
            return
        }
        bluetooth.connect(deviceId: deviceId)
        call.resolve()
    }

    @objc func disconnectAntenna(_ call: CAPPluginCall) {
        bluetooth.disconnect()
        call.resolve()
    }

    @objc func getConnectedAntenna(_ call: CAPPluginCall) {
        if let d = bluetooth.connectedDevice() {
            call.resolve([
                "device": [
                    "id": d.id,
                    "name": d.name,
                    "isConnected": true
                ]
            ])
        } else {
            call.resolve(["device": NSNull()])
        }
    }

    // MARK: - GNSS stream

    @objc func startGnss(_ call: CAPPluginCall) {
        if started {
            call.reject("startGnss called twice without stopGnss", "ALREADY_STARTED")
            return
        }
        preferredSource = call.getString("preferredSource") ?? "AUTO"
        minAccuracyMeters = call.getDouble("minAccuracyMeters") ?? 10
        centroidSamples = call.getInt("centroidSamples") ?? 20
        requireOsnma = call.getBool("requireOsnma") ?? false
        centroidBuffer.removeAll()
        carry = ""

        let hasAntenna = bluetooth.connectedDevice() != nil
        switch preferredSource {
        case "EXTERNAL":
            if !hasAntenna {
                call.reject("preferredSource=EXTERNAL but no antenna is connected", "DEVICE_NOT_FOUND")
                return
            }
        case "INTERNAL":
            gnss.start()
        default: // AUTO
            gnss.start()
        }

        started = true
        call.resolve()
    }

    @objc func stopGnss(_ call: CAPPluginCall) {
        gnss.stop()
        started = false
        centroidBuffer.removeAll()
        call.resolve()
    }

    @objc func getCurrentFix(_ call: CAPPluginCall) {
        call.resolve(["fix": lastFix ?? NSNull()])
    }

    // MARK: - Event handlers

    private func handleInternalFix(_ fix: GnssService.OutFix) {
        guard started else { return }
        if bluetooth.connectedDevice() != nil && preferredSource != "INTERNAL" { return }

        emit(
            lat: fix.lat,
            lon: fix.lon,
            alt: fix.alt,
            hAccuracy: fix.hAccuracy,
            vAccuracy: fix.vAccuracy,
            timestamp: Int64(fix.timestamp * 1000),
            speed: fix.speed,
            bearing: fix.bearing,
            satellitesUsed: 0,
            satellitesVisible: 0,
            constellations: ["UNKNOWN"],
            egnosActive: false,
            osnmaStatus: "NOT_SUPPORTED",
            isMock: fix.isMockLocation,
            source: "INTERNAL_GNSS",
            antenna: nil
        )
    }

    private func handleNmeaSentence(_ sentence: String) {
        guard started else {
            carry = ""
            return
        }
        let (parsed, newCarry) = NmeaParser.parseStream(chunk: sentence + "\n", carry: carry)
        carry = newCarry
        guard let gga = parsed.gga else { return }

        let hdop = (parsed.gsa?.hdop ?? 0) > 0 ? parsed.gsa!.hdop : gga.hdop
        let uere: Double
        switch gga.fixQuality {
        case 2: uere = 2
        case 4: uere = 0.1
        case 5: uere = 0.5
        default: uere = 4
        }
        let hAcc = hdop > 0 ? hdop * uere : 4

        var antenna: [String: Any]? = nil
        if let d = bluetooth.connectedDevice() {
            antenna = ["id": d.id, "name": d.name]
        }

        emit(
            lat: gga.latitude,
            lon: gga.longitude,
            alt: gga.altitude,
            hAccuracy: hAcc,
            vAccuracy: 0,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000),
            speed: parsed.rmc?.speedMs,
            bearing: parsed.rmc?.bearing,
            satellitesUsed: gga.satellites,
            satellitesVisible: gga.satellites,
            constellations: parsed.constellations.isEmpty ? ["UNKNOWN"] : Array(parsed.constellations),
            egnosActive: gga.fixQuality == 2,
            osnmaStatus: "UNKNOWN",
            isMock: false,
            source: "EXTERNAL_BT",
            antenna: antenna
        )
    }

    private func emit(
        lat: Double, lon: Double, alt: Double,
        hAccuracy: Double, vAccuracy: Double,
        timestamp: Int64, speed: Double?, bearing: Double?,
        satellitesUsed: Int, satellitesVisible: Int,
        constellations: [String],
        egnosActive: Bool, osnmaStatus: String, isMock: Bool,
        source: String, antenna: [String: Any]?
    ) {
        var centroidPayload: [String: Any]? = nil
        if centroidSamples > 0 {
            centroidBuffer.append(ConvexHull.P(lat: lat, lon: lon))
            while centroidBuffer.count > centroidSamples {
                centroidBuffer.removeFirst()
            }
            if let c = ConvexHull.innermostCentroid(centroidBuffer) {
                centroidPayload = [
                    "lat": c.lat,
                    "lon": c.lon,
                    "samples": centroidBuffer.count
                ]
            }
        }

        let integrity = Integrity.level(
            Integrity.InputFix(
                hAccuracy: hAccuracy,
                isMockLocation: isMock,
                osnmaOk: osnmaStatus == "OK",
                egnosActive: egnosActive,
                fromExternalAntenna: source == "EXTERNAL_BT"
            ),
            minAccuracyMeters: minAccuracyMeters,
            requireOsnma: requireOsnma
        )

        var payload: [String: Any] = [
            "lat": lat,
            "lon": lon,
            "alt": alt,
            "hAccuracy": hAccuracy,
            "vAccuracy": vAccuracy,
            "timestamp": timestamp,
            "satellitesUsed": satellitesUsed,
            "satellitesVisible": satellitesVisible,
            "constellations": constellations,
            "egnosActive": egnosActive,
            "osnmaStatus": osnmaStatus,
            "isMockLocation": isMock,
            "source": source,
            "integrityLevel": integrity
        ]
        if let s = speed { payload["speed"] = s }
        if let b = bearing { payload["bearing"] = b }
        if let c = centroidPayload { payload["centroid"] = c }
        if let a = antenna { payload["antenna"] = a }

        lastFix = payload
        notifyListeners("gnssUpdate", data: payload)
    }
}

/// Compatibility wrapper for CBCentralManager authorization across iOS versions.
/// iOS 13 introduced `CBManager.authorization`; we avoid touching it directly in
/// the main class to keep the `requestPermissions` body tidy.
private enum CBCentralManagerImmediateAuthorization {
    static var current: AuthorizationValue {
        if #available(iOS 13.1, *) {
            switch CBManager.authorization {
            case .allowedAlways: return .allowedAlways
            case .denied: return .denied
            case .restricted: return .restricted
            default: return .notDetermined
            }
        } else {
            return .notDetermined
        }
    }

    enum AuthorizationValue {
        case allowedAlways
        case denied
        case restricted
        case notDetermined
    }
}
