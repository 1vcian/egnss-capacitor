import type { GnssFix } from '../definitions';

/**
 * Wraps `navigator.geolocation.watchPosition` and emits minimal fixes
 * that the main plugin then enriches with integrity and centroid data.
 */
export class GeolocationSource {
  private watchId: number | null = null;

  start(onFix: (f: Partial<GnssFix>) => void, onError: (err: GeolocationPositionError) => void): void {
    if (this.watchId !== null) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      onError({
        code: 2,
        message: 'navigator.geolocation unavailable',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => onFix(toPartialFix(pos)),
      onError,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30_000,
      },
    );
  }

  stop(): void {
    if (this.watchId !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  }
}

function toPartialFix(pos: GeolocationPosition): Partial<GnssFix> {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    alt: pos.coords.altitude ?? 0,
    hAccuracy: pos.coords.accuracy,
    vAccuracy: pos.coords.altitudeAccuracy ?? 0,
    timestamp: pos.timestamp,
    speed: pos.coords.speed ?? undefined,
    bearing: pos.coords.heading ?? undefined,
    satellitesUsed: 0,
    satellitesVisible: 0,
    constellations: ['UNKNOWN'],
    egnosActive: false,
    osnmaStatus: 'NOT_SUPPORTED',
    isMockLocation: false,
    source: 'WEB_GEOLOC',
  };
}
