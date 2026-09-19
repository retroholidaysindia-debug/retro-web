/**
 * Vendors the passport-index visa matrix at build time.
 *
 * Visa *requirement* has no viable live API but does have a permissively
 * licensed open dataset (MIT), so it is fetched once and committed rather than
 * queried per request. Visa *fees* are not in any free dataset and come from
 * the hand-seeded table in `estimate.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Country, VisaRule } from "../../lib/atlas/schema";
import { VISA_FEE_INR } from "./estimate";

const SOURCE_URL =
  "https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index-tidy-iso3.csv";

const CACHE = path.join("data", "vendor", "passport-index-tidy-iso3.csv");

/** Nationalities offered in the planner. Keeps the shipped matrix small. */
export const SUPPORTED_NATIONALITIES = [
  "IND", "USA", "GBR", "ARE", "CAN", "AUS", "SGP", "DEU", "FRA", "NLD",
  "CHE", "ZAF", "MYS", "NPL", "LKA", "BGD", "QAT", "SAU", "KWT", "OMN",
];

/**
 * Downloads the matrix unless a cached copy already exists, so builds stay
 * reproducible and work offline once primed.
 */
export async function fetchVisaMatrix(refresh = false): Promise<string> {
  if (!refresh && existsSync(CACHE)) return readFileSync(CACHE, "utf8");

  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    if (existsSync(CACHE)) {
      console.warn(`  visa matrix fetch failed (${res.status}); using cached copy`);
      return readFileSync(CACHE, "utf8");
    }
    throw new Error(`Visa matrix fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, body);
  return body;
}

/** A numeric requirement is a visa-free allowance in days. */
function classify(raw: string): { requirement: VisaRule["requirement"]; days: number | null } {
  const t = raw.trim().toLowerCase();
  const numeric = Number(t);
  if (Number.isFinite(numeric) && numeric > 0) return { requirement: "visa_free", days: numeric };
  if (t === "-1") return { requirement: "visa_free", days: null }; // same country
  if (t === "visa free" || t === "visa-free") return { requirement: "visa_free", days: null };
  if (t === "visa on arrival") return { requirement: "visa_on_arrival", days: null };
  if (t === "e-visa" || t === "evisa") return { requirement: "e_visa", days: null };
  if (t === "eta") return { requirement: "eta", days: null };
  if (t === "no admission") return { requirement: "no_admission", days: null };
  return { requirement: "visa_required", days: null };
}

/** Fees only apply where a visa is actually needed. */
const FREE_REQUIREMENTS = new Set<VisaRule["requirement"]>(["visa_free", "no_admission"]);

export function buildVisaRules(csv: string, countries: Country[]): VisaRule[] {
  // Several catalogue nodes share an ISO3 (England/Scotland -> GBR), and
  // clusters have none, so index destinations by code and fan out.
  const byIso = new Map<string, Country[]>();
  for (const c of countries) {
    if (!c.iso3) continue;
    const list = byIso.get(c.iso3);
    if (list) list.push(c);
    else byIso.set(c.iso3, [c]);
  }

  const nationalities = new Set(SUPPORTED_NATIONALITIES);
  const rules: VisaRule[] = [];
  const seen = new Set<string>();

  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [passport, destination, requirementRaw] = line.split(",");
    if (!passport || !destination || !requirementRaw) continue;
    if (!nationalities.has(passport)) continue;

    const targets = byIso.get(destination);
    if (!targets) continue;

    const { requirement } = classify(requirementRaw);
    // Fees are seeded for Indian passports; other nationalities inherit the
    // same handling charge until the agency supplies their own card.
    const fee = FREE_REQUIREMENTS.has(requirement) ? 0 : (VISA_FEE_INR[destination] ?? 6000);

    for (const target of targets) {
      const key = `${passport}|${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({
        nationality: passport,
        destCountryId: target.id,
        requirement,
        feeInr: fee,
        processingDays: null,
        source: passport === "IND" ? "estimated" : "estimated",
      });
    }
  }

  return rules;
}
