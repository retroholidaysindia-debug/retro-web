/**
 * Client-facing helpers derived from the compiled catalogue: how many nights
 * a selection of places realistically needs, and which other places are
 * still selectable once some are already chosen.
 *
 * Kept separate from the pricing/day-planning engine because both the map
 * picker and the decision matrix need these *before* a quote is generated,
 * to guide the traveller rather than just validate them after the fact.
 * `filterRealisticSelection` (near the bottom) is the exception — it is the
 * same rule set applied *inside* `generateQuotation()` as a backstop, so a
 * request that reaches the engine by any path other than the two pickers
 * below is still held to the same standard.
 */
import policy from "../../../content/quote-policy.json";
import type { CoreBundle, HotelStar, TravellerType, TripStyle } from "../schema";

export type NightsBounds = {
  /** Hard floor — the slider cannot go below this. */
  min: number;
  /** Sum of each place's own documented/estimated maximum, at least `min`. */
  max: number;
  /** Sum of each place's ideal nights, clamped into [min, max]. */
  recommended: number;
  /**
   * Plain-language explanation of any adjustment made for who is travelling
   * and how they travel, or null when the destinations alone decided it.
   * Surfaced next to the slider so a shifted recommendation reads as a
   * deliberate judgement rather than an unexplained number.
   */
  profileNote: string | null;
};

/** Who is travelling and how, for the purposes of sizing the trip. */
export type TripProfile = {
  travellerType: TravellerType;
  tripStyle: TripStyle;
};

const MIN_TRIP_NIGHTS_BY_REGION = policy.guardrails.minTripNightsByRegion as Record<string, number>;
const MAX_REGIONS_PER_TRIP = policy.guardrails.maxRegionsPerTrip;
const MAX_COUNTRIES_PER_TRIP = policy.guardrails.maxCountriesPerTrip;
const MAX_PLACES_PER_TRIP = policy.guardrails.maxPlacesPerTrip;

const PROFILES = policy.travellerProfiles;
const BY_TRAVELLER = PROFILES.byTraveller as Record<
  string,
  { nightsFactor: number; maxTripNights: number; reason: string }
>;
const BY_STYLE = PROFILES.byStyle as Record<string, { nightsFactor: number; reason: string }>;
const HOTEL_STAR_BY_STYLE = PROFILES.hotelStarByStyle as Record<string, HotelStar>;

/**
 * The hotel category a trip style implies.
 *
 * Style *determines* the category rather than merely hinting at it: an
 * adventure trip sleeps in a 3-star because the traveller is out all day, a
 * honeymoon does not. Exported so the planner and the engine agree on one
 * source of truth instead of each keeping its own table.
 */
export function hotelStarForStyle(style: TripStyle): HotelStar {
  return HOTEL_STAR_BY_STYLE[style] ?? "4 Star";
}

/**
 * Whether a hotel category may be offered for a trip style at all.
 *
 * Only the luxury style unlocks Luxury 5 Star. That tier also carries the
 * higher agent markup, so letting it be reachable from a budget or pilgrimage
 * itinerary would quietly inflate the quote for a trip that never asked for
 * it. Every other tier stays freely selectable as an override.
 */
export function isHotelStarAvailable(style: TripStyle, star: HotelStar): boolean {
  if (star !== "Luxury 5 Star") return true;
  return style === PROFILES.luxuryHotelOnlyForStyle;
}

/**
 * How much longer or shorter this traveller/style pairing makes the same
 * itinerary. The two factors multiply — a honeymooning couple and a pilgrim on
 * a pilgrimage both pull the same way — then clamp, so a compounding pair
 * still lands somewhere an agent would recognise.
 */
function nightsFactorFor(profile: TripProfile): number {
  const traveller = BY_TRAVELLER[profile.travellerType]?.nightsFactor ?? 1;
  const style = BY_STYLE[profile.tripStyle]?.nightsFactor ?? 1;
  const { min, max } = PROFILES.factorRange;
  return Math.min(max, Math.max(min, traveller * style));
}

