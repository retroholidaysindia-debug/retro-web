import { z } from "zod";

/**
 * The Atlas relational model.
 *
 * One schema serves three consumers: the ETL validates what it emits, the
 * quotation engine reads it, and `scripts/etl/emit-sql.ts` renders the same
 * shape as SQLite DDL so the whole model can move to Cloudflare D1 later
 * without a redesign.
 *
 * Money is stored as INR minor-unit-free integers/floats — every rate carries
 * `inr` as the canonical figure plus its original baseline for auditability.
 */

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

/** Where a number came from. Surfaced per line item in the quotation. */
export const RateSource = z.enum([
  "workbook", // Pricing_Rules.xlsx — the agency's own contracted card
  "estimated", // Derived at build time for a gap; needs agency review
  "live", // Fetched from a rate API at quote time
  "manual", // Hand-entered override committed to the repo
]);
export type RateSource = z.infer<typeof RateSource>;

export const HotelStar = z.enum(["3 Star", "4 Star", "5 Star", "Luxury 5 Star"]);
export type HotelStar = z.infer<typeof HotelStar>;

export const HotelZone = z.enum(["Central", "Outskirts"]);
export type HotelZone = z.infer<typeof HotelZone>;

/** Transfer services priced per vehicle, not per person. */
export const TransferService = z.enum([
  "Airport→Hotel",
  "Hotel→Airport",
  "Hotel→Sightseeing",
  "Full Day Vehicle",
  "Extra Hour",
  "Airport→Cruise",
  "Cruise→Airport",
  "Cruise→Sightseeing",
]);
export type TransferService = z.infer<typeof TransferService>;

export const MealType = z.enum(["Lunch", "Dinner", "Snack", "Welcome Drink"]);
export type MealType = z.infer<typeof MealType>;

export const TransportMode = z.enum([
  "flight",
  "train",
  "bus",
  "cruise",
  "ferry",
  "seaplane",
  "shared_vehicle",
  "private_vehicle",
]);
export type TransportMode = z.infer<typeof TransportMode>;

/** Who is travelling — drives room allocation and pace, and selects TripStyle. */
export const TravellerType = z.enum([
  "family",
  "couple",
  "friends",
  "stags",
  "business",
  "pilgrimage",
  "solo",
]);
export type TravellerType = z.infer<typeof TravellerType>;

/**
 * How the trip is planned. These map 1:1 onto the "ACTIVITIES BY PURPOSE"
 * headings in the destination files, which is what makes day planning
 * data-driven rather than heuristic.
 */
export const TripStyle = z.enum([
  "family",
  "honeymoon",
  "romantic",
  "luxury",
  "budget",
  "culture",
  "adventure",
  "pilgrimage",
]);
export type TripStyle = z.infer<typeof TripStyle>;

export const FoodPreference = z.enum(["veg", "non-veg", "vegan", "jain", "halal", "no-preference"]);
export type FoodPreference = z.infer<typeof FoodPreference>;

export const CarrierType = z.enum(["LCC", "FSC"]);
export type CarrierType = z.infer<typeof CarrierType>;

export const WalkingIntensity = z.enum(["LOW", "LOW_MEDIUM", "MEDIUM", "MEDIUM_HIGH", "HIGH"]);
export type WalkingIntensity = z.infer<typeof WalkingIntensity>;

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export const Region = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const Country = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  regionId: z.string(),
  /** ISO-3166-1 alpha-3 where the node is a real country; null for clusters. */
  iso3: z.string().length(3).nullable(),
  /**
   * Several master nodes are marketing clusters, not countries
   * ("Europen Cluster 1", "Trans Siberian Russia"). They still own packages.
   */
  isCluster: z.boolean(),
  /** For clusters, the real countries covered. */
  memberCountryIds: z.array(z.string()),
});

export const Subregion = z.object({
  id: z.string(),
  name: z.string(),
  regionId: z.string(),
});

export const State = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  countryId: z.string(),
  subregionId: z.string().nullable(),
});

export const Place = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  countryId: z.string(),
  stateId: z.string().nullable(),
  /** True once the place has a rate card and can be priced without estimation. */
  hasRates: z.boolean(),
  hasContent: z.boolean(),
  /**
   * Resolved at build time from the hand-placed map marker, the primary
   * airport, or the cached geocoder — in that order of preference.
   *
   * Carried into the runtime bundle because the transport graph is far too
   * sparse to route on alone: only ~1.4% of place pairs have an authored
   * route, and the usable graph breaks into dozens of small components. With
   * a coordinate the engine can measure any pair directly and synthesise a
   * plausible leg; without one it has to fall back to a region-wide median
   * fare that is identical for a 120km hop and a 6,000km one.
   *
   * Null for the handful of places no source could locate — never guessed,
   * because a wrong coordinate silently mis-prices every leg touching it.
   */
  lat: z.number().min(-90).max(90).nullable().default(null),
  lon: z.number().min(-180).max(180).nullable().default(null),
});

