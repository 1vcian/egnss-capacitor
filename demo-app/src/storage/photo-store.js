import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory } from '@capacitor/filesystem';

/**
 * Persistent storage for geotagged photos.
 *
 * - Metadata + the full GnssFix snapshot → Capacitor Preferences (JSON).
 * - Image bytes                          → Capacitor Filesystem in Directory.Data.
 * - A small 96×96 thumbnail              → Preferences as data: URI, used for
 *                                          the map marker and popup preview.
 *
 * On web, Filesystem falls back to IndexedDB; both APIs work uniformly across
 * the three targets, so the consumer does not branch on platform.
 *
 * @typedef {Object} PhotoRecord
 * @property {string} id
 * @property {string} fileName
 * @property {string} fileUri        Path returned by Filesystem.writeFile.
 * @property {string} thumbUri       Base64 data URI of a 96×96 PNG preview.
 * @property {number} thumbSize      Thumbnail edge in CSS pixels (always 96).
 * @property {number} lat
 * @property {number} lon
 * @property {number} timestamp
 * @property {'HIGH' | 'STANDARD' | 'LOW' | 'UNTRUSTED'} integrityLevel
 * @property {'INTERNAL_GNSS' | 'EXTERNAL_BT' | 'WEB_GEOLOC'} source
 * @property {number} hAccuracy
 * @property {import('egnss-capacitor').GnssFix} fix   Full fix snapshot at capture time.
 * @property {{minAccuracyMeters: number, requireOsnma: boolean}} options
 */

const KEY = 'demoposition.photos.v1';
export const THUMB_SIZE = 96; // px, exposed so the map marker knows the exact size.

export async function listPhotos() {
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return [];
  try {
    const records = JSON.parse(value);
    if (!Array.isArray(records)) return [];
    // Heal legacy records: before PHOTO_MARKER_PX / width+height landed, a
    // few captures persisted a full-resolution data URI as `thumbUri`. On
    // the map that produced a marker the size of the viewport. Regenerate
    // the thumbnail the first time we see such a record so the UI behaves.
    let mutated = false;
    const healed = await Promise.all(
      records.map(async (r) => {
        if (!r?.thumbUri) return r;
        if (r.thumbSize === THUMB_SIZE) return r;
        if (typeof r.thumbUri === 'string' && r.thumbUri.length < 40_000) return r;
        try {
          const smaller = await makeThumbnail(r.thumbUri, THUMB_SIZE);
          mutated = true;
          return { ...r, thumbUri: smaller, thumbSize: THUMB_SIZE };
        } catch {
          return r;
        }
      }),
    );
    if (mutated) {
      await Preferences.set({ key: KEY, value: JSON.stringify(healed) });
    }
    return healed;
  } catch {
    return [];
  }
}

/**
 * Persist a captured photo.
 * @param {{
 *   base64: string,
 *   fix: import('egnss-capacitor').GnssFix,
 *   mime?: string,
 *   options?: {minAccuracyMeters: number, requireOsnma: boolean},
 * }} input
 * @returns {Promise<PhotoRecord>}
 */
export async function savePhoto({ base64, fix, mime = 'image/jpeg', options }) {
  const id = String(fix.timestamp) + '-' + Math.random().toString(36).slice(2, 8);
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const fileName = `${id}.${ext}`;

  const writeResult = await Filesystem.writeFile({
    path: `photos/${fileName}`,
    data: base64,
    directory: Directory.Data,
    recursive: true,
  });

  const thumbUri = await makeThumbnail(`data:${mime};base64,${base64}`, THUMB_SIZE);

  const record = {
    id,
    fileName,
    fileUri: writeResult.uri,
    thumbUri,
    thumbSize: THUMB_SIZE,
    lat: fix.lat,
    lon: fix.lon,
    timestamp: fix.timestamp,
    integrityLevel: fix.integrityLevel,
    source: fix.source,
    hAccuracy: fix.hAccuracy,
    fix,
    options: options ?? { minAccuracyMeters: 10, requireOsnma: false },
  };

  const existing = await listPhotos();
  const next = [...existing, record];
  await Preferences.set({ key: KEY, value: JSON.stringify(next) });

  return record;
}

/**
 * Read the full image bytes of a previously saved photo as a data: URI.
 * Used by the lightbox to display the real photo (not the thumbnail).
 * @param {PhotoRecord} record
 */
export async function readPhotoDataUrl(record) {
  const mime = record.fileName.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const { data } = await Filesystem.readFile({
    path: `photos/${record.fileName}`,
    directory: Directory.Data,
  });
  // On native, Filesystem.readFile returns a base64 string; on web it may
  // return a Blob — handle both defensively.
  if (typeof data === 'string') {
    return `data:${mime};base64,${data}`;
  }
  return await blobToDataUrl(data);
}

export async function deletePhoto(id) {
  const existing = await listPhotos();
  const target = existing.find((r) => r.id === id);
  if (!target) return;

  try {
    await Filesystem.deleteFile({
      path: `photos/${target.fileName}`,
      directory: Directory.Data,
    });
  } catch {
    // File may be missing on web storage after a reset; metadata cleanup still happens.
  }
  const next = existing.filter((r) => r.id !== id);
  await Preferences.set({ key: KEY, value: JSON.stringify(next) });
}

export function isNativePlatform() {
  return Capacitor.isNativePlatform();
}

/**
 * Draw the source image onto a canvas of fixed size (keeping aspect-ratio)
 * and export a PNG base64 data URI. Guarantees the icon used by OpenLayers
 * has a predictable on-screen footprint.
 *
 * @param {string} dataUrl
 * @param {number} size  Output canvas edge in pixels (square).
 * @returns {Promise<string>}
 */
function makeThumbnail(dataUrl, size) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      // Center-crop so the thumbnail stays square.
      const src = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - src) / 2;
      const sy = (img.naturalHeight - src) / 2;
      ctx.drawImage(img, sx, sy, src, src, 0, 0, size, size);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl); // fallback: return as-is
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
