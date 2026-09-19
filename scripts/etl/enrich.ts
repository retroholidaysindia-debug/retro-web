/**
 * Build-time rate enrichment.
 *
 * Two ways to replace a guessed rate with something defensible:
 *
 *  1. **Derived** — computed from real geography. Airfare becomes a function of
 *     great-circle distance from the Indian departure metro to the destination's
 *     own airport, which is far better grounded than a flat per-region band.
 *
 *  2. **Live** — fetched from a rate API when credentials are configured. These
 *     are the only truly authoritative numbers short of the agency's own card.
 *
 * Both are optional: with no network and no keys the build still completes, and
 * every value reports which method produced it.
 */
import type { Country, FlightBand, Place, Region } from "../../lib/atlas/schema";
import { type Airport, haversineKm } from "./vendor-airports";

/** Indian departure metros offered in the planner, with their airports. */
export const DEPARTURE_CITIES: { iata: string; label: string }[] = [
  { iata: "DEL", label: "Delhi" },
  { iata: "BOM", label: "Mumbai" },
  { iata: "MAA", label: "Chennai" },
  { iata: "BLR", label: "Bengaluru" },
  { iata: "HYD", label: "Hyderabad" },
  { iata: "CCU", label: "Kolkata" },
  { iata: "COK", label: "Kochi" },
  { iata: "AMD", label: "Ahmedabad" },
  { iata: "PNQ", label: "Pune" },
  { iata: "GOI", label: "Goa" },
];

/**
 * Return economy fare per km, in INR, by haul length. Short hops cost
 * disproportionately more per km because fixed costs dominate, which a single
 * linear rate would badly misprice at both ends.
 */
const FARE_CURVE: { maxKm: number; fixedInr: number; perKmInr: number }[] = [
  { maxKm: 1500, fixedInr: 4500, perKmInr: 5.2 },
  { maxKm: 3500, fixedInr: 6000, perKmInr: 4.1 },
  { maxKm: 6500, fixedInr: 9000, perKmInr: 3.4 },
  { maxKm: 10000, fixedInr: 12000, perKmInr: 3.0 },
  { maxKm: Infinity, fixedInr: 16000, perKmInr: 2.7 },
];

/** Spread around the mid fare, so every band has a low and a high. */
const BAND_SPREAD = 0.35;

/** Low-cost carriers undercut full-service on the same route. */
const LCC_FACTOR = 0.75;

const CABIN_FACTOR: Record<string, number> = {
  Economy: 1,
  "Premium Economy": 1.7,
  Business: 3.2,
};

/** LCCs do not fly ultra-long-haul, so beyond this they are not offered. */
const LCC_MAX_KM = 6000;

function returnFareInr(distanceKm: number): number {
  const seg = FARE_CURVE.find((s) => distanceKm <= s.maxKm)!;
  // The curve prices a one-way leg; a return is roughly twice, less a little.
  const oneWay = seg.fixedInr + distanceKm * seg.perKmInr;
  return oneWay * 1.85;
}

export type FlightDerivation = {
  bands: FlightBand[];
  /** Per-country working, for the review workbook. */
  workings: {
    country: string;
    airport: string | null;
    fromCity: string;
    distanceKm: number | null;
    midFareInr: number | null;
    method: "distance" | "region-fallback";
  }[];
};

/**
 * Regional fallback bands, used only where a country has no resolvable airport.
 */
const REGION_FALLBACK_KM: Record<string, number> = {
  india: 1200,
  "south-asia": 2000,
  "south-east-asia": 4200,
  "middle-east-and-gulf": 3000,
  "east-asia": 6000,
  "eurasia-cis": 4000,
  africa: 6000,
  europe: 7000,
  russia: 5000,
  oceania: 10500,
};

/**
 * Builds a fare band per country, per carrier type, per cabin, from the
 * distance between each Indian metro and the destination's primary airport.
 */
