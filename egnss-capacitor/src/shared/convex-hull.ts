/**
 * Innermost convex-hull centroid, used to filter out spurious GNSS
 * samples and compute a more stable position.
 *
 * Port of the algorithm that EGNSS4ALL uses on Android (module
 * `convex_hull`) and on iOS (`Model/ConvexHull/CHQuickHull.swift`):
 *
 *   1. Compute the convex hull of the sample set (gift-wrapping /
 *      Andrew's monotone chain is used here — O(n log n)).
 *   2. Keep only the inner points (= samples that are *not* vertices
 *      of the hull). These are considered "inliers".
 *   3. If fewer than 3 inliers remain, fall back to the centroid of
 *      all samples to avoid returning `null` for small sets.
 *   4. Return the centroid (arithmetic mean) of the inliers.
 *
 * The algorithm works in latitude/longitude space directly; for the
 * small spatial extent typical of a single GNSS session (<<1 km) the
 * resulting error from not projecting to a planar CRS is well below
 * the GNSS noise we are trying to filter.
 */

export interface Point2D {
  lat: number;
  lon: number;
}

/** Compute the centroid after discarding the outer convex hull. */
export function innermostConvexHullCentroid(samples: Point2D[]): Point2D | null {
  if (samples.length === 0) return null;
  if (samples.length < 4) return arithmeticMean(samples);

  const hull = convexHull(samples);
  const hullSet = new Set(hull.map(pointKey));
  const inliers = samples.filter((p) => !hullSet.has(pointKey(p)));

  const pool = inliers.length >= 3 ? inliers : samples;
  return arithmeticMean(pool);
}

/** Standard arithmetic mean of a set of coordinates. */
export function arithmeticMean(points: Point2D[]): Point2D | null {
  if (points.length === 0) return null;
  let latSum = 0;
  let lonSum = 0;
  for (const p of points) {
    latSum += p.lat;
    lonSum += p.lon;
  }
  return { lat: latSum / points.length, lon: lonSum / points.length };
}

/**
 * Andrew's monotone chain algorithm.
 * Returns the convex hull in CCW order (first point is not repeated).
 */
export function convexHull(samples: Point2D[]): Point2D[] {
  if (samples.length < 3) return [...samples];
  const pts = [...samples].sort((a, b) => (a.lon === b.lon ? a.lat - b.lat : a.lon - b.lon));

  const lower: Point2D[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point2D[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
}

function pointKey(p: Point2D): string {
  return `${p.lat.toFixed(8)},${p.lon.toFixed(8)}`;
}
