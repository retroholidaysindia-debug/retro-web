/**
 * Parses the 216 destination knowledge files into structured content.
 *
 * The files follow a 36-section convention but with real-world drift: section
 * titles vary ("12. AIRPORT TRANSFER LOGIC" vs "12. ARRIVAL TRANSFER LOGIC"),
 * sections 29-31 are itinerary patterns whose titles encode their own length,
 * and a handful of files omit sections entirely. Parsing is therefore driven by
 * the leading section *number*, and every field is optional.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Matcher, normalise, slugify } from "./normalise";
import { parseDecisionRules } from "../../lib/atlas/engine/rules";
import type {
  Activity,
  Area,
  Attraction,
  Cluster,
  DecisionRuleRow,
  Destination,
  DestinationGuidance,
  DestinationTag,
  HotelZone,
  MonthlyScore,
  Place,
  PurposeActivity,
  SuitabilityScore,
  TripStyle,
  WalkingIntensity,
} from "../../lib/atlas/schema";

// ---------------------------------------------------------------------------
// Generic markdown helpers
// ---------------------------------------------------------------------------

type Section = { number: number | null; title: string; body: string };

function splitSections(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const out: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const h1 = /^#\s+(?:(\d+)\s*\.\s*)?(.+?)\s*:?\s*$/.exec(line);
    // Only treat as a section break at h1 level (a single leading '#').
    if (h1 && !/^##/.test(line)) {
      if (current) out.push(current);
      current = { number: h1[1] ? Number(h1[1]) : null, title: h1[2].trim(), body: "" };
      continue;
    }
    if (current) current.body += line + "\n";
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits a section body on its subheadings. Depth varies between files — the
 * same cluster list is `##` in one file and `####` in another — so any of
 * h2-h4 opens a subsection, and the shallowest depth present wins.
 */