/**
 * Bounds the total-nights slider by the places actually selected: each
 * place's own min/ideal/max (backfilled at build time for places with no
 * detailed write-up), floored by the region's minimum trip length — a short
 * hop next door can be two nights, but a long-haul region needs enough
 * nights to be worth the flight even if every individual stop there would be
 * "happy" with less.
 *
 * `profile` then adjusts that around who is actually travelling: the
 * destinations decide what is *possible*, the profile decides what is
 * *sensible*. A stag party and a family can pick the same two cities and
 * should not be offered the same trip length.
 */
export function computeNightsBounds(
  core: CoreBundle,
  placeIds: string[],
  profile?: TripProfile,
): NightsBounds {
  if (!placeIds.length) return { min: 0, max: 0, recommended: 0, profileNote: null };

  const summaryById = new Map(core.placeSummaries.map((s) => [s.placeId, s]));
  let min = 0;
  let max = 0;
  let recommended = 0;
  for (const id of placeIds) {
    const s = summaryById.get(id);
    min += Math.max(1, s?.minNights ?? 1);
    max += Math.max(1, s?.maxNights ?? 6);
    recommended += Math.max(1, s?.idealNights ?? 2);
  }

  // Applied to the ideal before headroom is worked out below, so a stretched
  // recommendation still gets room to move above it rather than pinning the
  // slider to its own ceiling. The unadjusted figure is kept so the note can
  // report what actually changed once every clamp has had its say.
  const factor = profile ? nightsFactorFor(profile) : 1;
  const unadjustedIdeal = recommended;
  if (factor !== 1) recommended = Math.max(1, Math.round(recommended * factor));

  const countryOf = new Map(core.places.map((p) => [p.id, p.countryId]));
  const regionOf = new Map(core.countries.map((c) => [c.id, c.regionId]));
  const firstRegion = regionOf.get(countryOf.get(placeIds[0]) ?? "");
  const regionFloor = (firstRegion && MIN_TRIP_NIGHTS_BY_REGION[firstRegion]) || 2;

  min = Math.max(min, regionFloor);
  // A place's own maximum is guidance for a *first visit*, not a hard ceiling
  // on the whole trip — Portugal's own destination file caps a first visit at
  // 4 nights but goes on to say "5+ nights: best for slower travel", and a
  // single-country trip commonly runs far longer than any one place's own
  // cap. Without headroom here, a region's minimum trip length (needed to
  // justify the flight from India) can collide with a tight per-place max and
  // freeze the slider at a single value. Real, generous headroom keeps it
  // usable regardless of how conservative any one place's own guidance is.
  const headroom = Math.max(7, placeIds.length * 3);
  max = Math.max(max, min + headroom, recommended + headroom);
  // ...but never past the trip-wide realism ceiling (see quote-policy.json's
  // guardrails.maxNights) — the per-place sum is a floor on how much room to
  // give the slider, not licence to exceed what the agency has ever sold.
  max = Math.min(max, policy.guardrails.maxNights);

  // The kind of trip caps how long it credibly runs — nobody sells a
  // three-week stag party. Applied last, and never below what the chosen
  // destinations genuinely need: when the two disagree the destinations win,
  // because they are physical fact and the cap is a norm.
  let capNote: string | null = null;
  if (profile) {
    const cap = BY_TRAVELLER[profile.travellerType]?.maxTripNights;
    if (cap != null && cap < max) {
      // Always leave a couple of nights of play, so the slider stays usable
      // even where the cap and the destinations' own floor nearly meet — a
      // slider pinned to a single value reads as broken rather than as a
      // deliberate answer.
      const capped = Math.min(max, Math.max(cap, min + MIN_SLIDER_SPAN));
      capNote =
        cap < min
          ? `A ${labelFor(profile.travellerType)} trip rarely runs beyond ${nights(cap)}, but these ` +
            `destinations need at least ${min} — worth reviewing the shortlist.`
          : `Capped at ${nights(capped)} for a ${labelFor(profile.travellerType)} trip.`;
      max = capped;
    }
  }

  min = Math.min(min, max);
  recommended = Math.min(Math.max(recommended, min), max);
  // The same ideal put through the same final window, but without the
  // profile's factor — so the note reports what *who is travelling* changed,
  // isolated from what the destinations and any cap already forced.
  const baseline = Math.min(Math.max(unadjustedIdeal, min), max);

  return {
    min,
    max,
    recommended,
    // Only speaks up when the profile actually moved the number. On a single
    // long-haul stop the region floor often dominates and nothing shifts;
    // claiming an adjustment there would be noise at best, misleading at worst.
    profileNote: buildNote(profile, recommended - baseline, capNote),
  };
}

