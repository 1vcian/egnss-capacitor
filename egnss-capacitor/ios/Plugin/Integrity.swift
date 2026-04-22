import Foundation

/// Swift mirror of the integrity rules in `src/shared/integrity.ts`.
enum Integrity {
    struct InputFix {
        let hAccuracy: Double
        let isMockLocation: Bool
        let osnmaOk: Bool
        let egnosActive: Bool
        let fromExternalAntenna: Bool
    }

    static func level(
        _ fix: InputFix,
        minAccuracyMeters: Double,
        requireOsnma: Bool
    ) -> String {
        if fix.isMockLocation { return "UNTRUSTED" }
        let accurate = fix.hAccuracy > 0 && fix.hAccuracy <= minAccuracyMeters
        if !accurate { return "LOW" }
        if fix.osnmaOk { return "HIGH" }
        if requireOsnma { return "LOW" }
        if fix.egnosActive || fix.fromExternalAntenna { return "STANDARD" }
        return "STANDARD"
    }
}
