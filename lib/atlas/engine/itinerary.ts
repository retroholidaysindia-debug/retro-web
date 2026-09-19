/**
 * Stage 1-2 of the pipeline: decide how long to spend in each place, and in
 * what order to visit them.
 */
import type { CoreBundle, PlaceSummary, Route, TransportMode, TripStyle } from "../schema";
import type { PlaceStay } from "./types";
import {
  deriveDurationMinutes,
  deriveFareInr,
  haversineKm,
  plausibleModes,
  type GeoPoint,
} from "./geo";

// ---------------------------------------------------------------------------
// Reference package matching
// ---------------------------------------------------------------------------

/**
 * Finds the published package that best covers the chosen places. Quotes are
 * always built as a modification of a real package rather than from scratch,
 * so this is what anchors the itinerary and the price floor.
 */
export function matchReferencePackage(
  placeIds: string[],
  packages: CoreBundle["packages"],
): { id: string; name: string; priceFromInr: number; matchRatio: number } | null {
  const wanted = new Set(placeIds);
  let best: { pkg: CoreBundle["packages"][number]; score: number; ratio: number } | null = null;

  for (const pkg of packages) {
    const covered = pkg.placeIds.filter((id) => wanted.has(id)).length;
    if (!covered) continue;
    // Jaccard over places, so a package is penalised both for missing what the
    // traveller asked for and for padding the trip with places they did not.
    const union = new Set([...pkg.placeIds, ...placeIds]).size;
    const score = covered / union;
    const ratio = covered / wanted.size;
    if (!best || score > best.score) best = { pkg, score, ratio };
  }

  if (!best) return null;
  return {
    id: best.pkg.id,
    name: best.pkg.name,
    priceFromInr: best.pkg.priceFromInr,
    matchRatio: best.ratio,
  };
}

// ---------------------------------------------------------------------------
// Night allocation
// ---------------------------------------------------------------------------

/** How well a place serves a given trip style, 0-100. */
export function styleScore(summary: PlaceSummary | undefined, style: TripStyle): number {
  if (!summary) return 50;
  const s = summary.styleScores;
  // The destination files label these rows differently to our style vocabulary.
  const candidates: Record<TripStyle, string[]> = {
    family: ["family", "family with young children"],
    honeymoon: ["honeymoon", "romantic"],
    romantic: ["romantic", "honeymoon"],
    luxury: ["luxury"],
    budget: ["budget"],
    culture: ["culture", "history"],
    adventure: ["adventure", "nature"],
    pilgrimage: ["culture", "history", "first time travelers"],
  };
  const values = candidates[style].map((k) => s[k]).filter((v): v is number => typeof v === "number");
  if (values.length) return values.reduce((a, b) => a + b, 0) / values.length;
  const all = Object.values(s);
  return all.length ? all.reduce((a, b) => a + b, 0) / all.length : 50;
}

/**
 * Splits the total nights across places.
 *
 * Weighted by how well each place suits the trip style and how much there is to
 * do there (cluster and activity counts), then clamped to each place's own
 * documented minimum and maximum stay. Largest-remainder assignment keeps the
 * parts summing exactly to the requested total.
 */
