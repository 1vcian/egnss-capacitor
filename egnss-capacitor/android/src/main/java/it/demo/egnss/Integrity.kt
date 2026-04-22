package it.demo.egnss

/** Kotlin mirror of the integrity rules defined in `src/shared/integrity.ts`. */
internal object Integrity {

    data class InputFix(
        val hAccuracy: Double,
        val isMockLocation: Boolean,
        val osnmaOk: Boolean,
        val egnosActive: Boolean,
        val fromExternalAntenna: Boolean,
    )

    fun level(
        fix: InputFix,
        minAccuracyMeters: Double,
        requireOsnma: Boolean,
    ): String {
        if (fix.isMockLocation) return "UNTRUSTED"
        val accurate = fix.hAccuracy > 0 && fix.hAccuracy <= minAccuracyMeters
        if (!accurate) return "LOW"
        if (fix.osnmaOk) return "HIGH"
        if (requireOsnma) return "LOW"
        if (fix.egnosActive || fix.fromExternalAntenna) return "STANDARD"
        return "STANDARD"
    }
}
