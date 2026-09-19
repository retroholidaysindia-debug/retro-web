import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Feature, Geometry, MultiPolygon, Polygon } from "geojson";
import { geoPath, geoMercator, geoConicConformal, geoConicEqualArea, type GeoProjection } from "d3-geo";
import mapshaper from "mapshaper";
import { loadDestinations } from "@/lib/destinations";
import { loadAdmin0, loadAdmin1 } from "./natural-earth";
import { unionCountries, mergeFeatures, loadCountryFeature, explodePolygons, pointInPolygon, polygonExtent, findMissingIslands, synthesiseIslets, filterAdmin1, bboxOf, expandBboxForMarkers } from "./geometry";
import { selectProjection } from "./projection";
import { placeLabels } from "./labels";
import { buildMapSvg, type SvgMarker } from "./svg";

const OUT_DIR = path.join(process.cwd(), "public", "maps");
const VIEW_W = 600;
const VIEW_H = 600;
const LABEL_OFFSET = 60;

// The vendored Natural Earth GeoJSON (data/natural-earth/*.geojson) has every
// polygon ring wound opposite to the right-hand rule that d3-geo requires for
// spherical geometry. Left uncorrected, d3 treats each ring as if it were the
// sphere-sized complement of the intended shape: geoBounds/geoArea balloon to
// ~4*PI (a whole sphere) per ring, fitExtent scales against that bogus bbox,
// and the projection's clip circle then fragments the coastline into many
// spurious sub-paths — this is what blew country SVGs up to 100+ KB rather
// than the expected few KB. Reversing every ring's point order restores the
// correct orientation (verified via d3.geoArea dropping from ~4*PI*N per
// country down to the true, tiny land-area fraction of the sphere).
function reverseRingWinding<G extends Geometry>(geometry: G): G {
  if (geometry.type === "Polygon") {
    const g = geometry as Polygon;
    return { ...g, coordinates: g.coordinates.map((ring) => [...ring].reverse()) } as G;
  }
  if (geometry.type === "MultiPolygon") {
    const g = geometry as MultiPolygon;
    return {
      ...g,
      coordinates: g.coordinates.map((poly) => poly.map((ring) => [...ring].reverse())),
    } as G;
  }
  return geometry;
}

function withCorrectedWinding<F extends Feature<Geometry>>(feature: F): F {
  return { ...feature, geometry: reverseRingWinding(feature.geometry) };
}

// Even after the winding fix, some destinations' country union (e.g. Indonesia's
// full admin0 shape, thousands of islands) is still far too detailed to fit the
// 12KB SVG budget for a 600x600 preview map. Re-simplify the specific feature
// being rendered (not the vendored source file) with mapshaper before
// projecting.
async function simplifyFeature<F extends Feature<Geometry>>(feature: F, percent: number): Promise<F> {
  const [result] = await simplifyFeatures([feature], percent);
  return result;
}

/**
 * Simplifies several features together as one mapshaper run, but — critically
 * — keeps each as its own top-level feature going in, so mapshaper's
 * `keep-shapes` guard (which protects a shape from being simplified away to
 * nothing) applies to each one individually.
 *
 * A region map unions several countries' polygons before this used to run,
 * which merged them into a single MultiPolygon feature first. `keep-shapes`
 * only protects whole *features*, not individual rings within one, so a small
 * country's entire polygon could fall under the retention threshold and
 * vanish once it was just one ring among a large neighbour's many — this is
 * exactly what happened to Mauritius and Seychelles on the Africa map, both
 * silently dropped rather than rendered too small to notice. Simplifying while
 * each country is still its own feature, then merging afterwards, keeps every
 * one of them, however small.
 */
async function simplifyFeatures<F extends Feature<Geometry>>(features: F[], percent: number): Promise<F[]> {
  const collection = { type: "FeatureCollection" as const, features };
  const output = await mapshaper.applyCommands(
    `-i in.json -simplify ${percent}% keep-shapes -o out.json format=geojson`,
    { "in.json": JSON.stringify(collection) }
  );
  const simplified = JSON.parse(output["out.json"]);
  return simplified.features as F[];
}

const SIMPLIFY_PERCENT = 6;

