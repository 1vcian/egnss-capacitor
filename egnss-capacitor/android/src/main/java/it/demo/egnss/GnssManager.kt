package it.demo.egnss

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.OnNmeaMessageListener
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat

/**
 * Wraps the Android [LocationManager] and emits enriched fixes to the
 * plugin. In its current form (P4) it implements:
 *
 *   - `LocationManager.GPS_PROVIDER` via `requestLocationUpdates`.
 *   - `OnNmeaMessageListener` to mark EGNOS-corrected fixes (GGA quality == 2).
 *   - `GnssStatus.Callback` to count used / visible satellites per constellation.
 *   - Mock-location detection via `location.isFromMockProvider`.
 *
 * The EGNSS4ALL integration (OSNMA + raw GNSS) enters through
 * [Egnss4AllBridge]. When its AAR is not on the classpath the bridge's
 * `isAvailable` returns false and we simply emit non-authenticated fixes.
 */
internal class GnssManager(
    private val context: Context,
    private val onFix: (FixOut) -> Unit,
    private val onError: (String) -> Unit,
) {

    data class FixOut(
        val lat: Double,
        val lon: Double,
        val alt: Double,
        val hAccuracy: Double,
        val vAccuracy: Double,
        val timestamp: Long,
        val speed: Double?,
        val bearing: Double?,
        val satellitesUsed: Int,
        val satellitesVisible: Int,
        val constellations: Set<String>,
        val egnosActive: Boolean,
        val isMockLocation: Boolean,
    )

    private val locationManager: LocationManager =
        context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    private val mainHandler = Handler(Looper.getMainLooper())

    private var satellitesVisible = 0
    private var satellitesUsed = 0
    private val constellations = linkedSetOf<String>()
    private var egnosActive = false

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val isMock = try {
                @Suppress("DEPRECATION")
                location.isFromMockProvider
            } catch (_: Throwable) {
                false
            }
            val vAcc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()) {
                location.verticalAccuracyMeters.toDouble()
            } else {
                0.0
            }

            onFix(
                FixOut(
                    lat = location.latitude,
                    lon = location.longitude,
                    alt = if (location.hasAltitude()) location.altitude else 0.0,
                    hAccuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0,
                    vAccuracy = vAcc,
                    timestamp = location.time,
                    speed = if (location.hasSpeed()) location.speed.toDouble() else null,
                    bearing = if (location.hasBearing()) location.bearing.toDouble() else null,
                    satellitesUsed = satellitesUsed,
                    satellitesVisible = satellitesVisible,
                    constellations = constellations.toSet(),
                    egnosActive = egnosActive,
                    isMockLocation = isMock,
                ),
            )
        }

        @Deprecated("Kept for API < 30 compatibility")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) { /* no-op */ }
        override fun onProviderEnabled(provider: String) { /* no-op */ }
        override fun onProviderDisabled(provider: String) {
            onError("Provider disabled: $provider")
        }
    }

    private val nmeaListener = OnNmeaMessageListener { message, _ ->
        // Watch GGA fix quality to detect EGNOS/SBAS.
        if (message.contains("GGA", ignoreCase = true)) {
            val fields = message.split(',')
            val quality = fields.getOrNull(6)?.toIntOrNull() ?: 0
            egnosActive = (quality == 2)
        }
    }

    private val gnssCallback = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            var visible = 0
            var used = 0
            val seen = linkedSetOf<String>()
            for (i in 0 until status.satelliteCount) {
                visible++
                if (status.usedInFix(i)) used++
                seen.add(constellationOf(status.getConstellationType(i)))
            }
            satellitesVisible = visible
            satellitesUsed = used
            constellations.clear()
            constellations.addAll(seen)
        }
    }

    fun start(): Boolean {
        if (!hasFineLocation()) {
            onError("ACCESS_FINE_LOCATION permission not granted")
            return false
        }
        try {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                1000L,
                0f,
                locationListener,
                Looper.getMainLooper(),
            )
        } catch (e: SecurityException) {
            onError(e.message ?: "SecurityException in requestLocationUpdates")
            return false
        }
        try {
            locationManager.addNmeaListener(nmeaListener, mainHandler)
        } catch (e: SecurityException) {
            // Non-fatal: EGNOS flag will stay false.
            onError(e.message ?: "Unable to register NMEA listener")
        }
        try {
            locationManager.registerGnssStatusCallback(gnssCallback, mainHandler)
        } catch (_: SecurityException) {
            /* ignored */
        }
        return true
    }

    fun stop() {
        try {
            locationManager.removeUpdates(locationListener)
        } catch (_: SecurityException) {
            /* ignored */
        }
        try {
            locationManager.removeNmeaListener(nmeaListener)
        } catch (_: SecurityException) {
            /* ignored */
        }
        try {
            locationManager.unregisterGnssStatusCallback(gnssCallback)
        } catch (_: SecurityException) {
            /* ignored */
        }
    }

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun constellationOf(type: Int): String = when (type) {
        GnssStatus.CONSTELLATION_GPS -> "GPS"
        GnssStatus.CONSTELLATION_GLONASS -> "GLONASS"
        GnssStatus.CONSTELLATION_GALILEO -> "GALILEO"
        GnssStatus.CONSTELLATION_BEIDOU -> "BEIDOU"
        GnssStatus.CONSTELLATION_QZSS -> "QZSS"
        GnssStatus.CONSTELLATION_IRNSS -> "IRNSS"
        GnssStatus.CONSTELLATION_SBAS -> "SBAS"
        else -> "UNKNOWN"
    }
}