export function deriveFlightBands(
  countries: Country[],
  regions: Region[],
  places: Place[],
  airportsByPlace: Map<string, string[]>,
  airports: Map<string, Airport>,
): FlightDerivation {
  const bands: FlightBand[] = [];
  const workings: FlightDerivation["workings"] = [];
  const regionById = new Map(regions.map((r) => [r.id, r]));

  for (const country of countries) {
    // The destination airport is whichever of the country's places names one.
    const countryPlaces = places.filter((p) => p.countryId === country.id);
    let destAirport: Airport | undefined;
    for (const place of countryPlaces) {
      for (const code of airportsByPlace.get(place.id) ?? []) {
        const hit = airports.get(code);
        if (!hit) continue;
        // Prefer a large airport in the right country.
        if (!destAirport || (hit.size === "large" && destAirport.size !== "large")) {
          destAirport = hit;
        }
      }
      if (destAirport?.size === "large") break;
    }

    for (const origin of DEPARTURE_CITIES) {
      const from = airports.get(origin.iata);
      let distanceKm: number | null = null;
      let method: "distance" | "region-fallback" = "region-fallback";

      if (from && destAirport) {
        distanceKm = Math.round(haversineKm(from, destAirport));
        method = "distance";
      } else {
        distanceKm = REGION_FALLBACK_KM[country.regionId] ?? 5000;
      }

      const mid = returnFareInr(distanceKm);
      workings.push({
        country: country.name,
        airport: destAirport ? `${destAirport.iata} ${destAirport.name}` : null,
        fromCity: origin.iata,
        distanceKm,
        midFareInr: Math.round(mid),
        method,
      });

      for (const carrier of ["LCC", "FSC"] as const) {
        if (carrier === "LCC" && distanceKm > LCC_MAX_KM) continue;
        const carrierFactor = carrier === "LCC" ? LCC_FACTOR : 1;
        for (const cabin of ["Economy", "Premium Economy", "Business"] as const) {
          if (carrier === "LCC" && cabin === "Business") continue;
          const f = carrierFactor * CABIN_FACTOR[cabin];
          bands.push({
            id: `${country.id}:${origin.iata}:${carrier}:${cabin.replace(/\s+/g, "-")}`,
            originCity: origin.iata,
            destCountryId: country.id,
            carrier,
            cabin,
            tripType: "Round Trip",
            priceLow: Math.round(mid * f * (1 - BAND_SPREAD)),
            priceHigh: Math.round(mid * f * (1 + BAND_SPREAD)),
            currency: "INR",
            durationMinutes: distanceKm ? Math.round((distanceKm / 800) * 60 + 45) : null,
            source: method === "distance" ? "estimated" : "estimated",
          });
        }
      }
    }
    void regionById;
  }

  return { bands, workings };
}

// ---------------------------------------------------------------------------
// Live rates (build-time, credential-gated)
// ---------------------------------------------------------------------------

/** Carriers that price as low-cost, so LCC/FSC can be told apart. */
const LCC_CARRIERS = new Set([
  "6E", "SG", "QP", "IX", "G8", "AK", "D7", "FD", "TR", "JT", "QZ", "VJ",
  "5J", "PQ", "U2", "FR", "W6", "VY", "PC", "XY", "J9", "G9", "3L",
]);

export type LiveFlightSample = {
  origin: string;
  destination: string;
  carrier: "LCC" | "FSC";
  inr: number;
};

/**
 * Fetches real cached fares from the Travelpayouts Aviasales Data API.
 * Returns an empty list when no token is configured, so the build is unchanged
 * for anyone without credentials.
 */
export async function fetchLiveFlights(
  pairs: { origin: string; destination: string; month: string }[],
  token: string | undefined,
  log: (msg: string) => void,
): Promise<LiveFlightSample[]> {
  if (!token) return [];
  const out: LiveFlightSample[] = [];

  for (const pair of pairs) {
    const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
    url.searchParams.set("origin", pair.origin);
    url.searchParams.set("destination", pair.destination);
    url.searchParams.set("departure_at", pair.month);
    url.searchParams.set("one_way", "false");
    url.searchParams.set("currency", "inr");
    url.searchParams.set("sorting", "price");
    url.searchParams.set("limit", "30");

    try {
      const res = await fetch(url, { headers: { "X-Access-Token": token } });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: { price?: number; airline?: string }[] };
      const offers = (body.data ?? []).filter((o) => typeof o.price === "number" && o.price! > 0);
      for (const carrier of ["LCC", "FSC"] as const) {
        const pool = offers.filter((o) => {
          const isLcc = LCC_CARRIERS.has((o.airline ?? "").toUpperCase());
          return carrier === "LCC" ? isLcc : !isLcc;
        });
        if (!pool.length) continue;
        out.push({
          origin: pair.origin,
          destination: pair.destination,
          carrier,
          inr: Math.min(...pool.map((o) => o.price!)),
        });
      }
    } catch {
      // A failed lookup simply leaves the derived band in place.
    }
  }

  log(`  live flights ${out.length} fare(s) fetched from Travelpayouts`);
  return out;
}
