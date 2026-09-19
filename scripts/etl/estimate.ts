/**
 * Fills the gaps the source data leaves behind, and records every estimate so
 * it can be exported for the agency to review and correct.
 *
 * Two kinds of gap:
 *  1. Places with no sheet in the pricing workbook (223 of 427). Their rates
 *     are inferred from priced peers in the same country, then region.
 *  2. Rate tables the workbook's own index promises but does not contain —
 *     flights, visa fees, insurance, city tax.
 */
import type {
  CityTax,
  Country,
  FlightBand,
  HotelRate,
  HotelStar,
  HotelZone,
  InsuranceRate,
  MealRate,
  MealType,
  Package,
  Place,
  Region,
  TransferRate,
  TransferService,
} from "../../lib/atlas/schema";

export type Estimate = {
  table: string;
  key: string;
  field: string;
  value: number;
  basis: string;
  confidence: "high" | "medium" | "low";
};

const STARS: HotelStar[] = ["3 Star", "4 Star", "5 Star", "Luxury 5 Star"];
const ZONES: HotelZone[] = ["Central", "Outskirts"];
const SERVICES: TransferService[] = [
  "Airport→Hotel",
  "Hotel→Airport",
  "Hotel→Sightseeing",
  "Full Day Vehicle",
  "Extra Hour",
];
const MEALS: MealType[] = ["Lunch", "Dinner", "Snack", "Welcome Drink"];

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Cost-level words in the destination files, as a multiplier on peer medians. */
const COST_LEVEL_FACTOR: [RegExp, number][] = [
  [/VERY\s*HIGH/i, 1.35],
  [/HIGH/i, 1.2],
  [/MEDIUM/i, 1.0],
  [/LOW/i, 0.8],
  [/VERY\s*LOW/i, 0.65],
];