export function allocateNights(
  placeIds: string[],
  totalNights: number,
  summaries: Map<string, PlaceSummary>,
  style: TripStyle,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const result = new Map<string, number>();
  if (!placeIds.length) return result;

  // Explicit overrides consume their nights first.
  const overridden = placeIds.filter((id) => typeof overrides[id] === "number");
  let remaining = totalNights;
  for (const id of overridden) {
    const n = Math.max(0, Math.min(overrides[id], remaining));
    result.set(id, n);
    remaining -= n;
  }

  const auto = placeIds.filter((id) => !result.has(id));
  if (!auto.length || remaining <= 0) {
    for (const id of auto) result.set(id, 0);
    return result;
  }

  const weights = auto.map((id) => {
    const s = summaries.get(id);
    const suitability = styleScore(s, style) / 100; // 0..1
    const depth = Math.log2(1 + (s?.clusterCount ?? 0) + (s?.activityCount ?? 0) / 3);
    const ideal = s?.idealNights ?? 2;
    // Ideal nights dominates; suitability and depth modulate it.
    return Math.max(0.25, ideal * (0.6 + 0.5 * suitability) * (0.7 + 0.15 * depth));
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / totalWeight) * remaining);

  // Floor, then clamp to each place's documented range.
  const floors = raw.map((v, i) => {
    const s = summaries.get(auto[i]);
    const min = Math.max(1, s?.minNights ?? 1);
    const max = Math.max(min, s?.maxNights ?? 99);
    return Math.min(max, Math.max(min, Math.floor(v)));
  });

  let assigned = floors.reduce((a, b) => a + b, 0);

  // Distribute or reclaim the difference by largest fractional remainder.
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
    .map((x) => x.i);

  let guard = 0;
  while (assigned !== remaining && guard++ < 1000) {
    let moved = false;
    for (const i of assigned < remaining ? order : [...order].reverse()) {
      const s = summaries.get(auto[i]);
      const min = Math.max(1, s?.minNights ?? 1);
      const max = Math.max(min, s?.maxNights ?? 99);
      if (assigned < remaining && floors[i] < max) {
        floors[i]++;
        assigned++;
        moved = true;
      } else if (assigned > remaining && floors[i] > min) {
        floors[i]--;
        assigned--;
        moved = true;
      }
      if (assigned === remaining) break;
    }
    // Every place is at its clamp; relax the floor so the total still balances.
    if (!moved) {
      for (const i of order) {
        if (assigned > remaining && floors[i] > 0) {
          floors[i]--;
          assigned--;
        } else if (assigned < remaining) {
          floors[i]++;
          assigned++;
        }
        if (assigned === remaining) break;
      }
      if (assigned !== remaining) break;
    }
  }

  auto.forEach((id, i) => result.set(id, floors[i]));
  return result;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** How hard the router trades money against journey time. */
export type TransportPreference = "fastest" | "balanced" | "cheapest";

/**
 * What an hour of the traveller's time is worth, in INR, per preference.
 *
 * This single knob is the whole "best vs cheap" mechanism: at zero, only the
 * fare matters and an overnight bus always wins; at a high value, a flight
 * that saves eight hours justifies its fare.
 */
const HOUR_VALUE_INR: Record<TransportPreference, number> = {
  cheapest: 60,
  balanced: 500,
  fastest: 2500,
};

/**
 * Per-mode comfort ceiling, in minutes, before continuous travel stops being
 * a fare-vs-time tradeoff and starts being simply unrealistic to put in front
 * of a traveller by default — a bus is a fine, cheap way to cover three or
 * four hours; nobody plans a leisure holiday around a nine-hour one when a
 * ninety-minute flight exists. Beyond the ceiling, a steep discomfort
 * surcharge is added to the mode's score so a comfortable alternative wins
 * the *default* pick; the long/cheap option is never removed from the list —
 * it stays fully selectable, so a traveller who genuinely wants it still can.
 *
 * Not applied when the preference is "cheapest": that preference is an
 * explicit, informed request to prioritise fare over comfort, and overriding
 * it would be worse than the problem this solves.
 */
const MODE_COMFORT_MAX_MINUTES: Partial<Record<TransportMode, number>> = {
  bus: 360, // 6h
  train: 480, // 8h — we don't distinguish a seated day train from an overnight sleeper
  private_vehicle: 240, // 4h
  shared_vehicle: 240,
  ferry: 360,
  seaplane: 180,
};
/** ~INR 2,400/hour beyond the ceiling — enough to hand the default pick to a
 *  comfortable alternative whenever one exists, without ever making the long
 *  option unselectable. */
const DISCOMFORT_SURCHARGE_PER_MIN = 40;

/** Preference used when the caller does not express one. */
export const DEFAULT_TRANSPORT_PREFERENCE: TransportPreference = "balanced";

/**
 * How many real authored hops may be chained into one composed leg.
 *
 * Two is the sweet spot: it bridges the common "both cities are on the
 * network but not to each other" case without turning a single transfer into
 * a grand tour of intermediate cities to save a few hundred rupees.
 */
const MAX_COMPOSED_HOPS = 3;

/** Realistic layover/changeover allowance between two chained hops. */
const CONNECTION_BUFFER_MINUTES = 75;

/**
 * Below this distance a cross-border pair is assumed to be reachable by road.
 * Beyond it, without a real route saying otherwise, only air is offered — it
 * stops the synthesiser proposing a bus from Cairo to Cape Town.
 */
const LAND_ASSUMPTION_KM = 900;

/** One selectable way of making a single leg. */
export type RouteChoice = {
  mode: TransportMode;
  minutes: number;
  priceInr: number;
  /** True when the fare or the time was derived rather than supplied. */
  estimated: boolean;
  distanceKm: number | null;
  /** Set when the journey itself is the experience (Nile cruise, Ha Long Bay). */
  onsiteMode: string | null;
  /**
   * Intermediate places, when this leg was composed from several real hops
   * because no direct route existed. Empty for a direct leg.
   */
  via?: string[];
};

export type RouteHit = RouteChoice & { route: Route | null };

export type RouteLookup = {
  /**
   * Every viable way to make this leg, best-first for the given preference.
   * Empty when the two places are not connected at any fallback tier.
   */
  options(originId: string, destId: string, preference?: TransportPreference): RouteHit[];
  /** The single best option for the given preference, or null. */
  best(originId: string, destId: string, preference?: TransportPreference): RouteHit | null;
  /** Great-circle distance between two places, when both are located. */
  distanceKm(originId: string, destId: string): number | null;
};

/**
 * A leg whose every mode is explicitly marked unavailable is not a gap in the
 * data — it is a statement that no scheduled intercity service exists,
 * typically because both ends are on the same island, inside one city, or on
 * a trekking circuit. Those are still driven, so they are priced as a local
 * road transfer rather than being handed a regional airfare.
 */
const LOCAL_TRANSFER_KMH = 45;
const LOCAL_TRANSFER_FIXED_INR = 900;
const LOCAL_TRANSFER_PER_KM_INR = 22;
/** Used when even the distance is unknown — a half-day vehicle, roughly. */
const LOCAL_TRANSFER_DEFAULT_INR = 3500;
const LOCAL_TRANSFER_DEFAULT_MIN = 90;

function midPrice(option: { priceLow: number | null; priceHigh: number | null }): number {
  return option.priceLow != null && option.priceHigh != null
    ? (option.priceLow + option.priceHigh) / 2
    : (option.priceLow ?? option.priceHigh ?? 0);
}

function scoreOf(choice: { mode: TransportMode; priceInr: number; minutes: number }, preference: TransportPreference) {
  let score = choice.priceInr + (choice.minutes / 60) * HOUR_VALUE_INR[preference];
  if (preference !== "cheapest") {
    const comfortMax = MODE_COMFORT_MAX_MINUTES[choice.mode];
    if (comfortMax && choice.minutes > comfortMax) {
      score += (choice.minutes - comfortMax) * DISCOMFORT_SURCHARGE_PER_MIN;
    }
  }
  return score;
}

/** Every enabled, priced option across a set of candidate routes, best-first. */
function collect(candidates: Route[], preference: TransportPreference): RouteHit[] {
  const out: RouteHit[] = [];
  for (const route of candidates) {
    for (const option of route.options) {
      if (!option.enabled) continue;
      const priceInr = midPrice(option);
      if (priceInr <= 0) continue;
      out.push({
        route,
        mode: option.mode,
        minutes: option.durationMinutes ?? 240,
        priceInr,
        // A derived fare or a derived journey time both make this an estimate.
        estimated: option.priceSource === "estimated" || option.durationSource === "estimated",
        distanceKm: option.distanceKm ?? null,
        onsiteMode: route.onsiteMode ?? null,
      });
    }
  }
  // One mode can appear on several overlapping routes; keep the best of each.
  const byMode = new Map<TransportMode, RouteHit>();
  for (const hit of out) {
    const existing = byMode.get(hit.mode);
    if (!existing || scoreOf(hit, preference) < scoreOf(existing, preference)) {
      byMode.set(hit.mode, hit);
    }
  }
  return [...byMode.values()].sort((a, b) => scoreOf(a, preference) - scoreOf(b, preference));
}

/** True when a route exists but every mode on it is explicitly unavailable. */
function isExplicitlyUnavailable(candidates: Route[]): boolean {
  if (!candidates.length) return false;
  return candidates.every((r) => r.options.every((o) => !o.enabled));
}

function localTransfer(candidates: Route[]): RouteHit {
  const distanceKm =
    candidates.flatMap((r) => r.options.map((o) => o.distanceKm)).find((d) => d != null) ?? null;
  const priceInr =
    distanceKm != null
      ? Math.round(LOCAL_TRANSFER_FIXED_INR + distanceKm * LOCAL_TRANSFER_PER_KM_INR)
      : LOCAL_TRANSFER_DEFAULT_INR;
  const minutes =
    distanceKm != null
      ? Math.round(20 + (distanceKm * 1.3) / LOCAL_TRANSFER_KMH * 60)
      : LOCAL_TRANSFER_DEFAULT_MIN;
  return {
    route: candidates[0] ?? null,
    mode: "private_vehicle",
    minutes,
    priceInr,
    estimated: true,
    distanceKm,
    onsiteMode: null,
  };
}

/**
 * Indexes the route table for symmetric origin/destination lookups.
 *
 * Real transport data is only ever authored between specific places, and it is
 * far sparser than it looks: 437 places share 1,353 place-to-place routes —
 * about 1.4% of all possible pairs — and the usable graph breaks into 63
 * disconnected components, the largest holding just 18 places. So the great
 * majority of legs a real multi-country trip needs have no authored route at
 * all, and the lookup falls through a tiered cascade:
 *
 *  1. An exact place-to-place route (real authored data).
 *  2. A local road transfer, when a route exists but every mode on it is
 *     explicitly unavailable — an intra-island beach, an intra-city
 *     attraction, a trekking waypoint. These are driven, not flown, and
 *     handing them an airfare was badly wrong.
 *  3. A **composed multi-hop path** over real authored routes, when the two
 *     ends sit in the same component but share no direct edge. Bangkok to
 *     Chiang Rai via Chiang Mai is two real fares, which beats inventing one.
 *  4. A country-to-country route, when the two ends resolve to countries
 *     (still real data, just authored at a coarser scope).
 *  5. A **geographically synthesised leg** — the great-circle distance between
 *     the two places run through the same per-mode speed and fare curves the
 *     ETL uses to fill gaps in the authored table. Clearly flagged
 *     (`estimated: true`), but proportionate: a 120km hop and a 6,000km one
 *     now differ, where the previous region-median fallback quoted both the
 *     same.
 *  6. The median priced `between_countries` fare within the same region, kept
 *     only for the handful of places with no coordinate at all.
 */
export function buildRouteLookup(
  routes: Route[],
  places?: CoreBundle["places"],
  countries?: CoreBundle["countries"],
): RouteLookup {
  const byPlacePair = new Map<string, Route[]>();
  const byCountryPair = new Map<string, Route[]>();
  const add = (map: Map<string, Route[]>, a: string, b: string, r: Route) => {
    const key = `${a}|${b}`;
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  };
  /** Adjacency over places that share at least one usable authored option. */
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = neighbours.get(a);
    if (set) set.add(b);
    else neighbours.set(a, new Set([b]));
  };

  for (const r of routes) {
    if (r.originPlaceId && r.destPlaceId) {
      add(byPlacePair, r.originPlaceId, r.destPlaceId, r);
      add(byPlacePair, r.destPlaceId, r.originPlaceId, r); // treat as bidirectional
      if (r.options.some((o) => o.enabled && midPrice(o) > 0)) {
        link(r.originPlaceId, r.destPlaceId);
        link(r.destPlaceId, r.originPlaceId);
      }
    }
    if (r.originCountryId && r.destCountryId && r.originCountryId !== r.destCountryId) {
      add(byCountryPair, r.originCountryId, r.destCountryId, r);
      add(byCountryPair, r.destCountryId, r.originCountryId, r);
    }
  }

  const countryOfPlace = new Map((places ?? []).map((p) => [p.id, p.countryId]));
  const regionOfCountry = new Map((countries ?? []).map((c) => [c.id, c.regionId]));
  const pointOfPlace = new Map<string, GeoPoint>();
  for (const p of places ?? []) {
    if (p.lat != null && p.lon != null) pointOfPlace.set(p.id, { lat: p.lat, lon: p.lon });
  }

  /**
   * Mean position of every located place in a country, used only for the
   * handful of places no source could pin down. A country centroid is a poor
   * coordinate for one city but a far better basis for a leg than no
   * geography at all — it still separates a domestic hop from an
   * intercontinental one, which the flat regional median never did.
   */
  const countryCentroid = new Map<string, GeoPoint>();
  {
    const acc = new Map<string, { lat: number; lon: number; n: number }>();
    for (const p of places ?? []) {
      if (p.lat == null || p.lon == null) continue;
      const cur = acc.get(p.countryId);
      if (cur) {
        cur.lat += p.lat;
        cur.lon += p.lon;
        cur.n++;
      } else {
        acc.set(p.countryId, { lat: p.lat, lon: p.lon, n: 1 });
      }
    }
    for (const [countryId, v] of acc) {
      countryCentroid.set(countryId, { lat: v.lat / v.n, lon: v.lon / v.n });
    }
  }

  /** Best known position for a place: its own, else its country's centroid. */
  const approximatePoint = (placeId: string): GeoPoint | null => {
    const own = pointOfPlace.get(placeId);
    if (own) return own;
    const countryId = countryOfPlace.get(placeId);
    return (countryId ? countryCentroid.get(countryId) : null) ?? null;
  };

  // One typical fare per region, from every priced between-country route in
  // it — the median is robust to the one-off long-haul outlier that a mean
  // would not be.
  const regionSamples = new Map<string, number[]>();
  for (const r of routes) {
    if (r.scope !== "between_countries" || !r.originCountryId) continue;
    const regionId = regionOfCountry.get(r.originCountryId);
    if (!regionId) continue;
    for (const option of r.options) {
      if (!option.enabled) continue;
      const price = midPrice(option);
      if (price <= 0) continue;
      const list = regionSamples.get(regionId);
      if (list) list.push(price);
      else regionSamples.set(regionId, [price]);
    }
  }
  const regionMedian = new Map<string, number>();
  for (const [regionId, prices] of regionSamples) {
    const sorted = [...prices].sort((a, b) => a - b);
    regionMedian.set(regionId, sorted[Math.floor(sorted.length / 2)]);
  }

  /** The direct, authored options for a pair — no fallbacks. */
  const directOptions = (a: string, b: string, preference: TransportPreference): RouteHit[] =>
    collect(byPlacePair.get(`${a}|${b}`) ?? [], preference);

  /**
   * Cheapest chain of real authored hops between two places in the same
   * component, as a single collapsed leg.
   *
   * Dijkstra on the preference-weighted hop score, bounded to
   * `MAX_COMPOSED_HOPS` so a "route" never becomes an implausible grand tour
   * of six intermediate cities to save a few hundred rupees.
   */
  const composePath = (
    originId: string,
    destId: string,
    preference: TransportPreference,
  ): RouteHit | null => {
    if (!neighbours.has(originId) || !neighbours.has(destId)) return null;

    type Node = {
      id: string;
      score: number;
      hops: number;
      minutes: number;
      price: number;
      estimated: boolean;
      via: string[];
      /** Kept so the collapsed leg can report its dominant mode. */
      legs: { mode: TransportMode; minutes: number }[];
    };
    const start: Node = {
      id: originId, score: 0, hops: 0, minutes: 0, price: 0, estimated: false, via: [], legs: [],
    };
    const bestAt = new Map<string, number>([[originId, 0]]);
    const queue: Node[] = [start];

    let arrival: Node | null = null;
    let guard = 0;
    while (queue.length && guard++ < 4000) {
      queue.sort((x, y) => x.score - y.score);
      const node = queue.shift()!;
      if (node.id === destId) {
        arrival = node;
        break;
      }
      if (node.hops >= MAX_COMPOSED_HOPS) continue;
      if ((bestAt.get(node.id) ?? Infinity) < node.score) continue;

      for (const next of neighbours.get(node.id) ?? []) {
        if (next === originId || node.via.includes(next)) continue;
        const hop = directOptions(node.id, next, preference)[0];
        if (!hop) continue;
        const score = node.score + scoreOf(hop, preference);
        if ((bestAt.get(next) ?? Infinity) <= score) continue;
        bestAt.set(next, score);
        queue.push({
          id: next,
          score,
          hops: node.hops + 1,
          minutes: node.minutes + hop.minutes + CONNECTION_BUFFER_MINUTES,
          price: node.price + hop.priceInr,
          estimated: node.estimated || hop.estimated,
          via: [...node.via, next],
          legs: [...node.legs, { mode: hop.mode, minutes: hop.minutes }],
        });
      }
    }

    if (!arrival || arrival.hops < 2) return null;

    // The longest hop is what the leg most honestly looks like to a traveller.
    const dominant = arrival.legs.reduce((a, b) => (b.minutes > a.minutes ? b : a));

    return {
      route: null,
      mode: dominant.mode,
      minutes: Math.max(0, arrival.minutes - CONNECTION_BUFFER_MINUTES),
      priceInr: arrival.price,
      // Composed of real authored fares, but the connection itself is ours.
      estimated: true,
      distanceKm: null,
      onsiteMode: null,
      via: arrival.via.slice(0, -1),
    };
  };

  /**
   * A plausible leg measured from the two places' own coordinates.
   *
   * This is what stops an unrouted pair being quoted a flat region-wide
   * median. Every physically sensible mode for the distance is offered, each
   * priced and timed on the same curves the ETL applies to the authored
   * table, so the traveller still gets a real choice of how to make the leg.
   */
  const synthesise = (
    originId: string,
    destId: string,
    preference: TransportPreference,
  ): RouteHit[] => {
    const a = approximatePoint(originId);
    const b = approximatePoint(destId);
    if (!a || !b) return [];

    const distanceKm = Math.round(haversineKm(a, b));
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) return [];

    const originCountry = countryOfPlace.get(originId);
    const regionId = originCountry ? (regionOfCountry.get(originCountry) ?? "") : "";
    // Domestic legs are assumed drivable; a cross-border pair might not be.
    const sameCountry = originCountry != null && originCountry === countryOfPlace.get(destId);

    const hits = plausibleModes(distanceKm, sameCountry || distanceKm <= LAND_ASSUMPTION_KM).map(
      (mode): RouteHit => ({
        route: null,
        mode,
        minutes: deriveDurationMinutes(mode, distanceKm, regionId),
        priceInr: deriveFareInr(mode, distanceKm),
        estimated: true,
        distanceKm,
        onsiteMode: null,
      }),
    );

    return hits.sort((x, y) => scoreOf(x, preference) - scoreOf(y, preference));
  };

  const optionsFor = (
    originId: string,
    destId: string,
    preference: TransportPreference,
  ): RouteHit[] => {
    const placeCandidates = byPlacePair.get(`${originId}|${destId}`) ?? [];
    const direct = collect(placeCandidates, preference);
    if (direct.length) return direct;

    // A route that exists but offers nothing is a road transfer, not a gap.
    if (isExplicitlyUnavailable(placeCandidates)) return [localTransfer(placeCandidates)];

    // Two real fares beat one invented one.
    const composed = composePath(originId, destId, preference);

    const originCountry = countryOfPlace.get(originId);
    const destCountry = countryOfPlace.get(destId);
    const viaCountry =
      originCountry && destCountry && originCountry !== destCountry
        ? collect(byCountryPair.get(`${originCountry}|${destCountry}`) ?? [], preference)
        : [];

    const synthetic = synthesise(originId, destId, preference);

    // Offer everything we found, best-first, so the traveller still gets a
    // choice of mode on a leg the source data never described.
    const pool = [...(composed ? [composed] : []), ...viaCountry, ...synthetic];
    if (pool.length) {
      const byMode = new Map<string, RouteHit>();
      for (const hit of pool) {
        const existing = byMode.get(hit.mode);
        if (!existing || scoreOf(hit, preference) < scoreOf(existing, preference)) {
          byMode.set(hit.mode, hit);
        }
      }
      return [...byMode.values()].sort((x, y) => scoreOf(x, preference) - scoreOf(y, preference));
    }

    // Last resort, for a place with no coordinate and no connection.
    const regionId = originCountry ? regionOfCountry.get(originCountry) : undefined;
    const fallbackInr = regionId ? regionMedian.get(regionId) : undefined;
    if (fallbackInr) {
      return [{
        route: null, mode: "flight", minutes: 240, priceInr: fallbackInr,
        estimated: true, distanceKm: null, onsiteMode: null,
      }];
    }
    return [];
  };

  return {
    options: (originId, destId, preference = DEFAULT_TRANSPORT_PREFERENCE) =>
      optionsFor(originId, destId, preference),
    best: (originId, destId, preference = DEFAULT_TRANSPORT_PREFERENCE) =>
      optionsFor(originId, destId, preference)[0] ?? null,
    distanceKm: (originId, destId) => {
      const a = pointOfPlace.get(originId);
      const b = pointOfPlace.get(destId);
      return a && b ? haversineKm(a, b) : null;
    },
  };
}

