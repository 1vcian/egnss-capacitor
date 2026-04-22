/**
 * Classify a Bluetooth device discovered during the antenna scan.
 *
 * We receive both bonded classic devices (phones, speakers, headsets,
 * keyboards, …) and every BLE peripheral advertising nearby, so connecting
 * to the first one is never safe. This module scores each candidate so
 * the picker can put real GNSS receivers on top and warn the user before
 * pairing something odd.
 *
 * Heuristic sources:
 *   - Advertised name contains a well-known GNSS brand / keyword.
 *   - Name matches typical consumer GNSS patterns (e.g. "GPS", "RTK",
 *     "NMEA", "Reach"...).
 *   - Name clearly indicates a non-GNSS peripheral (headphones,
 *     keyboards, mice, speakers, smartwatches, phones).
 */

/** Keywords that strongly indicate a GNSS receiver. */
const GNSS_KEYWORDS = [
  'gnss', 'gps', 'rtk', 'nmea',
  'u-blox', 'ublox', 'ardusimple',
  'bad elf', 'badelf',
  'garmin glo', 'glo 2',
  'xgps', 'dual xgps', 'dualav',
  'stonex', 'emlid', 'reach', 'sxblue', 'geode',
  'trimble', 'juniper', 'facet', 'sparkfun rtk',
  'leica', 'topcon', 'spectra', 'tersus',
  'holux', 'qstarz', 'columbus', 'skytraq',
  'chcnav', 'south',
];

/** Keywords that clearly mark a device as "not a GNSS receiver". */
const NON_GNSS_KEYWORDS = [
  // Audio
  'wh-', 'wf-', 'hd ', 'airpods', 'beats', 'jbl', 'bose', 'sony', 'jabra',
  'soundcore', 'earbud', 'earphone', 'headphone', 'headset', 'buds',
  'speaker', 'echo', 'homepod', 'sonos',
  // Input
  'keyboard', 'mouse', 'trackpad', 'magic ',
  // Wearables / smartwatches
  'watch', 'mi band', 'fitbit', 'garmin forerunner', 'garmin venu',
  'garmin fenix', 'apple watch',
  // Phones / tablets
  'iphone', 'ipad', 'macbook', 'galaxy', 'pixel',
  // Car / IoT
  'tesla', 'tile', 'airtag', 'smartthings',
];

/**
 * @param {{id: string, name?: string | null, rssi?: number}} device
 * @returns {{
 *   score: number,           // higher = more likely a GNSS receiver
 *   kind: 'gnss' | 'unknown' | 'non-gnss',
 *   hint: string,            // human explanation shown in the picker
 * }}
 */
export function classifyAntenna(device) {
  const name = (device.name ?? '').trim();
  const lc = name.toLowerCase();
  if (!name) {
    return {
      score: 0,
      kind: 'unknown',
      hint: 'Unnamed Bluetooth device — tap to try pairing anyway.',
    };
  }

  for (const kw of NON_GNSS_KEYWORDS) {
    if (lc.includes(kw)) {
      return {
        score: -10,
        kind: 'non-gnss',
        hint: `Looks like ${prettyCategory(kw)} — not a GNSS receiver.`,
      };
    }
  }

  for (const kw of GNSS_KEYWORDS) {
    if (lc.includes(kw)) {
      return {
        score: 10,
        kind: 'gnss',
        hint: `Matches known GNSS keyword "${kw}".`,
      };
    }
  }

  return {
    score: 1,
    kind: 'unknown',
    hint: 'Unknown Bluetooth device — tap to try pairing anyway.',
  };
}

function prettyCategory(kw) {
  if (['wh-', 'wf-', 'airpods', 'beats', 'jbl', 'bose', 'sony', 'jabra', 'soundcore',
       'earbud', 'earphone', 'headphone', 'headset', 'buds'].includes(kw))
    return 'headphones / earbuds';
  if (['speaker', 'echo', 'homepod', 'sonos'].includes(kw)) return 'a speaker';
  if (['keyboard', 'mouse', 'trackpad', 'magic '].includes(kw)) return 'an input device';
  if (['watch', 'mi band', 'fitbit'].some((k) => kw.includes(k))) return 'a smartwatch / fitness band';
  if (['iphone', 'ipad', 'macbook', 'galaxy', 'pixel'].includes(kw)) return 'a phone / tablet / laptop';
  if (['tile', 'airtag'].includes(kw)) return 'a tracker tag';
  return 'a non-GNSS device';
}

/**
 * Sort the discovered devices best-first (GNSS > unknown > non-GNSS),
 * tie-breaking by RSSI where available, then by name.
 */
export function sortAntennas(devices) {
  return [...devices]
    .map((d) => ({ device: d, meta: classifyAntenna(d) }))
    .sort((a, b) => {
      if (a.meta.score !== b.meta.score) return b.meta.score - a.meta.score;
      const rssiA = a.device.rssi ?? -999;
      const rssiB = b.device.rssi ?? -999;
      if (rssiA !== rssiB) return rssiB - rssiA;
      return (a.device.name ?? '').localeCompare(b.device.name ?? '');
    });
}
