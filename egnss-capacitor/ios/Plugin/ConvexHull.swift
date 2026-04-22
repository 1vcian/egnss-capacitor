import Foundation

/**
 * Swift port of the innermost convex-hull centroid used by the shared
 * JS helper (`src/shared/convex-hull.ts`) and the Android Kotlin
 * version (`ConvexHull.kt`). Kept small and dependency-free so the
 * plugin builds cleanly before the EGNSS4ALL-iOS ConvexHull module is
 * dropped in — when it is, `Egnss4AllSupport.convexCentroid` is used
 * in its place.
 */
enum ConvexHull {
    struct P: Hashable {
        let lat: Double
        let lon: Double
    }

    static func innermostCentroid(_ samples: [P]) -> P? {
        guard !samples.isEmpty else { return nil }
        if samples.count < 4 { return mean(samples) }
        let hull = Set(convexHull(samples))
        let inliers = samples.filter { !hull.contains($0) }
        let pool = inliers.count >= 3 ? inliers : samples
        return mean(pool)
    }

    static func mean(_ pts: [P]) -> P? {
        guard !pts.isEmpty else { return nil }
        var lat = 0.0
        var lon = 0.0
        for p in pts { lat += p.lat; lon += p.lon }
        return P(lat: lat / Double(pts.count), lon: lon / Double(pts.count))
    }

    /// Andrew's monotone-chain convex hull (CCW, first vertex not repeated).
    static func convexHull(_ samples: [P]) -> [P] {
        guard samples.count >= 3 else { return samples }
        let sorted = samples.sorted { a, b in
            a.lon == b.lon ? a.lat < b.lat : a.lon < b.lon
        }

        var lower: [P] = []
        for p in sorted {
            while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 {
                lower.removeLast()
            }
            lower.append(p)
        }

        var upper: [P] = []
        for p in sorted.reversed() {
            while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 {
                upper.removeLast()
            }
            upper.append(p)
        }

        lower.removeLast()
        upper.removeLast()
        return lower + upper
    }

    private static func cross(_ a: P, _ b: P, _ c: P) -> Double {
        (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon)
    }
}