/** Every source spelling that resolves to a place, with how it was matched. */
export const PlaceAlias = z.object({
  alias: z.string(),
  placeId: z.string(),
  source: z.enum(["master", "pricing", "markdown", "transport", "manual"]),
  how: z.string(),
});

// ---------------------------------------------------------------------------
// Destination content (parsed from the destination markdown files)
// ---------------------------------------------------------------------------

export const Destination = z.object({
  placeId: z.string(),
  destinationCode: z.string().nullable(),
  shortDescription: z.string().nullable(),
  agentSummary: z.string().nullable(),
  destinationTypes: z.array(z.string()),
  currency: z.string().nullable(),
  timezone: z.string().nullable(),
  minNights: z.number().int().nonnegative().nullable(),
  idealNights: z.number().int().nonnegative().nullable(),
  maxNights: z.number().int().nonnegative().nullable(),
  gettingAround: z.array(z.string()),
  primaryAirports: z.array(z.string()),
  overallCostLevel: z.string().nullable(),
});

/**
 * A block of planner guidance lifted from the destination files.
 *
 * The files follow a 36-section convention, but only 15 of those sections were
 * ever read. The other 21 — present in ~213 files each — carry the material
 * that actually makes these documents worth having: how airport transfers
 * really work in this city (§12), what to do and avoid with children, on a
 * honeymoon, at the luxury end, with seniors, or with limited mobility
 * (§18-23), food, shopping and nightlife (§24-26), worked itinerary patterns
 * (§28-31), what inexperienced planners get wrong and what an experienced one
 * does instead (§32), explicit IF/THEN decision rules (§33), and the agency's
 * own closing verdict (§35).
 *
 * All of it was parsed by nothing and reached neither the model nor the quote.
 * Rather than inventing a bespoke shape per section — several are free prose
 * and would be lossy in any rigid schema — each block is captured whole, keyed
 * by the section it came from and by the audience its subheading names, so the
 * engine can pull exactly the blocks that apply to the trip being quoted.
 */
export const DestinationGuidance = z.object({
  placeId: z.string(),
  /** Source section number, 1-36. */
  section: z.number().int().min(1).max(60),
  /** Slug of the section title, e.g. `travel-agent-insights`. */
  topic: z.string(),
  /** Section title as written. */
  sectionTitle: z.string(),
  /** Subheading within the section, when it had one. */
  heading: z.string().nullable(),
  /**
   * Who this block is about, when the subheading names them — `family`,
   * `honeymoon`, `luxury`, `budget`, `adventure`, `senior`, `accessibility`.
   * Null for guidance that applies to everyone.
   */
  audience: z.string().nullable(),
  /** Bulleted points, already stripped of their markers. */
  bullets: z.array(z.string()),
  /** The prose, with bullets removed. */
  body: z.string(),
});
export type DestinationGuidance = z.infer<typeof DestinationGuidance>;

/**
 * One parsed decision rule from section 33.
 *
 * Stored structured rather than as prose so the engine can decide whether a
 * rule applies to the trip in hand, instead of showing a traveller all sixteen
 * of a destination's rules and leaving them to work it out.
 */
export const DecisionRuleRow = z.object({
  placeId: z.string(),
  id: z.string(),
  conditions: z.array(
    z.object({
      variable: z.string(),
      operator: z.enum(["==", "!=", ">=", "<=", ">", "<"]),
      value: z.string(),
      number: z.number().nullable(),
      unit: z.string().nullable(),
      joiner: z.enum(["AND", "OR"]).nullable(),
    }),
  ),
  action: z.string(),
  reason: z.string().nullable(),
  /** Actions the engine executes rather than merely reporting. */
  effects: z.array(
    z.object({
      kind: z.enum(["prioritise", "avoid"]),
      tokens: z.array(z.string()),
    }),
  ),
});
export type DecisionRuleRow = z.infer<typeof DecisionRuleRow>;

export const SuitabilityScore = z.object({
  placeId: z.string(),
  category: z.string(),
  score: z.number().min(0).max(100),
});

