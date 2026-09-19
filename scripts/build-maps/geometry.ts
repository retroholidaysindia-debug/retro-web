import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import { geoBounds } from "d3-geo";

export function loadCountryFeature(
  countries: FeatureCollection,
  iso3: string
): Feature<Geometry> | undefined {
  return countries.features.find((f) => f.properties?.ADM0_A3 === iso3) as
    | Feature<Geometry>
    | undefined;
}

/**
 * Combines already-resolved country features into one multi-geometry feature.
 * Split out from `unionCountries` so a caller that needs to simplify each
 * country's shape individually first — before mapshaper's per-feature
 * `keep-shapes` protection is lost by merging them — can still finish with
 * the same combined shape `unionCountries` used to produce in one step.
 */
export function mergeFeatures(features: Feature<Geometry>[]): Feature<MultiPolygon> {
  const polygons: Polygon["coordinates"][] = [];
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") {
      polygons.push((feature.geometry as Polygon).coordinates);
    } else if (feature.geometry.type === "MultiPolygon") {
      polygons.push(...(feature.geometry as MultiPolygon).coordinates);
    } else {
      throw new Error(`mergeFeatures: unsupported geometry type "${feature.geometry.type}"`);
    }
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: polygons },
  };
}

export function unionCountries(
  countries: FeatureCollection,
  iso3Codes: string[]
): Feature<MultiPolygon> {
  const features = iso3Codes.map((code) => {
    const feature = loadCountryFeature(countries, code);
    if (!feature) throw new Error(`unionCountries: country not found: ${code}`);
    return feature;
  });
  const merged = mergeFeatures(features);
  return { ...merged, properties: { countries: iso3Codes } };
}

/**
 * Splits a feature into one feature per polygon.
 *
 * Mapshaper's `keep-shapes` guard protects whole *features* from being
 * simplified out of existence, not the individual polygons inside one. A
 * country's offshore territories are polygons within its single MultiPolygon,
 * so they are unprotected however small they are — which is how India's
 * Andaman islands vanished from its own map while the mainland was fine.
 * Exploding first, and merging back afterwards, extends that protection to
 * every separate landmass.
 */
export function explodePolygons(feature: Feature<Geometry>): Feature<Polygon>[] {
  const g = feature.geometry;
  const polygons: Polygon["coordinates"][] =
    g.type === "Polygon" ? [(g as Polygon).coordinates]
    : g.type === "MultiPolygon" ? (g as MultiPolygon).coordinates
    : [];
  return polygons.map((coordinates) => ({
    type: "Feature",
    properties: { ...feature.properties },
    geometry: { type: "Polygon", coordinates },
  }));
}

/** True when a lng/lat point falls inside a polygon's outer ring. */
export function pointInPolygon(point: [number, number], polygon: Polygon["coordinates"]): boolean {
  const [px, py] = point;
  const ring = polygon[0] ?? [];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Diagonal of a polygon's bounding box, in degrees. */
export function polygonExtent(polygon: Polygon["coordinates"]): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const ring of polygon) {
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 0;
}

/**
 * Finds island territories a country's own outline is missing.
 *
 * The vendored admin0 outlines are small-scale: they drop offshore territories
 * that are far too small to register at world scale but are very much places
 * we sell. India's Lakshadweep has no polygon there at all, so its markers sat
 * forty pixels out in open sea. The admin1 file is higher resolution and does
 * carry them, as states.
 *
 * Only genuinely *separate* land is pulled in. A marker sitting a pixel or two
 * off a simplified coastline (Panaji, Rameswaram) would otherwise drag in the
 * whole of Goa or Tamil Nadu and draw it a second time on top of the mainland,
 * so a candidate is rejected when a meaningful share of its own outline
 * already falls inside the land we have drawn.
 */
