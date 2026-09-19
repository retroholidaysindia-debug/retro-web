/**
 * The destination decision rules (section 33), parsed and executed.
 *
 * Every destination file closes with a block of genuine, machine-shaped rules —
 * 3,426 of them across 213 files:
 *
 *     IF:
 *     trip_length <= 3 nights
 *     AND:
 *     traveler_type == FAMILY
 *     THEN:
 *     do not recommend Saqqara, Dahshur or other distant day trips by default.
 *     Reason:
 *     Short Cairo stays work best concentrated around Giza …
 *
 * They were previously stored as prose and shown in full, which meant a
 * traveller saw all sixteen of a destination's rules whether or not any applied
 * to them. This module parses them into a small AST at build time and evaluates
 * them against the actual quote request at runtime, so only the rules that
 * genuinely fire are surfaced.
 *
 * ## Why three-valued logic
 *
 * The rule vocabulary is wider than the request. `trip_length`,
 * `traveler_type`, `children_age` and the rest map cleanly onto a quote, but
 * `route`, `hotel_priority`, `visibility`, `departure_time` and a long tail of
 * others describe things the planner never asks. Treating an unanswerable
 * condition as false would silently swallow rules; treating it as true would
 * fire advice at people it was never written for. So conditions evaluate to
 * **true, false or unknown**, and a rule fires only when its conditions are
 * decisively true. Anything resting on an unknown is reported as `skipped`
 * rather than guessed at — visible to the agent, invisible to the traveller.
 *
 * ## What it is allowed to do
 *
 * Firing a rule surfaces its advice. Two action shapes are also *executed*,
 * because their semantics are unambiguous: `prioritize_X + Y` boosts matching
 * clusters in the day plan, and `do not recommend X` demotes them. Everything
 * else ("book a sunrise slot", "combine with a Nile cruise") is prose written
 * for a human and is surfaced, never acted on. That boundary is deliberate: a
 * rule engine that half-understands an instruction and reorders someone's
 * holiday is worse than one that hands the instruction over intact.
 */
import type { TravellerType, TripStyle } from "../schema";

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type RuleOperator = "==" | "!=" | ">=" | "<=" | ">" | "<";

export type RuleCondition = {
  /** Left-hand side, lower-cased: `trip_length`, `traveler_type`, … */
  variable: string;
  operator: RuleOperator;
  /** Right-hand side as written, upper-cased for symbols. */
  value: string;
  /** Numeric value when the RHS is a number. */
  number: number | null;
  /** `nights` / `days`, when the RHS carried a unit. */
  unit: string | null;
  /** How this condition joins the one before it. `null` on the first. */
  joiner: "AND" | "OR" | null;
};

/** An action the engine can carry out itself, not merely repeat. */
export type RuleEffect = {
  kind: "prioritise" | "avoid";
  /** Normalised words to match clusters and attractions against. */
  tokens: string[];
};