function costFactor(level: string | null | undefined): number {
  if (!level) return 1;
  // "LOW → MEDIUM" — average the ends rather than taking the first match.
  const hits = COST_LEVEL_FACTOR.filter(([re]) => re.test(level)).map(([, f]) => f);
  if (!hits.length) return 1;
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

// ---------------------------------------------------------------------------
// 1. Place rates
// ---------------------------------------------------------------------------

export type RateGapInput = {
  places: Place[];
  countries: Country[];
  hotelRates: HotelRate[];
  transferRates: TransferRate[];
  mealRates: MealRate[];
  /** placeId -> overall cost level from the destination file, when known. */
  costLevels: Map<string, string | null>;
};

export type RateGapOutput = {
  hotelRates: HotelRate[];
  transferRates: TransferRate[];
  mealRates: MealRate[];
  estimates: Estimate[];
  /** Places that still have no rates because no peer could be found. */
  unresolved: Place[];
};

export function estimatePlaceRates(input: RateGapInput): RateGapOutput {
  const { places, countries, hotelRates, transferRates, mealRates, costLevels } = input;
  const countryById = new Map(countries.map((c) => [c.id, c]));

  const priced = new Set<string>([
    ...hotelRates.map((r) => r.placeId),
    ...transferRates.map((r) => r.placeId),
    ...mealRates.map((r) => r.placeId),
  ]);

  // Index existing rates by peer scope so medians are cheap to compute.
  const scopeOf = (placeId: string) => {
    const p = places.find((x) => x.id === placeId);
    const c = p ? countryById.get(p.countryId) : undefined;
    return { countryId: p?.countryId ?? "", regionId: c?.regionId ?? "" };
  };

  const hotelIdx = new Map<string, number[]>();
  const transferIdx = new Map<string, number[]>();
  const mealIdx = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };

  for (const r of hotelRates) {
    const { countryId, regionId } = scopeOf(r.placeId);
    push(hotelIdx, `c:${countryId}|${r.star}|${r.zone}`, r.inr);
    push(hotelIdx, `r:${regionId}|${r.star}|${r.zone}`, r.inr);
    push(hotelIdx, `*|${r.star}|${r.zone}`, r.inr);
  }
  for (const r of transferRates) {
    const { countryId, regionId } = scopeOf(r.placeId);
    push(transferIdx, `c:${countryId}|${r.service}`, r.inr);
    push(transferIdx, `r:${regionId}|${r.service}`, r.inr);
    push(transferIdx, `*|${r.service}`, r.inr);
  }
  for (const r of mealRates) {
    const { countryId, regionId } = scopeOf(r.placeId);
    push(mealIdx, `c:${countryId}|${r.meal}`, r.inr);
    push(mealIdx, `r:${regionId}|${r.meal}`, r.inr);
    push(mealIdx, `*|${r.meal}`, r.inr);
  }

  const out: RateGapOutput = {
    hotelRates: [],
    transferRates: [],
    mealRates: [],
    estimates: [],
    unresolved: [],
  };

  /** Peer median for a key, preferring country then region then global. */
  const lookup = (
    idx: Map<string, number[]>,
    countryId: string,
    regionId: string,
    suffix: string,
  ): { value: number; basis: string } | null => {
    const tiers: [string, string][] = [
      [`c:${countryId}|${suffix}`, "country peers"],
      [`r:${regionId}|${suffix}`, "region peers"],
      [`*|${suffix}`, "global median"],
    ];
    for (const [key, basis] of tiers) {
      const m = median(idx.get(key) ?? []);
      if (m != null) return { value: m, basis };
    }
    return null;
  };

  for (const place of places) {
    if (priced.has(place.id)) continue;
    const country = countryById.get(place.countryId);
    const countryId = place.countryId;
    const regionId = country?.regionId ?? "";
    const factor = costFactor(costLevels.get(place.id));
    let filled = 0;

    for (const star of STARS) {
      for (const zone of ZONES) {
        const hit = lookup(hotelIdx, countryId, regionId, `${star}|${zone}`);
        if (!hit) continue;
        const inr = Math.round(hit.value * factor);
        out.hotelRates.push({
          placeId: place.id,
          star,
          zone,
          mealPlan: "Breakfast",
          unit: "Room/Night",
          inr,
          baseline: null,
          baselineCurrency: null,
          source: "estimated",
        });
        out.estimates.push({
          table: "hotel_rate",
          key: `${place.name} / ${star} / ${zone}`,
          field: "inr",
          value: inr,
          basis: `${hit.basis} median x${factor.toFixed(2)} cost-level`,
          confidence: hit.basis === "country peers" ? "medium" : "low",
        });
        filled++;
      }
    }

    for (const service of SERVICES) {
      const hit = lookup(transferIdx, countryId, regionId, service);
      if (!hit) continue;
      const inr = Math.round(hit.value * factor);
      out.transferRates.push({
        placeId: place.id,
        service,
        unit: "Vehicle",
        inr,
        baseline: null,
        baselineCurrency: null,
        source: "estimated",
      });
      out.estimates.push({
        table: "transfer_rate",
        key: `${place.name} / ${service}`,
        field: "inr",
        value: inr,
        basis: `${hit.basis} median x${factor.toFixed(2)} cost-level`,
        confidence: hit.basis === "country peers" ? "medium" : "low",
      });
      filled++;
    }

    for (const meal of MEALS) {
      const hit = lookup(mealIdx, countryId, regionId, meal);
      if (!hit) continue;
      const inr = Math.round(hit.value * factor);
      out.mealRates.push({
        placeId: place.id,
        meal,
        unit: "Person",
        inr,
        baseline: null,
        baselineCurrency: null,
        source: "estimated",
      });
      out.estimates.push({
        table: "meal_rate",
        key: `${place.name} / ${meal}`,
        field: "inr",
        value: inr,
        basis: `${hit.basis} median x${factor.toFixed(2)} cost-level`,
        confidence: hit.basis === "country peers" ? "medium" : "low",
      });
      filled++;
    }

    if (!filled) out.unresolved.push(place);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. Flight bands
// ---------------------------------------------------------------------------

/**
 * Cross-checks each published package price against what its own land
 * components cost once the markup chain is applied.
 *
 * The agency publishes land-only "from" prices — airfare is quoted on top — so
 * this is a direct land-vs-land comparison. The cheapest airfare band is
 * carried alongside purely to show what a traveller will be asked for *in
 * addition*, never as something the published price has to absorb.
 */
export function reconcilePackagePrices(
  packages: Package[],
  landCostPerPerson: Map<string, number>,
  markupChain: number,
  bands: FlightBand[],
): {
  packageId: string;
  name: string;
  published: number;
  land: number;
  landSellPrice: number;
  headroom: number;
  flightOnTop: number;
}[] {
  const bandByCountry = new Map<string, FlightBand>();
  for (const b of bands) {
    if (b.carrier === "FSC" && b.cabin === "Economy") bandByCountry.set(b.destCountryId, b);
  }
  return packages.map((p) => {
    const land = landCostPerPerson.get(p.id) ?? 0;
    // What we would actually have to charge for the land package, before any
    // discounting — the published price has to at least cover this.
    const landSellPrice = land * markupChain;
    // A multi-country package is quoted against its first country's band.
    const band = p.countryIds.map((id) => bandByCountry.get(id)).find(Boolean);
    return {
      packageId: p.id,
      name: p.name,
      published: p.priceFromInr,
      land: Math.round(land),
      landSellPrice: Math.round(landSellPrice),
      headroom: Math.round(p.priceFromInr - landSellPrice),
      flightOnTop: band?.priceLow ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Insurance and city tax
// ---------------------------------------------------------------------------

const INSURANCE_BY_REGION: Record<string, number> = {
  india: 60,
  "south-asia": 120,
  "south-east-asia": 150,
  "middle-east-and-gulf": 160,
  "east-asia": 200,
  "eurasia-cis": 180,
  africa: 260,
  europe: 300,
  russia: 220,
  oceania: 300,
};

/** Per person per night, INR. Tourist/city taxes are a European habit. */
const CITY_TAX_BY_REGION: Record<string, number> = {
  india: 0,
  "south-asia": 0,
  "south-east-asia": 0,
  "middle-east-and-gulf": 180,
  "east-asia": 120,
  "eurasia-cis": 0,
  africa: 90,
  europe: 320,
  russia: 0,
  oceania: 0,
};

export function estimateInsuranceAndTax(
  regions: Region[],
  places: Place[],
  countries: Country[],
): { insurance: InsuranceRate[]; cityTax: CityTax[]; estimates: Estimate[] } {
  const countryById = new Map(countries.map((c) => [c.id, c]));
  const estimates: Estimate[] = [];

  const insurance: InsuranceRate[] = regions.map((r) => {
    const perDay = INSURANCE_BY_REGION[r.id] ?? 250;
    estimates.push({
      table: "insurance_rate",
      key: r.name,
      field: "perPersonPerDayInr",
      value: perDay,
      basis: "typical retail travel-insurance day rate — no insurance sheet in the workbook",
      confidence: "low",
    });
    return { zone: r.id, perPersonPerDayInr: perDay, source: "estimated" };
  });

  const cityTax: CityTax[] = [];
  const reported = new Set<string>();
  for (const place of places) {
    const regionId = countryById.get(place.countryId)?.regionId ?? "";
    const perNight = CITY_TAX_BY_REGION[regionId] ?? 0;
    if (!perNight) continue;
    cityTax.push({ placeId: place.id, perPersonPerNightInr: perNight, source: "estimated" });
    if (!reported.has(regionId)) {
      reported.add(regionId);
      estimates.push({
        table: "city_tax",
        key: `all places in ${regionId}`,
        field: "perPersonPerNightInr",
        value: perNight,
        basis: "regional average tourist tax — no Other_Costs sheet in the workbook",
        confidence: "low",
      });
    }
  }

  return { insurance, cityTax, estimates };
}

/**
 * Government visa fee plus agency handling, per person, in INR, for an Indian
 * passport. Hand-seeded because no free dataset carries fees — the
 * passport-index data supplies the *requirement*, this supplies the price.
 */
export const VISA_FEE_INR: Record<string, number> = {
  EGY: 2800, KEN: 4500, MUS: 0, SYC: 0, ZAF: 4200,
  GEO: 2500, AZE: 2200, KAZ: 3000, UZB: 2000, KGZ: 2500,
  RUS: 7500, LKA: 4500, NPL: 0, BTN: 1800, MDV: 0,
  JPN: 3200, KOR: 5500, CHN: 9500, HKG: 0,
  FRA: 8500, CHE: 8500, LUX: 8500, BEL: 8500, DEU: 8500,
  AUT: 8500, NLD: 8500, LIE: 8500, CZE: 8500, HUN: 8500,
  POL: 8500, ESP: 8500, PRT: 8500, GRC: 8500, ITA: 8500,
  DNK: 8500, NOR: 8500, SWE: 8500, FIN: 8500, ISL: 8500,
  GBR: 13500, IRL: 11000,
  ARE: 6500, TUR: 4500, OMN: 4000, JOR: 5500,
  NZL: 18000, AUS: 16500, FJI: 0,
  VNM: 2800, THA: 0, SGP: 3000, MYS: 0, IDN: 3200,
  KHM: 3200, LAO: 3200, PHL: 3500,
  IND: 0, ROU: 8500, PYF: 8500,
};