/** Nights of play always left on the slider, so it never pins to one value. */
const MIN_SLIDER_SPAN = 2;

/** Traveller type as it reads in a sentence. */
function labelFor(travellerType: TravellerType): string {
  return travellerType === "stags" ? "stag or hen" : travellerType;
}

/** "family", not "family family"; "stag or hen adventure", not "stags adventure". */
function tripLabel(profile: TripProfile): string {
  const traveller = labelFor(profile.travellerType);
  return traveller === profile.tripStyle ? traveller : `${traveller} ${profile.tripStyle}`;
}

/** "1 night", "2 nights" — the note reads as prose, not a template. */
function nights(n: number): string {
  return `${n} night${n === 1 ? "" : "s"}`;
}

function buildNote(
  profile: TripProfile | undefined,
  shift: number,
  capNote: string | null,
): string | null {
  if (!profile) return capNote;
  const parts: string[] = [];
  if (shift > 0) {
    parts.push(`Allowing ${nights(shift)} longer for a ${tripLabel(profile)} trip.`);
  } else if (shift < 0) {
    parts.push(`Kept ${nights(-shift)} tighter for a ${tripLabel(profile)} trip.`);
  }
  if (capNote) parts.push(capNote);
  return parts.length ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Realistic-combination rules
// ---------------------------------------------------------------------------
//
// Three independent caps, each grounded in the agency's own 75 published
// packages (see quote-policy.json's guardrails._realisticComment):
//  - at most `MAX_REGIONS_PER_TRIP` distinct regions (only 1 of 75 packages
//    ever spans two, and it is one specific proven pair, not a general rule)
//  - at most `MAX_COUNTRIES_PER_TRIP` distinct countries (the real max is 4)
//  - at most `MAX_PLACES_PER_TRIP` distinct places (already existed, now
//    enforced live instead of silently trimmed after the fact)
// ...layered on top of the pre-existing pairwise country-compatibility graph
// (`core.countryCompatibility`), which decides *which* second region/country
// is allowed, not how many.

function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

/** Every place the traveller could still add, factoring in all three caps
 *  plus the pairwise compatibility graph — computed once per render so both
 *  pickers can look up a single place's status in O(1). */
export type PlaceSelectability = {
  allowed: boolean;
  /** Why a place is disabled, in plain language — null when allowed. */
  reason: string | null;
};

/**
 * Evaluates every place in the catalogue against the current selection.
 * Already-selected places are always `allowed` (so they can be toggled off).
 * Returns a map covering every place, not just the ones passed in, so a
 * picker can look up any candidate directly without recomputing anything.
 */
export function evaluatePlaceSelectability(
  core: CoreBundle,
  selectedPlaceIds: string[],
): Map<string, PlaceSelectability> {
  const result = new Map<string, PlaceSelectability>();
  for (const id of selectedPlaceIds) result.set(id, { allowed: true, reason: null });
  if (!selectedPlaceIds.length) {
    for (const p of core.places) result.set(p.id, { allowed: true, reason: null });
    return result;
  }

  const countryOf = new Map(core.places.map((p) => [p.id, p.countryId]));
  const regionOf = new Map(core.countries.map((c) => [c.id, c.regionId]));
  const compat = core.countryCompatibility;

  const countriesUsed = new Set<string>();
  const regionsUsed = new Set<string>();
  let allowedCountries: Set<string> | null = null;
  for (const placeId of selectedPlaceIds) {
    const countryId = countryOf.get(placeId);
    if (!countryId) continue;
    countriesUsed.add(countryId);
    const regionId = regionOf.get(countryId);
    if (regionId) regionsUsed.add(regionId);
    const reachable = new Set<string>([countryId, ...(compat[countryId] ?? [])]);
    allowedCountries = allowedCountries ? intersectSets(allowedCountries, reachable) : reachable;
  }

  const atPlaceCap = selectedPlaceIds.length >= MAX_PLACES_PER_TRIP;
  const atCountryCap = countriesUsed.size >= MAX_COUNTRIES_PER_TRIP;
  const atRegionCap = regionsUsed.size >= MAX_REGIONS_PER_TRIP;

  for (const p of core.places) {
    if (result.has(p.id)) continue;

    if (atPlaceCap) {
      result.set(p.id, { allowed: false, reason: `Trip already has the maximum of ${MAX_PLACES_PER_TRIP} places` });
      continue;
    }
    const regionId = regionOf.get(p.countryId);
    const isNewCountry = !countriesUsed.has(p.countryId);
    const isNewRegion = regionId ? !regionsUsed.has(regionId) : false;

    if (isNewCountry && atCountryCap) {
      result.set(p.id, { allowed: false, reason: `Trip already covers the maximum of ${MAX_COUNTRIES_PER_TRIP} countries` });
      continue;
    }
    if (isNewRegion && atRegionCap) {
      result.set(p.id, { allowed: false, reason: `Trip already covers the maximum of ${MAX_REGIONS_PER_TRIP} regions` });
      continue;
    }
    if (allowedCountries && !allowedCountries.has(p.countryId)) {
      result.set(p.id, { allowed: false, reason: "Not realistically combinable with your other destinations" });
      continue;
    }
    result.set(p.id, { allowed: true, reason: null });
  }
  return result;
}

export type SelectionDrop = { placeId: string; reason: string };

/**
 * Engine-side backstop: applies the exact same three caps and the pairwise
 * compatibility graph as `evaluatePlaceSelectability`, but to an already-
 * chosen ordered list rather than "what could be added next" — this is what
 * `generateQuotation()` runs so a request that reaches it by any path other
 * than the two live pickers (a future UI, a stale link, a direct request)
 * still cannot silently price an unrealistic combination.
 *
 * Processes `placeIds` in order, keeping a place only if it stays within all
 * three caps and remains compatible with everything kept so far; a place
 * that breaches any rule is dropped and reported, never silently kept.
 */
export function filterRealisticSelection(
  core: CoreBundle,
  placeIds: string[],
): { kept: string[]; dropped: SelectionDrop[] } {
  const countryOf = new Map(core.places.map((p) => [p.id, p.countryId]));
  const regionOf = new Map(core.countries.map((c) => [c.id, c.regionId]));
  const compat = core.countryCompatibility;

  const kept: string[] = [];
  const dropped: SelectionDrop[] = [];
  const countriesUsed = new Set<string>();
  const regionsUsed = new Set<string>();
  let allowedCountries: Set<string> | null = null;

  for (const placeId of placeIds) {
    const countryId = countryOf.get(placeId);
    if (!countryId) {
      dropped.push({ placeId, reason: "not in the catalogue" });
      continue;
    }
    if (kept.length >= MAX_PLACES_PER_TRIP) {
      dropped.push({ placeId, reason: `trip already has the maximum of ${MAX_PLACES_PER_TRIP} places` });
      continue;
    }
    const regionId = regionOf.get(countryId);
    const isNewCountry = !countriesUsed.has(countryId);
    const isNewRegion = regionId ? !regionsUsed.has(regionId) : false;

    if (isNewCountry && countriesUsed.size >= MAX_COUNTRIES_PER_TRIP) {
      dropped.push({ placeId, reason: `trip already covers the maximum of ${MAX_COUNTRIES_PER_TRIP} countries` });
      continue;
    }
    if (isNewRegion && regionsUsed.size >= MAX_REGIONS_PER_TRIP) {
      dropped.push({ placeId, reason: `trip already covers the maximum of ${MAX_REGIONS_PER_TRIP} regions` });
      continue;
    }
    if (allowedCountries && !allowedCountries.has(countryId)) {
      dropped.push({ placeId, reason: "not realistically combinable with the rest of the trip" });
      continue;
    }

    kept.push(placeId);
    countriesUsed.add(countryId);
    if (regionId) regionsUsed.add(regionId);
    const reachable: Set<string> = new Set<string>([countryId, ...(compat[countryId] ?? [])]);
    allowedCountries = allowedCountries ? intersectSets(allowedCountries, reachable) : reachable;
  }

  return { kept, dropped };
}