export type DecisionRule = {
  placeId: string;
  /** Stable within a place: `{placeId}:rule:{n}`. */
  id: string;
  conditions: RuleCondition[];
  action: string;
  reason: string | null;
  effects: RuleEffect[];
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const BACKTICK = String.fromCharCode(96);

function tidy(text: string): string {
  return text
    .split(BACKTICK)
    .join("")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** First non-empty line of a block — the rules put their payload on its own line. */
function firstLine(block: string): string {
  return (
    block
      .split(BACKTICK)
      .join("")
      .replace(/\*\*/g, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^[-*_]{3,}$/.test(l))[0] ?? ""
  );
}

function parseCondition(raw: string, joiner: "AND" | "OR" | null): RuleCondition | null {
  const text = firstLine(raw);
  if (!text) return null;

  const m = /^([a-z_]+)\s*(<=|>=|==|!=|<|>)\s*(.+)$/i.exec(text);
  if (!m) return null;

  const value = m[3].trim().replace(/[.,;]$/, "");
  const numeric = /^(\d+(?:\.\d+)?)\s*([a-z]+)?/i.exec(value);

  return {
    variable: m[1].toLowerCase(),
    operator: m[2] as RuleOperator,
    value: value.toUpperCase(),
    number: numeric ? Number(numeric[1]) : null,
    unit: numeric?.[2] ? numeric[2].toLowerCase() : null,
    joiner,
  };
}

/** Splits `A + B + C` and `A, B and C` into separate match tokens. */
function splitTokens(text: string): string[] {
  return text
    .split(/\s*(?:\+|\bOR\b|\bAND\b|,|\/)\s*/i)
    .map((t) => t.replace(/^(?:prioriti[sz]e|focus on|add|include|the)[_ ]/i, ""))
    .map((t) => t.replace(/_/g, " ").replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 3);
}

/**
 * Recognises the action shapes with unambiguous meaning.
 *
 * Everything else is left as prose. The negative form is checked first: "do
 * not recommend the Giza day trip" contains a place list exactly like the
 * positive form, and reading it as a recommendation would invert the rule.
 *
 * The positive form is deliberately anchored to an explicit marker —
 * "prioritise", "focus on", "covering", "around" — rather than any list of
 * capitalised words. Plenty of these actions mention a landmark in passing
 * ("request a private balcony overlooking Mehrangarh"), and treating that as
 * an instruction to build the day around it would be wrong.
 */
function parseEffects(action: string): RuleEffect[] {
  const effects: RuleEffect[] = [];

  const avoid =
    /\b(?:do not|don'?t|avoid|skip|exclude)\s+(?:recommend(?:ing)?|include|visit(?:ing)?|add(?:ing)?)?\s*(.+?)(?:\s+by default)?\.?$/i.exec(
      action,
    );
  if (avoid) {
    const tokens = splitTokens(clipSentence(avoid[1]));
    if (tokens.length) effects.push({ kind: "avoid", tokens });
    return effects;
  }

  // `prioritize_A + B`, `prioritise A, B and C`, `focus on A and B`,
  // `... circuit covering A, B, C`, `... itinerary around A, B and C`.
  const positive =
    /\b(?:prioriti[sz]e|focus on|centred? on|built? around|covering|around)[_ :]\s*(.+)$/i.exec(action);
  if (positive) {
    const tokens = splitTokens(clipSentence(positive[1]));
    if (tokens.length) effects.push({ kind: "prioritise", tokens });
  }
  return effects;
}

/** Keeps the list, drops the trailing justification that usually follows it. */
function clipSentence(text: string): string {
  return text.split(/[.;:]|\s+(?:with time for|supplemented by|while|because|so that)\b/i)[0] ?? text;
}

/**
 * Parses one destination's section 33 into rules.
 *
 * Rules are separated by `IF:` rather than by the `---` between them, because
 * a handful of files drop the separator while every rule without exception
 * opens with `IF:`.
 */
export function parseDecisionRules(sectionBody: string, placeId: string): DecisionRule[] {
  if (!sectionBody.trim()) return [];

  // Emphasis has to go before the split, not after. Files are inconsistent
  // about it — most write `**IF:**` but a good number use `****IF:****` — and
  // with the asterisks still attached the line no longer starts with `IF:`,
  // so every rule in those files was silently skipped.
  const normalised = sectionBody.split(BACKTICK).join("").replace(/\*+/g, "");

  const rules: DecisionRule[] = [];
  const chunks = normalised.split(/^\s*IF\s*:/im).slice(1);

  for (const chunk of chunks) {
    const [condPart, rest = ""] = splitOnce(chunk, /^\s*THEN\s*:/im);
    if (!rest) continue;
    const [actionPart, reasonPart = ""] = splitOnce(rest, /^\s*Reason\s*:/im);

    const conditions: RuleCondition[] = [];
    // Keep the connectors so `a AND b` and `a OR b` stay distinguishable.
    const pieces = condPart.split(/^\s*(AND|OR)\s*:/im);
    const first = parseCondition(pieces[0], null);
    if (first) conditions.push(first);
    for (let i = 1; i < pieces.length; i += 2) {
      const joiner = pieces[i].toUpperCase() === "OR" ? "OR" : "AND";
      const cond = parseCondition(pieces[i + 1] ?? "", joiner);
      if (cond) conditions.push(cond);
    }

    const action = tidy(actionPart);
    if (!conditions.length || !action) continue;

    rules.push({
      placeId,
      id: `${placeId}:rule:${rules.length}`,
      conditions,
      action,
      reason: tidy(reasonPart) || null,
      effects: parseEffects(action),
    });
  }

  return rules;
}

function splitOnce(text: string, re: RegExp): [string, string?] {
  const m = re.exec(text);
  if (!m) return [text];
  return [text.slice(0, m.index), text.slice(m.index + m[0].length)];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What the engine knows about a trip, in the rules' own vocabulary. */
export type RuleFacts = {
  /**
   * Nights **at this destination**, not across the whole trip.
   *
   * The rules live in a destination's own file and talk about that
   * destination's attractions — Agra's `trip_length <= 3 nights` is about how
   * long you are in Agra, not how long you are away from home. `trip_length`
   * in days is compared against nights + 1.
   */
  nights: number;
  travellerType: TravellerType;
  tripStyle: TripStyle;
  childAges: number[];
  /** 1-12, the month the stay falls in. */
  month: number | null;
  /**
   * The destination's own weather score for that month, 0-100. Low scores are
   * what let a `weather == HEAVY_RAIN` rule resolve without a forecast.
   */
  monthWeather: number | null;
  /** Interests the traveller actually stated, upper-cased. */
  interests: string[];
  /** Whether this is a first visit; decides the `FIRST_TIME_*` rules. */
  firstTimeVisitor: boolean;
};

export type Truth = true | false | "unknown";

/** Symbols each traveller type and style answer to in the rules' vocabulary. */
const TYPE_SYMBOLS: Record<TravellerType, string[]> = {
  family: ["FAMILY"],
  couple: ["HONEYMOON", "ROMANTIC", "COUPLE"],
  friends: ["FRIENDS", "GROUP"],
  stags: ["FRIENDS", "GROUP"],
  business: ["BUSINESS"],
  pilgrimage: ["SENIOR", "PILGRIMAGE", "SPIRITUAL"],
  solo: ["SOLO"],
};

const STYLE_SYMBOLS: Record<TripStyle, string[]> = {
  family: ["FAMILY"],
  honeymoon: ["HONEYMOON", "ROMANTIC"],
  romantic: ["HONEYMOON", "ROMANTIC"],
  luxury: ["LUXURY", "PREMIUM"],
  budget: ["BUDGET"],
  culture: ["CULTURAL", "CULTURE", "HERITAGE", "HISTORY"],
  adventure: ["ADVENTURE"],
  pilgrimage: ["PILGRIMAGE", "SPIRITUAL", "SENIOR"],
};

/**
 * Interests a trip style implies on its own.
 *
 * Kept deliberately tight. A culture trip really does imply heritage and
 * history, but it says nothing about whether the traveller cares about food or
 * nightlife — those have to be asked for, and stay undecided until they are.
 */
const STYLE_INTERESTS: Record<TripStyle, string[]> = {
  family: [],
  honeymoon: ["ROMANTIC_RELAXATION", "RELAXATION"],
  romantic: ["ROMANTIC_RELAXATION", "RELAXATION"],
  luxury: [],
  budget: [],
  culture: ["CULTURE", "CULTURE_AND_HERITAGE", "HISTORY", "HISTORY_AND_CULTURE", "HERITAGE"],
  adventure: ["ADVENTURE", "ADVENTURE_AND_OUTDOORS", "NATURE"],
  pilgrimage: ["SPIRITUALITY"],
};

/** Weather symbols that a low monthly weather score is evidence for. */
const ADVERSE_WEATHER = /RAIN|MONSOON|SNOW|HEAT|SMOG|FOG|BLIZZARD|WIND|COLD|CYCLONE|STORM/;
/** Below this, the destination's own file calls the month materially adverse. */
const ADVERSE_WEATHER_SCORE = 60;

function symbolsFor(facts: RuleFacts): string[] {
  const out = new Set<string>([
    ...TYPE_SYMBOLS[facts.travellerType],
    ...STYLE_SYMBOLS[facts.tripStyle],
    ...STYLE_INTERESTS[facts.tripStyle],
    ...facts.interests.map((i) => i.toUpperCase()),
  ]);
  if (facts.childAges.length) out.add("FAMILY");
  if (facts.childAges.some((a) => a <= 7)) out.add("FAMILY_WITH_YOUNG_CHILDREN");
  if (facts.firstTimeVisitor) {
    out.add("FIRST_TIME_VISITOR");
    out.add("FIRST_TIME");
  }
  return [...out];
}

/**
 * `FAMILY_WITH_YOUNG_CHILDREN` should satisfy a plain `FAMILY` test, and a
 * first-time traveller should satisfy `FIRST_TIME_AGRA`.
 *
 * Compared as underscore-separated token lists rather than raw strings, so the
 * prefix has to land on a word boundary: `FOOD` matches `FOOD_AND_GASTRONOMY`
 * but not `FOODIE_TRAIL`, and `ART` never matches `ARTISAN_MARKETS`.
 */
function symbolMatches(candidate: string, wanted: string): boolean {
  const split = (s: string) =>
    s.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const a = split(candidate);
  const b = split(wanted);
  if (!a.length || !b.length) return false;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((token, i) => longer[i] === token);
}

function compare(actual: number, operator: RuleOperator, expected: number): boolean {
  switch (operator) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">=": return actual >= expected;
    case "<=": return actual <= expected;
    case ">": return actual > expected;
    case "<": return actual < expected;
  }
}

function evaluateCondition(condition: RuleCondition, facts: RuleFacts): Truth {
  const { variable, operator, value, number, unit } = condition;

  switch (variable) {
    case "trip_length":
    case "trip_duration": {
      if (number == null) return "unknown";
      // A "3 day" trip is two nights; compare like with like.
      const actual = unit === "day" || unit === "days" ? facts.nights + 1 : facts.nights;
      return compare(actual, operator, number);
    }

    case "children_age": {
      if (number == null) return "unknown";
      if (!facts.childAges.length) return false;
      // The rules use this to mean "a child this age is along", so the
      // youngest child is what decides a `<=` test.
      const youngest = Math.min(...facts.childAges);
      return compare(youngest, operator, number);
    }

    case "travel_month": {
      if (facts.month == null || number == null) return "unknown";
      return compare(facts.month, operator, number);
    }

    case "traveler_type":
    case "traveller_type":
    case "trip_type":
    case "traveler_interest":
    case "traveller_interest":
    case "traveler_goal":
    case "trip_purpose": {
      const wanted = value.split(/\s*(?:\/|\bOR\b|\|\|)\s*/i).filter(Boolean);
      if (!wanted.length) return "unknown";
      const mine = symbolsFor(facts);
      const hit = wanted.some((w) => mine.some((m) => symbolMatches(m, w)));
      if (operator === "!=") return !hit;
      if (hit) return true;

      // A miss is only decisive when we know what the traveller wants. For
      // type and trip_type the request always says; for interests it only
      // says if they were asked and answered, so an unstated interest leaves
      // the rule undecided rather than quietly false.
      const isInterest = variable === "traveler_interest" || variable === "traveller_interest";
      if (isInterest && !facts.interests.length) return "unknown";
      return false;
    }

    case "weather":
    case "season": {
      if (!ADVERSE_WEATHER.test(value)) return "unknown";
      if (facts.monthWeather == null) return "unknown";
      // The destination's own month score stands in for a forecast: it knows
      // its monsoon and its heatwave, which is what these rules are about.
      return facts.monthWeather < ADVERSE_WEATHER_SCORE;
    }

    default:
      // route, hotel_priority, movement, visibility, departure_time and the
      // rest describe things the planner never asks about.
      return "unknown";
  }
}

export type RuleEvaluation = {
  rule: DecisionRule;
  /** `fired` when decisively true; `skipped` when a condition is unanswerable. */
  status: "fired" | "skipped" | "not-applicable";
  /** The conditions that could not be decided, for the agent's benefit. */
  undecided: string[];
};

/**
 * Evaluates one rule.
 *
 * `AND` binds tighter than `OR`, so `a AND b OR c` is `(a AND b) OR c`. Within
 * a conjunction an unknown is contagious — the group can only be true if every
 * part of it is known true — but a disjunction still succeeds if any branch is
 * decisively true, which is what lets `traveler_type == FAMILY OR SENIOR`
 * resolve even when one side is unanswerable.
 */
export function evaluateRule(rule: DecisionRule, facts: RuleFacts): RuleEvaluation {
  const undecided: string[] = [];

  // Split into OR-groups of AND-ed conditions.
  const groups: RuleCondition[][] = [];
  let current: RuleCondition[] = [];
  for (const condition of rule.conditions) {
    if (condition.joiner === "OR" && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(condition);
  }
  if (current.length) groups.push(current);

  let anyTrue = false;
  let anyUnknown = false;

  for (const group of groups) {
    let groupTrue = true;
    let groupUnknown = false;
    for (const condition of group) {
      const truth = evaluateCondition(condition, facts);
      if (truth === "unknown") {
        groupUnknown = true;
        undecided.push(`${condition.variable} ${condition.operator} ${condition.value}`);
      } else if (truth === false) {
        groupTrue = false;
      }
    }
    if (groupTrue && !groupUnknown) anyTrue = true;
    if (groupUnknown) anyUnknown = true;
  }

  if (anyTrue) return { rule, status: "fired", undecided: [] };
  if (anyUnknown) return { rule, status: "skipped", undecided };
  return { rule, status: "not-applicable", undecided: [] };
}

/** Evaluates every rule for a place, returning only what actually fired. */
export function fireRules(
  rules: DecisionRule[],
  facts: RuleFacts,
): { fired: RuleEvaluation[]; skipped: RuleEvaluation[] } {
  const fired: RuleEvaluation[] = [];
  const skipped: RuleEvaluation[] = [];
  for (const rule of rules) {
    const result = evaluateRule(rule, facts);
    if (result.status === "fired") fired.push(result);
    else if (result.status === "skipped") skipped.push(result);
  }
  return { fired, skipped };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Turns the fired rules into a per-cluster score adjustment.
 *
 * Returns a multiplier-free, additive bias keyed by a normalised name, which
 * the day planner folds into its existing cluster ranking. Kept additive and
 * bounded so a rule nudges the running order rather than overriding the
 * planner's own judgement about what fits the day.
 */
export function clusterBias(fired: RuleEvaluation[]): { tokens: string[]; bias: number }[] {
  const out: { tokens: string[]; bias: number }[] = [];
  for (const { rule } of fired) {
    for (const effect of rule.effects) {
      out.push({ tokens: effect.tokens, bias: effect.kind === "prioritise" ? 1 : -1 });
    }
  }
  return out;
}
