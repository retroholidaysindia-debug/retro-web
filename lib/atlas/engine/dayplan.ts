/**
 * Stage 3: turn the ordered stays into a day-by-day plan.
 *
 * Each day gets an activity-hour budget derived from the pace, the group's
 * walking tolerance and whether it is an arrival, departure or transfer day.
 * Geographical clusters are then packed into that budget best-first, so a day
 * is filled as fully as it can be without breaching the rest requirement.
 */
import type { Cluster, DestinationBundle, PurposeActivity, TransportMode, TripStyle } from "../schema";
import policy from "../../../content/quote-policy.json";
import type { PlaceStay, PlannedActivity, PlannedDay, TransferLeg, TransportPreference } from "./types";
import type { RouteLookup } from "./itinerary";
import { formatDuration } from "./text";

const DAY = policy.dayPlanning;

export type GroupProfile = {
  hasYoungChildren: boolean;
  hasSeniors: boolean;
  paxTotal: number;
};

/** Hours of activity a day can absorb before the rest requirement is breached. */
export function dayBudget(
  pace: keyof typeof DAY.pace,
  group: GroupProfile,
  kind: "arrival" | "departure" | "transfer" | "full",
): number {
  let hours = DAY.pace[pace];
  if (group.hasYoungChildren) hours *= DAY.youngChildPenalty;
  if (group.hasSeniors) hours *= DAY.seniorPenalty;
  if (kind === "arrival") hours *= DAY.arrivalDayFactor;
  if (kind === "departure") hours *= DAY.departureDayFactor;

  const ceiling = 24 - DAY.restHours - DAY.mealBreakHours;
  // `maxSightseeingHoursPerDay` is the hard one: every activity — planned by
  // the ranker or added by hand on the quotation page — is packed against
  // this budget, so it is the single place a day's sightseeing is capped.
  return Math.max(
    0,
    Math.min(hours, ceiling, DAY.maxActiveHours, DAY.maxSightseeingHoursPerDay),
  );
}

/**
 * Ranks a place's clusters for a trip style.
 *
 * The destination files list activities by purpose in prose, so a cluster is
 * scored by how many of that purpose's phrases its attractions echo. Falls back
 * to attraction count so a place with no purpose section still plans sensibly.
 *
 * A destination's own decision rules can then nudge the order: a rule that
 * fired for this trip and says `prioritize_TAJ_MAHAL_SUNRISE` pushes the
 * matching cluster up, and one saying `do not recommend Saqqara by default`
 * pushes it down. The nudge is bounded — it reorders, it does not override —
 * so the planner still decides what actually fits the day.
 */
export function rankClusters(
  clusters: Cluster[],
  purposeActivities: PurposeActivity[],
  style: TripStyle,
  bias: { tokens: string[]; bias: number }[] = [],
): Cluster[] {
  const phrases = purposeActivities
    .filter((p) => p.purpose === style)
    .map((p) => p.description.toLowerCase());

  const score = (c: Cluster) => {
    const haystack = `${c.name} ${c.attractions.join(" ")}`.toLowerCase();
    let matches = 0;
    for (const phrase of phrases) {
      // Match on distinctive words rather than whole sentences.
      const words = phrase.split(/\W+/).filter((w) => w.length > 4);
      const hits = words.filter((w) => haystack.includes(w)).length;
      if (hits >= 2) matches++;
    }

    let ruleScore = 0;
    for (const entry of bias) {
      if (entry.tokens.some((t) => tokenMatchesCluster(t, haystack))) {
        ruleScore += entry.bias * RULE_BIAS_WEIGHT;
      }
    }

    return matches * 10 + c.attractions.length + ruleScore;
  };

  return [...clusters].sort((a, b) => score(b) - score(a));
}

/**
 * How strongly a fired rule moves a cluster in the ranking.
 *
 * Comparable to one purpose-phrase match, so a rule is influential without
 * being able to drag an otherwise irrelevant cluster to the top of the list.
 */
const RULE_BIAS_WEIGHT = 12;

/**
 * Whether a rule's target names this cluster.
 *
 * Rule tokens are workbook-style identifiers turned into words ("TAJ MAHAL
 * SUNRISE"), and the cluster they refer to is rarely titled identically, so
 * the test is on the distinctive words they share. Two is the threshold: one
 * shared common word ("city", "temple") is noise, two is a reference.
 */
function tokenMatchesCluster(token: string, haystack: string): boolean {
  const words = token.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return false;
  const hits = words.filter((w) => haystack.includes(w)).length;
  return words.length === 1 ? hits === 1 : hits >= 2;
}

