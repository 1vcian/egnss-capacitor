/**
 * Human-readable explanation for the `integrityLevel` of a GnssFix.
 *
 * Mirrors the rules in `egnss-capacitor/src/shared/integrity.ts`:
 *
 *   1. isMockLocation               → UNTRUSTED
 *   2. osnmaStatus === 'KO'         → UNTRUSTED (spoofing signal)
 *   3. hAccuracy > threshold        → LOW
 *   4. osnmaStatus === 'OK'         → HIGH
 *   5. requireOsnma but no OSNMA OK → LOW
 *   6. egnosActive || EXTERNAL_BT   → STANDARD
 *   7. otherwise                    → STANDARD
 *
 * @param {import('egnss-capacitor').GnssFix} fix
 * @param {{ minAccuracyMeters?: number, requireOsnma?: boolean }} [opts]
 * @returns {{
 *   level: 'HIGH' | 'STANDARD' | 'LOW' | 'UNTRUSTED',
 *   reasons: string[],          // bullet list shown to the user
 *   short: string,              // single-line summary
 * }}
 */
export function explainIntegrity(fix, opts = {}) {
  const { minAccuracyMeters = 10, requireOsnma = false } = opts;
  const reasons = [];

  if (fix.isMockLocation) {
    reasons.push(
      'The OS reports this fix came from a MOCK location provider (developer mode, fake GPS app, or emulator).',
    );
    return { level: 'UNTRUSTED', reasons, short: 'Mock / fake location detected.' };
  }

  if (fix.osnmaStatus === 'KO') {
    reasons.push(
      'Galileo OSNMA authentication failed: the received navigation message signature is invalid (possible spoofing).',
    );
    return { level: 'UNTRUSTED', reasons, short: 'OSNMA authentication failed.' };
  }

  const acc = Number(fix.hAccuracy);
  if (!(acc > 0) || acc > minAccuracyMeters) {
    reasons.push(
      `Horizontal accuracy is ±${acc.toFixed(1)} m, worse than the configured threshold (${minAccuracyMeters} m).`,
    );
    reasons.push(
      'Go outdoors with a clear view of the sky and wait for the satellite fix to settle — indoor / urban-canyon conditions usually give 15–50 m.',
    );
    return { level: 'LOW', reasons, short: `Accuracy ±${acc.toFixed(1)} m > ${minAccuracyMeters} m.` };
  }

  if (fix.osnmaStatus === 'OK') {
    reasons.push(
      `Galileo OSNMA signature is valid — the navigation data on at least ${fix.satellitesUsed ?? '?'} sats is authenticated.`,
    );
    reasons.push(
      `Accuracy is ±${acc.toFixed(1)} m, within the ${minAccuracyMeters} m threshold.`,
    );
    return { level: 'HIGH', reasons, short: 'OSNMA OK and accuracy within threshold.' };
  }

  if (requireOsnma) {
    reasons.push(
      'requireOsnma=true was passed, but no OSNMA-authenticated frame has arrived yet. Level is capped until one does.',
    );
    return { level: 'LOW', reasons, short: 'Waiting for OSNMA authentication.' };
  }

  const bits = [];
  if (fix.egnosActive) bits.push('EGNOS / SBAS corrections are applied');
  if (fix.source === 'EXTERNAL_BT') bits.push('fix comes from a paired external GNSS receiver');
  if (fix.source === 'INTERNAL_GNSS') bits.push('fix comes from the on-device GNSS chip');
  if (fix.source === 'WEB_GEOLOC') bits.push('fix comes from the browser geolocation API');

  bits.push(`accuracy ±${acc.toFixed(1)} m within ${minAccuracyMeters} m threshold`);
  if (fix.osnmaStatus === 'UNKNOWN') bits.push('OSNMA is supported but no authenticated frame yet');
  if (fix.osnmaStatus === 'NOT_SUPPORTED') bits.push('OSNMA is not available on this platform');

  reasons.push('Position is usable but not cryptographically authenticated:');
  for (const b of bits) reasons.push('• ' + b);

  return { level: 'STANDARD', reasons, short: 'Position usable, not OSNMA-authenticated.' };
}

/**
 * Short one-liner shown in lists / markers without unwrapping the object.
 */
export function explainIntegrityShort(fix, opts) {
  return explainIntegrity(fix, opts).short;
}
