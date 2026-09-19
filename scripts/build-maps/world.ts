/**
 * Builds `public/maps/world.json` for the planner's "choose a region, then
 * zoom in" map. Two layers share one whole-world projection:
 *  - `land`: every country on Earth (bar Antarctica) merged into a single
 *    coastline path, drawn once as inert backdrop so the picker reads as a
 *    standard atlas rather than ten disconnected blobs floating in empty
 *    space — unsupported countries "stay as it is": visible, but never
 *    interactive.
 *  - `regions`: the ten catalogue regions, drawn again on top as separate
 *    hoverable/clickable shapes (same source geometry, so they trace the
 *    same coastlines as the backdrop beneath them) — only these are
 *    selectable and get the hover highlight.
 *
 * Deliberately separate from `index.ts`'s per-destination builder: it reads
 * region/country geography straight from the mother file via `parseMaster`
 * (not from `public/atlas/core.json`), so it never depends on the ETL having
 * run first, and it needs a much coarser simplification than a single-country
 * zoom does.
 *
 * The output is JSON, not a static SVG — the planner renders the `<path>`
 * elements itself so region hover/selection state stays plain React state
 * rather than DOM class juggling.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Feature, Geometry, MultiPolygon, Polygon } from "geojson";
import { geoPath, type GeoProjection } from "d3-geo";
import { geoRobinson } from "d3-geo-projection";
import mapshaper from "mapshaper";
import { loadAdmin0 } from "./natural-earth";
import { parseMaster } from "../etl/parse-master";
import { normalise } from "../etl/normalise";

const OUT_FILE = path.join(process.cwd(), "public", "maps", "world.json");
const VIEW_W = 960;
const VIEW_H = 500;
const PADDING = 24;
// World-scale detail only needs to read as a recognisable silhouette at a few
// hundred pixels, so it can be simplified far more aggressively than the
// single-country/region zoom maps (which use 6%, or 1.5% for archipelagos).
// The backdrop and the interactive region overlay share this same value so
// their coastlines trace exactly on top of one another with no visible seam.
const SIMPLIFY_PERCENT = 3;
// A generous budget: the backdrop now carries every country on Earth (bar
// Antarctica), not just the ten catalogue regions, so it is much larger than
// the old regions-only file.
const SIZE_BUDGET_KB = 400;

/**
 * A handful of catalogue country nodes stand in for several real countries
 * (e.g. "Scandinivia" covers Denmark, Norway, Sweden, Finland, Iceland) but
 * only carry one ISO3 code unless a package happened to populate
 * `memberCountryIds`. This fills in the one such case in the current dataset
 * so its region isn't drawn as a single country's outline.
 */
const CLUSTER_ISO_OVERRIDES: Record<string, string[]> = {
  scandinivia: ["SWE", "NOR", "DNK", "FIN", "ISL"],
};

// --- geometry helpers -------------------------------------------------------
// Duplicated in miniature from index.ts rather than shared, so this new,
// lower-stakes builder can't regress the tested per-destination pipeline.

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

async function simplifyFeature<F extends Feature<Geometry>>(feature: F, percent: number): Promise<F> {
  const collection = { type: "FeatureCollection" as const, features: [feature] };
  const output = await mapshaper.applyCommands(
    `-i in.json -simplify ${percent}% keep-shapes -o out.json format=geojson`,
    { "in.json": JSON.stringify(collection) },
  );
  return JSON.parse(output["out.json"]).features[0] as F;
}

// --- build -------------------------------------------------------------

export type WorldRegion = {
  id: string;
  name: string;
  /** SVG path data in the shared world viewBox. */
  path: string;
  /** [x, y, width, height] in the shared viewBox — used to zoom the view. */
  bbox: [number, number, number, number];
  labelX: number;
  labelY: number;
};

export type WorldMap = {
  viewBox: [number, number, number, number];
  /** SVG path data for every country on Earth (bar Antarctica), merged into
   *  one shape — inert backdrop, not selectable. */
  land: string;
  regions: WorldRegion[];
};

