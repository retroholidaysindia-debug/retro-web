import { readFileSync } from "node:fs";
import path from "node:path";
import type { FeatureCollection } from "geojson";

const DATA_DIR = path.join(process.cwd(), "data", "natural-earth");

export function loadAdmin0(povCountry?: string): FeatureCollection {
  const filename = povCountry === "IND" ? "admin0-ind.geojson" : "admin0.geojson";
  return JSON.parse(readFileSync(path.join(DATA_DIR, filename), "utf-8"));
}

export function loadAdmin1(): FeatureCollection {
  return JSON.parse(readFileSync(path.join(DATA_DIR, "admin1.geojson"), "utf-8"));
}