/** A cluster rendered as a plannable, priceable activity. */
function toActivity(cluster: Cluster, priceLookup: (cluster: Cluster) => { code: string | null; price: number }): PlannedActivity {
  const { code, price } = priceLookup(cluster);
  return {
    clusterId: cluster.id,
    code,
    title: cluster.name,
    hours: cluster.durationHours,
    attractions: cluster.attractions,
    walkingIntensity: cluster.walkingIntensity,
    locked: false,
    pricePerPersonInr: price,
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type DayPlanInput = {
  stays: PlaceStay[];
  startDate: string;
  style: TripStyle;
  pace: keyof typeof DAY.pace;
  group: GroupProfile;
  bundles: Map<string, DestinationBundle>;
  routes: RouteLookup;
  mealPlan: { lunch: boolean; dinner: boolean };
  excludedClusterIds: Set<string>;
  /** Clusters the traveller asked for; packed ahead of the ranker's picks. */
  pinnedClusterIds: Set<string>;
  /** How hard to trade fare against journey time on intercity legs. */
  transportPreference: TransportPreference;
  /** Per-leg mode the traveller pinned, keyed by the arriving place's id. */
  legModes: Record<string, TransportMode>;
  /** Resolves a cluster to its priced activity code and per-person price. */
  priceLookup: (placeId: string, cluster: Cluster) => { code: string | null; price: number };
  /**
   * Ranking nudges from the destination's own decision rules that fired for
   * this trip, keyed by place. Optional: with none supplied the planner ranks
   * exactly as it did before.
   */
  clusterBiasFor?: (placeId: string) => { tokens: string[]; bias: number }[];
};

/**
 * Builds stand-in clusters for a place that has priced activities but no
 * geographical clusters of its own.
 *
 * Without this a destination with no knowledge file is planned as empty days
 * and charged nothing for sightseeing, which both reads badly and undercuts the
 * quote. Each priced activity becomes a half-day outing instead.
 */
function syntheticClusters(bundle: DestinationBundle | undefined, placeId: string): Cluster[] {
  if (!bundle || bundle.clusters.length) return [];

  // Prefer the workbook's priced activities; fall back to named attractions.
  const fromRates = bundle.activityRates.map((rate) => {
    const activity = bundle.activities.find((a) => a.code === rate.code);
    return activity?.name ?? rate.code.replace(/^[A-Z0-9]+_A_/i, "").replace(/_/g, " ");
  });
  const names = fromRates.length
    ? fromRates
    : bundle.attractions.slice(0, 8).map((a) => a.name);

  return names.map((name, i) => ({
    id: `${placeId}:auto:${i}`,
    placeId,
    name,
    attractions: [name],
    recommendedDuration: "Half day",
    durationHours: 4,
    walkingIntensity: "MEDIUM" as const,
  }));
}

export type DayPlanResult = {
  days: PlannedDay[];
  /** Clusters that did not fit, offered as paid add-ons. */
  suggestions: PlannedActivity[];
  /**
   * Legs whose journey time did not fit inside the nights booked at the
   * destination it arrives at, even after giving it every day the stay had.
   * The plan still shows a day-by-day itinerary that stays truthful to the
   * calendar rather than silently pretending the transfer took one day, but
   * this list is what tells the traveller the numbers do not add up.
   */
  transitOverflows: TransitOverflow[];
};

export type TransitOverflow = {
  from: string;
  to: string;
  mode: TransportMode | "transfer";
  durationMinutes: number;
  /** Calendar days the journey actually needs, at a realistic pace. */
  daysRequired: number;
  /** Calendar days the stay could spare for it. */
  daysAvailable: number;
};

export function planDays(input: DayPlanInput): DayPlanResult {
  const {
    stays, startDate, style, pace, group, bundles, routes, mealPlan, excludedClusterIds,
    pinnedClusterIds, transportPreference, legModes, priceLookup, clusterBiasFor,
  } = input;

  const days: PlannedDay[] = [];
  const suggestions: PlannedActivity[] = [];
  const transitOverflows: TransitOverflow[] = [];

  const totalNights = stays.reduce((a, s) => a + s.nights, 0);
  const totalDays = totalNights + 1;
  let dayNumber = 0;

  for (let stayIndex = 0; stayIndex < stays.length; stayIndex++) {
    const stay = stays[stayIndex];
    const bundle = bundles.get(stay.placeId);
    const isFirst = stayIndex === 0;
    const isLast = stayIndex === stays.length - 1;

    // Rank once per stay, then consume the queue across that stay's days so a
    // cluster is never repeated. Places with no clusters of their own fall back
    // to their priced activities so the days are neither empty nor free.
    const available = bundle?.clusters.length
      ? bundle.clusters
      : syntheticClusters(bundle, stay.placeId);
    const queue = rankClusters(
      available.filter((c) => !excludedClusterIds.has(c.id)),
      bundle?.purposeActivities ?? [],
      style,
      clusterBiasFor?.(stay.placeId) ?? [],
    );

    // Anything the traveller explicitly asked for jumps the queue, so it is
    // packed before the ranker's own preferences. `sort` is stable, so the
    // ranking order still decides within each group. It does not get special
    // treatment on capacity: it competes for the same daily budget, which is
    // what keeps a day inside the sightseeing cap no matter what is pinned.
    if (pinnedClusterIds.size) {
      queue.sort(
        (a, b) => Number(pinnedClusterIds.has(b.id)) - Number(pinnedClusterIds.has(a.id)),
      );
    }

    // The arrival leg into this place: an airport transfer for the first stay,
    // an intercity hop thereafter.
    let transfer: TransferLeg | null = null;
    if (isFirst) {
      transfer = {
        from: "Airport",
        to: stay.placeName,
        mode: "transfer",
        durationMinutes: 60,
        onsiteMode: null,
        priceInr: 0, // priced separately as an airport transfer line item
        estimated: false,
        distanceKm: null,
        via: [],
        alternatives: [],
        userChosen: false,
      };
    } else {
      const previous = stays[stayIndex - 1];
      // Every viable mode, best-first for the trip's preference. The
      // traveller can pin a different one per leg; if the pinned mode is no
      // longer offered (they changed destinations), fall back to the best.
      const choices = routes.options(previous.placeId, stay.placeId, transportPreference);
      const pinned = legModes[stay.placeId];
      const hop = (pinned && choices.find((c) => c.mode === pinned)) ?? choices[0] ?? null;
      transfer = {
        from: previous.placeName,
        to: stay.placeName,
        mode: hop?.mode ?? "transfer",
        durationMinutes: hop?.minutes ?? null,
        onsiteMode: hop?.onsiteMode ?? null,
        priceInr: hop?.priceInr ?? 0,
        estimated: hop?.estimated ?? false,
        distanceKm: hop?.distanceKm ?? null,
        via: hop?.via ?? [],
        alternatives: choices.map((c) => ({
          mode: c.mode,
          minutes: c.minutes,
          priceInr: Math.round(c.priceInr),
          estimated: c.estimated,
        })),
        userChosen: Boolean(pinned && hop && hop.mode === pinned),
      };
    }

    // Days spent at this place. The final stay gets one extra day for departure.
    const dayCount = stay.nights + (isLast ? 1 : 0);

    // A transfer that takes longer than one calendar day's realistic
    // waking-plus-rest window (`maxActiveHours`, 14h — the same "at least
    // restHours of rest" ceiling every other day is held to) is not folded
    // into a single arrival day: physically, the traveller is still
    // travelling into the next calendar day(s). Every extra block is carved
    // out of *this* stay's own night count as a dedicated low/no-activity
    // transit day, rather than one day quietly absorbing the whole thing
    // regardless of how long it actually is.
    const usableMinutesPerDay = DAY.maxActiveHours * 60;
    const rawTransferDays = transfer?.durationMinutes
      ? Math.max(1, Math.ceil(transfer.durationMinutes / usableMinutesPerDay))
      : 1;
    // Never let transit claim every day the stay has: the final stay must
    // keep its departure day free, and a mid-trip stay should not be pared
    // to nothing without at least surfacing why.
    const maxTransferDays = isLast ? Math.max(1, dayCount - 1) : dayCount;
    const transferDays = Math.min(rawTransferDays, maxTransferDays);
    if (rawTransferDays > maxTransferDays && transfer?.durationMinutes) {
      transitOverflows.push({
        from: transfer.from,
        to: transfer.to,
        mode: transfer.mode,
        durationMinutes: transfer.durationMinutes,
        daysRequired: rawTransferDays,
        daysAvailable: maxTransferDays,
      });
    }

    for (let d = 0; d < dayCount; d++) {
      dayNumber++;
      const isArrivalDay = d === 0;
      // Later days still swallowed by the same journey — no hotel checkout,
      // no attractions, just the road, rail or water continuing underneath.
      const isTransitContinuation = !isArrivalDay && d < transferDays;
      const isDepartureDay = isLast && d === dayCount - 1;
      const kind = isDepartureDay
        ? "departure"
        : isArrivalDay || isTransitContinuation
          ? isFirst
            ? "arrival"
            : "transfer"
          : "full";

      let budget = dayBudget(pace, group, kind);

      // A long transfer eats into the same 24 hours as sightseeing — and,
      // spread over several days, each day only absorbs its own share of the
      // remaining journey rather than the whole thing landing on day one.
      if ((isArrivalDay || isTransitContinuation) && transfer?.durationMinutes) {
        const minutesElapsedBefore = d * usableMinutesPerDay;
        const minutesLeft = Math.max(0, transfer.durationMinutes - minutesElapsedBefore);
        budget = Math.max(0, budget - Math.min(usableMinutesPerDay, minutesLeft) / 60);
      }

      const activities: PlannedActivity[] = [];
      let used = 0;

      /** Walking tolerance is a property of the cluster, not of the day. */
      const allowanceFor = (cluster: Cluster) => {
        const factor =
          DAY.walkingBudgetFactor[
            (cluster.walkingIntensity ?? "MEDIUM") as keyof typeof DAY.walkingBudgetFactor
          ] ?? 0.9;
        return budget * factor;
      };

      // Best-first packing: take the highest-ranked cluster that still fits.
      let guard = 0;
      while (queue.length && guard++ < 50) {
        const index = queue.findIndex((c) => used + c.durationHours <= allowanceFor(c));
        if (index < 0) break;
        const [cluster] = queue.splice(index, 1);
        activities.push(toActivity(cluster, (c) => priceLookup(stay.placeId, c)));
        used += cluster.durationHours;
      }

      // A full-day cluster never fits a relaxed day with young children, but
      // dropping it entirely would leave the traveller with an empty itinerary.
      // Shorten the visit instead, which is what an agent actually does.
      if (!activities.length && queue.length && budget >= DAY.minPartialVisitHours) {
        const cluster = queue.shift()!;
        const hours = Math.min(cluster.durationHours, Math.max(DAY.minPartialVisitHours, allowanceFor(cluster)));
        const activity = toActivity(cluster, (c) => priceLookup(stay.placeId, c));
        activities.push({ ...activity, hours: Number(hours.toFixed(1)) });
        used += hours;
      }

      const notes: string[] = [];
      if (isArrivalDay && isFirst) notes.push("Arrival and hotel check-in");
      if (isArrivalDay && !isFirst && transfer) {
        notes.push(
          transferDays > 1
            ? `Transfer from ${transfer.from} to ${transfer.to} — day 1 of ${transferDays} ` +
              `(${formatDuration(transfer.durationMinutes ?? 0)} total journey)`
            : `Transfer from ${transfer.from} to ${transfer.to}`,
        );
      }
      if (isTransitContinuation && transfer) {
        notes.push(`Still travelling from ${transfer.from} to ${transfer.to} — day ${d + 1} of ${transferDays}`);
      }
      if (isDepartureDay) notes.push("Check-out and departure transfer");
      // Nothing fit this day's budget and it is not otherwise spoken for
      // (arrival/transfer/departure) — the stay is longer than there is
      // content to fill at this pace. Flagged as `isFreeDay` rather than left
      // as a silent gap, so the caller can warn the traveller about it.
      const isFreeDay = !activities.length && !notes.length;
      if (isFreeDay) notes.push("Free day at leisure");

      days.push({
        dayNumber,
        date: addDays(startDate, dayNumber - 1),
        placeId: stay.placeId,
        placeName: stay.placeName,
        // Only the arrival day carries the priced leg, so a multi-day
        // journey's fare is billed once, not once per day it spans.
        isTransferDay: isArrivalDay && !isFirst,
        isFreeDay,
        transfer: isArrivalDay ? transfer : null,
        activities,
        activeHours: Number(used.toFixed(1)),
        budgetHours: Number(budget.toFixed(1)),
        // No hotel on the very last day — the traveller flies home.
        hotelPlaceId: dayNumber < totalDays ? stay.placeId : null,
        meals: {
          breakfast: dayNumber > 1, // first night's breakfast is the next morning
          lunch: mealPlan.lunch && !isDepartureDay,
          dinner: mealPlan.dinner && !isDepartureDay,
        },
        notes,
      });
    }

    // Anything left over becomes an upsell rather than being silently dropped.
    for (const cluster of queue) {
      suggestions.push(toActivity(cluster, (c) => priceLookup(stay.placeId, c)));
    }
  }

  return { days, suggestions, transitOverflows };
}