async function main() {
  const geo = parseMaster("input_files/travel_agency_dataset.json");
  const admin0 = loadAdmin0();
  const byIso = new Map(admin0.features.map((f) => [f.properties?.ADM0_A3 as string, f]));

  // --- the full-world backdrop: every country bar Antarctica, merged into
  // one MultiPolygon. Adjoining countries share exact border coordinates, so
  // concatenating (rather than a true geometric union) still renders as one
  // seamless landmass — the shared internal edges just get drawn twice,
  // perfectly overlapping. This also matches the reference atlas's style: a
  // coastline-only map with no internal political borders drawn.
  const worldPolygons: Polygon["coordinates"][] = [];
  for (const feature of admin0.features) {
    if (feature.properties?.CONTINENT === "Antarctica") continue;
    const g = feature.geometry as Geometry;
    if (g.type === "Polygon") worldPolygons.push((g as Polygon).coordinates);
    else if (g.type === "MultiPolygon") worldPolygons.push(...(g as MultiPolygon).coordinates);
  }
  let landFeature: Feature<Geometry> = {
    type: "Feature",
    // mapshaper exports a feature with a fully-empty properties object as a
    // bare GeometryCollection (no attribute table), not a FeatureCollection,
    // which breaks the `.features[0]` unwrap below — a non-empty properties
    // object keeps it as a proper Feature.
    properties: { layer: "land" },
    geometry: { type: "MultiPolygon", coordinates: worldPolygons },
  };
  landFeature = await simplifyFeature(landFeature, SIMPLIFY_PERCENT);
  landFeature = withCorrectedWinding(landFeature);

  // --- the interactive overlay: only the ten catalogue regions, same source
  // geometry so their coastlines trace exactly over the backdrop above.
  const shapes: { id: string; name: string; feature: Feature<Geometry> }[] = [];

  for (const region of geo.regions) {
    const codes = new Set<string>();
    for (const country of geo.countries.filter((c) => c.regionId === region.id)) {
      const override = CLUSTER_ISO_OVERRIDES[normalise(country.name)];
      if (override) {
        override.forEach((c) => codes.add(c));
        continue;
      }
      if (country.iso3) codes.add(country.iso3);
      country.memberCountryIds.forEach((c) => codes.add(c));
    }

    const polygons: Polygon["coordinates"][] = [];
    for (const code of codes) {
      const feature = byIso.get(code);
      if (!feature) {
        console.warn(`  world map: no admin0 shape for ${code} (${region.name}) — skipped`);
        continue;
      }
      const g = feature.geometry as Geometry;
      if (g.type === "Polygon") polygons.push((g as Polygon).coordinates);
      else if (g.type === "MultiPolygon") polygons.push(...(g as MultiPolygon).coordinates);
    }
    if (!polygons.length) {
      console.warn(`  world map: region ${region.name} resolved no shapes — skipped`);
      continue;
    }

    let feature: Feature<Geometry> = {
      type: "Feature",
      properties: { regionId: region.id },
      geometry: { type: "MultiPolygon", coordinates: polygons },
    };
    feature = await simplifyFeature(feature, SIMPLIFY_PERCENT);
    feature = withCorrectedWinding(feature);
    shapes.push({ id: region.id, name: region.name, feature });
  }

  // Fit the projection to the full-world backdrop (not just the supported
  // regions), on the standard Greenwich-centred meridian, so the picker reads
  // as an ordinary atlas: Americas at the left, Europe/Africa/Asia in the
  // middle, Australia/Oceania at the right, true relative scale and ocean
  // gaps throughout, exactly like a normal world map.
  const projection = (geoRobinson() as GeoProjection).fitExtent(
    [[PADDING, PADDING], [VIEW_W - PADDING, VIEW_H - PADDING]],
    landFeature,
  );
  const pathGen = geoPath(projection).digits(1);

  const land = pathGen(landFeature) ?? "";

  const regions: WorldRegion[] = shapes.map((s) => {
    const d = pathGen(s.feature) ?? "";
    const bounds = pathGen.bounds(s.feature);
    const [[x0, y0], [x1, y1]] = bounds;
    return {
      id: s.id,
      name: s.name,
      path: d,
      bbox: [x0, y0, x1 - x0, y1 - y0],
      labelX: (x0 + x1) / 2,
      labelY: (y0 + y1) / 2,
    };
  });

  const world: WorldMap = { viewBox: [0, 0, VIEW_W, VIEW_H], land, regions };
  writeFileSync(OUT_FILE, JSON.stringify(world));

  const totalKb = Buffer.byteLength(JSON.stringify(world), "utf-8") / 1024;
  console.log(`world.json: ${regions.length} regions + full-world backdrop, ${totalKb.toFixed(1)} KB`);
  if (totalKb > SIZE_BUDGET_KB) {
    throw new Error(`world.json exceeds ${SIZE_BUDGET_KB}KB budget: ${totalKb.toFixed(1)}KB`);
  }
}

main();