/**
 * Drops the specks while keeping the land that matters.
 *
 * Exploding a country into per-polygon features protects every islet from
 * being simplified away, which is what we want for the Andamans — but taken
 * literally it also preserves all 103 of Indonesia's polygons, most of them
 * far too small to see and none of them places we sell. A polygon is kept
 * when it is either big enough to register at this map's scale, or holds one
 * of the destination's own markers — so an island we actually send travellers
 * to is drawn however tiny, and an anonymous rock is not.
 */
const MIN_VISIBLE_EXTENT_RATIO = 0.02;

function keepMeaningfulLand(
  pieces: Feature<Polygon>[],
  markers: { lat: number; lng: number }[],
): Feature<Polygon>[] {
  if (pieces.length <= 1) return pieces;
  const largest = Math.max(...pieces.map((p) => polygonExtent(p.geometry.coordinates)));
  const threshold = largest * MIN_VISIBLE_EXTENT_RATIO;
  const kept = pieces.filter(
    (p) =>
      polygonExtent(p.geometry.coordinates) >= threshold ||
      markers.some((m) => pointInPolygon([m.lng, m.lat], p.geometry.coordinates)),
  );
  // Never return nothing: if every piece somehow fell below the bar, the map
  // is better off with its biggest landmass than with empty sea.
  return kept.length ? kept : pieces;
}

/**
 * Minimum on-screen diagonal (in the 600x600 pre-crop canvas d3 projects
 * into) that a landmass must reach to register as more than a smudge.
 *
 * `keepMeaningfulLand` decides which raw-degree pieces are worth carrying at
 * all. It cannot see what happens next: a piece can be a perfectly real,
 * marker-holding island and still be squashed to a fraction of a pixel by the
 * *projection* itself. The Seychelles are a real ~0.2°-wide archipelago, but
 * Africa's map spans Egypt to South Africa — conic-projecting that scatter of
 * granite across a continent's worth of latitude compressed two of its three
 * islets to a sub-pixel sliver and the third to a literal zero-height point,
 * even though every earlier safeguard had correctly kept them. Applied last,
 * after projection, this is the backstop that actually guarantees visibility.
 */
const MIN_VISIBLE_PROJECTED_PX = 6;

/**
 * Renders a (possibly multi-polygon) feature to one SVG path string, drawing
 * a small visible dot in place of any disjoint landmass that would otherwise
 * project to less than `minVisiblePx` — the real geometry is simply too small
 * at this map's scale to be worth the traveller squinting for it.
 */
function renderLandmasses(
  pathGen: ReturnType<typeof geoPath>,
  feature: Feature<Geometry>,
  minVisiblePx = MIN_VISIBLE_PROJECTED_PX,
): string {
  const polygons: Polygon["coordinates"][] =
    feature.geometry.type === "Polygon"
      ? [(feature.geometry as Polygon).coordinates]
      : feature.geometry.type === "MultiPolygon"
        ? (feature.geometry as MultiPolygon).coordinates
        : [];

  const parts: string[] = [];
  for (const coordinates of polygons) {
    const piece: Feature<Polygon> = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates } };
    const bounds = pathGen.bounds(piece);
    const [[x0, y0], [x1, y1]] = bounds;
    const diagonal = Math.hypot(x1 - x0, y1 - y0);

    if (Number.isFinite(diagonal) && diagonal >= minVisiblePx) {
      const d = pathGen(piece);
      if (d) parts.push(d);
      continue;
    }

    // Too small (or degenerate) to see at this scale: a small dot at the same
    // spot beats an invisible sliver or, worse, nothing at all.
    const [cx, cy] = pathGen.centroid(piece);
    const centreX = Number.isFinite(cx) ? cx : (x0 + x1) / 2;
    const centreY = Number.isFinite(cy) ? cy : (y0 + y1) / 2;
    if (!Number.isFinite(centreX) || !Number.isFinite(centreY)) continue;
    const r = minVisiblePx / 2;
    parts.push(
      `M${(centreX + r).toFixed(1)},${centreY.toFixed(1)}` +
        `A${r},${r} 0 1,0 ${(centreX - r).toFixed(1)},${centreY.toFixed(1)}` +
        `A${r},${r} 0 1,0 ${(centreX + r).toFixed(1)},${centreY.toFixed(1)}Z`,
    );
  }
  return parts.join("");
}

