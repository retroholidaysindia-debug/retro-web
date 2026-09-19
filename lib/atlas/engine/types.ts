import { z } from "zod";
import policy from "../../../content/quote-policy.json";
import {
  CarrierType,
  FoodPreference,
  HotelStar,
  HotelZone,
  TransportMode,
  TravellerType,
  TripStyle,
} from "../schema";
import type { PlanningNote } from "./advisories";

/**
 * Engine inputs and outputs.
 *
 * Every input is a bounded choice — there is no free-text field anywhere in the
 * request, which is what lets the planner UI be entirely select-driven.
 */

export const Cabin = z.enum(["Economy", "Premium Economy", "Business"]);
export type Cabin = z.infer<typeof Cabin>;

export const MealPlan = z.enum(["breakfast", "half-board", "full-board"]);
export type MealPlan = z.infer<typeof MealPlan>;

export const Pace = z.enum(["relaxed", "balanced", "packed"]);
export type Pace = z.infer<typeof Pace>;

/** How hard the router trades fare against journey time on intercity legs. */
export const TransportPreference = z.enum(["fastest", "balanced", "cheapest"]);
export type TransportPreference = z.infer<typeof TransportPreference>;

export const QuoteRequest = z.object({
  /** Places chosen on the map, or resolved from the "explore" questionnaire. */
  placeIds: z.array(z.string()).min(1),
  /** Total nights for the whole trip. */
  nights: z.number().int().min(1).max(policy.guardrails.maxNights),
  /** ISO date of departure; drives the seasonality multiplier. */
  startDate: z.string(),

  adults: z.number().int().min(1).max(40),
  /** Ages drive room allocation, activity pricing and day-plan intensity. */
  childAges: z.array(z.number().int().min(0).max(17)),

  travellerType: TravellerType,
  tripStyle: TripStyle,
  /** Passport country (ISO-3166-1 alpha-3) — visa is a function of this. */
  nationality: z.string().length(3),
  departureCity: z.string(),

  hotelStar: HotelStar,
  hotelZone: HotelZone,
  carrier: CarrierType,
  cabin: Cabin,
  mealPlan: MealPlan,
  food: FoodPreference,
  pace: Pace,

  includeVisa: z.boolean(),
  includeInsurance: z.boolean(),
  includeFlight: z.boolean(),

  /**
   * What the traveller actually wants out of the trip — `PHOTOGRAPHY`,
   * `FOOD`, `NATURE`, `NIGHTLIFE`, and so on.
   *
   * The destination files' decision rules are written against this vocabulary
   * (509 distinct interests across 1,241 conditions), and without it roughly
   * half of every destination's rules are unanswerable. Empty is a valid and
   * honest answer: a rule resting on an interest the traveller never stated
   * is reported as undecided rather than guessed at.
   */
  interests: z.array(z.string()).default([]),
  /**
   * Whether this is the traveller's first visit to these destinations.
   *
   * Defaults to true because that is what an agency assumes when quoting cold,
   * and because the rules it unlocks are the "see the landmarks properly"
   * ones — the right default for a first quote. Set false for a repeat
   * traveller and those rules stop firing.
   */
  firstTimeVisitor: z.boolean().default(true),

  /**
   * How hard to trade fare against journey time on intercity legs.
   * "cheapest" will happily put the traveller on an overnight bus;
   * "fastest" buys the flight. Overridable per leg below.
   */
  transportPreference: TransportPreference.default("balanced"),
  /**
   * Per-leg mode override, keyed by the arriving place's id (each leg is
   * identified by where it lands, which is unique within one itinerary).
   */
  legModes: z.record(z.string(), TransportMode).default({}),

  /** Traveller adjustments made on the quotation page. */
  excludedActivityCodes: z.array(z.string()).default([]),
  excludedClusterIds: z.array(z.string()).default([]),
  addedActivityCodes: z.array(z.string()).default([]),
  /**
   * Clusters the traveller explicitly asked to include from the "you could
   * also add" list. These jump the ranking queue so they are packed before
   * anything the ranker merely preferred — but they are still packed against
   * the same daily sightseeing budget as everything else, so pinning one can
   * never push a day past `maxSightseeingHoursPerDay`. A pin that cannot fit
   * is reported back rather than silently honoured or silently dropped.
   */
  pinnedClusterIds: z.array(z.string()).default([]),
  /** Manual override of the automatic night split, keyed by place id. */
  nightOverrides: z.record(z.string(), z.number().int().min(0)).default({}),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

// ---------------------------------------------------------------------------
// Itinerary
// ---------------------------------------------------------------------------

export type PlannedActivity = {
  clusterId: string | null;
  /** Activity rate code, when this maps to a priced item. */
  code: string | null;
  title: string;
  hours: number;
  attractions: string[];
  walkingIntensity: string | null;
  /** Locked items are structural (transfers) and cannot be deselected. */
  locked: boolean;
  pricePerPersonInr: number;
};

/** One selectable way of making a leg, as offered to the traveller. */
export type TransferAlternative = {
  mode: TransportMode;
  minutes: number;
  /** Per person, before calibration and markup. */
  priceInr: number;
  estimated: boolean;
};

export type TransferLeg = {
  from: string;
  to: string;
  mode: TransportMode | "transfer";
  durationMinutes: number | null;
  /** Whether the journey itself is the experience (cruise, safari drive). */
  onsiteMode: string | null;
  priceInr: number;
  /** True when no real route rate was found and this used a coarser
   *  country-level or regional-median fallback (see `RouteLookup.best`). */
  estimated: boolean;
  /** Straight-line distance between the two ends, when known. */
  distanceKm: number | null;
  /**
   * Intermediate places, when no direct service exists and the leg had to be
   * composed from several real hops. Empty on a direct leg.
   */
  via: string[];
  /**
   * Every mode available for this leg, best-first for the trip's transport
   * preference — what the traveller picks between to trade price for time.
   */
  alternatives: TransferAlternative[];
  /** True when the traveller pinned this leg's mode themselves. */
  userChosen: boolean;
};

export type PlannedDay = {
  dayNumber: number;
  date: string;
  placeId: string;
  placeName: string;
  /** True on the day the traveller changes city. */
  isTransferDay: boolean;
  /** True when no attraction fit this day's budget — an "over-nighted" signal
   *  the traveller should see as a warning, not a silent gap in the plan. */
  isFreeDay: boolean;
  transfer: TransferLeg | null;
  activities: PlannedActivity[];
  activeHours: number;
  budgetHours: number;
  /** Hotel is null on the final day, when the traveller flies home. */
  hotelPlaceId: string | null;
  meals: { breakfast: boolean; lunch: boolean; dinner: boolean };
  notes: string[];
};

export type PlaceStay = {
  placeId: string;
  placeName: string;
  nights: number;
  /** Order in the routed sequence. */
  position: number;
};

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Mirrors the Quotation_Calculation sheet's cost components. */
export const CostComponent = z.enum([
  "hotel",
  "flight",
  "airport-transfer",
  "local-transport",
  "intercity-transport",
  "sightseeing",
  "meals",
  "visa",
  "insurance",
  "city-tax",
]);
export type CostComponent = z.infer<typeof CostComponent>;

export type LineItem = {
  component: CostComponent;
  label: string;
  detail: string;
  quantity: number;
  unit: string;
  unitPriceInr: number;
  totalInr: number;
  /** Structural costs the traveller may not remove. */
  locked: boolean;
  /** Where the rate came from, so the quote can be audited. */
  source: "workbook" | "estimated" | "live" | "manual";
  placeId: string | null;
};

export type QuoteTotals = {
  directCost: number;
  contingency: number;
  costBeforeMarkup: number;
  agentMarkup: number;
  salesVat: number;
  paymentAndFx: number;
  total: number;
  perPerson: number;
  /** Set when the published package floor bound the result. */
  flooredToPackage: string | null;
};

export type QuoteWarning = {
  level: "info" | "warning";
  /**
   * Internal notes explain how the engine arrived at a number and are for the
   * agency and the calibration report only — showing a traveller that their
   * price was floored, or that a rate is provisional, undermines the quote.
   */
  audience: "traveller" | "internal";
  message: string;
};

export type Quotation = {
  request: QuoteRequest;
  /** The published package this quote was built from, when one matched. */
  referencePackage: { id: string; name: string; priceFromInr: number; matchRatio: number } | null;
  stays: PlaceStay[];
  days: PlannedDay[];
  lineItems: LineItem[];
  totals: QuoteTotals;
  /** Head counts after applying the child age bands. */
  pax: { adults: number; children: number; infants: number; total: number; rooms: number };
  warnings: QuoteWarning[];
  /** Items the traveller could add, with their price impact. */
  suggestions: PlannedActivity[];
  /**
   * Planner guidance drawn from the destination files for exactly this trip —
   * how transfers really work in each city, what to do and avoid for this kind
   * of traveller, and the destination's own decision rules.
   *
   * Twenty-one of the files' thirty-six sections were previously read by
   * nothing at all; this is the route by which that knowledge reaches the
   * quotation instead of sitting unused on disk.
   */
  planningNotes: PlanningNote[];
  /**
   * The destination decision rules that actually fired for this trip.
   *
   * Section 33 of each file is a real rule block — `IF trip_length <= 3 nights
   * THEN …` — and there are around sixteen per destination. Showing all of
   * them told the traveller nothing; these are the ones whose conditions their
   * trip genuinely meets.
   */
  appliedRules: AppliedRule[];
};

/** A decision rule that fired, with where it came from and what it asked for. */
export type AppliedRule = {
  placeId: string;
  placeName: string;
  ruleId: string;
  /** The conditions that were met, rendered readably. */
  conditions: string[];
  action: string;
  reason: string | null;
  /** True when the engine acted on it, rather than only reporting it. */
  applied: boolean;
};
