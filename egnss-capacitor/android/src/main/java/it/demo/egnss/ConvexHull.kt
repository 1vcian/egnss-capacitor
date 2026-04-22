package it.demo.egnss

import kotlin.math.sign

/**
 * Kotlin port of the innermost convex-hull centroid used by the web
 * shared/convex-hull.ts. Kept here as a small, dependency-free utility
 * so this plugin compiles cleanly even before the EGNSS4ALL AARs are
 * dropped in (P5).
 *
 * When EGNSS4ALL is integrated, the adapter in [Egnss4AllBridge] forwards
 * to its own `convex_hull` module; otherwise [innermostCentroid] is used
 * as a fallback.
 */
internal object ConvexHull {

    data class P(val lat: Double, val lon: Double)

    fun innermostCentroid(samples: List<P>): P? {
        if (samples.isEmpty()) return null
        if (samples.size < 4) return mean(samples)

        val hull = convexHull(samples).toHashSet()
        val inliers = samples.filterNot { it in hull }
        val pool = if (inliers.size >= 3) inliers else samples
        return mean(pool)
    }

    fun mean(points: List<P>): P? {
        if (points.isEmpty()) return null
        var lat = 0.0
        var lon = 0.0
        for (p in points) {
            lat += p.lat
            lon += p.lon
        }
        return P(lat / points.size, lon / points.size)
    }

    /** Andrew's monotone-chain convex hull (CCW, first vertex not repeated). */
    fun convexHull(samples: List<P>): List<P> {
        if (samples.size < 3) return samples.toList()
        val pts = samples.sortedWith(compareBy({ it.lon }, { it.lat }))

        val lower = ArrayDeque<P>()
        for (p in pts) {
            while (lower.size >= 2 && cross(lower[lower.size - 2], lower.last(), p).sign <= 0) {
                lower.removeLast()
            }
            lower.addLast(p)
        }

        val upper = ArrayDeque<P>()
        for (i in pts.indices.reversed()) {
            val p = pts[i]
            while (upper.size >= 2 && cross(upper[upper.size - 2], upper.last(), p).sign <= 0) {
                upper.removeLast()
            }
            upper.addLast(p)
        }

        lower.removeLast()
        upper.removeLast()
        return lower + upper
    }

    private fun cross(a: P, b: P, c: P): Double =
        (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon)
}
