package it.demo.egnss

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

/**
 * Android entry point of the Egnss plugin.
 *
 * Orchestrates three cooperating subsystems:
 *   - [GnssManager]   — internal device GNSS via LocationManager.
 *   - [BluetoothManager] — external BT antenna (SPP + BLE UART).
 *   - [Egnss4AllBridge]  — optional EGNSS4ALL reflection bridge for OSNMA.
 *
 * Emits the same events as the web implementation:
 *   - `gnssUpdate`        : GnssFix
 *   - `antennaStatus`     : { connected, device, error? }
 *   - `antennaScanResult` : AntennaDevice
 */
@CapacitorPlugin(
    name = "Egnss",
    permissions = [
        Permission(
            alias = "location",
            strings = [
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ],
        ),
        Permission(
            alias = "bluetooth",
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
            ],
        ),
    ],
)
class EgnssPlugin : Plugin() {

    private lateinit var gnss: GnssManager
    private lateinit var bluetooth: BluetoothManager
    private lateinit var egnss4all: Egnss4AllBridge

    // Runtime state
    private var started = false
    private var preferredSource = "AUTO"
    private var minAccuracyMeters = 10.0
    private var centroidSamples = 20
    private var requireOsnma = false
    private val centroidBuffer = ArrayDeque<ConvexHull.P>()
    private var lastInternalFix: GnssManager.FixOut? = null
    private var lastFixJson: JSObject? = null
    private var carry = ""

    // Scan bookkeeping: we accumulate discovered devices during a scan so we
    // can resolve the `scanAntennas` promise with the full list when the
    // timeout elapses. Results are also pushed live via `antennaScanResult`.
    private var scanCall: PluginCall? = null
    private val scanResults = LinkedHashMap<String, JSObject>()

    override fun load() {
        super.load()
        gnss = GnssManager(
            context = context,
            onFix = this::onInternalFix,
            onError = { notifyListeners("gnssError", JSObject().put("message", it)) },
        )
        bluetooth = BluetoothManager(
            context = context,
            onSentence = this::onNmeaSentence,
            onStatus = this::onAntennaStatus,
            onScanResult = { id, name, rssi ->
                val entry = JSObject().apply {
                    put("id", id)
                    put("name", name ?: "Unknown GNSS device")
                    put("rssi", rssi)
                    put("isConnected", bluetooth.connectedDeviceId() == id)
                }
                scanResults[id] = entry
                notifyListeners("antennaScanResult", entry)
            },
            onScanFinished = { resolveScanCall() },
        )
        egnss4all = Egnss4AllBridge(context)
    }

    // ------------------------------------------------------------------
    // Capability + permissions
    // ------------------------------------------------------------------

    @PluginMethod
    fun checkCapability(call: PluginCall) {
        val result = JSObject().apply {
            put("platform", "android")
            put("hasInternalGnss", true)
            put("supportsRawGnss", Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
            put("supportsOsnmaInternal", egnss4all.isAvailable)
            put("supportsExternalAntenna", true)
            put("bluetoothAvailable", bluetooth.isAvailable())
        }
        call.resolve(result)
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val needed = buildList {
            if (getPermissionState("location") != PermissionState.GRANTED) add("location")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                getPermissionState("bluetooth") != PermissionState.GRANTED
            ) add("bluetooth")
        }
        if (needed.isEmpty()) {
            call.resolve(permissionsSnapshot())
        } else {
            requestPermissionForAliases(needed.toTypedArray(), call, "permissionsCallback")
        }
    }

    @PermissionCallback
    private fun permissionsCallback(call: PluginCall) {
        call.resolve(permissionsSnapshot())
    }

