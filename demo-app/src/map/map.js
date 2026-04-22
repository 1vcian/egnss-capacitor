import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import XYZ from 'ol/source/XYZ.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Circle from 'ol/geom/Circle.js';
import Style from 'ol/style/Style.js';
import CircleStyle from 'ol/style/Circle.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Icon from 'ol/style/Icon.js';
import Text from 'ol/style/Text.js';
import { fromLonLat } from 'ol/proj.js';

/**
 * Target on-screen size (CSS px) of the photo marker. OL's `Icon` is told to
 * render exactly at this size via `width` / `height` — that way the marker
 * stays small even if `thumbUri` happens to be a full-resolution photo (older
 * records saved before thumbnails were generated sometimes land in that
 * bucket and otherwise take over the whole viewport).
 */
const PHOTO_MARKER_PX = 56;

/**
 * Create the OpenLayers map used by the demo.
 *
 * Basemap: Esri World Imagery (free tier with attribution).
 *
 * Three vector layers on top:
 *   - markersLayer:   user-placed geotagged photos (A3).
 *   - positionLayer:  live "you are here" marker + accuracy circle (A1).
 *   - photoPinLayer:  same source as markers but rendered above.
 *
 * @param {HTMLElement} target
 */
export function createMap(target) {
  const esri = new TileLayer({
    source: new XYZ({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attributions:
        'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
      tileSize: 256,
      crossOrigin: 'anonymous',
    }),
  });

  const markersSource = new VectorSource();
  const markersLayer = new VectorLayer({
    source: markersSource,
    style: photoMarkerStyle,
  });

  const positionSource = new VectorSource();
  const positionLayer = new VectorLayer({
    source: positionSource,
    style: positionMarkerStyle,
  });

  const map = new Map({
    target,
    layers: [esri, markersLayer, positionLayer],
    view: new View({
      center: fromLonLat([12.4964, 41.9028]),
      zoom: 5,
      maxZoom: 19,
    }),
    controls: [],
  });

  // Live position + accuracy circle are mutable singletons.
  let positionFeature = null;
  let accuracyFeature = null;
  let hasAutoCentered = false;

  return {
    map,
    markersLayer,
    markersSource,
    positionLayer,
    positionSource,

    /**
     * Update the live position marker from a GnssFix. The first call auto-
     * centers the map on the location; subsequent calls only update the
     * geometry so the user can pan freely without being snapped back.
     */
    updatePosition(fix) {
      const coord = fromLonLat([fix.lon, fix.lat]);
      if (!positionFeature) {
        positionFeature = new Feature({ geometry: new Point(coord), kind: 'position' });
        accuracyFeature = new Feature({
          geometry: new Circle(coord, fix.hAccuracy || 1),
          kind: 'accuracy',
        });
        positionSource.addFeatures([accuracyFeature, positionFeature]);
      } else {
        positionFeature.getGeometry().setCoordinates(coord);
        accuracyFeature.getGeometry().setCenter(coord);
        accuracyFeature.getGeometry().setRadius(fix.hAccuracy || 1);
      }
      positionFeature.set('integrityLevel', fix.integrityLevel);

      if (!hasAutoCentered) {
        hasAutoCentered = true;
        map.getView().animate({ center: coord, zoom: 17, duration: 600 });
      }
    },

    /**
     * Force the map to re-center on the last known position (used by the
     * GPS FAB on subsequent taps).
     */
    recenterOnPosition() {
      if (!positionFeature) return false;
      map.getView().animate({
        center: positionFeature.getGeometry().getCoordinates(),
        zoom: Math.max(map.getView().getZoom(), 17),
        duration: 400,
      });
      return true;
    },

    addPhotoMarker(record) {
      const feat = new Feature({
        geometry: new Point(fromLonLat([record.lon, record.lat])),
        kind: 'photo',
        record,
      });
      markersSource.addFeature(feat);
      return feat;
    },

    clearPhotoMarkers() {
      markersSource.clear();
    },

    getMap() {
      return map;
    },
  };
}

/**
 * Style for the live-position blue dot + accuracy halo.
 */
function positionMarkerStyle(feature) {
  const kind = feature.get('kind');
  if (kind === 'accuracy') {
    return new Style({
      fill: new Fill({ color: 'rgba(59, 130, 246, 0.18)' }),
      stroke: new Stroke({ color: 'rgba(59, 130, 246, 0.55)', width: 1 }),
    });
  }

  const integrity = feature.get('integrityLevel') ?? 'STANDARD';
  const innerColor = integrityColor(integrity);

  return [
    new Style({
      image: new CircleStyle({
        radius: 10,
        fill: new Fill({ color: 'rgba(255,255,255,0.9)' }),
        stroke: new Stroke({ color: innerColor, width: 3 }),
      }),
    }),
    new Style({
      image: new CircleStyle({
        radius: 5,
        fill: new Fill({ color: innerColor }),
      }),
    }),
  ];
}

/**
 * Style for saved photo markers. The photo is drawn as a small thumbnail
 * (rendered via OpenLayers Icon from a data URI) if present, otherwise a
 * generic pin.
 */
function photoMarkerStyle(feature) {
  const record = feature.get('record');
  const integrity = record?.integrityLevel ?? 'STANDARD';
  const c = integrityColor(integrity);

  if (record?.thumbUri) {
    return [
      // Colored background halo that hints at the integrity level.
      new Style({
        image: new CircleStyle({
          radius: PHOTO_MARKER_PX / 2 + 3,
          fill: new Fill({ color: c }),
          stroke: new Stroke({ color: '#ffffff', width: 2 }),
        }),
      }),
      // `width`/`height` force the icon to this many CSS px regardless of
      // the underlying image dimensions. We *must not* use `scale` alone,
      // because OL would scale from the image's natural size (e.g. a
      // 3000×4000 JPEG would still render thousands of pixels wide even
      // with a fractional scale).
      new Style({
        image: new Icon({
          src: record.thumbUri,
          width: PHOTO_MARKER_PX,
          height: PHOTO_MARKER_PX,
          anchor: [0.5, 0.5],
          crossOrigin: 'anonymous',
        }),
      }),
    ];
  }

  return new Style({
    image: new CircleStyle({
      radius: 9,
      fill: new Fill({ color: c }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
    text: new Text({
      text: '📸',
      offsetY: -18,
      font: '14px sans-serif',
    }),
  });
}

function integrityColor(level) {
  switch (level) {
    case 'HIGH':
      return '#16a34a';
    case 'STANDARD':
      return '#3b82f6';
    case 'LOW':
      return '#f59e0b';
    case 'UNTRUSTED':
      return '#dc2626';
    default:
      return '#3b82f6';
  }
}
