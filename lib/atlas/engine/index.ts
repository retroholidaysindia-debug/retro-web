/**
 * The quotation engine.
 *
 * Pure, deterministic and synchronous: the same request against the same
 * compiled data always yields the same quotation. No model, no network — live
 * rates, when present, are supplied by the caller as plain data.
 */
import policy from "../../../content/quote-policy.json";
import type {
  Cluster,
  CoreBundle,
  DestinationBundle,
  PlaceSummary,
  RateSource,
  Route,
  TravellerType,
  TripStyle,
  VisaRule,
} from "../schema";
import { buildRouteLookup, buildStays, matchReferencePackage, styleScore } from "./itinerary";
import { planningNotes, seasonalityWarnings, suitabilityWarnings } from "./advisories";
import { clusterBias, fireRules, type RuleEvaluation, type RuleFacts } from "./rules";
import type {
  AppliedRule,
  PlannedActivity,
  Quotation,
  QuoteRequest,
  QuoteWarning,
} from "./types";
import { planDays, type GroupProfile } from "./dayplan";
import { priceQuotation, resolvePax, type LiveRate } from "./pricing";
import { normaliseKey, formatDuration } from "./text";
import { filterRealisticSelection } from "./bounds";

/** Default trip style for each traveller type; the planner lets it be changed. */
export const STYLE_FOR_TRAVELLER: Record<TravellerType, TripStyle> = {
  family: "family",
  couple: "romantic",
  friends: "adventure",
  stags: "adventure",
  business: "luxury",
  pilgrimage: "pilgrimage",
  solo: "culture",
};

export type EngineData = {
  core: CoreBundle;
  routes: Route[];
  visaRules: VisaRule[];
  /** Only the destinations referenced by the request need to be loaded. */
  bundles: Map<string, DestinationBundle>;
  liveRates?: Map<string, LiveRate>;
  /**
   * Disables the published-package price floor. Used by the calibration
   * harness, which must see the engine's own unassisted number — with the
   * floor on, every package would trivially match its own published price.
   */
  ignorePackageFloor?: boolean;
};

/**
 * Matches a cluster to a priced activity code.
 *
 * The workbook's activity codes are `{DEST}_A_{AREA}` where the area name comes
 * from the same source as the cluster names, so a normalised comparison joins
 * them. Where nothing matches, the cluster is planned but not charged for.
 */
function buildActivityPricer(bundles: Map<string, DestinationBundle>) {
  const byPlace = new Map<string, { key: string; code: string; inr: number; source: RateSource }[]>();

  for (const [placeId, bundle] of bundles) {
    const rows = bundle.activityRates.map((rate) => ({
      key: normaliseKey(rate.code.replace(/^[A-Z0-9]+_A_/i, "")),
      code: rate.code,
      inr: rate.inr,
      source: rate.source,
    }));
    byPlace.set(placeId, rows);
  }

  return (placeId: string, cluster: Cluster): { code: string | null; price: number; source: RateSource } => {
    const rows = byPlace.get(placeId) ?? [];
    if (!rows.length) return { code: null, price: 0, source: "estimated" };

    const target = normaliseKey(cluster.name);
    const exact = rows.find((r) => r.key === target);
    if (exact) return { code: exact.code, price: exact.inr, source: exact.source };

    // Cluster names and area names overlap but are rarely identical
    // ("GIZA PYRAMIDS AND SPHINX" vs "GIZA_PYRAMIDS"); score on shared words.
    const words = target.split(" ").filter((w) => w.length > 3);
    let best: { row: (typeof rows)[number]; hits: number } | null = null;
    for (const row of rows) {
      const hits = words.filter((w) => row.key.includes(w)).length;
      if (hits && (!best || hits > best.hits)) best = { row, hits };
    }
    if (best) return { code: best.row.code, price: best.row.inr, source: best.row.source };

    // Otherwise charge the place's median activity rate — the cluster is real
    // sightseeing even if we cannot tie it to a specific priced line.
    const sorted = rows.map((r) => r.inr).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 0;
    return { code: null, price: median, source: "estimated" };
  };
}