/**
 * Cost of a hop, blending money, time and ground actually covered.
 *
 * The distance term matters more than it looks. Large parts of the authored
 * fare table are flat — a Kerala circuit prices five consecutive legs at the
 * same ₹1,075 regardless of length — which leaves the sequencer with almost no
 * signal to order on, so it returns a geographically incoherent zigzag that
 * happens to tie on price. Folding in the real distance between the two ends
 * breaks those ties the way a human planner would, without overriding a fare
 * difference that is genuinely meaningful.
 */
function hopCost(lookup: RouteLookup, a: string, b: string): number {
  const km = lookup.distanceKm(a, b);
  const ground = km != null ? km * DISTANCE_WEIGHT_INR_PER_KM : 0;

  const hit = lookup.best(a, b);
  // Unconnected pairs are expensive but not impossible — the traveller can
  // always fly, we just have no rate for it.
  if (!hit) return 100_000 + ground;

  // Sequencing always uses the balanced weighting: the visiting order should
  // not lurch around just because the traveller asked for cheaper transport.
  return hit.priceInr + (hit.minutes / 60) * HOUR_VALUE_INR.balanced + ground;
}

/**
 * What a kilometre of ground covered is worth to the sequencer, in INR.
 *
 * Deliberately small: it is there to order places sensibly when fares are
 * uninformative, not to overrule a real price difference.
 */