    private fun permissionsSnapshot(): JSObject {
        val loc = when (getPermissionState("location")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
        val bt = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) "not_required" else when (getPermissionState("bluetooth")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
        return JSObject().apply {
            put("location", loc)
            put("bluetooth", bt)
        }
    }

    // ------------------------------------------------------------------
    // Bluetooth antenna
    // ------------------------------------------------------------------

    @PluginMethod
    fun scanAntennas(call: PluginCall) {
        val timeout = call.getLong("timeoutMs") ?: 8000L
        if (!bluetooth.isAvailable()) {
            call.reject("Bluetooth unavailable or turned off", "BLUETOOTH_UNAVAILABLE")
            return
        }
        // Resolve any previous scan call so we never leak a pending promise.
        resolveScanCall()
        scanResults.clear()
        scanCall = call
        bluetooth.startScan(timeout)
    }

    private fun resolveScanCall() {
        val call = scanCall ?: return
        scanCall = null
        val devices = JSArray()
        for (entry in scanResults.values) devices.put(entry)
        call.resolve(JSObject().put("devices", devices))
    }

    @PluginMethod
    fun connectAntenna(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        if (deviceId.isNullOrBlank()) {
            call.reject("deviceId is required", "DEVICE_NOT_FOUND")
            return
        }
        bluetooth.connect(deviceId)
        call.resolve()
    }

    @PluginMethod
    fun disconnectAntenna(call: PluginCall) {
        bluetooth.disconnect()
        call.resolve()
    }

    @PluginMethod
    fun getConnectedAntenna(call: PluginCall) {
        val id = bluetooth.connectedDeviceId()
        val result = JSObject()
        if (id != null && bluetooth.isConnected()) {
            val dev = JSObject().apply {
                put("id", id)
                put("name", bluetooth.connectedDeviceName() ?: "GNSS device")
                put("isConnected", true)
            }
            result.put("device", dev)
        } else {
            result.put("device", JSONObject.NULL)
        }
        call.resolve(result)
    }

    // ------------------------------------------------------------------
    // GNSS stream
    // ------------------------------------------------------------------

    @PluginMethod
    fun startGnss(call: PluginCall) {
        if (started) {
            call.reject("startGnss called twice without stopGnss", "ALREADY_STARTED")
            return
        }
        preferredSource = call.getString("preferredSource", "AUTO") ?: "AUTO"
        minAccuracyMeters = (call.getDouble("minAccuracyMeters") ?: 10.0).toDouble()
        centroidSamples = call.getInt("centroidSamples") ?: 20
        requireOsnma = call.getBoolean("requireOsnma", false) ?: false
        centroidBuffer.clear()
        carry = ""

        val hasAntenna = bluetooth.isConnected()
        when (preferredSource) {
            "EXTERNAL" -> {
                if (!hasAntenna) {
                    call.reject(
                        "preferredSource=EXTERNAL but no antenna is connected",
                        "DEVICE_NOT_FOUND",
                    )
                    return
                }
                // Antenna stream is already flowing via onNmeaSentence.
            }
            "INTERNAL" -> {
                val ok = gnss.start()
                if (!ok) {
                    call.reject("Could not start internal GNSS", "PERMISSION_DENIED")
                    return
                }
                egnss4all.startRawScan()
            }
            else -> {
                // AUTO: start internal too, antenna sentences (if any) take priority.
                gnss.start()
                egnss4all.startRawScan()
            }
        }
        started = true
        call.resolve()
    }

    @PluginMethod
    fun stopGnss(call: PluginCall) {
        gnss.stop()
        egnss4all.stopRawScan()
        started = false
        centroidBuffer.clear()
        call.resolve()
    }

    @PluginMethod
    fun getCurrentFix(call: PluginCall) {
        val json = lastFixJson
        val result = JSObject()
        if (json != null) result.put("fix", json) else result.put("fix", JSONObject.NULL)
        call.resolve(result)
    }

    // ------------------------------------------------------------------
    // Internal adapters
    // ------------------------------------------------------------------

    private fun onInternalFix(fix: GnssManager.FixOut) {
        if (!started) return
        lastInternalFix = fix
        // Prefer antenna: when connected we gate internal fixes out unless AUTO+external off.
        if (bluetooth.isConnected() && preferredSource != "INTERNAL") return
        emit(
            lat = fix.lat,
            lon = fix.lon,
            alt = fix.alt,
            hAccuracy = fix.hAccuracy,
            vAccuracy = fix.vAccuracy,
            timestamp = fix.timestamp,
            speed = fix.speed,
            bearing = fix.bearing,
            satellitesUsed = fix.satellitesUsed,
            satellitesVisible = fix.satellitesVisible,
            constellations = fix.constellations,
            egnosActive = fix.egnosActive,
            isMock = fix.isMockLocation,
            source = "INTERNAL_GNSS",
            antennaJson = null,
        )
    }

    private fun onNmeaSentence(sentence: String) {
        if (!started) {
            // Still update carry so re-starts don't see stale fragments.
            carry = ""
            return
        }
        val (parsed, newCarry) = NmeaParser.parseStream(sentence + "\n", carry)
        carry = newCarry
        val gga = parsed.gga ?: return

        val hdop = parsed.gsa?.hdop?.takeIf { it > 0 } ?: gga.hdop
        val uere = when (gga.fixQuality) {
            2 -> 2.0     // SBAS / EGNOS
            4 -> 0.1     // RTK fix
            5 -> 0.5     // RTK float
            else -> 4.0  // standalone civilian
        }
        val hAcc = if (hdop > 0) hdop * uere else 4.0
        val antennaJson = JSObject().apply {
            put("id", bluetooth.connectedDeviceId() ?: "bt")
            put("name", bluetooth.connectedDeviceName() ?: "GNSS device")
        }

        emit(
            lat = gga.latitude,
            lon = gga.longitude,
            alt = gga.altitude,
            hAccuracy = hAcc,
            vAccuracy = 0.0,
            timestamp = System.currentTimeMillis(),
            speed = parsed.rmc?.speedMs,
            bearing = parsed.rmc?.bearing,
            satellitesUsed = gga.satellites,
            satellitesVisible = gga.satellites,
            constellations = parsed.constellations,
            egnosActive = gga.fixQuality == 2,
            isMock = false,
            source = "EXTERNAL_BT",
            antennaJson = antennaJson,
        )
    }

    private fun onAntennaStatus(connected: Boolean, deviceId: String?, deviceName: String?, error: String?) {
        val status = JSObject().apply {
            put("connected", connected)
            if (deviceId != null) {
                val dev = JSObject().apply {
                    put("id", deviceId)
                    put("name", deviceName ?: "GNSS device")
                    put("isConnected", connected)
                }
                put("device", dev)
            }
            if (error != null) put("error", error)
        }
        notifyListeners("antennaStatus", status)
    }

    private fun emit(
        lat: Double,
        lon: Double,
        alt: Double,
        hAccuracy: Double,
        vAccuracy: Double,
        timestamp: Long,
        speed: Double?,
        bearing: Double?,
        satellitesUsed: Int,
        satellitesVisible: Int,
        constellations: Set<String>,
        egnosActive: Boolean,
        isMock: Boolean,
        source: String,
        antennaJson: JSObject?,
    ) {
        val osnmaStatus = egnss4all.osnmaStatus()
        val osnmaOk = osnmaStatus == "OK"

        val centroid = if (centroidSamples > 0) {
            centroidBuffer.addLast(ConvexHull.P(lat, lon))
            while (centroidBuffer.size > centroidSamples) centroidBuffer.removeFirst()
            ConvexHull.innermostCentroid(centroidBuffer.toList())
        } else null

        val integrity = Integrity.level(
            fix = Integrity.InputFix(
                hAccuracy = hAccuracy,
                isMockLocation = isMock,
                osnmaOk = osnmaOk,
                egnosActive = egnosActive,
                fromExternalAntenna = source == "EXTERNAL_BT",
            ),
            minAccuracyMeters = minAccuracyMeters,
            requireOsnma = requireOsnma,
        )

        val json = JSObject().apply {
            put("lat", lat)
            put("lon", lon)
            put("alt", alt)
            put("hAccuracy", hAccuracy)
            put("vAccuracy", vAccuracy)
            put("timestamp", timestamp)
            speed?.let { put("speed", it) }
            bearing?.let { put("bearing", it) }
            put("satellitesUsed", satellitesUsed)
            put("satellitesVisible", satellitesVisible)
            put("constellations", JSArray(constellations))
            put("egnosActive", egnosActive)
            put("osnmaStatus", osnmaStatus)
            put("isMockLocation", isMock)
            put("source", source)
            put("integrityLevel", integrity)
            if (centroid != null) {
                put(
                    "centroid",
                    JSObject().apply {
                        put("lat", centroid.lat)
                        put("lon", centroid.lon)
                        put("samples", centroidBuffer.size)
                    },
                )
            }
            if (antennaJson != null) put("antenna", antennaJson)
        }
        lastFixJson = json
        notifyListeners("gnssUpdate", json)
    }

    @Suppress("unused")
    private fun isFinePermissionGranted(): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
}