// One decimal place, not integer pixels: a country's own true landmass on a
// wide regional map can genuinely be sub-pixel (Mauritius and the Seychelles
// are both under one pixel across on Africa's map) and integer rounding
// collapses a shape that small to literally zero area — invisible even
// though the real geometry is there. One decimal keeps a mid-size country's
// output basically unchanged while giving a tiny island enough precision to
// still cover some area once rendered.
const PATH_DIGITS = 1;

// A handful of destinations union country shapes with unusually elaborate
// coastlines (archipelagos, many small islands) that stay far over the SVG
// budget even after the default simplification. Give those a lower
// keep-percentage rather than lowering fidelity for every destination.
//
// India previously sat at 1.5%, which crushed its 875-point outline down to a
// fifteen-sided blob: the Kashmir salient disappeared entirely, so the
// northern markers ended up floating in the sea above a country that no longer
// looked like India. The budget it was protecting is spent almost entirely on
// India's sixty-odd markers, not its coastline, so there was headroom to spare.
const SIMPLIFY_OVERRIDES: Record<string, number> = {
  india: 20,
};

function makeProjection(kind: ReturnType<typeof selectProjection>): GeoProjection {
  if (kind === "conicConformal") return geoConicConformal();
  if (kind === "conicEqualArea") return geoConicEqualArea();
  return geoMercator();
}