export const DestinationTag = z.object({
  placeId: z.string(),
  kind: z.enum(["best_for", "not_ideal_for", "primary_purpose", "secondary_purpose"]),
  tag: z.string(),
});

/** Section 8 — the per-month price index drives the seasonality multiplier. */
export const MonthlyScore = z.object({
  placeId: z.string(),
  month: z.number().int().min(1).max(12),
  weather: z.number().nullable(),
  crowd: z.number().nullable(),
  price: z.number().nullable(),
  overall: z.number().nullable(),
  recommendation: z.string().nullable(),
});

/** Section 14 — an area is a hotel-zone choice within a place. */
export const Area = z.object({
  id: z.string(),
  placeId: z.string(),
  name: z.string(),
  priceLevel: z.string().nullable(),
  transportConvenience: z.number().nullable(),
  bestFor: z.array(z.string()),
  advantages: z.array(z.string()),
  disadvantages: z.array(z.string()),
  recommendedFor: z.array(z.string()),
  /** Which pricing zone this area bills at. */
  zone: HotelZone,
});

/** Section 16 — named attractions with a first-time-visitor priority band. */
export const Attraction = z.object({
  id: z.string(),
  placeId: z.string(),
  name: z.string(),
  priority: z.number().int().min(0).max(100),
});

/** Section 15 — the code is the join key to `ActivityRate`. */
export const Activity = z.object({
  id: z.string(),
  placeId: z.string(),
  code: z.string(),
  name: z.string(),
});

/** Section 17 — which activities suit which trip style. */
export const PurposeActivity = z.object({
  placeId: z.string(),
  purpose: TripStyle,
  description: z.string(),
});

/**
 * Section 27 — the unit of day planning. A day is filled by packing clusters
 * until the active-hours budget is exhausted.
 */
export const Cluster = z.object({
  id: z.string(),
  placeId: z.string(),
  name: z.string(),
  attractions: z.array(z.string()),
  recommendedDuration: z.string().nullable(),
  /** `recommendedDuration` resolved to hours (half day = 4, full day = 8). */
  durationHours: z.number().positive(),
  walkingIntensity: WalkingIntensity.nullable(),
});

// ---------------------------------------------------------------------------
// Rate card
// ---------------------------------------------------------------------------

const RateBase = {
  placeId: z.string(),
  inr: z.number().nonnegative(),
  baseline: z.number().nonnegative().nullable(),
  baselineCurrency: z.string().nullable(),
  source: RateSource,
};

export const HotelRate = z.object({
  ...RateBase,
  star: HotelStar,
  zone: HotelZone,
  /** The workbook only carries room-with-breakfast; other plans are derived. */
  mealPlan: z.enum(["Breakfast", "Half Board", "Full Board", "Room Only"]),
  unit: z.literal("Room/Night"),
});

export const TransferRate = z.object({
  ...RateBase,
  service: TransferService,
  unit: z.literal("Vehicle"),
});

export const MealRate = z.object({
  ...RateBase,
  meal: MealType,
  unit: z.literal("Person"),
});

export const ActivityRate = z.object({
  ...RateBase,
  code: z.string(),
  unit: z.string(),
});

