/**
 * Pure-JS NMEA 0183 parser used by the web implementation when a
 * Bluetooth antenna is connected through Web Bluetooth.
 *
 * The native Android and iOS implementations parse NMEA with their
 * own platform-level listeners (and, on Android, reuse the more
 * complete parser that ships inside EGNSS4ALL); this JS parser only
 * covers what the web target needs:
 *
 *   - $xxGGA — position + fix quality (EGNOS flag = quality == 2)
 *   - $xxRMC — time + position + speed + bearing + validity
 *   - $xxGSA — DOP and active satellites
 *   - $xxGSV — satellites in view (used for constellation stats)
 *
 * Every sentence goes through checksum validation. Invalid or
 * unrecognized sentences yield `null`.
 */

import type { Constellation } from '../definitions';

export interface NmeaGga {
  time: string;
  latitude: number;
  longitude: number;
  /** 0=invalid, 1=GPS, 2=DGPS/SBAS/EGNOS, 4=RTK fix, 5=RTK float, 6=estimated. */
  fixQuality: number;
  satellites: number;
  hdop: number;
  altitude: number;
}

export interface NmeaRmc {
  time: string;
  active: boolean;
  latitude: number;
  longitude: number;
  /** m/s */
  speed?: number;
  /** 0–360 */
  bearing?: number;
}

export interface NmeaGsa {
  /** 1 = no fix, 2 = 2D, 3 = 3D */
  fixType: number;
  pdop: number;
  hdop: number;
  vdop: number;
}

export interface NmeaGsv {
  talker: Constellation;
  /** Total satellites visible for this talker in this cycle. */
  satellitesInView: number;
}

export type NmeaSentence =
  | { type: 'GGA'; data: NmeaGga }
  | { type: 'RMC'; data: NmeaRmc }
  | { type: 'GSA'; data: NmeaGsa }
  | { type: 'GSV'; data: NmeaGsv }
  | { type: 'OTHER'; talker: string; raw: string };

/** Validate the XOR checksum of an NMEA sentence (everything between '$' and '*'). */
export function verifyChecksum(sentence: string): boolean {
  const start = sentence.indexOf('$');
  const star = sentence.indexOf('*');
  if (start < 0 || star < 0 || star <= start + 1) return false;
  const body = sentence.slice(start + 1, star);
  const sumStr = sentence.slice(star + 1, star + 3).toUpperCase();
  let calc = 0;
  for (let i = 0; i < body.length; i++) {
    calc ^= body.charCodeAt(i);
  }
  const calcStr = calc.toString(16).toUpperCase().padStart(2, '0');
  return calcStr === sumStr.slice(0, 2);
}

const TALKER_TO_CONSTELLATION: Record<string, Constellation> = {
  GP: 'GPS',
  GL: 'GLONASS',
  GA: 'GALILEO',
  GB: 'BEIDOU',
  GQ: 'QZSS',
  GI: 'IRNSS',
  GN: 'GPS', // GNSS combined — reported as GPS for cosmetics
};

export function parseNmeaSentence(sentence: string): NmeaSentence | null {
  const trimmed = sentence.trim();
  if (!trimmed.startsWith('$') || !verifyChecksum(trimmed)) return null;

  const body = trimmed.slice(1, trimmed.indexOf('*'));
  const fields = body.split(',');
  const id = fields[0];
  if (!id || id.length < 5) return null;
  const talker = id.slice(0, 2);
  const type = id.slice(2);

  switch (type) {
    case 'GGA': {
      const data = parseGga(fields);
      return data ? { type: 'GGA', data } : null;
    }
    case 'RMC': {
      const data = parseRmc(fields);
      return data ? { type: 'RMC', data } : null;
    }
    case 'GSA': {
      const data = parseGsa(fields);
      return data ? { type: 'GSA', data } : null;
    }
    case 'GSV': {
      const data = parseGsv(fields, talker);
      return data ? { type: 'GSV', data } : null;
    }
    default:
      return { type: 'OTHER', talker, raw: trimmed };
  }
}

/** Split a stream buffer into individual NMEA sentences (CR/LF terminated). */
export function splitNmeaStream(chunk: string, carry: string): { sentences: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split(/\r?\n/);
  const nextCarry = parts.pop() ?? '';
  return { sentences: parts.filter((p) => p.length > 0), carry: nextCarry };
}

function parseGga(f: string[]): NmeaGga | null {
  if (f.length < 10) return null;
  const lat = parseLatLon(f[2], f[3]);
  const lon = parseLatLon(f[4], f[5]);
  if (lat == null || lon == null) return null;
  return {
    time: f[1] ?? '',
    latitude: lat,
    longitude: lon,
    fixQuality: parseInt(f[6] ?? '0', 10) || 0,
    satellites: parseInt(f[7] ?? '0', 10) || 0,
    hdop: parseFloat(f[8] ?? '0') || 0,
    altitude: parseFloat(f[9] ?? '0') || 0,
  };
}

function parseRmc(f: string[]): NmeaRmc | null {
  if (f.length < 7) return null;
  const active = (f[2] ?? 'V').toUpperCase() === 'A';
  const lat = parseLatLon(f[3], f[4]);
  const lon = parseLatLon(f[5], f[6]);
  if (lat == null || lon == null) return null;
  const knots = f[7] ? parseFloat(f[7]) : NaN;
  const bearing = f[8] ? parseFloat(f[8]) : NaN;
  return {
    time: f[1] ?? '',
    active,
    latitude: lat,
    longitude: lon,
    speed: Number.isFinite(knots) ? knots * 0.514444 : undefined, // knots → m/s
    bearing: Number.isFinite(bearing) ? bearing : undefined,
  };
}

function parseGsa(f: string[]): NmeaGsa | null {
  if (f.length < 18) return null;
  return {
    fixType: parseInt(f[2] ?? '1', 10) || 1,
    pdop: parseFloat(f[15] ?? '0') || 0,
    hdop: parseFloat(f[16] ?? '0') || 0,
    vdop: parseFloat(f[17] ?? '0') || 0,
  };
}

function parseGsv(f: string[], talker: string): NmeaGsv | null {
  if (f.length < 4) return null;
  const sat = parseInt(f[3] ?? '0', 10);
  if (!Number.isFinite(sat)) return null;
  return {
    talker: TALKER_TO_CONSTELLATION[talker] ?? 'UNKNOWN',
    satellitesInView: sat,
  };
}

function parseLatLon(value: string | undefined, hemisphere: string | undefined): number | null {
  if (!value || !hemisphere) return null;
  if (value.length < 4) return null;
  // NMEA format: ddmm.mmmm / dddmm.mmmm
  const dotIdx = value.indexOf('.');
  const degLen = dotIdx > 0 ? dotIdx - 2 : value.length - 2;
  if (degLen <= 0) return null;
  const deg = parseFloat(value.slice(0, degLen));
  const min = parseFloat(value.slice(degLen));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  let dec = deg + min / 60;
  const h = hemisphere.toUpperCase();
  if (h === 'S' || h === 'W') dec = -dec;
  return dec;
}