async function buildOne(destSlug: string) {
  const dest = loadDestinations().find((d) => d.slug === destSlug);
  if (!dest) throw new Error(`Unknown destination: ${destSlug}`);

  const area = dest.map_area;
  const simplifyPercent = SIMPLIFY_OVERRIDES[destSlug] ?? SIMPLIFY_PERCENT;
  let countryFeature: Feature<Geometry>;
  let contextFeature: Feature<Geometry> | null = null;

  if (area?.type === "state") {
    // Main shape: union of the specified admin1 regions (e.g. Kashmir + Ladakh).
    // Simplify each Polygon feature individually — mapshaper outputs a GeometryCollection
    // (not a FeatureCollection) when the input is a MultiPolygon, so we avoid that path.
    const admin1Data = loadAdmin1();
    const stateFeatures = filterAdmin1(admin1Data, area.country, area.admin1_names);
    if (!stateFeatures.length) {
      throw new Error(`No admin1 features found for ${JSON.stringify(area.admin1_names)} in ${area.country}`);
    }
    const allPolygonCoords: Polygon["coordinates"][] = [];
    for (const sf of stateFeatures) {
      const simplified = await simplifyFeature(sf as Feature<Geometry>, simplifyPercent);
      const corrected = withCorrectedWinding(simplified);
      const g = corrected.geometry;
      if (g.type === "Polygon") allPolygonCoords.push((g as Polygon).coordinates);
      else if (g.type === "MultiPolygon") allPolygonCoords.push(...(g as MultiPolygon).coordinates);
    }
    countryFeature = {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: allPolygonCoords },
    };

    // Context outline: the parent country, rendered as a dotted background.
    if (area.show_context !== false) {
      const admin0 = loadAdmin0(area.country);
      let ctx: Feature<Geometry> = unionCountries(admin0, [area.country]);
      ctx = await simplifyFeature(ctx, simplifyPercent);
      contextFeature = withCorrectedWinding(ctx);
    }
  } else {
    // Default: render one or more whole countries.
    const countries = area?.type === "region" ? area.countries
      : area?.type === "country" ? area.countries
      : dest.map.countries;
    const povCountry = area?.type === "country" ? area.pov_country
      : dest.map.povCountry;
    const admin0 = loadAdmin0(povCountry);
    // Simplify each *polygon* while it is still its own feature (see
    // `simplifyFeatures` and `explodePolygons`), then merge. Merging first and
    // simplifying the result, as this used to do, let a whole landmass vanish
    // once it was just one ring among a larger neighbour's many — which is how
    // India lost its Andaman islands and Africa lost Mauritius entirely.
    const countryFeatures = countries.map((code) => {
      const feature = loadCountryFeature(admin0, code);
      if (!feature) throw new Error(`Country not found: ${code}`);
      return feature;
    });
    const pieces = countryFeatures.flatMap(explodePolygons);
    const simplifiedPieces = await simplifyFeatures(pieces, simplifyPercent);
    let land = keepMeaningfulLand(simplifiedPieces, dest.map.markers);

    // Offshore territories the small-scale admin0 outline omits entirely
    // (India's Lakshadweep among them) are recovered from the higher-
    // resolution admin1 file, so a marker never floats in open sea.
    const missing = countries.flatMap((code) =>
      findMissingIslands(loadAdmin1(), code, dest.map.markers, land),
    );
    if (missing.length) {
      const islandPieces = await simplifyFeatures(
        missing.flatMap(explodePolygons),
        simplifyPercent,
      );
      land = [...land, ...keepMeaningfulLand(islandPieces, dest.map.markers)];
    }

    // Anything still adrift is an atoll no dataset carries (see
    // `synthesiseIslets`); give it a drawn islet rather than leaving the pin
    // floating in blank ocean.
    land = [...land, ...synthesiseIslets(dest.map.markers, land)];

    countryFeature = mergeFeatures(land);
    countryFeature = withCorrectedWinding(countryFeature);
  }

  let bbox = bboxOf(countryFeature);
  bbox = expandBboxForMarkers(bbox, dest.map.markers);

  const kind = selectProjection(bbox);

  // For state-type maps the country feature is already a tight admin1 union,
  // so fitting to it gives the right zoom level.  For country/region maps the
  // feature can include large overseas territories (Canary Islands, French
  // Guiana, etc.) that would pull the viewport far from the markers. In those
  // cases, fit the projection to the marker geographic bounding box instead —
  // this guarantees markers spread across the map area regardless of how large
  // or distant the surrounding country polygons are.
  let fittingFeature: Feature<Geometry>;
  // For state-type maps the country feature is already a tight admin1 union,
  // so fitting to it gives the right zoom level.  For country/region maps the
  // feature can include large overseas territories (Canary Islands, French
  // Guiana, etc.) that pull the viewport far from the markers.  Instead, fit
  // the projection to a MultiPoint of the actual marker coordinates so d3
  // scales directly from the markers' projected positions — not from a
  // geographic bounding rectangle, which distorts badly under conic projections.
  if (area?.type === "state") {
    fittingFeature = countryFeature;
  } else {
    fittingFeature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPoint",
        coordinates: dest.map.markers.map((m) => [m.lng, m.lat]),
      },
    };
  }

  const projection = makeProjection(kind).fitExtent(
    [[VIEW_W * 0.22, VIEW_H * 0.22], [VIEW_W * 0.78, VIEW_H * 0.78]],
    fittingFeature
  );
  const pathGen = geoPath(projection).digits(PATH_DIGITS);

  // Rendered piece-by-piece rather than as one `pathGen(countryFeature)` call
  // so a landmass that survives every earlier filter can still be caught if
  // *this* projection — this map's particular zoom and aspect ratio — happens
  // to squash it below visibility (see `renderLandmasses`).
  const countryPath = renderLandmasses(pathGen, countryFeature);
  const contextPath = contextFeature ? (pathGen(contextFeature) ?? "") : undefined;

  let highlightPaths: string[] = [];
  if (dest.map.highlight?.admin1?.length) {
    const admin1 = loadAdmin1();
    const regions = dest.map.countries.flatMap((iso3) =>
      filterAdmin1(admin1, iso3, dest.map.highlight!.admin1!)
    );
    const correctedRegions = regions.map((r) => withCorrectedWinding(r));
    highlightPaths = correctedRegions.map((r) => pathGen(r as never) ?? "").filter(Boolean);
  }

  const projectedMarkers = dest.map.markers.map((m) => {
    const p = projection([m.lng, m.lat]);
    return { ...m, x: p ? p[0] : 0, y: p ? p[1] : 0 };
  });

  // Actual projected centroid — passed as a hint but the new placeLabels
  // computes its own median from the data (kept for API compat).
  const centroidX = projectedMarkers.reduce((s, m) => s + m.x, 0) / Math.max(projectedMarkers.length, 1);
  const labeled = placeLabels(
    projectedMarkers.map((m) => ({ x: m.x, y: m.y, name: m.name, type: m.type })),
    centroidX
  );

  // First pass: place labels in the full 600×600 space.
  const svgMarkers: SvgMarker[] = projectedMarkers.map((m, i) => {
    const label = labeled[i];
    const dir = label.side === "left" ? -1 : 1;
    const unclampedX = label.x + dir * LABEL_OFFSET;
    const approxTextW = Math.ceil(m.name.length * 6.5) + 6;
    const MARGIN_X = 4;
    const labelX =
      label.side === "right"
        ? Math.min(unclampedX, VIEW_W - approxTextW - MARGIN_X)
        : Math.max(unclampedX, approxTextW + MARGIN_X);
    const MARGIN_Y = 8;
    const labelY = Math.max(MARGIN_Y, Math.min(label.y, VIEW_H - MARGIN_Y));
    return {
      name: m.name,
      cx: m.x,
      cy: m.y,
      type: m.type,
      subtype: m.subtype,
      group: m.group,
      labelX,
      labelY,
      labelSide: label.side,
    };
  });

  // Drive the viewBox from marker positions and their labels only.
  // We deliberately ignore pathGen.bounds(countryFeature) here — for
  // destinations like Europe or the Middle East, country polygons include
  // distant overseas territories (Canary Islands, French Guiana, etc.) that
  // would pull the viewport far off the area of interest. Country shapes that
  // extend beyond the computed viewBox are still rendered because the SVG has
  // overflow:visible in CSS.
  let cMinX = Infinity, cMinY = Infinity;
  let cMaxX = -Infinity, cMaxY = -Infinity;

  for (const m of svgMarkers) {
    const textW = Math.ceil(m.name.length * 6.5) + 8;
    const lx0 = m.labelSide === "right" ? m.labelX : m.labelX - textW;
    const lx1 = m.labelSide === "right" ? m.labelX + textW : m.labelX;
    cMinX = Math.min(cMinX, m.cx, lx0);
    cMaxX = Math.max(cMaxX, m.cx, lx1);
    cMinY = Math.min(cMinY, m.cy, m.labelY - 10);
    cMaxY = Math.max(cMaxY, m.cy, m.labelY + 10);
  }

  const CONTENT_PAD = 24;
  const rawX = Math.floor(cMinX - CONTENT_PAD);
  const rawY = Math.floor(cMinY - CONTENT_PAD);
  const rawW = Math.ceil(cMaxX + CONTENT_PAD) - rawX;
  const rawH = Math.ceil(cMaxY + CONTENT_PAD) - rawY;

  // Enforce a minimum viewBox dimension so the SVG never has an extreme
  // aspect ratio (e.g. very tall/narrow), which would make it render at an
  // enormous height in the browser relative to its container width.
  const MIN_DIM = VIEW_W * 0.45;
  const vbW = Math.max(rawW, MIN_DIM);
  const vbH = Math.max(rawH, MIN_DIM);
  // Re-centre when we expanded a dimension.
  const vbX = rawX - Math.floor((vbW - rawW) / 2);
  const vbY = rawY - Math.floor((vbH - rawH) / 2);
  const viewBox: [number, number, number, number] = [vbX, vbY, vbW, vbH];

  const svg = buildMapSvg({
    viewBox,
    countryPath,
    contextPath,
    highlightPaths,
    accent: dest.palette.accent,
    markers: svgMarkers,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outputPath(dest.slug, "svg"), svg);
  writeFileSync(
    outputPath(dest.slug, "markers.json"),
    JSON.stringify({ viewBox, markers: svgMarkers }, null, 2)
  );

  const sizeKb = Buffer.byteLength(svg, "utf-8") / 1024;
  console.log(`${dest.slug}: ${sizeKb.toFixed(1)} KB (${kind})`);
  if (sizeKb > 32) {
    throw new Error(`${dest.slug}.svg exceeds 32KB budget: ${sizeKb.toFixed(1)}KB`);
  }
}

function outputPath(slug: string, ext: string) {
  return path.join(OUT_DIR, `${slug}.${ext}`);
}

async function main() {
  for (const dest of loadDestinations()) {
    await buildOne(dest.slug);
  }
}

main();
