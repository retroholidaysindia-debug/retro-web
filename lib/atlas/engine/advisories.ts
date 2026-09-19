/**
 * Destination advisories: the knowledge in the destination files that the
 * quote should act on, not just price.
 *
 * The markdown corpus scores every destination month by month on weather,
 * crowd, price and an overall verdict, and tags each one with what it is and
 * is not good for. All of it was parsed, stored and then ignored — the engine
 * read a single number, the month price index, and only to move the hotel
 * rate. So the quote could tell a traveller their July week in Munnar was
 * cheap without ever mentioning it falls in the monsoon, and could sell a
 * high-adrenaline adventure trip to a destination whose own file says it is
 * not ideal for one.
 *
 * These checks close that gap. They are advisory by design: nothing here
 * changes a price or drops a place, because the traveller asked for this trip
 * and is entitled to take it. They make sure the trip is never quoted
 * *silently* against the destination's own documented advice.
 */
import policy from "../../../content/quote-policy.json";
import type { DestinationBundle, MonthlyScore, TravellerType, TripStyle } from "../schema";
import type { PlaceStay, PlannedDay, QuoteWarning } from "./types";

const SEASON = policy.seasonality;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Trims a destination file's one-line verdict down to a single sentence. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/[.;]\s/);
  return stop > 0 ? trimmed.slice(0, stop) : trimmed.replace(/[.;]\s*$/, "");
}

/**
 * The best month to travel, by the destination's own overall score, along with
 * how much better it is than the month chosen.
 */
export function bestMonth(months: MonthlyScore[]): { month: number; score: number } | null {
  let best: { month: number; score: number } | null = null;
  for (const m of months) {
    if (m.overall == null) continue;
    if (!best || m.overall > best.score) best = { month: m.month, score: m.overall };
  }
  return best;
}

/**
 * Warns when a stay falls in a month the destination itself rates poorly.
 *
 * The test is mostly *relative* — how far the chosen month sits below that
 * destination's own best month — because the files do not share a scale. Some
 * score their worst month at 5 and others never drop below 57, so a single
 * absolute cut-off either misses a genuine monsoon or flags half the year
 * everywhere. An absolute floor is kept alongside it to catch the months that
 * are bad by any measure.
 *
 * Fires on the *overall* score rather than weather alone, because a month can
 * be hot and still be the right time to go, and uses the destination's own
 * recommendation text so the traveller gets the real reason rather than a
 * generic "off season" note.
 */