function splitSubsections(body: string): { title: string; body: string }[] {
  const depths = [...body.matchAll(/^(#{2,4})\s+\S/gm)].map((m) => m[1].length);
  if (!depths.length) return [];
  const depth = Math.min(...depths);
  const re = new RegExp(`^#{${depth}}\\s+(.+?)\\s*$`);

  const out: { title: string; body: string }[] = [];
  let current: { title: string; body: string } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = re.exec(line);
    // Guard against a deeper heading matching the prefix (### vs ##).
    if (h && !new RegExp(`^#{${depth + 1}}`).test(line)) {
      if (current) out.push(current);
      current = { title: h[1].replace(/\*+/g, "").trim(), body: "" };
      continue;
    }
    if (current) current.body += line + "\n";
  }
  if (current) out.push(current);
  return out;
}

/**
 * Reads a `key:` field. Values may sit on the same line or on the following
 * lines up to the next blank-line-separated field.
 *
 * `H` is horizontal whitespace only: a plain `\s*` would cross the newline and
 * silently capture the first line of a multi-line value as if it were inline.
 */
const H = "[^\\S\\r\\n]*";

function field(body: string, key: string): string | null {
  const re = new RegExp(`^${H}${key}${H}:${H}(.*)$`, "im");
  const m = re.exec(body);
  if (!m) return null;
  if (m[1].trim()) return m[1].trim();

  const after = body.slice(m.index + m[0].length);
  const collected: string[] = [];
  for (const line of after.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      if (collected.length) break;
      continue;
    }
    // Stop at the next field, bullet list, heading or rule.
    if (/^[a-z][a-z0-9_ /]{2,40}:\s*$/i.test(t) || /^[*#|-]{1,3}\s|^\*\*\*$|^---$/.test(t)) break;
    collected.push(t);
    if (collected.length >= 8) break;
  }
  return collected.join(" ").trim() || null;
}

/** First non-empty value among several spellings of the same field. */
function fieldAny(body: string, keys: string[]): string | null {
  for (const k of keys) {
    const v = field(body, k);
    if (v) return v;
  }
  return null;
}

/** Reads a `* item` bullet list, optionally under a `key:` lead-in. */
function bullets(body: string, key?: string): string[] {
  let scope = body;
  if (key) {
    const re = new RegExp(`^${H}${key}${H}:${H}$`, "im");
    const m = re.exec(body);
    if (!m) return [];
    scope = body.slice(m.index + m[0].length);
  }
  const out: string[] = [];
  for (const line of scope.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const b = /^[*\-]\s+(.+)$/.exec(t);
    if (b) {
      const v = b[1].replace(/\*+/g, "").trim();
      if (v) out.push(v);
      continue;
    }
    if (out.length) break; // list ended
    if (/^[a-z][a-z0-9_ /]{2,40}:\s*$/i.test(t)) break;
  }
  return out;
}

/**
 * A list that may be written either as bullets under `key:` or inline as a
 * comma-separated value on the same line. Both appear across the corpus.
 */
function listAny(body: string, keys: string[]): string[] {
  for (const k of keys) {
    const b = bullets(body, k);
    if (b.length) return b;
  }
  const inline = fieldAny(body, keys);
  if (!inline) return [];
  return inline
    .split(/\s*[,;]\s+|\s+\+\s+/)
    .map((s) => s.replace(/\*+/g, "").trim())
    .filter((s) => s.length > 1);
}

/**
 * Parses a pipe table. Many files write a bordered header row but unbordered
 * data rows ("Family | 90 | Disneyland..."), so a leading pipe is optional.
 */
function table(body: string): string[][] {
  const rows: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.includes("|")) continue;
    if (/^\|?[\s|:*-]+\|?$/.test(t)) continue; // separator row
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

/** "82" | "78-86" | "MEDIUM → HIGH" -> a number where possible. */
function score(text: string | null | undefined): number | null {
  if (!text) return null;
  const range = /(\d+)\s*[-–—]\s*(\d+)/.exec(text);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const single = /(\d+(?:\.\d+)?)/.exec(text);
  return single ? Number(single[1]) : null;
}

/** "2-3" -> 2 (low end), "4-5" -> 4. */
function nightsLow(text: string | null): number | null {
  if (!text) return null;
  const m = /(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

function nightsHigh(text: string | null): number | null {
  if (!text) return null;
  const all = [...text.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
  return all.length ? Math.max(...all) : null;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Words that look like IATA codes but are not, so the loose fallback below
 * cannot mistake prose for an airport.
 */
const NOT_AIRPORT_CODES = new Set([
  "THE", "AND", "FOR", "ARE", "NOT", "BUT", "ALL", "ONE", "TWO", "VIA", "PER",
  "MIN", "HRS", "KMS", "USD", "EUR", "INR", "GBP", "AED", "JPY", "CNY",
  "IATA", "ICAO", "BUS", "CAR", "TAX", "VAT", "AIR", "NEX", "TIP", "DAY",
]);

/**
 * Extracts IATA codes from the arrival section.
 *
 * Files write airports three ways: `(IATA: COK)`, `(IATA: FCO, ICAO: LIRF)` and
 * bare (`Narita NRT - 60-90min to Tokyo`). The explicit forms are preferred;
 * the bare form is only used when no labelled code is present.
 */
function airportCodes(body: string): string[] {
  const labelled = [...body.matchAll(/IATA:\s*([A-Z]{3})/g)].map((m) => m[1]);
  if (labelled.length) return [...new Set(labelled)];

  const loose: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    // Only mine lines that plausibly name an airport or a transfer route.
    if (!/airport|→|->|terminal/i.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Z]{3})\b/g)) {
      if (!NOT_AIRPORT_CODES.has(m[1])) loose.push(m[1]);
    }
  }
  return [...new Set(loose)];
}


// ---------------------------------------------------------------------------
// Domain mapping
// ---------------------------------------------------------------------------

/** "## Family" / "## Honeymoon" -> TripStyle. */
const PURPOSE_TO_STYLE: Record<string, TripStyle> = {
  family: "family",
  honeymoon: "honeymoon",
  romantic: "romantic",
  luxury: "luxury",
  budget: "budget",
  culture: "culture",
  cultural: "culture",
  adventure: "adventure",
  pilgrimage: "pilgrimage",
};

/** Section 2 suitability rows -> the trip styles used for allocation/day planning. */
const SUITABILITY_TO_STYLE: Record<string, TripStyle> = {
  family: "family",
  "family with young children": "family",
  honeymoon: "honeymoon",
  romantic: "romantic",
  luxury: "luxury",
  budget: "budget",
  culture: "culture",
  history: "culture",
  adventure: "adventure",
};

const DURATION_HOURS: [RegExp, number][] = [
  [/full day\s*(?:to|-|–)\s*(?:multi|two)/i, 8],
  [/half day\s*(?:to|-|–)\s*full day/i, 6],
  [/full\s*day/i, 8],
  [/half\s*day/i, 4],
  [/(\d+)\s*(?:to|-|–)\s*(\d+)\s*hours?/i, 0], // handled numerically below
  [/(\d+)\s*hours?/i, 0],
  [/evening|night/i, 3],
  [/short|quick/i, 2],
];

function durationToHours(text: string | null): number {
  if (!text) return 4;
  const range = /(\d+)\s*(?:to|-|–)\s*(\d+)\s*hours?/i.exec(text);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const hours = /(\d+(?:\.\d+)?)\s*hours?/i.exec(text);
  if (hours) return Number(hours[1]);
  for (const [re, h] of DURATION_HOURS) {
    if (h && re.test(text)) return h;
  }
  return 4;
}

function walkingIntensity(text: string | null): WalkingIntensity | null {
  if (!text) return null;
  const t = text.toUpperCase().replace(/[^A-Z_ ]/g, " ");
  if (/MEDIUM[\s_]*HIGH/.test(t)) return "MEDIUM_HIGH";
  if (/LOW[\s_]*MEDIUM/.test(t)) return "LOW_MEDIUM";
  if (/\bHIGH\b/.test(t)) return "HIGH";
  if (/\bMEDIUM\b/.test(t)) return "MEDIUM";
  if (/\bLOW\b/.test(t)) return "LOW";
  return null;
}

/**
 * Which pricing zone an area bills at. The workbook only has Central and
 * Outskirts, so area names/price levels are mapped onto those two.
 */
function areaZone(name: string, priceLevel: string | null): HotelZone {
  if (/outskirt|suburb|periphery|airport|outside|rural|countryside/i.test(name)) return "Outskirts";
  if (/central|downtown|old town|city cent|centre|center|marina|waterfront|beach|corniche/i.test(name))
    return "Central";
  // Fall back to price: premium areas are the central ones.
  return /HIGH/i.test(priceLevel ?? "") ? "Central" : "Outskirts";
}

// ---------------------------------------------------------------------------
// Per-file parse
// ---------------------------------------------------------------------------

export type DestinationContent = {
  destination: Destination;
  suitability: SuitabilityScore[];
  tags: DestinationTag[];
  months: MonthlyScore[];
  areas: Area[];
  attractions: Attraction[];
  activities: Activity[];
  purposeActivities: PurposeActivity[];
  clusters: Cluster[];
  guidance: DestinationGuidance[];
  decisionRules: DecisionRuleRow[];
};

function parseFile(raw: string, placeId: string): DestinationContent {
  // A third of the corpus writes fields as `**key:** value` rather than
  // `key:`. Flatten that first so every downstream reader sees one form.
  const md = raw.replace(
    /^([^\S\r\n]*)\*\*[^\S\r\n]*([A-Za-z][A-Za-z0-9_ /-]{1,40}?)[^\S\r\n]*:?[^\S\r\n]*\*\*[^\S\r\n]*:?[^\S\r\n]*/gm,
    "$1$2: ",
  );

  const sections = splitSections(md);
  const byNumber = new Map<number, Section>();
  for (const s of sections) if (s.number != null && !byNumber.has(s.number)) byNumber.set(s.number, s);
  const sec = (n: number) => byNumber.get(n)?.body ?? "";

  // Identity fields live in the unnumbered heading blocks before section 1
  // ("# DESTINATION KNOWLEDGE FILE", "# CAIRO, AFRICA"), so take them all.
  const firstNumbered = sections.findIndex((s) => s.number != null);
  const head = sections
    .slice(0, firstNumbered < 0 ? sections.length : firstNumbered)
    .map((s) => s.body)
    .join("\n");

  // --- 1 / header: identity ------------------------------------------------
  const preamble = head + "\n" + sec(1);
  const destination: Destination = {
    placeId,
    destinationCode: field(preamble, "destination_id"),
    shortDescription: field(sec(1), "short_description"),
    agentSummary: field(sec(1), "travel_agent_summary"),
    destinationTypes: listAny(preamble, ["destination_type", "destination_types"]),
    currency: field(preamble, "currency"),
    timezone: field(preamble, "timezone"),
    minNights: nightsLow(fieldAny(sec(6), ["minimum_nights", "min_nights"])),
    idealNights: nightsLow(fieldAny(sec(6), ["ideal_nights", "recommended_nights"])),
    maxNights:
      nightsHigh(
        fieldAny(sec(6), [
          "maximum_recommended_nights_for_first_visit",
          "maximum_first_visit",
          "maximum_nights",
          "max_nights",
        ]),
      ) ?? nightsHigh(fieldAny(sec(6), ["ideal_nights", "recommended_nights"])),
    gettingAround: bullets(sec(13), "Primary modes") .concat(bullets(sec(13))).filter((v, i, a) => a.indexOf(v) === i),
    primaryAirports: airportCodes(sec(11)),
    overallCostLevel: field(sec(9), "Overall cost level"),
  };

  // --- 2: suitability ------------------------------------------------------
  const suitability: SuitabilityScore[] = [];
  for (const row of table(sec(2))) {
    const [category, value] = row;
    if (!category || /^category$/i.test(category)) continue;
    const s = score(value);
    if (s != null && s >= 0 && s <= 100) suitability.push({ placeId, category, score: s });
  }

  // --- 3 / 4 / 5: tags -----------------------------------------------------
  const tags: DestinationTag[] = [];
  const pushTags = (kind: DestinationTag["kind"], values: string[]) => {
    for (const tag of values) if (tag && tag.length < 60) tags.push({ placeId, kind, tag });
  };
  pushTags("best_for", listAny(sec(3), ["best_for"]).concat(bullets(sec(3))));
  pushTags("not_ideal_for", listAny(sec(4), ["not_ideal_for"]).concat(bullets(sec(4))));
  pushTags("primary_purpose", listAny(sec(5), ["primary_purposes", "primary_purpose"]));
  pushTags("secondary_purpose", listAny(sec(5), ["secondary_purposes", "secondary_purpose"]));

  // --- 8: monthly score table ---------------------------------------------
  const months: MonthlyScore[] = [];
  for (const row of table(sec(8))) {
    const idx = MONTHS.indexOf(normalise(row[0] ?? ""));
    if (idx < 0) continue;
    months.push({
      placeId,
      month: idx + 1,
      weather: score(row[1]),
      crowd: score(row[2]),
      price: score(row[3]),
      overall: score(row[4]),
      recommendation: row[5] || null,
    });
  }

  // --- 14: important areas -------------------------------------------------
  const areas: Area[] = [];
  for (const sub of splitSubsections(sec(14))) {
    const priceLevel = fieldAny(sub.body, ["price_level", "price"]);
    areas.push({
      id: `${placeId}:area:${slugify(sub.title)}`,
      placeId,
      name: sub.title,
      priceLevel,
      transportConvenience: score(
        fieldAny(sub.body, ["transport_convenience", "transport", "convenience"]),
      ),
      bestFor: listAny(sub.body, ["best_for", "good_for"]),
      advantages: listAny(sub.body, ["advantages", "pros"]),
      disadvantages: listAny(sub.body, ["disadvantages", "cons"]),
      recommendedFor: listAny(sub.body, ["recommended_for", "suits"]),
      zone: areaZone(sub.title, priceLevel),
    });
  }

  // --- 15: activity codes (join key to the rate card) ---------------------
  const activities: Activity[] = [];
  const seenCodes = new Set<string>();
  for (const line of sec(15).split(/\r?\n/)) {
    const t = line.trim().replace(/\s{2,}$/, "");
    if (!/^[A-Z][A-Z0-9]*_A_/.test(t)) continue;
    const code = t.replace(/\s+$/, "");
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);
    activities.push({
      id: `${placeId}:${normalise(code).replace(/\s+/g, "-")}`,
      placeId,
      code,
      name: code.replace(/^[A-Z0-9]+_A_/, "").replace(/_/g, " "),
    });
  }

  // --- 16: first-time visitor priority ------------------------------------
  const attractions: Attraction[] = [];
  {
    let priority = 60;
    const seen = new Set<string>();
    for (const line of sec(16).split(/\r?\n/)) {
      const t = line.trim();
      const band = /^Priority\s+(\d+)\s*[-–—]\s*(\d+)/i.exec(t);
      if (band) {
        priority = (Number(band[1]) + Number(band[2])) / 2;
        continue;
      }
      if (/^optional/i.test(t)) {
        priority = 50;
        continue;
      }
      const b = /^[*\-]\s+(.+)$/.exec(t);
      if (!b) continue;
      const name = b[1].replace(/\*+/g, "").trim();
      if (!name || seen.has(normalise(name))) continue;
      seen.add(normalise(name));
      attractions.push({ id: `${placeId}:poi:${slugify(name)}`, placeId, name, priority });
    }
  }

  // --- 17: activities by purpose ------------------------------------------
  const purposeActivities: PurposeActivity[] = [];
  for (const sub of splitSubsections(sec(17))) {
    const style = PURPOSE_TO_STYLE[normalise(sub.title)];
    if (!style) continue;
    for (const description of bullets(sub.body)) {
      purposeActivities.push({ placeId, purpose: style, description });
    }
  }

  // --- 27: geographical clusters (the day-planning unit) -------------------
  const clusters: Cluster[] = [];
  for (const sub of splitSubsections(sec(27))) {
    const recommendedDuration = fieldAny(sub.body, [
      "recommended_duration",
      "duration",
      "suggested_duration",
      "time_needed",
    ]);
    const attractionNames = listAny(sub.body, ["attractions", "highlights", "sites", "includes"]);
    if (!attractionNames.length) continue;
    // "CLUSTER 1 — GIZA PYRAMIDS AND SPHINX" -> "Giza Pyramids And Sphinx"
    const name = sub.title.replace(/^CLUSTER\s*\d+\s*[—–-]\s*/i, "").trim() || sub.title;
    clusters.push({
      id: `${placeId}:cluster:${slugify(name)}`,
      placeId,
      name,
      attractions: attractionNames,
      recommendedDuration,
      durationHours: durationToHours(recommendedDuration),
      walkingIntensity: walkingIntensity(
        fieldAny(sub.body, ["walking_intensity", "walking", "walk"]),
      ),
    });
  }

  return {
    destination,
    suitability,
    tags,
    months,
    areas,
    attractions,
    activities,
    purposeActivities,
    clusters,
    guidance: parseGuidance(byNumber, placeId),
    // Section 33 is a genuine rule block, so it is parsed into an evaluable
    // form as well as kept whole in the guidance sweep.
    decisionRules: parseDecisionRules(sec(33), placeId),
  };
}

/**
 * Sections whose content is already extracted into a dedicated table. Kept out
 * of the guidance sweep so the same text is not stored twice.
 */
const STRUCTURED_SECTIONS = new Set([1, 2, 3, 4, 5, 6, 8, 9, 11, 13, 14, 15, 16, 17, 27]);

/** `## Family` and friends — the audience a guidance block is written for. */
const AUDIENCE_PATTERNS: { audience: string; test: RegExp }[] = [
  { audience: "family", test: /\bfamil|\bchild|\bkids?\b/i },
  { audience: "honeymoon", test: /honeymoon|romantic|couple/i },
  { audience: "luxury", test: /luxur|premium/i },
  { audience: "budget", test: /budget|backpack|cost-conscious/i },
  { audience: "adventure", test: /adventur|adrenaline|trek/i },
  { audience: "senior", test: /senior|elderly|older travel/i },
  { audience: "accessibility", test: /accessib|mobility|wheelchair/i },
  { audience: "solo", test: /\bsolo\b/i },
  { audience: "business", test: /business|corporate/i },
];

function audienceOf(heading: string | null): string | null {
  if (!heading) return null;
  for (const { audience, test } of AUDIENCE_PATTERNS) {
    if (test.test(heading)) return audience;
  }
  return null;
}

/** Strips list markers and collapses whitespace. */
function cleanBullet(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, "").replace(/\s+/g, " ").trim();
}

/**
 * Sweeps every section the structured parsers do not claim into guidance rows.
 *
 * Deliberately generic. These 21 sections are a mix of tables, IF/THEN rule
 * blocks and free prose, and several drift in both title and depth between
 * files; a bespoke shape per section would be brittle and lossy, whereas
 * capturing each block whole — tagged with its section, its subheading and the
 * audience that subheading names — keeps all of it and still lets the engine
 * ask for precisely the blocks that apply to a given trip.
 */
function parseGuidance(byNumber: Map<number, Section>, placeId: string): DestinationGuidance[] {
  const out: DestinationGuidance[] = [];

  for (const [number, section] of byNumber) {
    if (STRUCTURED_SECTIONS.has(number)) continue;
    const topic = slugify(section.title);
    if (!topic) continue;

    const subs = splitSubsections(section.body);
    // A section with no subheadings is still one block of guidance.
    const blocks = subs.length ? subs : [{ title: "", body: section.body }];

    for (const block of blocks) {
      const bullets: string[] = [];
      const prose: string[] = [];
      for (const line of block.body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^[-*_]{3,}$/.test(trimmed)) continue; // blank or rule
        if (/^\s*[-*+]\s+\S/.test(line)) bullets.push(cleanBullet(line));
        else prose.push(trimmed);
      }
      const body = prose.join(" ").replace(/\s+/g, " ").trim();
      if (!bullets.length && !body) continue;

      const heading = block.title.trim() || null;
      out.push({
        placeId,
        section: number,
        topic,
        sectionTitle: section.title,
        heading,
        audience: audienceOf(heading),
        bullets,
        body,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Directory walk
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export type DestinationParse = {
  byPlaceId: Map<string, DestinationContent>;
  /** Files whose name matched no place in the master catalogue. */
  orphanFiles: string[];
};

export function parseDestinations(
  root: string,
  places: Place[],
  overrides: Record<string, string> = {},
): DestinationParse {
  const matcher = new Matcher(
    places.map((p) => ({ name: p.name, value: p })),
    overrides,
  );

  const byPlaceId = new Map<string, DestinationContent>();
  const orphanFiles: string[] = [];

  for (const file of walk(root)) {
    const base = path.basename(file).replace(/\.md$/i, "");
    const hit = matcher.match(base);
    if (!hit) {
      orphanFiles.push(base);
      continue;
    }
    // First file wins when two files map to the same place.
    if (byPlaceId.has(hit.value.id)) continue;
    byPlaceId.set(hit.value.id, parseFile(readFileSync(file, "utf8"), hit.value.id));
  }

  return { byPlaceId, orphanFiles };
}

export { SUITABILITY_TO_STYLE };