function groupProfile(request: QuoteRequest): GroupProfile {
  return {
    hasYoungChildren: request.childAges.some((a) => a <= 7),
    hasSeniors: request.travellerType === "pilgrimage",
    paxTotal: request.adults + request.childAges.length,
  };
}

export function generateQuotation(request: QuoteRequest, data: EngineData): Quotation {
  const warnings: QuoteWarning[] = [];
  const { core, bundles } = data;

  const summaries = new Map<string, PlaceSummary>(core.placeSummaries.map((s) => [s.placeId, s]));
  const names = new Map(core.places.map((p) => [p.id, p.name]));

  // --- validate and trim the selection -------------------------------------
  const known = new Set(core.places.map((p) => p.id));
  let placeIds = request.placeIds.filter((id) => known.has(id));
  if (placeIds.length !== request.placeIds.length) {
    warnings.push({ level: "warning", audience: "traveller", message: "Some selected places are not in the catalogue and were dropped." });
  }

  // Backstop against an unrealistic combination reaching the engine by any
  // path other than the two live pickers (a future UI, a stale link, a
  // direct request) — the same region/country/place caps and pairwise
  // compatibility graph the pickers already enforce live, applied here too
  // so a quote can never be silently generated for a trip no agency would
  // actually sell. Processes in selection order and drops only what
  // breaches a rule, rather than truncating the whole list at a fixed count.
  const filtered = filterRealisticSelection(core, placeIds);
  placeIds = filtered.kept;
  if (filtered.dropped.length) {
    const placeName = new Map(core.places.map((p) => [p.id, p.name]));
    const byReason = new Map<string, string[]>();
    for (const d of filtered.dropped) {
      const name = placeName.get(d.placeId) ?? d.placeId;
      const list = byReason.get(d.reason);
      if (list) list.push(name);
      else byReason.set(d.reason, [name]);
    }
    for (const [reason, names] of byReason) {
      warnings.push({
        level: "warning",
        audience: "traveller",
        message: `${names.join(", ")} dropped — ${reason}.`,
      });
    }
  }
  if (!placeIds.length) throw new Error("No valid places selected");

  // Nights must at least cover one per place.
  let nights = request.nights;
  if (nights < placeIds.length) {
    nights = placeIds.length;
    warnings.push({
      level: "info",
      audience: "traveller",
      message: `Extended to ${nights} nights so each destination gets at least one night.`,
    });
  }

  for (const id of placeIds) {
    const place = core.places.find((p) => p.id === id);
    if (place && !place.hasContent) {
      warnings.push({
        level: "info",
        audience: "internal",
        message: `${place.name} has no destination file yet, so its days follow a generic plan.`,
      });
    }
  }

  // --- 1-2. allocate and sequence ------------------------------------------
  const routeLookup = buildRouteLookup(data.routes, core.places, core.countries);

  // The order places are visited in depends on where the traveller enters and
  // leaves the trip, not just on the hops between them.
  const gatewayCity = (core.departureCities ?? []).find((c) => c.code === request.departureCity);  const gateway =
    gatewayCity?.lat != null && gatewayCity.lon != null
      ? { lat: gatewayCity.lat, lon: gatewayCity.lon }
      : null;
  const placePoints = new Map<string, { lat: number; lon: number }>();
  for (const p of core.places) {
    if (p.lat != null && p.lon != null) placePoints.set(p.id, { lat: p.lat, lon: p.lon });
  }

  const stays = buildStays(
    placeIds, nights, summaries, request.tripStyle, routeLookup, names, request.nightOverrides,
    gateway, placePoints,
  );

  // --- 3. plan the days ----------------------------------------------------
  const pricer = buildActivityPricer(bundles);
  const activityPrices = new Map<string, { code: string | null; price: number; source: RateSource }>();

  // Evaluate each destination's own decision rules against this trip. Only the
  // rules that decisively apply fire; the rest are either not applicable or
  // rest on something the planner never asked, and are reported to the agent
  // rather than guessed at.
  const startMonth = new Date(`${request.startDate}T00:00:00Z`).getUTCMonth() + 1;
  const firedByPlace = new Map<string, RuleEvaluation[]>();
  const skippedRuleCount = new Map<string, number>();

  for (const stay of stays) {
    const rules = bundles.get(stay.placeId)?.decisionRules ?? [];
    if (!rules.length) continue;
    const summary = summaries.get(stay.placeId);
    const facts: RuleFacts = {
      // The rules are a destination's own, so `trip_length` is how long the
      // traveller is *there*, not how long they are away from home.
      nights: stay.nights,
      travellerType: request.travellerType,
      tripStyle: request.tripStyle,
      childAges: request.childAges,
      month: startMonth,
      monthWeather: summary?.monthWeather?.[String(startMonth)] ?? null,
      interests: request.interests,
      firstTimeVisitor: request.firstTimeVisitor,
    };
    const { fired, skipped } = fireRules(rules, facts);
    if (fired.length) firedByPlace.set(stay.placeId, fired);
    if (skipped.length) skippedRuleCount.set(stay.placeId, skipped.length);
  }

  const plan = planDays({
    stays,
    startDate: request.startDate,
    style: request.tripStyle,
    pace: request.pace,
    group: groupProfile(request),
    bundles,
    routes: routeLookup,
    mealPlan: policy.meals.plans[request.mealPlan],
    excludedClusterIds: new Set(request.excludedClusterIds),
    pinnedClusterIds: new Set(request.pinnedClusterIds),
    transportPreference: request.transportPreference,
    legModes: request.legModes,
    clusterBiasFor: (placeId) => clusterBias(firedByPlace.get(placeId) ?? []),
    priceLookup: (placeId, cluster) => {
      const priced = pricer(placeId, cluster);
      activityPrices.set(cluster.id, priced);
      return { code: priced.code, price: priced.price };
    },
  });

  // Nights booked at a place beyond what there is to see become empty days —
  // no traveller wants "free day at leisure" as a surprise, only as something
  // they explicitly chose. Warn plainly and point at the fix, rather than
  // letting the day cards quietly carry the news on their own.
  const freeDays = plan.days.filter((d) => d.isFreeDay);
  if (freeDays.length) {
    const byPlace = new Map<string, number>();
    for (const d of freeDays) byPlace.set(d.placeName, (byPlace.get(d.placeName) ?? 0) + 1);
    const placeList = [...byPlace.entries()].map(([name, count]) => `${count} in ${name}`).join(", ");
    const hasSuggestions = plan.suggestions.length > 0;
    warnings.push({
      level: "warning",
      audience: "traveller",
      message:
        `${freeDays.length} free day(s) at leisure (${placeList}) — the trip is booked with more nights ` +
        "than there is planned to fill at this pace. " +
        (hasSuggestions
          ? "Add one of the suggested extras below, or shorten the stay."
          : "Shorten the stay, or pick a more packed pace, to make use of the time."),
    });
  }

  // A transfer whose real journey time does not fit inside the nights booked
  // at the destination it arrives at (a slow overland mode across a long
  // distance, say) is a scheduling problem for the traveller to resolve, not
  // something the day plan should quietly absorb into one under-priced,
  // under-timed arrival day.
  for (const overflow of plan.transitOverflows) {
    warnings.push({
      level: "warning",
      audience: "traveller",
      message:
        `${overflow.mode.replace(/_/g, " ")} from ${overflow.from} to ${overflow.to} takes about ` +
        `${formatDuration(overflow.durationMinutes)} — that needs ${overflow.daysRequired} day(s) of travel, ` +
        `more than the ${overflow.daysAvailable} available at ${overflow.to}. Add nights, or choose a faster ` +
        "mode for this leg.",
    });
  }

  // A pinned cluster that still did not land on a day could not be fitted
  // without breaching the daily sightseeing cap. Say so plainly rather than
  // silently ignoring the request or quietly overfilling the day.
  if (request.pinnedClusterIds.length) {
    const placed = new Set<string>();
    for (const day of plan.days) {
      for (const activity of day.activities) {
        if (activity.clusterId) placed.add(activity.clusterId);
      }
    }
    const unplaced = plan.suggestions.filter(
      (s) => s.clusterId && request.pinnedClusterIds.includes(s.clusterId) && !placed.has(s.clusterId),
    );
    if (unplaced.length) {
      warnings.push({
        level: "warning",
        audience: "traveller",
        message:
          `No room for ${unplaced.map((s) => s.title).join(", ")} without going over the ` +
          `${policy.dayPlanning.maxSightseeingHoursPerDay}-hour daily sightseeing limit. ` +
          `Add a night, or drop something else, to fit ${unplaced.length > 1 ? "them" : "it"} in.`,
      });
    }
  }

  // Deselected activities stay in the plan but stop being charged.
  const excludedCodes = new Set(request.excludedActivityCodes);
  for (const [clusterId, priced] of activityPrices) {
    if (priced.code && excludedCodes.has(priced.code)) {
      activityPrices.set(clusterId, { ...priced, price: 0 });
    }
  }

  // The transport data has no real rate for these legs at any scope, so they
  // priced off geography or a chain of real hops (see `RouteLookup.best`)
  // rather than being silently dropped. The agent should still confirm it.
  const estimatedLegs = plan.days.filter((d) => d.isTransferDay && d.transfer?.estimated);
  if (estimatedLegs.length) {
    warnings.push({
      level: "warning",
      audience: "internal",
      message:
        `${estimatedLegs.length} intercity leg(s) have no contracted route rate and were priced from ` +
        `measured distance or a composed connection: ${estimatedLegs
          .map((d) => `${d.transfer!.from} to ${d.transfer!.to}`)
          .join(", ")}.`,
    });
  }

  // A leg the traveller has to make in two or more hops because no direct
  // service exists is a real constraint on their day, so say so.
  for (const day of plan.days) {
    const via = day.transfer?.via;
    if (!via?.length) continue;
    warnings.push({
      level: "info",
      audience: "traveller",
      message:
        `No direct service from ${day.transfer!.from} to ${day.transfer!.to} — routed via ` +
        `${via.map((id) => names.get(id) ?? id).join(", ")}.`,
    });
  }

  // Finally, the destination knowledge that should shape the trip rather than
  // just price it: travelling in a month the destination itself rates poorly,
  // and places documented as a bad fit for this kind of trip.
  warnings.push(...seasonalityWarnings(stays, plan.days, bundles));
  warnings.push(
    ...suitabilityWarnings(stays, bundles, request.tripStyle, request.travellerType, request.childAges),
  );

  // --- 4. price -------------------------------------------------------------
  const referencePackage = matchReferencePackage(placeIds, core.packages);
  const pax = resolvePax(request.adults, request.childAges);
  const { lineItems, totals } = priceQuotation({
    request,
    pax,
    stays,
    days: plan.days,
    core,
    summaries,
    visaRules: data.visaRules,
    liveRates: data.liveRates ?? new Map(),
    activityPrices,
    referencePackageId: referencePackage?.id ?? null,
  });

  // --- 5. reconcile against the published package --------------------------
  if (
    policy.guardrails.enforcePackageFloor &&
    !data.ignorePackageFloor &&
    referencePackage &&
    // Only floor when the quote genuinely covers that package's scope; a
    // two-night taster of a fourteen-night package should not inherit its price.
    referencePackage.matchRatio >= 0.8
  ) {
    const pkg = core.packages.find((p) => p.id === referencePackage.id);
    const scale = pkg && pkg.nights > 0 ? Math.min(1, nights / pkg.nights) : 1;
    const floorPerPerson = referencePackage.priceFromInr * scale * (1 - policy.guardrails.packageFloorTolerance);

    // The published "from" price covers the land package only unless the
    // package says otherwise, so the comparison has to be like-for-like:
    // measure the quote's *land* share against it, not the all-in total that
    // also carries an ex-India airfare. Every markup in the chain is
    // multiplicative on `directCost`, so the flight's share of the total is
    // exactly its share of the direct cost.
    const flightDirect = lineItems
      .filter((i) => i.component === "flight")
      .reduce((a, i) => a + i.totalInr, 0);
    const landShare =
      pkg?.priceIncludesFlight || totals.directCost <= 0
        ? 1
        : Math.max(0, totals.directCost - flightDirect) / totals.directCost;
    const flightTotal = totals.total - totals.total * landShare;
    const landPerPerson = (totals.total * landShare) / Math.max(1, pax.total);

    if (landPerPerson < floorPerPerson) {
      const flooredLandTotal = floorPerPerson * pax.total;
      const newTotal = Math.round(flooredLandTotal + flightTotal);
      warnings.push({
        level: "info",
        audience: "internal",
        message:
          `Raised to the published "from" price for ${referencePackage.name}. ` +
          `Land component rates came to ₹${Math.round(landPerPerson).toLocaleString("en-IN")} per person ` +
          `against a published land-only "from" of ₹${referencePackage.priceFromInr.toLocaleString("en-IN")}.`,
      });
      totals.total = newTotal;
      totals.perPerson = Math.round(newTotal / Math.max(1, pax.total));
      totals.flooredToPackage = referencePackage.name;
    }
  }

  // --- 6. suggestions -------------------------------------------------------
  const suggestions: PlannedActivity[] = plan.suggestions
    .sort((a, b) => b.attractions.length - a.attractions.length)
    .slice(0, 8);

  if (!lineItems.some((i) => i.component === "flight") && request.includeFlight) {
    warnings.push({ level: "warning", audience: "traveller", message: "No airfare band for this destination; flights quoted separately." });
  }
  if (!request.includeFlight) {
    warnings.push({
      level: "info",
      audience: "traveller",
      message:
        "This is a land-only price — airfare is not included. Tick return flights in the trip options to have them quoted.",
    });
  }
  if (!request.includeInsurance) {
    warnings.push({
      level: "info",
      audience: "traveller",
      message: "Travel insurance is excluded from this quote — add it back any time from the trip options.",
    });
  }
  const estimatedCount = lineItems.filter((i) => i.source === "estimated").length;  if (estimatedCount) {
    warnings.push({
      level: "info",
      audience: "internal",
      message: `${estimatedCount} line item(s) use estimated rates pending the agency's contracted card.`,
    });
  }

  // --- 7. decision rules ----------------------------------------------------
  const appliedRules: AppliedRule[] = [];
  for (const [placeId, fired] of firedByPlace) {
    const placeName = names.get(placeId) ?? placeId;
    for (const { rule } of fired) {
      appliedRules.push({
        placeId,
        placeName,
        ruleId: rule.id,
        conditions: rule.conditions.map(
          (c) => `${c.joiner ? `${c.joiner} ` : ""}${c.variable} ${c.operator} ${c.value}`,
        ),
        action: rule.action,
        reason: rule.reason,
        applied: rule.effects.length > 0,
      });
    }
  }

  // Rules resting on something the planner never asks — the traveller's route
  // preference, their hotel priority, the visibility on the day. Surfaced to
  // the agent so the coverage gap is visible rather than silently absorbed.
  const totalSkipped = [...skippedRuleCount.values()].reduce((a, b) => a + b, 0);
  if (totalSkipped) {
    warnings.push({
      level: "info",
      audience: "internal",
      message:
        `${totalSkipped} destination rule(s) could not be evaluated because they depend on inputs ` +
        "the planner does not collect; they were skipped rather than guessed at.",
    });
  }
  if (appliedRules.length) {
    warnings.push({
      level: "info",
      audience: "internal",
      message:
        `${appliedRules.length} destination decision rule(s) fired for this trip, ` +
        `${appliedRules.filter((r) => r.applied).length} of which the planner acted on directly.`,
    });
  }

  return {
    request,
    referencePackage,
    stays,
    days: plan.days,
    lineItems,
    totals,
    pax: {
      adults: pax.adults, children: pax.children, infants: pax.infants,
      total: pax.total, rooms: pax.rooms,
    },
    warnings,
    suggestions,
    planningNotes: planningNotes(
      stays, bundles, request.tripStyle, request.travellerType, request.childAges,
    ),
    appliedRules,
  };
}

export { styleScore };
export type { Quotation, QuoteRequest } from "./types";
