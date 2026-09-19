/**
 * Stage 4: price the itinerary.
 *
 * Follows the workbook's own `Quotation_Calculation` structure: build the direct
 * cost from components, add contingency, apply agent markup, then tax and
 * payment fees. Every line records where its rate came from so a quote can be
 * audited back to the workbook, an estimate, or a live lookup.
 */
import policy from "../../../content/quote-policy.json";
import calibration from "../../../content/pricing-calibration.json";
import type {
  CityTax,
  CoreBundle,
  FlightBand,
  HotelRate,
  InsuranceRate,
  MealRate,
  PlaceSummary,
  RateSource,
  TransferRate,
  VisaRule,
} from "../schema";
import type {
  CostComponent,
  LineItem,
  PlaceStay,
  PlannedDay,
  QuoteRequest,
  QuoteTotals,
} from "./types";
import { formatDuration } from "./text";

const OCC = policy.occupancy;
const VEH = policy.vehicles;
const SEASON = policy.seasonality;
const MARKUP = policy.markup;

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

type FactorTable = Record<string, Partial<Record<CostComponent, number>>>;

const CALIBRATION = calibration as unknown as {
  global: Partial<Record<CostComponent, number>>;
  region: FactorTable;
  country: FactorTable;
  package: FactorTable;
};

export type CalibrationScope = {
  packageId?: string | null;
  countryId?: string | null;
  regionId?: string | null;
};

/**
 * Correction factor for a component.
 *
 * Lets the agency reconcile generated quotes with their published prices
 * without editing the rate card. The most specific scope wins outright — the
 * levels deliberately do not compound, so a package factor is the whole story
 * for that package and stays easy to reason about.
 */
