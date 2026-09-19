/**
 * Build-time geocoder for places the catalogue cannot locate on its own.
 *
 * Most places already resolve to a coordinate from their map marker or their
 * primary airport. The remainder — mostly small towns on Indian circuits —
 * have neither, which leaves the transport graph with no distance to reason
 * about. Those are looked up once against Nominatim (OpenStreetMap) and the
 * answer is written to a committed cache, so:
 *
 *  - the network is hit at most once per place, ever;
 *  - CI and offline builds are fully reproducible from the cache;
 *  - Nominatim's usage policy (1 request/second, identifying User-Agent) is
 *    respected without slowing down normal builds at all.
 *
 * Nothing here is required for a build to succeed: a place that cannot be
 * geocoded simply keeps whatever coarser coordinate it already had, and the
 * gap is reported in the review workbook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE = path.join("data", "vendor", "geocode.json");
const ENDPOINT = "https://nominatim.openstreetmap.org/search";
/** Nominatim asks for no more than one request a second, and an honest UA. */
const RATE_LIMIT_MS = 1100;
const USER_AGENT = "retro-atlas-etl/1.0 (travel-quotation build-time geocoder)";

export type GeoPoint = { lat: number; lon: number };

/** `"<place name>|<country name>"` -> point, or `null` for a confirmed miss. */
type GeocodeCache = Record<string, GeoPoint | null>;

export function loadGeocodeCache(): GeocodeCache {
  if (!existsSync(CACHE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE, "utf8")) as GeocodeCache;
  } catch {
    return {};
  }
}

function saveGeocodeCache(cache: GeocodeCache) {
  mkdirSync(path.dirname(CACHE), { recursive: true });
  // Sorted so the committed file has a stable diff.
  const sorted: GeocodeCache = {};
  for (const key of Object.keys(cache).sort()) sorted[key] = cache[key];
  writeFileSync(CACHE, `${JSON.stringify(sorted, null, 2)}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lookup(query: string): Promise<GeoPoint | null> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { lat: string; lon: string }[];
  if (!body.length) return null;
  const lat = Number(body[0].lat);
  const lon = Number(body[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export type GeocodeRequest = { placeId: string; name: string; country: string };

/**
 * Resolves each requested place, using the cache first and the network only
 * for genuinely unseen entries.
 *
 * `allowNetwork` defaults to false so an ordinary `npm run build-atlas` never
 * makes a network call or takes a rate-limit penalty; pass `--geocode` to the
 * ETL to refresh the cache when new places appear in the catalogue.
 */
export async function geocodePlaces(
  requests: GeocodeRequest[],
  allowNetwork: boolean,
): Promise<{ points: Map<string, GeoPoint>; fetched: number; missed: number; pending: number }> {
  const cache = loadGeocodeCache();
  const points = new Map<string, GeoPoint>();
  let fetched = 0;
  let missed = 0;
  let pending = 0;
  let dirty = false;

  for (const req of requests) {
    const key = `${req.name}|${req.country}`;
    if (key in cache) {
      const hit = cache[key];
      if (hit) points.set(req.placeId, hit);
      else missed++;
      continue;
    }
    if (!allowNetwork) {
      pending++;
      continue;
    }

    try {
      await sleep(RATE_LIMIT_MS);
      const hit = await lookup(`${req.name}, ${req.country}`);
      cache[key] = hit;
      dirty = true;
      if (hit) {
        points.set(req.placeId, hit);
        fetched++;
      } else {
        missed++;
      }
    } catch (err) {
      // A transient failure must not fail the build or poison the cache with
      // a false negative — leave the key absent so a later run retries it.
      console.warn(`  geocode: ${req.name}, ${req.country} failed (${(err as Error).message})`);
      pending++;
    }
  }

  if (dirty) saveGeocodeCache(cache);
  return { points, fetched, missed, pending };
}
