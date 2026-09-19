/**
 * Resolves one coordinate per place, from the best source available.
 *
 * The transport graph needs a real distance between every pair of places it
 * might route between — without one, every mode looks the same length and
 * the cheapest (a bus) wins regardless of whether the hop is 50km or 2000km.
 *
 * Sources, best first:
 *  1. **Map marker** — hand-placed in `content/destinations/*.json` for the
 *     destination pages, so it points at the actual town, not its airport.
 *  2. **Primary airport** — from the destination file's IATA codes, but only
 *     when that airport serves this place alone. A shared airport is worse
 *     than no coordinate: it silently places every town it serves on the same
 *     point, and a distance of zero between two real towns mis-prices and
 *     mis-orders every leg between them.
 *  3. **Geocoder** — Nominatim, cached on disk (see `vendor-geocode.ts`).
 *
 * A place that resolves from none of these is reported rather than guessed:
 * a wrong coordinate would silently mis-price every leg touching it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Country, Place } from "../../lib/atlas/schema";
import type { Airport } from "./vendor-airports";
import { geocodePlaces, type GeoPoint } from "./vendor-geocode";
import { normalise } from "./normalise";

const MARKER_DIR = path.join("content", "destinations");

export type PlaceCoords = {
  points: Map<string, GeoPoint>;
  /** Where each resolved point came from, for the review workbook. */
  source: Map<string, "marker" | "airport" | "geocode">;
  unresolved: Place[];
  /** Places that still need a geocode pass (`--geocode`) to be resolved. */
  pendingGeocode: number;
};

/** Reads every hand-placed map marker, keyed by normalised place name. */
function markerPoints(): Map<string, GeoPoint> {
  const out = new Map<string, GeoPoint>();
  if (!existsSync(MARKER_DIR)) return out;
  for (const file of readdirSync(MARKER_DIR).filter((f) => f.endsWith(".json"))) {
    let parsed: { map?: { markers?: { name: string; lat: number; lng: number }[] } };
    try {
      parsed = JSON.parse(readFileSync(path.join(MARKER_DIR, file), "utf8"));
    } catch {
      continue;
    }
    for (const m of parsed.map?.markers ?? []) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
      const key = normalise(m.name);
      if (!out.has(key)) out.set(key, { lat: m.lat, lon: m.lng });
    }
  }
  return out;
}

export async function resolvePlaceCoords(
  places: Place[],
  countries: Country[],
  airportsByPlace: Map<string, string[]>,
  airports: Map<string, Airport>,
  allowNetwork: boolean,
): Promise<PlaceCoords> {
  const points = new Map<string, GeoPoint>();
  const source = new Map<string, "marker" | "airport" | "geocode">();

  const markers = markerPoints();
  for (const place of places) {
    const hit = markers.get(normalise(place.name));
    if (hit) {
      points.set(place.id, hit);
      source.set(place.id, "marker");
    }
  }

  // How many places claim each airport as theirs — see the skip below.
  const placesPerAirport = new Map<string, number>();
  for (const place of places) {
    for (const code of airportsByPlace.get(place.id) ?? []) {
      placesPerAirport.set(code, (placesPerAirport.get(code) ?? 0) + 1);
    }
  }

  for (const place of places) {
    if (points.has(place.id)) continue;
    for (const code of airportsByPlace.get(place.id) ?? []) {
      // An airport is only a usable stand-in for a place when it serves that
      // place alone. Kerala's circuit towns — Thekkady, Alleppey,
      // Kanyakumari — all list Kochi as their nearest airport, so taking its
      // coordinate collapsed three towns hundreds of kilometres apart onto a
      // single point, and every distance between them came out as zero.
      // Shared airports are skipped so the geocoder resolves the town itself.
      if ((placesPerAirport.get(code) ?? 0) > 1) continue;
      const a = airports.get(code);
      if (a) {
        points.set(place.id, { lat: a.lat, lon: a.lon });
        source.set(place.id, "airport");
        break;
      }
    }
  }

  const countryName = new Map(countries.map((c) => [c.id, c.name]));
  const stillMissing = places.filter((p) => !points.has(p.id));
  const geo = await geocodePlaces(
    stillMissing.map((p) => ({
      placeId: p.id,
      name: p.name,
      country: countryName.get(p.countryId) ?? "",
    })),
    allowNetwork,
  );
  for (const [placeId, point] of geo.points) {
    points.set(placeId, point);
    source.set(placeId, "geocode");
  }

  return {
    points,
    source,
    unresolved: places.filter((p) => !points.has(p.id)),
    pendingGeocode: geo.pending,
  };
}