export function seasonalityWarnings(
  stays: PlaceStay[],
  days: PlannedDay[],
  bundles: Map<string, DestinationBundle>,
): QuoteWarning[] {
  const warnings: QuoteWarning[] = [];

  const monthOfStay = new Map<string, number>();
  for (const day of days) {
    if (monthOfStay.has(day.placeId)) continue;
    const parsed = new Date(`${day.date}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) monthOfStay.set(day.placeId, parsed.getUTCMonth() + 1);
  }

  for (const stay of stays) {
    const bundle = bundles.get(stay.placeId);
    if (!bundle?.months.length) continue;

    const month = monthOfStay.get(stay.placeId);
    if (!month) continue;

    const row = bundle.months.find((m) => m.month === month);
    if (!row || row.overall == null) continue;

    const better = bestMonth(bundle.months);
    const shortfall = better ? better.score - row.overall : 0;
    const notablyWorse = shortfall >= SEASON.belowBestMargin;
    const poorOutright = row.overall < SEASON.poorMonthScore;
    if (!notablyWorse && !poorOutright) continue;

    const advice = row.recommendation ? ` ${firstSentence(row.recommendation)}.` : "";
    const alternative =
      better && better.month !== month && shortfall >= SEASON.betterMonthMargin
        ? ` ${MONTH_NAMES[better.month - 1]} is the strongest month there.`
        : "";

    warnings.push({
      level: "warning",
      audience: "traveller",
      message:
        `${stay.placeName} in ${MONTH_NAMES[month - 1]} scores ${Math.round(row.overall)}/100 ` +
        `on its own seasonal rating.${advice}${alternative}`,
    });
  }

  return warnings;
}

/**
 * Planner guidance selected for the trip being quoted.
 *
 * One block of advice, lifted verbatim from the destination file, with the
 * place and topic it came from so the quotation can attribute it.
 */
export type PlanningNote = {
  placeId: string;
  placeName: string;
  topic: string;
  sectionTitle: string;
  heading: string | null;
  audience: string | null;
  bullets: string[];
  body: string;
};

/**
 * Which guidance audiences a given trip should be shown.
 *
 * A honeymoon couple wants the honeymoon transfer advice and the honeymoon
 * pattern, not the family one; a family with small children wants both the
 * family block and anything written about accessibility if a senior is along.
 */
function audiencesFor(
  style: TripStyle,
  travellerType: TravellerType,
  childAges: number[],
): Set<string> {
  const wanted = new Set<string>();

  const styleAudience: Partial<Record<TripStyle, string>> = {
    family: "family",
    honeymoon: "honeymoon",
    romantic: "honeymoon",
    luxury: "luxury",
    budget: "budget",
    adventure: "adventure",
  };
  const fromStyle = styleAudience[style];
  if (fromStyle) wanted.add(fromStyle);

  const travellerAudience: Partial<Record<TravellerType, string>> = {
    family: "family",
    couple: "honeymoon",
    business: "business",
    solo: "solo",
    pilgrimage: "senior",
  };
  const fromTraveller = travellerAudience[travellerType];
  if (fromTraveller) wanted.add(fromTraveller);

  if (childAges.length) wanted.add("family");
  if (travellerType === "pilgrimage") wanted.add("accessibility");

  return wanted;
}

/**
 * Pulls the guidance blocks that apply to this trip.
 *
 * Audience-specific blocks are filtered to the audiences the trip actually
 * involves; blocks with no audience (the destination's decision rules, its
 * general transfer logic) apply to everyone and are always included. Capped
 * per place so a long multi-city itinerary does not bury the quotation.
 */
export function planningNotes(
  stays: PlaceStay[],
  bundles: Map<string, DestinationBundle>,
  style: TripStyle,
  travellerType: TravellerType,
  childAges: number[],
  maxPerPlace = 6,
): PlanningNote[] {
  const wanted = audiencesFor(style, travellerType, childAges);
  const notes: PlanningNote[] = [];

  for (const stay of stays) {
    const guidance = bundles.get(stay.placeId)?.guidance ?? [];
    if (!guidance.length) continue;

    const relevant = guidance.filter((g) => g.audience == null || wanted.has(g.audience));
    // Audience-specific advice first — it is the part written for this
    // traveller — then the destination's general rules.
    const ordered = [
      ...relevant.filter((g) => g.audience != null),
      ...relevant.filter((g) => g.audience == null),
    ].slice(0, maxPerPlace);

    for (const g of ordered) {
      notes.push({
        placeId: stay.placeId,
        placeName: stay.placeName,
        topic: g.topic,
        sectionTitle: g.sectionTitle,
        heading: g.heading,
        audience: g.audience,
        bullets: g.bullets,
        body: g.body,
      });
    }
  }

  return notes;
}

/**
 * Tag vocabulary per trip style.
 *
 * The destination files tag in SCREAMING_SNAKE and their vocabulary is wider
 * than ours, so each style lists the tokens that mean it. Matching is on
 * substring so `HIGH_ADRENALINE_ADVENTURE` satisfies `ADVENTURE`.
 */
const STYLE_TAGS: Record<TripStyle, string[]> = {
  family: ["FAMILY"],
  honeymoon: ["HONEYMOON", "ROMANTIC", "COUPLE"],
  romantic: ["ROMANTIC", "HONEYMOON", "COUPLE"],
  luxury: ["LUXURY"],
  budget: ["BUDGET", "BACKPACK"],
  culture: ["CULTURAL", "CULTURE", "HERITAGE", "HISTORY"],
  adventure: ["ADVENTURE", "ADRENALINE", "TREK"],
  pilgrimage: ["PILGRIM", "SPIRITUAL", "RELIGIOUS", "TEMPLE"],
};

/** Tokens that mark a place as a poor fit for travelling with small children. */
const YOUNG_CHILD_TAGS = ["YOUNG_CHILDREN", "SMALL_CHILDREN", "KIDS", "TODDLER", "INFANT"];

/** Tokens that mark a place as demanding for older or less mobile travellers. */
const SENIOR_TAGS = ["SENIOR", "ELDERLY", "LIMITED_MOBILITY", "ACCESSIBILITY"];

function matches(tag: string, tokens: string[]): boolean {
  const normalised = tag.toUpperCase();
  return tokens.some((t) => normalised.includes(t));
}

/**
 * Warns when a destination's own file says it is not ideal for the trip being
 * quoted — for the chosen style, for young children, or for seniors.
 *
 * Only `not_ideal_for` drives a warning. A missing `best_for` tag is not
 * evidence of a bad fit, merely of an incomplete file, and warning on it would
 * bury the real signal in noise.
 */
export function suitabilityWarnings(
  stays: PlaceStay[],
  bundles: Map<string, DestinationBundle>,
  style: TripStyle,
  travellerType: TravellerType,
  childAges: number[],
): QuoteWarning[] {
  const warnings: QuoteWarning[] = [];
  const styleTokens = STYLE_TAGS[style] ?? [];
  const hasYoungChildren = childAges.some((a) => a <= 7);
  const hasSeniors = travellerType === "pilgrimage";

  for (const stay of stays) {
    const bundle = bundles.get(stay.placeId);
    if (!bundle) continue;

    const notIdeal = bundle.tags.filter((t) => t.kind === "not_ideal_for");
    if (!notIdeal.length) continue;

    const reasons: string[] = [];

    if (styleTokens.length && notIdeal.some((t) => matches(t.tag, styleTokens))) {
      reasons.push(`a ${style.replace(/-/g, " ")} trip`);
    }
    if (hasYoungChildren && notIdeal.some((t) => matches(t.tag, YOUNG_CHILD_TAGS))) {
      reasons.push("travelling with young children");
    }
    if (hasSeniors && notIdeal.some((t) => matches(t.tag, SENIOR_TAGS))) {
      reasons.push("travellers with limited mobility");
    }

    if (reasons.length) {
      warnings.push({
        level: "warning",
        audience: "traveller",
        message:
          `${stay.placeName} is documented as not ideal for ${reasons.join(" or ")}. ` +
          "It stays in the plan — this is a note, not a restriction.",
      });
    }
  }

  return warnings;
}