const DISTANCE_WEIGHT_INR_PER_KM = 12;

/**
 * Where the traveller enters and leaves the trip.
 *
 * Sequencing without this optimises the internal hops in isolation, which is
 * only half the journey: a Delhi traveller doing Cairo, Luxor and Alexandria
 * should land at the gateway nearest home and leave from wherever the itinerary
 * ends, and the order that minimises the three internal hops is not
 * necessarily the one that minimises the whole trip. Modelling the gateway as
 * a virtual first and last node fixes an order that was previously chosen
 * blind to how the traveller actually gets there and back.
 */
export type Gateway = { lat: number; lon: number };

/**
 * Straight-line proxy for the cost of flying between the gateway and a place.
 *
 * Deliberately a distance, not a fare: the international airfare is priced
 * properly from the flight bands during costing. Here it only needs to be
 * monotonic in distance so the *ordering* comes out right, and using the
 * banded fare would double-count the long-haul component at both ends.
 */
function gatewayCost(
  gateway: Gateway | null,
  placeId: string,
  points: Map<string, GeoPoint>,
): number {
  if (!gateway) return 0;
  const point = points.get(placeId);
  if (!point) return 0;
  return haversineKm(gateway, point) * GATEWAY_KM_WEIGHT;
}

/**
 * Weight on gateway distance relative to the money-and-time score of an
 * internal hop. Tuned so the entry/exit choice matters without overwhelming
 * the internal ordering — the internal hops are still the bulk of the trip.
 */