export function calibrationFactor(component: CostComponent, scope: CalibrationScope): number {
  const tiers: (number | undefined)[] = [
    scope.packageId ? CALIBRATION.package?.[scope.packageId]?.[component] : undefined,
    scope.countryId ? CALIBRATION.country?.[scope.countryId]?.[component] : undefined,
    scope.regionId ? CALIBRATION.region?.[scope.regionId]?.[component] : undefined,
    CALIBRATION.global?.[component],
  ];
  for (const value of tiers) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Head counts
// ---------------------------------------------------------------------------

export type PaxBreakdown = {
  adults: number;
  children: number;
  infants: number;
  total: number;
  rooms: number;
  extraBeds: number;
  /** Sum of per-head activity factors — children pay a reduced rate. */
  activityHeads: number;
  mealHeads: number;
};

function bandFor(age: number) {
  return OCC.childBands.find((b) => age <= b.maxAge) ?? OCC.childBands[OCC.childBands.length - 1];
}

export function resolvePax(adults: number, childAges: number[]): PaxBreakdown {
  let infants = 0;
  let children = 0;
  let extraBeds = 0;
  let adultEquivalents = adults;
  let activityHeads = adults;
  let mealHeads = adults;

  for (const age of childAges) {
    const band = bandFor(age);
    activityHeads += band.activityFactor;
    mealHeads += band.mealFactor;
    if (band.roomPolicy === "sharing") infants++;
    else if (band.roomPolicy === "extraBed") {
      children++;
      extraBeds++;
    } else {
      children++;
      adultEquivalents++;
    }
  }

  return {
    adults,
    children,
    infants,
    total: adults + childAges.length,
    rooms: Math.max(1, Math.ceil(adultEquivalents / OCC.adultsPerRoom)),
    extraBeds,
    activityHeads,
    mealHeads,
  };
}

/** Transfers are billed per vehicle, so group size changes the unit cost. */
export function vehiclePlan(pax: number): { count: number; factor: number; label: string } {
  const cls = VEH.classes.find((c) => pax <= c.maxPax) ?? VEH.classes[VEH.classes.length - 1];
  const count = Math.max(1, Math.ceil(pax / cls.maxPax));
  return { count, factor: cls.rateFactor, label: cls.label };
}

// ---------------------------------------------------------------------------
// Seasonality
// ---------------------------------------------------------------------------

/**
 * Maps a destination's monthly price index (0-100) onto a rate multiplier.
 * An index of 50 is neutral; peak months cost more, troughs less.
 */
export function seasonMultiplier(summary: PlaceSummary | undefined, month: number): number {
  const index = summary?.monthPrice?.[String(month)];
  if (index == null) return 1;
  const raw = 1 + (index - SEASON.neutralIndex) * SEASON.sensitivity;
  return Math.min(SEASON.maxMultiplier, Math.max(SEASON.minMultiplier, raw));
}

// ---------------------------------------------------------------------------
// Live-rate override
// ---------------------------------------------------------------------------

export type LiveRate = {
  component: "flight" | "hotel" | "activity";
  key: string;
  inr: number;
  fetchedAt: string;
};

/**
 * Second-level check: a live figure replaces the compiled baseline, but only
 * when it is fresh and within a plausible distance of it, and always with a
 * volatility margin so the quote survives movement before booking.
 */
export function resolveRate(
  baseline: number,
  baselineSource: RateSource,
  live: LiveRate | undefined,
  component: keyof typeof policy.liveRates.volatilityMargin,
): { inr: number; source: RateSource } {
  const cfg = policy.liveRates;
  if (!cfg.enabled || !live || !Number.isFinite(live.inr) || live.inr <= 0) {
    return { inr: baseline, source: baselineSource };
  }

  const ageHours = (Date.now() - Date.parse(live.fetchedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > cfg.maxAgeHours) {
    return { inr: baseline, source: baselineSource };
  }

  // A wildly different live figure is more likely a bad response than a real
  // price, so clamp it rather than trusting it outright.
  const lower = baseline * (1 - cfg.clampDeviation);
  const upper = baseline * (1 + cfg.clampDeviation);
  const clamped = baseline > 0 ? Math.min(upper, Math.max(lower, live.inr)) : live.inr;

  return { inr: clamped * (1 + cfg.volatilityMargin[component]), source: "live" };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PricingInput = {
  request: QuoteRequest;
  pax: PaxBreakdown;
  stays: PlaceStay[];
  days: PlannedDay[];
  core: CoreBundle;
  summaries: Map<string, PlaceSummary>;
  visaRules: VisaRule[];
  /** Live overrides keyed `${component}:${key}`. */
  liveRates: Map<string, LiveRate>;
  /** Per-person activity price by cluster id, from the day planner. */
  activityPrices: Map<string, { code: string | null; price: number; source: RateSource }>;
  /** Scopes the calibration factors to the matched package. */
  referencePackageId?: string | null;
};

function index<T extends { placeId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.placeId);
    if (list) list.push(r);
    else m.set(r.placeId, [r]);
  }
  return m;
}

/**
 * A place with no authored Airport-Hotel/Sightseeing rate at all (its
 * destination is real but the rate card was never filled in for it) still
 * needs one — every "land package" transfer is structurally always charged,
 * per policy. Rather than leave it uncosted, this reuses the median rate for
 * that same service among every OTHER place in the same region that does
 * have one, which is a defensible "typical vehicle transfer here" figure.
 */
function buildRegionalTransferFallback(
  transferRates: TransferRate[],
  places: { id: string; countryId: string }[],
  countries: { id: string; regionId: string }[],
): Map<string, number> {
  const regionOfPlace = new Map<string, string>();
  const regionOfCountry = new Map(countries.map((c) => [c.id, c.regionId]));
  for (const p of places) {
    const regionId = regionOfCountry.get(p.countryId);
    if (regionId) regionOfPlace.set(p.id, regionId);
  }

  const samples = new Map<string, number[]>(); // `${regionId}|${service}` -> rates
  for (const rate of transferRates) {
    const regionId = regionOfPlace.get(rate.placeId);
    if (!regionId || rate.inr <= 0) continue;
    const key = `${regionId}|${rate.service}`;
    const list = samples.get(key);
    if (list) list.push(rate.inr);
    else samples.set(key, [rate.inr]);
  }

  const median = new Map<string, number>();
  for (const [key, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    median.set(key, sorted[Math.floor(sorted.length / 2)]);
  }
  return median;
}

export function priceQuotation(input: PricingInput): {
  lineItems: LineItem[];
  totals: QuoteTotals;
} {
  const { request, pax, stays, days, core, summaries, visaRules, liveRates, activityPrices } = input;
  const items: LineItem[] = [];

  const hotels = index<HotelRate>(core.hotelRates);
  const transfers = index<TransferRate>(core.transferRates);
  const meals = index<MealRate>(core.mealRates);
  const cityTax = new Map<string, CityTax>(core.cityTaxes.map((c) => [c.placeId, c]));
  const placeName = new Map(core.places.map((p) => [p.id, p.name]));
  const countryOf = new Map(core.places.map((p) => [p.id, p.countryId]));
  const regionOf = new Map(core.countries.map((c) => [c.id, c.regionId]));
  const transferFallback = buildRegionalTransferFallback(core.transferRates, core.places, core.countries);

  const startMonth = new Date(`${request.startDate}T00:00:00Z`).getUTCMonth() + 1;

  /**
   * The months each stay's nights actually fall in, and how many land in each.
   *
   * Seasonality used to be read once, from the departure date, and applied to
   * every hotel in the trip. On a three-week itinerary starting in late March
   * that prices the last fortnight at March rates, and a single stay that
   * straddles a month boundary was billed entirely at the cheaper month. The
   * day plan already knows the real date of every night, so each stay's rate
   * is the nights-weighted blend of the months it actually spans.
   */
  const monthsOfStay = new Map<string, Map<number, number>>();
  for (const day of days) {
    // The final day is a departure, not a night, so it must not pull the
    // stay's rate into the following month.
    if (day.hotelPlaceId == null) continue;
    const parsed = new Date(`${day.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) continue;
    const month = parsed.getUTCMonth() + 1;
    const counts = monthsOfStay.get(day.hotelPlaceId) ?? new Map<number, number>();
    counts.set(month, (counts.get(month) ?? 0) + 1);
    monthsOfStay.set(day.hotelPlaceId, counts);
  }

  /** Nights-weighted seasonal multiplier for a stay. */
  const staySeason = (placeId: string): number => {
    const summary = summaries.get(placeId);
    const counts = monthsOfStay.get(placeId);
    if (!counts?.size) return seasonMultiplier(summary, startMonth);

    let weighted = 0;
    let nights = 0;
    for (const [month, count] of counts) {
      weighted += seasonMultiplier(summary, month) * count;
      nights += count;
    }
    return nights ? weighted / nights : seasonMultiplier(summary, startMonth);
  };

  const vehicle = vehiclePlan(pax.total);
  const dietFactor = policy.meals.dietFactor[request.food] ?? 1;

  // Calibration is scoped to the trip's first destination, which is what the
  // reference package and the airfare are anchored on.
  const firstCountryId = stays.length ? (countryOf.get(stays[0].placeId) ?? null) : null;
  const scope: CalibrationScope = {
    packageId: input.referencePackageId ?? null,
    countryId: firstCountryId,
    regionId: core.countries.find((c) => c.id === firstCountryId)?.regionId ?? null,
  };

  const push = (
    component: CostComponent,
    label: string,
    detail: string,
    quantity: number,
    unit: string,
    unitPriceInr: number,
    locked: boolean,
    source: RateSource,
    placeId: string | null,
  ) => {
    // Calibration is applied here so every component is corrected the same way,
    // whatever priced it.
    const calibrated = unitPriceInr * calibrationFactor(component, scope);
    if (quantity <= 0 || calibrated <= 0) return;
    items.push({
      component, label, detail, quantity, unit,
      unitPriceInr: Math.round(calibrated),
      totalInr: Math.round(quantity * calibrated),
      locked, source, placeId,
    });
  };

  // --- hotel ---------------------------------------------------------------
  for (const stay of stays) {
    if (!stay.nights) continue;
    const rate =
      hotels.get(stay.placeId)?.find((h) => h.star === request.hotelStar && h.zone === request.hotelZone) ??
      hotels.get(stay.placeId)?.find((h) => h.star === request.hotelStar);
    if (!rate) continue;

    const season = staySeason(stay.placeId);
    const live = liveRates.get(`hotel:${stay.placeId}:${request.hotelStar}`);
    const resolved = resolveRate(rate.inr * season, rate.source, live, "hotel");

    push("hotel", `${stay.placeName} — ${request.hotelStar}`,
      `${stay.nights} night(s) x ${pax.rooms} room(s), ${request.hotelZone}, room with breakfast`,
      stay.nights * pax.rooms, "room-night", resolved.inr, true, resolved.source, stay.placeId);

    if (pax.extraBeds) {
      const band = OCC.childBands.find((b) => b.roomPolicy === "extraBed");
      push("hotel", `${stay.placeName} — extra bed`,
        `${pax.extraBeds} child bed(s) x ${stay.nights} night(s)`,
        stay.nights * pax.extraBeds, "bed-night",
        resolved.inr * (band?.extraBedFactor ?? 0.35), true, resolved.source, stay.placeId);
    }

    const tax = cityTax.get(stay.placeId);
    if (tax?.perPersonPerNightInr) {
      push("city-tax", `${stay.placeName} — city / tourism tax`,
        `${pax.total} traveller(s) x ${stay.nights} night(s)`,
        stay.nights * pax.total, "person-night", tax.perPersonPerNightInr, true, tax.source, stay.placeId);
    }
  }

  // --- flight --------------------------------------------------------------
  // The bands are return fares to a single country. That is exactly right for
  // a one-country trip, and quietly wrong for every other kind: pricing only a
  // round trip to the *first* destination assumes the traveller doubles back
  // to fly home from where they started, when a Cairo → Nairobi → Cape Town
  // itinerary plainly flies home from South Africa. Where the trip starts and
  // ends in different countries it is priced as an open jaw — the outbound
  // half of the fare to the first country, plus the inbound half of the fare
  // from the last — which is both how such a ticket is actually sold and far
  // closer to the truth than ignoring the return country altogether.
  if (request.includeFlight && stays.length) {
    const selectBand = (destCountryId: string | undefined) => {
      const forCountry = core.flightBands.filter((b: FlightBand) => b.destCountryId === destCountryId);
      // Prefer the requested carrier and cabin, but never return no airfare at
      // all: low-cost carriers do not fly ultra-long-haul, so a traveller who
      // asked for one still has to be quoted the full-service fare.
      const byPreference = forCountry.filter(
        (b) => b.carrier === request.carrier && b.cabin === request.cabin,
      );
      const fallbackCarrier = forCountry.filter((b) => b.cabin === request.cabin);
      const fallbackCabin = forCountry.filter((b) => b.cabin === "Economy");
      const pool = byPreference.length
        ? byPreference
        : fallbackCarrier.length
          ? fallbackCarrier
          : fallbackCabin;

      // Bands are keyed by departure metro, so match the traveller's own city.
      return (
        pool.find((b) => b.originCity === request.departureCity) ??
        pool.find((b) => b.originCity === "*") ??
        pool[0]
      );
    };

    const fareOf = (band: FlightBand, destCountryId: string | undefined) => {
      const baseline = (band.priceLow + band.priceHigh) / 2;
      const live = liveRates.get(`flight:${request.departureCity}:${destCountryId}:${request.carrier}`);
      return resolveRate(baseline, band.source, live, "flight");
    };

    const carrierNote = (band: FlightBand) => {
      const carrierLabel = band.carrier === "LCC" ? "Low-cost carrier" : "Full-service carrier";
      return band.carrier !== request.carrier
        ? `${carrierLabel} (no low-cost service on this route)`
        : carrierLabel;
    };

    const firstPlace = stays[0];
    const lastPlace = stays[stays.length - 1];
    const inboundCountry = countryOf.get(firstPlace.placeId);
    const outboundCountry = countryOf.get(lastPlace.placeId);

    const inboundBand = selectBand(inboundCountry);

    if (inboundBand && inboundCountry === outboundCountry) {
      const resolved = fareOf(inboundBand, inboundCountry);
      push("flight", `Return airfare — ${request.departureCity} to ${placeName.get(firstPlace.placeId)}`,
        `${carrierNote(inboundBand)}, ${inboundBand.cabin}, round trip`,
        pax.total, "person", resolved.inr, false, resolved.source, null);
    } else if (inboundBand) {
      const outboundBand = selectBand(outboundCountry) ?? inboundBand;
      const inboundResolved = fareOf(inboundBand, inboundCountry);
      const outboundResolved = fareOf(outboundBand, outboundCountry);

      push("flight", `Airfare out — ${request.departureCity} to ${placeName.get(firstPlace.placeId)}`,
        `${carrierNote(inboundBand)}, ${inboundBand.cabin}, one way of an open-jaw ticket`,
        pax.total, "person", inboundResolved.inr / 2, false, inboundResolved.source, null);

      push("flight", `Airfare home — ${placeName.get(lastPlace.placeId)} to ${request.departureCity}`,
        `${carrierNote(outboundBand)}, ${outboundBand.cabin}, one way of an open-jaw ticket`,
        pax.total, "person", outboundResolved.inr / 2, false, outboundResolved.source, null);
    }
  }

  // --- airport transfers (structural, always included) ---------------------
  // Every stay gets its own arrival pickup and departure drop-off — the
  // agency's own policy is that these "land package" transfers are always
  // included, whether the traveller is arriving from India at the first stop
  // or moving on from a mid-trip city, so this is not special-cased to only
  // the trip's absolute first arrival and last departure.
  if (stays.length) {
    // Cruise destinations name their transfers Airport→Cruise rather than
    // Airport→Hotel, so accept either.
    const pick = (placeId: string, services: TransferRate["service"][]) => {
      const rows = transfers.get(placeId) ?? [];
      for (const service of services) {
        const hit = rows.find((t) => t.service === service);
        if (hit) return hit;
      }
      return undefined;
    };
    // When a place has no authored rate at all, fall back to the regional
    // median for that exact service rather than leaving the transfer
    // uncosted — it is always structurally included, per policy.
    const fallbackFor = (placeId: string, service: TransferRate["service"]): number | undefined => {
      const regionId = regionOf.get(countryOf.get(placeId) ?? "");
      return regionId ? transferFallback.get(`${regionId}|${service}`) : undefined;
    };
    for (const stay of stays) {
      const arrive = pick(stay.placeId, ["Airport→Hotel", "Airport→Cruise"]);
      const depart = pick(stay.placeId, ["Hotel→Airport", "Cruise→Airport"]);
      const arriveInr = arrive?.inr ?? fallbackFor(stay.placeId, "Airport→Hotel");
      const departInr = depart?.inr ?? fallbackFor(stay.placeId, "Hotel→Airport");
      if (arriveInr) {
        push("airport-transfer", `Airport to hotel — ${placeName.get(stay.placeId)}`,
          `${vehicle.count} x ${vehicle.label}`, vehicle.count, "vehicle",
          arriveInr * vehicle.factor, true, arrive?.source ?? "estimated", stay.placeId);
      }
      if (departInr) {
        push("airport-transfer", `Hotel to airport — ${placeName.get(stay.placeId)}`,
          `${vehicle.count} x ${vehicle.label}`, vehicle.count, "vehicle",
          departInr * vehicle.factor, true, depart?.source ?? "estimated", stay.placeId);
      }
    }
  }

  // --- local transport: one sightseeing vehicle per active day -------------
  const activeDaysByPlace = new Map<string, number>();
  for (const day of days) {
    if (!day.activities.length) continue;
    activeDaysByPlace.set(day.placeId, (activeDaysByPlace.get(day.placeId) ?? 0) + 1);
  }
  for (const [placeId, count] of activeDaysByPlace) {
    const rate =
      transfers.get(placeId)?.find((t) => t.service === "Hotel→Sightseeing") ??
      transfers.get(placeId)?.find((t) => t.service === "Cruise→Sightseeing");
    const regionId = regionOf.get(countryOf.get(placeId) ?? "");
    const fallbackInr = regionId ? transferFallback.get(`${regionId}|Hotel→Sightseeing`) : undefined;
    const inr = rate?.inr ?? fallbackInr;
    if (!inr) continue;
    push("local-transport", `Sightseeing transport — ${placeName.get(placeId)}`,
      `${count} day(s) x ${vehicle.count} x ${vehicle.label}`,
      count * vehicle.count, "vehicle-day", inr * vehicle.factor, true, rate?.source ?? "estimated", placeId);
  }

  // --- intercity transport --------------------------------------------------
  for (const day of days) {
    if (!day.isTransferDay || !day.transfer || day.transfer.priceInr <= 0) continue;
    const leg = day.transfer;
    const mode = leg.mode.replace(/_/g, " ");
    const onsite = leg.onsiteMode ? ` (${leg.onsiteMode.replace(/_/g, " ")})` : "";
    const time = leg.durationMinutes != null ? ` · ${formatDuration(leg.durationMinutes)}` : "";
    const distance = leg.distanceKm ? ` · ${leg.distanceKm} km` : "";
    push("intercity-transport", `${leg.from} to ${leg.to}`,
      `${mode}${onsite}${time}${distance}`,
      pax.total, "person", leg.priceInr, true, leg.estimated ? "estimated" : "workbook", day.placeId);
  }

  // --- sightseeing ----------------------------------------------------------
  for (const day of days) {
    for (const activity of day.activities) {
      if (!activity.clusterId) continue;
      const priced = activityPrices.get(activity.clusterId);
      if (!priced || priced.price <= 0) continue;
      push("sightseeing", `${activity.title} — ${day.placeName}`,
        `Day ${day.dayNumber}, ${activity.hours}h`,
        pax.activityHeads, "person", priced.price, false, priced.source, day.placeId);
    }
  }

  // --- meals ---------------------------------------------------------------
  const lunchDays = new Map<string, number>();
  const dinnerDays = new Map<string, number>();
  for (const day of days) {
    if (day.meals.lunch) lunchDays.set(day.placeId, (lunchDays.get(day.placeId) ?? 0) + 1);
    if (day.meals.dinner) dinnerDays.set(day.placeId, (dinnerDays.get(day.placeId) ?? 0) + 1);
  }
  const mealLine = (map: Map<string, number>, meal: "Lunch" | "Dinner") => {
    for (const [placeId, count] of map) {
      const rate = meals.get(placeId)?.find((m) => m.meal === meal);
      if (!rate) continue;
      push("meals", `${meal} — ${placeName.get(placeId)}`,
        `${count} day(s) x ${pax.mealHeads.toFixed(1)} head(s), ${request.food}`,
        count * pax.mealHeads, "person-meal", rate.inr * dietFactor, false, rate.source, placeId);
    }
  };
  mealLine(lunchDays, "Lunch");
  mealLine(dinnerDays, "Dinner");

  // --- visa ----------------------------------------------------------------
  if (request.includeVisa) {
    const seen = new Set<string>();
    for (const stay of stays) {
      const countryId = countryOf.get(stay.placeId);
      if (!countryId || seen.has(countryId)) continue;
      seen.add(countryId);
      const rule = visaRules.find(
        (v) => v.nationality === request.nationality && v.destCountryId === countryId,
      );
      if (!rule || rule.feeInr <= 0) continue;
      push("visa", `Visa support — ${core.countries.find((c) => c.id === countryId)?.name ?? countryId}`,
        `${request.nationality} passport, ${rule.requirement.replace(/_/g, " ")}`,
        pax.total, "person", rule.feeInr, false, rule.source, null);
    }
  }

  // --- insurance -----------------------------------------------------------
  if (request.includeInsurance && stays.length) {
    const regionId = core.countries.find((c) => c.id === countryOf.get(stays[0].placeId))?.regionId;
    const rate = core.insuranceRates.find((i: InsuranceRate) => i.zone === regionId);
    if (rate) {
      const tripDays = days.length;
      push("insurance", "Travel insurance",
        `${tripDays} day(s) x ${pax.total} traveller(s)`,
        tripDays * pax.total, "person-day", rate.perPersonPerDayInr, false, rate.source, null);
    }
  }

  // --- totals --------------------------------------------------------------
  const directCost = items.reduce((a, i) => a + i.totalInr, 0);
  const contingency = directCost * MARKUP.contingency;
  const costBeforeMarkup = directCost + contingency;
  // Real tour-operator commission is regressive, not flat: a bigger booking
  // already clears the fixed cost of servicing it, so the percentage margin
  // steps down as the per-person direct cost rises (see MARKUP.regressiveBands
  // in content/quote-policy.json).
  const perPersonCost = pax.total > 0 ? costBeforeMarkup / pax.total : costBeforeMarkup;
  const band =
    MARKUP.regressiveBands.find((b) => perPersonCost <= b.maxPerPersonInr) ??
    MARKUP.regressiveBands[MARKUP.regressiveBands.length - 1];
  const baseRate = request.hotelStar === "Luxury 5 Star" ? MARKUP.luxuryMarkup : MARKUP.baseAgentMarkup;
  const markupRate = Math.max(MARKUP.minAgentMarkup, baseRate - band.reduction);
  let agentMarkup = costBeforeMarkup * markupRate;
  // The commercial rule is that contingency + agent margin, combined, must
  // land between 10% and 15% of the direct cost — not a flat rate, since the
  // regressive bands above and the luxury rate can otherwise push it outside
  // that band. Contingency is fixed, so the clamp is absorbed by the margin.
  if (directCost > 0) {
    const combined = contingency + agentMarkup;
    const minCombined = directCost * MARKUP.contingencyMarginRange.min;
    const maxCombined = directCost * MARKUP.contingencyMarginRange.max;
    if (combined < minCombined) agentMarkup += minCombined - combined;
    else if (combined > maxCombined) agentMarkup -= combined - maxCombined;
  }
  const afterMarkup = costBeforeMarkup + agentMarkup;
  const salesVat = afterMarkup * MARKUP.salesVat;
  const paymentAndFx = (afterMarkup + salesVat) * (MARKUP.paymentGatewayFee + MARKUP.fxBuffer);
  const total = Math.round(afterMarkup + salesVat + paymentAndFx);

  return {
    lineItems: items,
    totals: {
      directCost: Math.round(directCost),
      contingency: Math.round(contingency),
      costBeforeMarkup: Math.round(costBeforeMarkup),
      agentMarkup: Math.round(agentMarkup),
      salesVat: Math.round(salesVat),
      paymentAndFx: Math.round(paymentAndFx),
      total,
      // Derived from the rounded total so the two always reconcile.
      perPerson: Math.round(total / Math.max(1, pax.total)),
      flooredToPackage: null,
    },
  };
}
