/**
 * Vendors the OurAirports database and derives real geography for the engine.
 *
 * Two things the catalogue cannot supply on its own:
 *  - **Airport coordinates**, which turn each place's IATA code into a point on
 *    the globe. Flight fares are then a function of actual great-circle distance
 *    rather than a flat per-region guess.
 *  - **Place coordinates**, taken from the nearest served airport, which give
 *    the routing stage a distance fallback where the transport graph has no
 *    edge between two places.
 *
 * The data is public domain and fetched once, then cached under `data/vendor`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
const CACHE = path.join("data", "vendor", "airports.csv");

export type Airport = {
  iata: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  municipality: string;
  /** OurAirports size class; large/medium airports carry the useful routes. */
  size: "large" | "medium" | "small";
};

export async function fetchAirports(refresh = false): Promise<string> {
  if (!refresh && existsSync(CACHE)) return readFileSync(CACHE, "utf8");

  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    if (existsSync(CACHE)) {
      console.warn(`  airport data fetch failed (${res.status}); using cached copy`);
      return readFileSync(CACHE, "utf8");
    }
    throw new Error(`Airport data fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, body);
  return body;
}

/** Splits a CSV line, honouring double-quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

export function parseAirports(csv: string): Map<string, Airport> {
  const lines = csv.split(/\r?\n/);
  const header = splitCsv(lines[0]);
  const col = (name: string) => header.indexOf(name);

  const iIata = col("iata_code");
  const iName = col("name");
  const iLat = col("latitude_deg");
  const iLon = col("longitude_deg");
  const iCountry = col("iso_country");
  const iMunicipality = col("municipality");
  const iType = col("type");
  const iService = col("scheduled_service");

  const byIata = new Map<string, Airport>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = splitCsv(lines[i]);
    const iata = (f[iIata] ?? "").trim().toUpperCase();
    if (iata.length !== 3) continue;
    if ((f[iService] ?? "") !== "yes") continue; // ignore airfields with no flights

    const type = f[iType] ?? "";
    const size = type.includes("large") ? "large" : type.includes("medium") ? "medium" : "small";
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // Keep the largest airport when a code collides.
    const existing = byIata.get(iata);
    const rank = { large: 3, medium: 2, small: 1 } as const;
    if (existing && rank[existing.size] >= rank[size]) continue;

    byIata.set(iata, {
      iata,
      name: f[iName] ?? iata,
      lat,
      lon,
      country: f[iCountry] ?? "",
      municipality: f[iMunicipality] ?? "",
      size,
    });
  }
  return byIata;
}

/** Great-circle distance in kilometres. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