export const MarkupRule = z.object({
  level: z.enum(["Package", "Service", "Tax", "Fee"]),
  rule: z.string(),
  unit: z.string(),
  value: z.number(),
  notes: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Transport network
// ---------------------------------------------------------------------------

export const RouteOption = z.object({
  mode: TransportMode,
  enabled: z.boolean(),
  priceLow: z.number().nonnegative().nullable(),
  priceHigh: z.number().nonnegative().nullable(),
  currency: z.string().nullable(),
  durationMinutes: z.number().nonnegative().nullable(),
  terminalFrom: z.string().nullable(),
  terminalTo: z.string().nullable(),
  unavailableReason: z.string().nullable(),
  /** Where the fare came from. */
  priceSource: RateSource.default("workbook"),
  /**
   * Where the journey time came from. The source data leaves this null on
   * ~93% of options, which used to collapse to a flat default and made every
   * mode look equally long — so a missing one is derived from real
   * great-circle distance and a per-mode speed profile.
   */
  durationSource: RateSource.default("workbook"),
  /** Great-circle km between the two endpoints, when both are locatable. */
  distanceKm: z.number().nonnegative().nullable().default(null),
});

export const Route = z.object({
  id: z.string(),
  scope: z.enum(["within_country", "between_countries"]),
  /** The package/country context the route was authored under. */
  countryContext: z.string().nullable(),
  originPlaceId: z.string().nullable(),
  destPlaceId: z.string().nullable(),
  originCountryId: z.string().nullable(),
  destCountryId: z.string().nullable(),
  /** When the journey *is* the experience (Nile cruise, Ha Long Bay). */
  onsiteMode: z.string().nullable(),
  tourType: z.array(z.string()),
  routeType: z.string().nullable(),
  options: z.array(RouteOption),
});

// ---------------------------------------------------------------------------
// Commercial tables absent from the workbook (estimated at build time,
// overridable by the review workbook and by live APIs)
// ---------------------------------------------------------------------------

export const FlightBand = z.object({
  id: z.string(),
  /** Departure metro in India; "*" is the catch-all fallback. */
  originCity: z.string(),
  destCountryId: z.string(),
  carrier: CarrierType,
  cabin: z.enum(["Economy", "Premium Economy", "Business"]),
  tripType: z.enum(["Round Trip", "One Way"]),
  priceLow: z.number().nonnegative(),
  priceHigh: z.number().nonnegative(),
  currency: z.literal("INR"),
  durationMinutes: z.number().nonnegative().nullable(),
  source: RateSource,
});

export const VisaRule = z.object({
  /** Passport country, ISO-3166-1 alpha-3. */
  nationality: z.string().length(3),
  destCountryId: z.string(),
  requirement: z.enum([
    "visa_free",
    "visa_on_arrival",
    "e_visa",
    "eta",
    "visa_required",
    "no_admission",
  ]),
  /** Government fee plus the agency's handling charge, per person. */
  feeInr: z.number().nonnegative(),
  processingDays: z.number().int().nonnegative().nullable(),
  source: RateSource,
});

export const InsuranceRate = z.object({
  /** Coarse risk zone: "domestic" | "asia" | "schengen" | "worldwide" ... */
  zone: z.string(),
  perPersonPerDayInr: z.number().nonnegative(),
  source: RateSource,
});

export const CityTax = z.object({
  placeId: z.string(),
  perPersonPerNightInr: z.number().nonnegative(),
  source: RateSource,
});

// ---------------------------------------------------------------------------
// Packages — the reference itineraries every quotation is built from
// ---------------------------------------------------------------------------

export const Package = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  regionId: z.string(),
  /**
   * Packages live at region level and may span several countries
   * ("European Delights" covers France, Switzerland, Luxembourg and Belgium).
   */
  countryIds: z.array(z.string()),
  /** Indian packages additionally resolve to the states their places sit in. */
  stateIds: z.array(z.string()),
  nights: z.number().int().nonnegative(),
  days: z.number().int().positive(),
  /**
   * Published "from" price, per person, twin share — the *land* package only.
   * Airfare is quoted on top (see `priceIncludesFlight`), so this must never
   * be compared against an all-in generated total without first removing the
   * flight component, or every package looks wildly over-quoted.
   */
  priceFromInr: z.number().nonnegative(),
  /**
   * Whether `priceFromInr` already covers airfare. The agency's master file
   * publishes land-only "from" prices, so this is `false` throughout today —
   * it is modelled per package rather than assumed globally so a future
   * all-inclusive fare cannot silently be treated as land-only.
   */
  priceIncludesFlight: z.boolean(),
  /** True when duration is marketed as "Flexible". */
  flexibleDuration: z.boolean(),
  description: z.string(),
  highlights: z.array(z.string()),
  placeIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Bundles as shipped to the client
// ---------------------------------------------------------------------------

/** Loaded once, on entering the planner. Small enough to ship whole. */
export const CoreBundle = z.object({
  version: z.string(),
  generatedAt: z.string(),
  regions: z.array(Region),
  countries: z.array(Country),
  subregions: z.array(Subregion),
  states: z.array(State),
  places: z.array(Place),
  packages: z.array(Package),
  hotelRates: z.array(HotelRate),
  transferRates: z.array(TransferRate),
  mealRates: z.array(MealRate),
  markupRules: z.array(MarkupRule),
  flightBands: z.array(FlightBand),
  insuranceRates: z.array(InsuranceRate),
  cityTaxes: z.array(CityTax),
  /**
   * The departure metros the planner offers, with the coordinates of their
   * airport.
   *
   * Carried in the bundle because the gateway is part of the routing problem,
   * not just a pricing key: the order places are visited in should account for
   * where the traveller enters and leaves the trip, and the return home has to
   * be priced from wherever the itinerary actually ends.
   */
  departureCities: z
    .array(
      z.object({
        /** IATA code of the metro's main airport, e.g. `DEL`. */
        code: z.string(),
        label: z.string(),
        lat: z.number().nullable().default(null),
        lon: z.number().nullable().default(null),
      }),
    )
    .default([]),
  /**
   * Which other countries a given country can realistically be combined with
   * in one land package: same region (normal multi-country travel), plus any
   * cross-region pair proven either by a real published package or by a real
   * authored transport route. Symmetric — every id lists every id it maps to
   * back. Used to grey out unrealistic combinations on the map picker before
   * the traveller ever reaches a broken quote.
   */
  countryCompatibility: z.record(z.string(), z.array(z.string())),
  /** Min/ideal/max nights + cost level for every place, for allocation. */
  placeSummaries: z.array(
    z.object({
      placeId: z.string(),
      minNights: z.number().int().nonnegative().nullable(),
      idealNights: z.number().int().nonnegative().nullable(),
      maxNights: z.number().int().nonnegative().nullable(),
      clusterCount: z.number().int().nonnegative(),
      activityCount: z.number().int().nonnegative(),
      /** Suitability score per trip style, 0-100. */
      styleScores: z.record(z.string(), z.number()),
      /** Month index 1-12 -> price index 0-100. */
      monthPrice: z.record(z.string(), z.number()),
      /**
       * Month index 1-12 -> weather and overall desirability, 0-100.
       *
       * The destination files score every month on weather, crowd and an
       * overall verdict, but only the price index was ever carried into the
       * bundle — so the engine could tell you a July trip to Kerala was
       * cheap without ever mentioning it is the middle of the monsoon.
       * Carried here so the quote can warn, and can point at a better month.
       */
      monthWeather: z.record(z.string(), z.number()).default({}),
      monthOverall: z.record(z.string(), z.number()).default({}),
    }),
  ),
});

/** Lazily fetched per selected place. */
export const DestinationBundle = z.object({
  place: Place,
  destination: Destination.nullable(),
  suitability: z.array(SuitabilityScore),
  tags: z.array(DestinationTag),
  months: z.array(MonthlyScore),
  areas: z.array(Area),
  attractions: z.array(Attraction),
  activities: z.array(Activity),
  activityRates: z.array(ActivityRate),
  purposeActivities: z.array(PurposeActivity),
  clusters: z.array(Cluster),
  /** Planner guidance from the sections the parser used to skip entirely. */
  guidance: z.array(DestinationGuidance).default([]),
  /** Section 33's decision rules, parsed into an evaluable form. */
  decisionRules: z.array(DecisionRuleRow).default([]),
});

export const RoutesBundle = z.object({
  routes: z.array(Route),
});

export const VisaBundle = z.object({
  rules: z.array(VisaRule),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Region = z.infer<typeof Region>;
export type Country = z.infer<typeof Country>;
export type Subregion = z.infer<typeof Subregion>;
export type State = z.infer<typeof State>;
export type Place = z.infer<typeof Place>;
export type PlaceAlias = z.infer<typeof PlaceAlias>;
export type Destination = z.infer<typeof Destination>;
export type SuitabilityScore = z.infer<typeof SuitabilityScore>;
export type DestinationTag = z.infer<typeof DestinationTag>;
export type MonthlyScore = z.infer<typeof MonthlyScore>;
export type Area = z.infer<typeof Area>;
export type Attraction = z.infer<typeof Attraction>;
export type Activity = z.infer<typeof Activity>;
export type PurposeActivity = z.infer<typeof PurposeActivity>;
export type Cluster = z.infer<typeof Cluster>;
export type HotelRate = z.infer<typeof HotelRate>;
export type TransferRate = z.infer<typeof TransferRate>;
export type MealRate = z.infer<typeof MealRate>;
export type ActivityRate = z.infer<typeof ActivityRate>;
export type MarkupRule = z.infer<typeof MarkupRule>;
export type RouteOption = z.infer<typeof RouteOption>;
export type Route = z.infer<typeof Route>;
export type FlightBand = z.infer<typeof FlightBand>;
export type VisaRule = z.infer<typeof VisaRule>;
export type InsuranceRate = z.infer<typeof InsuranceRate>;
export type CityTax = z.infer<typeof CityTax>;
export type Package = z.infer<typeof Package>;
export type CoreBundle = z.infer<typeof CoreBundle>;
export type DestinationBundle = z.infer<typeof DestinationBundle>;
export type RoutesBundle = z.infer<typeof RoutesBundle>;
export type VisaBundle = z.infer<typeof VisaBundle>;
export type PlaceSummary = CoreBundle["placeSummaries"][number];
