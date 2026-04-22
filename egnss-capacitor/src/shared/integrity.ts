import type { GnssFix, IntegrityLevel } from '../definitions';

/**
 * Compute the {@link IntegrityLevel} of a fix from its raw fields.
 * The rules are the same on all platforms so they live in a single
 * shared module; the native implementations call the equivalent logic
 * on their side but the expected outcome matches this function.
 */
export function computeIntegrityLevel(
  fix: Omit<GnssFix, 'integrityLevel'>,
  opts: { minAccuracyMeters: number; requireOsnma: boolean },
): IntegrityLevel {
  if (fix.isMockLocation) {
    return 'UNTRUSTED';
  }
  const accurate = fix.hAccuracy > 0 && fix.hAccuracy <= opts.minAccuracyMeters;
  if (!accurate) {
    return 'LOW';
  }
  if (fix.osnmaStatus === 'OK') {
    return 'HIGH';
  }
  if (opts.requireOsnma) {
    return 'LOW';
  }
  if (fix.egnosActive || fix.source === 'EXTERNAL_BT') {
    return 'STANDARD';
  }
  return 'STANDARD';
}
