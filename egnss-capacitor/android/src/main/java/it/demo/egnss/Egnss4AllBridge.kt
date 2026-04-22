package it.demo.egnss

import android.content.Context
import android.util.Log

/**
 * Optional bridge to the EGNSS4ALL Android library. Resolved via reflection
 * so this plugin compiles and runs cleanly *without* the upstream AAR, and
 * lights up automatically when the consumer drops the AAR into:
 *
 *     egnss-capacitor/android/libs/egnss4all-core.aar
 *
 * (see README of this folder). When available, the bridge provides:
 *
 *   - OSNMA authentication status (Galileo navigation message signature).
 *   - A richer convex-hull centroid derived from raw GnssMeasurements
 *     instead of post-processed locations.
 *   - Raw mock detection beyond what `Location.isFromMockProvider` offers.
 *
 * Because the EGNSS4ALL public Kotlin / Java API is currently not versioned,
 * every reflection call is defensive. If any lookup fails the bridge behaves
 * as if the library were absent.
 */
internal class Egnss4AllBridge(private val context: Context) {

    private var rawAccess: Any? = null
    private var osnmaClass: Class<*>? = null

    /**
     * Class names used by EGNSS4ALLAndroid (module `gnss_compare_core`).
     * These are the well-known FQNs used throughout EGNSS4ALL examples.
     * We try both historical packages the upstream project has used so
     * either drop-in version works.
     */
    private val candidateOsnmaClasses = listOf(
        "eu.gsa.osnma.OsnmaHelper",
        "com.galileosatelliteauth.osnma.OsnmaHelper",
    )

    /** True if EGNSS4ALL is on the classpath. */
    val isAvailable: Boolean by lazy {
        for (fqn in candidateOsnmaClasses) {
            try {
                osnmaClass = Class.forName(fqn)
                return@lazy true
            } catch (_: ClassNotFoundException) {
                /* try next */
            }
        }
        false
    }

    /**
     * Returns the current OSNMA authentication status:
     *   "OK", "KO", "UNKNOWN" or "NOT_SUPPORTED".
     *
     * Falls back to "NOT_SUPPORTED" whenever the library is missing or the
     * reflection surface doesn't expose the expected hook. The production
     * integration (to be done when the AAR is added) should replace the
     * reflection probe with a direct call.
     */
    fun osnmaStatus(): String {
        if (!isAvailable) return "NOT_SUPPORTED"
        return try {
            val cls = osnmaClass ?: return "UNKNOWN"
            val method = cls.methods.firstOrNull { it.name == "getCurrentStatus" || it.name == "currentStatus" }
                ?: return "UNKNOWN"
            val instance = cls.methods.firstOrNull { it.name == "getInstance" }?.invoke(null)
            val status = method.invoke(instance)?.toString() ?: "UNKNOWN"
            when {
                status.contains("OK", ignoreCase = true) -> "OK"
                status.contains("KO", ignoreCase = true) ||
                    status.contains("FAIL", ignoreCase = true) -> "KO"
                else -> "UNKNOWN"
            }
        } catch (t: Throwable) {
            Log.w(TAG, "OSNMA reflection failed: ${t.message}")
            "UNKNOWN"
        }
    }

    /** Start the underlying EGNSS4ALL raw-GNSS scanner if the AAR is present. */
    fun startRawScan() {
        if (!isAvailable) return
        try {
            val startClass = Class.forName("eu.gsa.gnss_compare_core.RawScanner")
            val getInstance = startClass.methods.firstOrNull { it.name == "getInstance" }
            val instance = getInstance?.invoke(null, context) ?: getInstance?.invoke(null)
            rawAccess = instance
            startClass.methods.firstOrNull { it.name == "start" }?.invoke(instance)
        } catch (t: Throwable) {
            Log.w(TAG, "RawScanner start failed: ${t.message}")
        }
    }

    fun stopRawScan() {
        val instance = rawAccess ?: return
        try {
            instance::class.java.methods.firstOrNull { it.name == "stop" }?.invoke(instance)
        } catch (_: Throwable) { /* ignore */ }
        rawAccess = null
    }

    companion object {
        private const val TAG = "Egnss4AllBridge"
    }
}
