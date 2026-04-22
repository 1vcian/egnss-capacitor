package it.demo.egnss

/**
 * Minimal NMEA 0183 parser used on the BT SPP / BLE-UART path.
 * Android's internal GNSS exposes raw `NmeaMessage` to the
 * [GnssManager], where we let the platform do most of the work,
 * but when we feed bytes from an external Bluetooth receiver
 * we have to parse them ourselves.
 *
 * Mirrors the behaviour of the TypeScript parser used on the web.
 */
internal object NmeaParser {

    data class Gga(
        val latitude: Double,
        val longitude: Double,
        val altitude: Double,
        val fixQuality: Int,
        val satellites: Int,
        val hdop: Double,
    )

    data class Rmc(
        val latitude: Double,
        val longitude: Double,
        val active: Boolean,
        val speedMs: Double?,
        val bearing: Double?,
    )

    data class Gsa(val hdop: Double)

    data class Parsed(
        val gga: Gga? = null,
        val rmc: Rmc? = null,
        val gsa: Gsa? = null,
        val constellations: Set<String> = emptySet(),
    )

    fun verifyChecksum(sentence: String): Boolean {
        val start = sentence.indexOf('$')
        val star = sentence.indexOf('*')
        if (start < 0 || star < 0 || star <= start + 1) return false
        val body = sentence.substring(start + 1, star)
        val sumStr = sentence.substring(star + 1).take(2).uppercase()
        var calc = 0
        for (c in body) calc = calc xor c.code
        return calc.toString(16).uppercase().padStart(2, '0') == sumStr
    }

    /**
     * Parse a flat buffer of sentences (possibly with leftover carry from a
     * previous read) and return a [Parsed] aggregate containing the last GGA /
     * RMC / GSA seen, plus the set of constellation talkers reported via GSV.
     *
     * The [carry] is the incomplete trailing sentence that could not be
     * fully parsed; callers should pass it back in on the next call.
     */
    fun parseStream(chunk: String, carry: String): Pair<Parsed, String> {
        val combined = carry + chunk
        val parts = combined.split(Regex("\\r?\\n"))
        val nextCarry = parts.lastOrNull() ?: ""
        var gga: Gga? = null
        var rmc: Rmc? = null
        var gsa: Gsa? = null
        val constellations = linkedSetOf<String>()

        for (raw in parts.subList(0, parts.size - 1)) {
            if (raw.isBlank()) continue
            if (!verifyChecksum(raw)) continue
            val fields = raw.substring(1, raw.indexOf('*')).split(',')
            val id = fields.firstOrNull() ?: continue
            if (id.length < 5) continue
            val talker = id.substring(0, 2)
            when (id.substring(2)) {
                "GGA" -> parseGga(fields)?.let { gga = it }
                "RMC" -> parseRmc(fields)?.let { rmc = it }
                "GSA" -> parseGsa(fields)?.let { gsa = it }
                "GSV" -> talkerToConstellation(talker)?.let { constellations.add(it) }
            }
        }

        return Parsed(gga, rmc, gsa, constellations) to nextCarry
    }

    // --- internal ---

    private fun parseGga(f: List<String>): Gga? {
        if (f.size < 10) return null
        val lat = latLon(f.getOrNull(2), f.getOrNull(3)) ?: return null
        val lon = latLon(f.getOrNull(4), f.getOrNull(5)) ?: return null
        return Gga(
            latitude = lat,
            longitude = lon,
            altitude = f.getOrNull(9)?.toDoubleOrNull() ?: 0.0,
            fixQuality = f.getOrNull(6)?.toIntOrNull() ?: 0,
            satellites = f.getOrNull(7)?.toIntOrNull() ?: 0,
            hdop = f.getOrNull(8)?.toDoubleOrNull() ?: 0.0,
        )
    }

    private fun parseRmc(f: List<String>): Rmc? {
        if (f.size < 7) return null
        val lat = latLon(f.getOrNull(3), f.getOrNull(4)) ?: return null
        val lon = latLon(f.getOrNull(5), f.getOrNull(6)) ?: return null
        val active = (f.getOrNull(2) ?: "V").uppercase() == "A"
        val knots = f.getOrNull(7)?.toDoubleOrNull()
        val bearing = f.getOrNull(8)?.toDoubleOrNull()
        return Rmc(
            latitude = lat,
            longitude = lon,
            active = active,
            speedMs = knots?.let { it * 0.514444 },
            bearing = bearing,
        )
    }

    private fun parseGsa(f: List<String>): Gsa? {
        if (f.size < 18) return null
        return Gsa(hdop = f.getOrNull(16)?.toDoubleOrNull() ?: 0.0)
    }

    private fun latLon(value: String?, hemi: String?): Double? {
        if (value.isNullOrBlank() || hemi.isNullOrBlank() || value.length < 4) return null
        val dotIdx = value.indexOf('.')
        val degLen = if (dotIdx > 0) dotIdx - 2 else value.length - 2
        if (degLen <= 0) return null
        val deg = value.substring(0, degLen).toDoubleOrNull() ?: return null
        val min = value.substring(degLen).toDoubleOrNull() ?: return null
        var dec = deg + min / 60
        val h = hemi.uppercase()
        if (h == "S" || h == "W") dec = -dec
        return dec
    }

    private fun talkerToConstellation(talker: String): String? = when (talker) {
        "GP" -> "GPS"
        "GL" -> "GLONASS"
        "GA" -> "GALILEO"
        "GB" -> "BEIDOU"
        "GQ" -> "QZSS"
        "GI" -> "IRNSS"
        "GN" -> "GPS"
        else -> null
    }
}
