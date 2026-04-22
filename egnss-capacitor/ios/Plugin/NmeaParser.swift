import Foundation

/// Minimal NMEA 0183 parser for the external Bluetooth path on iOS.
/// Mirrors `src/shared/nmea-parser.ts` and the Kotlin `NmeaParser.kt`.
enum NmeaParser {

    struct Gga {
        let latitude: Double
        let longitude: Double
        let altitude: Double
        let fixQuality: Int
        let satellites: Int
        let hdop: Double
    }

    struct Rmc {
        let latitude: Double
        let longitude: Double
        let active: Bool
        let speedMs: Double?
        let bearing: Double?
    }

    struct Gsa {
        let hdop: Double
    }

    struct Parsed {
        var gga: Gga?
        var rmc: Rmc?
        var gsa: Gsa?
        var constellations: Set<String>
    }

    static func verifyChecksum(_ sentence: String) -> Bool {
        guard let start = sentence.firstIndex(of: "$"),
              let star = sentence.firstIndex(of: "*"),
              sentence.distance(from: start, to: star) > 1 else { return false }
        let body = sentence[sentence.index(after: start)..<star]
        let after = sentence[sentence.index(after: star)...]
        let sumHex = String(after.prefix(2)).uppercased()
        var calc: UInt8 = 0
        for b in body.utf8 { calc ^= b }
        let calcStr = String(format: "%02X", calc)
        return calcStr == sumHex
    }

    /// Parse a stream chunk using a carried-over prefix. Returns the aggregate
    /// plus the new carry.
    static func parseStream(chunk: String, carry: String) -> (Parsed, String) {
        let combined = carry + chunk
        var parts = combined.components(separatedBy: CharacterSet(charactersIn: "\r\n"))
            .filter { !$0.isEmpty }
        // Only sentences followed by a newline in the input are "complete";
        // the last fragment may or may not be complete. We conservatively treat
        // the last element as carry when the input didn't end with a newline.
        let newCarry: String
        if let last = combined.last, last != "\n" && last != "\r" {
            newCarry = parts.popLast() ?? ""
        } else {
            newCarry = ""
        }

        var parsed = Parsed(gga: nil, rmc: nil, gsa: nil, constellations: [])
        for raw in parts {
            guard verifyChecksum(raw),
                  let star = raw.firstIndex(of: "*") else { continue }
            let body = String(raw[raw.index(after: raw.startIndex)..<star])
            let fields = body.components(separatedBy: ",")
            guard let id = fields.first, id.count >= 5 else { continue }
            let talker = String(id.prefix(2))
            let type = String(id.suffix(3))
            switch type {
            case "GGA":
                if let g = parseGga(fields) { parsed.gga = g }
            case "RMC":
                if let r = parseRmc(fields) { parsed.rmc = r }
            case "GSA":
                if let g = parseGsa(fields) { parsed.gsa = g }
            case "GSV":
                if let c = talkerConstellation(talker) { parsed.constellations.insert(c) }
            default:
                break
            }
        }
        return (parsed, newCarry)
    }

    // MARK: - Helpers

    private static func parseGga(_ f: [String]) -> Gga? {
        guard f.count >= 10,
              let lat = latLon(f[safe: 2], f[safe: 3]),
              let lon = latLon(f[safe: 4], f[safe: 5]) else { return nil }
        return Gga(
            latitude: lat,
            longitude: lon,
            altitude: Double(f[safe: 9] ?? "") ?? 0,
            fixQuality: Int(f[safe: 6] ?? "0") ?? 0,
            satellites: Int(f[safe: 7] ?? "0") ?? 0,
            hdop: Double(f[safe: 8] ?? "0") ?? 0
        )
    }

    private static func parseRmc(_ f: [String]) -> Rmc? {
        guard f.count >= 7,
              let lat = latLon(f[safe: 3], f[safe: 4]),
              let lon = latLon(f[safe: 5], f[safe: 6]) else { return nil }
        let active = (f[safe: 2] ?? "V").uppercased() == "A"
        let knots = Double(f[safe: 7] ?? "")
        let bearing = Double(f[safe: 8] ?? "")
        return Rmc(
            latitude: lat,
            longitude: lon,
            active: active,
            speedMs: knots.map { $0 * 0.514444 },
            bearing: bearing
        )
    }

    private static func parseGsa(_ f: [String]) -> Gsa? {
        guard f.count >= 18 else { return nil }
        return Gsa(hdop: Double(f[safe: 16] ?? "0") ?? 0)
    }

    private static func latLon(_ value: String?, _ hemi: String?) -> Double? {
        guard let value = value, let hemi = hemi,
              !value.isEmpty, !hemi.isEmpty, value.count >= 4 else { return nil }
        let dotIdx = value.firstIndex(of: ".")
        let degLen: Int
        if let di = dotIdx {
            degLen = value.distance(from: value.startIndex, to: di) - 2
        } else {
            degLen = value.count - 2
        }
        guard degLen > 0 else { return nil }
        let degStr = String(value.prefix(degLen))
        let minStr = String(value.dropFirst(degLen))
        guard let deg = Double(degStr), let min = Double(minStr) else { return nil }
        var dec = deg + min / 60
        let h = hemi.uppercased()
        if h == "S" || h == "W" { dec = -dec }
        return dec
    }

    private static func talkerConstellation(_ talker: String) -> String? {
        switch talker {
        case "GP": return "GPS"
        case "GL": return "GLONASS"
        case "GA": return "GALILEO"
        case "GB": return "BEIDOU"
        case "GQ": return "QZSS"
        case "GI": return "IRNSS"
        case "GN": return "GPS"
        default: return nil
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