export function findMissingIslands(
  admin1: FeatureCollection,
  iso3: string,
  markers: { lat: number; lng: number }[],
  existing: Feature<Polygon>[],
): Feature<Geometry>[] {
  const onLand = (point: [number, number]) =>
    existing.some((p) => pointInPolygon(point, p.geometry.coordinates));
  const stranded = markers.filter((m) => !onLand([m.lng, m.lat]));
  if (!stranded.length) return [];

  const candidates = admin1.features.filter((f) => f.properties?.adm0_a3 === iso3);
  const found: Feature<Geometry>[] = [];
  for (const candidate of candidates) {
    const pieces = explodePolygons(candidate as Feature<Geometry>);
    const holdsStranded = stranded.some((m) =>
      pieces.some((p) => pointInPolygon([m.lng, m.lat], p.geometry.coordinates)),
    );
    if (!holdsStranded) continue;

    // Already-drawn land: its border traces territory we have, so adding it
    // would just paint over the mainland.
    const vertices = pieces.flatMap((p) => p.geometry.coordinates[0] ?? []);
    const covered = vertices.filter((v) => onLand(v as [number, number])).length;
    if (vertices.length && covered / vertices.length > 0.2) continue;

    found.push(candidate as Feature<Geometry>);
  }
  return found;
}

/**
 * Draws a small islet under any marker still stranded in open ocean.
 *
 * Some places we sell are coral atolls a few kilometres across — Kavaratti and
 * Agatti in Lakshadweep among them — and no free dataset carries them: Natural
 * Earth's 10m admin0, admin1 and minor-islands files between them hold a
 * single speck 200km south of both. Drawn at true size they would be well
 * under a pixel anyway.
 *
 * So this is a legibility glyph, not survey geometry, and it is deliberately
 * the same treatment a printed atlas gives an atoll: a dot at the right place,
 * exaggerated enough to see. It is only ever added where a marker is genuinely
 * out at sea — a coastal city sitting a pixel off a simplified coastline is a
 * simplification artefact on real land and must not sprout an island.
 */
export function synthesiseIslets(
  markers: { name: string; lat: number; lng: number }[],
  land: Feature<Polygon>[],
  /** Degrees of separation beyond which a marker counts as genuinely offshore. */
  strandedBeyondDegrees = 0.5,
  /** Drawn radius in degrees; sized to read on the map, not to scale. */
  radiusDegrees = 0.22,
): Feature<Polygon>[] {
  const nearestLand = (point: [number, number]) => {
    let best = Infinity;
    for (const piece of land) {
      if (pointInPolygon(point, piece.geometry.coordinates)) return 0;
      for (const ring of piece.geometry.coordinates) {
        for (const [x, y] of ring) {
          best = Math.min(best, Math.hypot(x - point[0], y - point[1]));
        }
      }
    }
    return best;
  };

  const islets: Feature<Polygon>[] = [];
  for (const marker of markers) {
    if (nearestLand([marker.lng, marker.lat]) <= strandedBeyondDegrees) continue;
    // A slightly irregular ring rather than a circle, so it reads as land
    // rather than as another piece of interface.
    const ring: [number, number][] = [];
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const wobble = 0.82 + 0.18 * Math.abs(Math.sin(i * 2.3));
      ring.push([
        marker.lng + Math.cos(angle) * radiusDegrees * wobble,
        marker.lat + Math.sin(angle) * radiusDegrees * wobble,
      ]);
    }
    ring.push(ring[0]);
    islets.push({
      type: "Feature",
      properties: { synthesised: true, name: marker.name },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return islets;
}

export function filterAdmin1(
  admin1: FeatureCollection,
  iso3: string,
  regionNames: string[]
): Feature<Geometry>[] {
  const wanted = new Set(regionNames);
  return admin1.features.filter(
    (f) => f.properties?.adm0_a3 === iso3 && wanted.has(f.properties?.name)
  ) as Feature<Geometry>[];
}

export function bboxOf(
  input: Feature<Geometry> | FeatureCollection
): [number, number, number, number] {
  const [[minLng, minLat], [maxLng, maxLat]] = geoBounds(input as never);
  return [minLng, minLat, maxLng, maxLat];
}

export function expandBboxForMarkers(
  bbox: [number, number, number, number],
  markers: { lat: number; lng: number }[]
): [number, number, number, number] {
  let [minLng, minLat, maxLng, maxLat] = bbox;
  for (const m of markers) {
    minLng = Math.min(minLng, m.lng);
    maxLng = Math.max(maxLng, m.lng);
    minLat = Math.min(minLat, m.lat);
    maxLat = Math.max(maxLat, m.lat);
  }
  return [minLng, minLat, maxLng, maxLat];
}