const GATEWAY_KM_WEIGHT = 8;

/**
 * How much less the exit leg counts than the entry leg.
 *
 * An open path and its reverse always visit the same two places at the ends,
 * so a symmetric gateway term scores both identically and leaves the direction
 * of travel to whatever the search happened to find first. Discounting the
 * exit breaks that tie deterministically in favour of entering at the place
 * nearest home, which is how these itineraries are actually built: the
 * long-haul lands at the primary gateway and the trip works outward from it.
 */
const GATEWAY_EXIT_DISCOUNT = 0.85;

/**
 * Orders the places to minimise total transfer cost.
 *
 * Nearest-neighbour from every possible start, then 2-opt improvement. With at
 * most a dozen places this is exhaustive enough to be effectively optimal and
 * still runs in microseconds in the browser.
 *
 * When a gateway is supplied, the open path is scored end to end — arrival
 * from the gateway, every internal hop, then the flight home — so the chosen
 * order reflects the whole journey rather than only its middle.
 */
export function sequencePlaces(
  placeIds: string[],
  lookup: RouteLookup,
  gateway: Gateway | null = null,
  points: Map<string, GeoPoint> = new Map(),
): string[] {
  if (placeIds.length <= 1) return [...placeIds];

  const cost = new Map<string, number>();
  const d = (a: string, b: string) => {
    const key = `${a}|${b}`;
    let v = cost.get(key);
    if (v == null) {
      v = hopCost(lookup, a, b);
      cost.set(key, v);
    }
    return v;
  };

  const entry = (id: string) => gatewayCost(gateway, id, points);

  const tourLength = (tour: string[]) => {
    let total = entry(tour[0]) + entry(tour[tour.length - 1]) * GATEWAY_EXIT_DISCOUNT;
    for (let i = 0; i < tour.length - 1; i++) total += d(tour[i], tour[i + 1]);
    return total;
  };

  // Two places still have two possible orders once the gateway is in play.
  if (placeIds.length === 2) {
    const forward = [placeIds[0], placeIds[1]];
    const reverse = [placeIds[1], placeIds[0]];
    return tourLength(forward) <= tourLength(reverse) ? forward : reverse;
  }

  let best: string[] = [...placeIds];
  let bestLength = tourLength(best);

  for (const start of placeIds) {
    const unvisited = new Set(placeIds);
    unvisited.delete(start);
    const tour = [start];
    while (unvisited.size) {
      const from = tour[tour.length - 1];
      let pick: string | null = null;
      let pickCost = Infinity;
      for (const candidate of unvisited) {
        const c = d(from, candidate);
        if (c < pickCost) {
          pickCost = c;
          pick = candidate;
        }
      }
      tour.push(pick!);
      unvisited.delete(pick!);
    }

    // 2-opt: reverse any segment that shortens the whole path. Scored on the
    // full tour (gateway included) rather than the two touched edges, because
    // reversing a segment that touches either end also changes which place the
    // traveller flies into or out of.
    let improved = true;
    let guard = 0;
    let length = tourLength(tour);
    while (improved && guard++ < 100) {
      improved = false;
      for (let i = 0; i < tour.length - 1; i++) {
        for (let j = i + 1; j < tour.length; j++) {
          const candidate = [
            ...tour.slice(0, i),
            ...tour.slice(i, j + 1).reverse(),
            ...tour.slice(j + 1),
          ];
          const candidateLength = tourLength(candidate);
          if (candidateLength < length - 1e-9) {
            tour.splice(0, tour.length, ...candidate);
            length = candidateLength;
            improved = true;
          }
        }
      }
    }

    if (length < bestLength) {
      best = tour;
      bestLength = length;
    }
  }

  return best;
}

/** Combines allocation and sequencing into the ordered stay list. */
export function buildStays(
  placeIds: string[],
  totalNights: number,
  summaries: Map<string, PlaceSummary>,
  style: TripStyle,
  lookup: RouteLookup,
  names: Map<string, string>,
  overrides: Record<string, number> = {},
  gateway: Gateway | null = null,
  points: Map<string, GeoPoint> = new Map(),
): PlaceStay[] {
  const nights = allocateNights(placeIds, totalNights, summaries, style, overrides);
  const ordered = sequencePlaces(
    placeIds.filter((id) => (nights.get(id) ?? 0) > 0),
    lookup,
    gateway,
    points,
  );
  return ordered.map((placeId, position) => ({
    placeId,
    placeName: names.get(placeId) ?? placeId,
    nights: nights.get(placeId) ?? 0,
    position,
  }));
}
