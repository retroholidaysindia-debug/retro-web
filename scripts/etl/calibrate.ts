/**
 * Prices every published package through the quotation engine and reports how
 * far the generated number lands from the agency's own "from" price.
 *
 * The published price is a *minimum*: per person, twin share, cheapest hotel,
 * cheapest carrier — and it covers the **land package only**, with airfare
 * quoted on top. So the harness builds exactly that configuration with the
 * flight excluded, searches every departure city and the cheapest month, and
 * takes the lowest result — anything else would not be a like-for-like
 * comparison. (Departure city still matters with no airfare: it drives the
 * visa and some transfer rates.)
 *
 * The package price floor is switched off, otherwise every package would
 * trivially reproduce its own published price and the test would prove nothing.
 *
 *   npm run calibrate              # report only
 *   npm run calibrate -- --write   # also fit and write correction factors
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CoreBundle,
  type DestinationBundle,
  type Package,
  type Route,
  type TripStyle,
  type VisaRule,
} from "../../lib/atlas/schema";
import { generateQuotation } from "../../lib/atlas/engine";
import { QuoteRequest, type CostComponent, type Quotation } from "../../lib/atlas/engine/types";
import { writeWorkbook, type SheetSpec } from "./xlsx-write";
import { Workbook, cell, num } from "./xlsx-read";

const DATA = "public/atlas";
const CALIBRATION_FILE = path.join("content", "pricing-calibration.json");
const REPORT = path.join("data", "atlas", "Atlas_Pricing_Calibration.xlsx");
const write = process.argv.includes("--write");
const apply = process.argv.includes("--apply");

/**
 * How far above the published price is acceptable. Slightly higher is expected
 * — the published figure is a loss-leading "from" price — but a large overshoot
 * means the traveller sees a number that does not match the advertised one.
 */
const TOLERANCE = { underPct: 0, warnOverPct: 25, failOverPct: 60 };

const core = CoreBundle.parse(JSON.parse(readFileSync(path.join(DATA, "core.json"), "utf8")));
const routes = (JSON.parse(readFileSync(path.join(DATA, "routes.json"), "utf8")) as { routes: Route[] }).routes;
const visaRules = (JSON.parse(readFileSync(path.join(DATA, "visa.json"), "utf8")) as { rules: VisaRule[] }).rules;

const DEPARTURE_CITIES = ["DEL", "BOM", "MAA", "BLR", "HYD", "CCU", "COK", "AMD", "PNQ", "GOI"];

const bundleCache = new Map<string, DestinationBundle | null>();
function loadBundles(placeIds: string[]): Map<string, DestinationBundle> {
  const map = new Map<string, DestinationBundle>();
  for (const id of placeIds) {
    const place = core.places.find((p) => p.id === id);
    if (!place) continue;
    if (!bundleCache.has(id)) {
      try {
        bundleCache.set(id, JSON.parse(readFileSync(path.join(DATA, "destinations", `${place.slug}.json`), "utf8")));
      } catch {
        bundleCache.set(id, null);
      }
    }
    const bundle = bundleCache.get(id);
    if (bundle) map.set(id, bundle);
  }
  return map;
}

/** The month a destination is cheapest, from its own monthly price index. */
function cheapestMonth(placeId: string): number {
  const summary = core.placeSummaries.find((s) => s.placeId === placeId);
  const months = Object.entries(summary?.monthPrice ?? {});
  if (!months.length) return 6;
  return Number(months.sort((a, b) => a[1] - b[1])[0][0]);
}

/** The published price is a minimum, so quote the cheapest legitimate setup. */
function minimumRequest(pkg: Package, departureCity: string): QuoteRequest {
  const month = cheapestMonth(pkg.placeIds[0]);
  const year = new Date().getUTCFullYear() + 1;
  const style: TripStyle = /pilgrim|kailash|amarnath|char dham/i.test(pkg.name) ? "pilgrimage" : "culture";

  return QuoteRequest.parse({
    placeIds: pkg.placeIds,
    nights: pkg.nights || Math.max(1, pkg.placeIds.length),
    startDate: `${year}-${String(month).padStart(2, "0")}-15`,
    adults: 2,
    childAges: [],
    travellerType: "couple",
    tripStyle: style,
    nationality: "IND",
    departureCity,
    hotelStar: "3 Star",
    hotelZone: "Outskirts",
    carrier: "LCC",
    cabin: "Economy",
    mealPlan: "breakfast",
    food: "no-preference",
    pace: "balanced",
    includeVisa: true,
    includeInsurance: false,
    // The published "from" price is land-only, so the quote it is measured
    // against must be too — see `pkg.priceIncludesFlight`.
    includeFlight: pkg.priceIncludesFlight,
  });
}

type Row = {
  pkg: Package;
  quote: Quotation;
  departureCity: string;
  published: number;
  generated: number;
  deltaPct: number;
  verdict: "UNDER" | "OK" | "HIGH" | "TOO HIGH";
  componentPerPerson: Partial<Record<CostComponent, number>>;
};

function evaluate(pkg: Package): Row | null {
  let best: { quote: Quotation; city: string } | null = null;

  for (const city of DEPARTURE_CITIES) {
    const request = minimumRequest(pkg, city);
    let quote: Quotation;
    try {
      quote = generateQuotation(request, {
        core, routes, visaRules,
        bundles: loadBundles(request.placeIds),
        ignorePackageFloor: true,
      });
    } catch {
      continue;
    }
    if (!best || quote.totals.perPerson < best.quote.totals.perPerson) best = { quote, city };
  }
  if (!best) return null;

  const published = pkg.priceFromInr;
  const generated = best.quote.totals.perPerson;
  const deltaPct = published > 0 ? ((generated - published) / published) * 100 : 0;

  const componentPerPerson: Partial<Record<CostComponent, number>> = {};
  for (const item of best.quote.lineItems) {
    componentPerPerson[item.component] =
      (componentPerPerson[item.component] ?? 0) + item.totalInr / best.quote.pax.total;
  }

  const verdict: Row["verdict"] =
    deltaPct < TOLERANCE.underPct
      ? "UNDER"
      : deltaPct > TOLERANCE.failOverPct
        ? "TOO HIGH"
        : deltaPct > TOLERANCE.warnOverPct
          ? "HIGH"
          : "OK";

  return {
    pkg, quote: best.quote, departureCity: best.city,
    published, generated, deltaPct, verdict, componentPerPerson,
  };
}

// ---------------------------------------------------------------------------
// Feedback loop
// ---------------------------------------------------------------------------

/**
 * Fits a per-region correction factor from the observed deltas.
 *
 * Only the components the agency can plausibly have mispriced are scaled —
 * visa, insurance and city tax are pass-through costs, so distorting them to
 * hit a headline number would just hide the error somewhere worse.
 */
type FactorTable = Record<string, Partial<Record<CostComponent, number>>>;

const SCALABLE: CostComponent[] = [
  "hotel", "flight", "local-transport", "intercity-transport", "sightseeing", "meals",
];

function fitFactors(rows: Row[]): Record<string, Partial<Record<CostComponent, number>>> {
  const byRegion = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byRegion.get(row.pkg.regionId) ?? [];
    list.push(row);
    byRegion.set(row.pkg.regionId, list);
  }

  const out: Record<string, Partial<Record<CostComponent, number>>> = {};
  for (const [regionId, regionRows] of byRegion) {
    // Target the median package in the region, so one outlier cannot drag the
    // whole region's pricing with it.
    const ratios = regionRows
      .filter((r) => r.published > 0)
      .map((r) => r.generated / r.published)
      .sort((a, b) => a - b);
    if (!ratios.length) continue;
    const median = ratios[ratios.length >> 1];

    // Aim a little above the published price rather than exactly at it.
    const target = 1.05;
    const correction = target / median;
    if (Math.abs(correction - 1) < 0.02) continue; // already close enough

    const scalableShare = regionRows.reduce((sum, r) => {
      const total = Object.values(r.componentPerPerson).reduce((a, b) => a + b, 0);
      const scalable = SCALABLE.reduce((a, c) => a + (r.componentPerPerson[c] ?? 0), 0);
      return sum + (total > 0 ? scalable / total : 1);
    }, 0) / regionRows.length;

    // Only the scalable share can absorb the correction, so it must move more
    // than the headline gap to close it.
    const factor = 1 + (correction - 1) / Math.max(0.2, scalableShare);
    const clamped = Math.max(0.4, Math.min(2.5, factor));

    out[regionId] = Object.fromEntries(
      SCALABLE.map((c) => [c, Number(clamped.toFixed(4))]),
    ) as Partial<Record<CostComponent, number>>;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying the agency's own corrections
// ---------------------------------------------------------------------------

/**
 * Reads the "Your Corrections" sheet back out of the workbook and turns each
 * filled-in row into a calibration factor.
 *
 * The agency states the price a package *should* be; the factor needed to reach
 * it is derived from what the engine currently produces, and applied to the
 * scalable components only. Stating a target price is far easier than guessing
 * a multiplier, which is why the sheet asks for the former.
 */
function applyCorrections(rows: Row[]): {
  packageFactors: Record<string, Partial<Record<CostComponent, number>>>;
  applied: { name: string; target: number; factor: number }[];
  skipped: string[];
} {
  const packageFactors: Record<string, Partial<Record<CostComponent, number>>> = {};
  const applied: { name: string; target: number; factor: number }[] = [];
  const skipped: string[] = [];

  let sheet;
  try {
    sheet = Workbook.open(REPORT).sheet("Your Corrections");
  } catch {
    return { packageFactors, applied, skipped: ["No calibration workbook found — run `npm run calibrate` first."] };
  }

  // Whatever factor is already in force for a region, so a package correction
  // can carry it forward rather than replacing it.
  const current = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8")) as {
    region?: FactorTable;
    global?: Partial<Record<CostComponent, number>>;
  };
  const currentFactor = (regionId: string, component: CostComponent) =>
    current.region?.[regionId]?.[component] ?? current.global?.[component] ?? 1;

  const byId = new Map(rows.map((r) => [r.pkg.id, r]));

  for (const row of sheet.slice(1)) {
    const packageId = cell(row, 1);
    if (!packageId) continue;

    const target = num(row, 4); // "Correct price pp (fill in)"
    const explicitFactor = num(row, 6); // "Your factor"
    const component = cell(row, 5).trim() as CostComponent | "";

    const current = byId.get(packageId);
    if (!current) {
      skipped.push(`${packageId} — no longer in the catalogue`);
      continue;
    }

    let factor: number | null = null;
    if (explicitFactor && explicitFactor > 0) {
      factor = explicitFactor;
    } else if (target && target > 0 && current.generated > 0) {
      // Only the scalable components can move, so they must absorb the whole
      // correction and therefore shift by more than the headline difference.
      const totalPp = Object.values(current.componentPerPerson).reduce((a, b) => a + b, 0);
      const scalablePp = SCALABLE.reduce((a, c) => a + (current.componentPerPerson[c] ?? 0), 0);
      if (scalablePp <= 0) {
        skipped.push(`${current.pkg.name} — nothing scalable to adjust`);
        continue;
      }
      const ratio = target / current.generated;
      const share = scalablePp / Math.max(1, totalPp);
      const correction = 1 + (ratio - 1) / share;

      // The observed price already includes whatever region factor is in force.
      // Because scopes do not compound, a package factor replaces it outright —
      // so it has to carry that region factor forward, or the correction would
      // silently undo it.
      const inForce = currentFactor(current.pkg.regionId, component || "hotel");
      factor = inForce * correction;
    }

    if (factor == null) continue;
    const clamped = Number(Math.max(0.2, Math.min(4, factor)).toFixed(4));

    packageFactors[packageId] = component
      ? { [component]: clamped }
      : (Object.fromEntries(SCALABLE.map((c) => [c, clamped])) as Partial<Record<CostComponent, number>>);

    applied.push({ name: current.pkg.name, target: target ?? 0, factor: clamped });
  }

  return { packageFactors, applied, skipped };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const rows = core.packages
  .map(evaluate)
  .filter((r): r is Row => r !== null)
  .sort((a, b) => a.deltaPct - b.deltaPct);

const counts = { UNDER: 0, OK: 0, HIGH: 0, "TOO HIGH": 0 };
for (const r of rows) counts[r.verdict]++;

const inr = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

console.log(`\nPricing calibration — ${rows.length} of ${core.packages.length} packages priced\n`);
console.log(`  UNDER published : ${String(counts.UNDER).padStart(3)}   (a real problem — we would undercut the brochure)`);
console.log(`  OK (0 to +${TOLERANCE.warnOverPct}%) : ${String(counts.OK).padStart(3)}`);
console.log(`  HIGH (to +${TOLERANCE.failOverPct}%)  : ${String(counts.HIGH).padStart(3)}`);
console.log(`  TOO HIGH        : ${String(counts["TOO HIGH"]).padStart(3)}   (traveller sees far more than advertised)`);

const deltas = rows.map((r) => r.deltaPct).sort((a, b) => a - b);
console.log(
  `\n  delta  min ${pct(deltas[0])}   median ${pct(deltas[deltas.length >> 1])}   max ${pct(deltas[deltas.length - 1])}`,
);

console.log("\n  " + "Package".padEnd(40) + "Published".padStart(11) + "Generated".padStart(11) + "Delta".padStart(9) + "  Verdict");
console.log("  " + "-".repeat(88));
for (const r of rows) {
  console.log(
    "  " + r.pkg.name.slice(0, 39).padEnd(40) +
      inr(r.published).padStart(11) +
      inr(r.generated).padStart(11) +
      pct(r.deltaPct).padStart(9) +
      "  " + r.verdict,
  );
}

// --- workbook -------------------------------------------------------------
const allComponents: CostComponent[] = [
  "hotel", "flight", "airport-transfer", "local-transport", "intercity-transport",
  "sightseeing", "meals", "visa", "insurance", "city-tax",
];

const regionName = new Map(core.regions.map((r) => [r.id, r.name]));

const sheets: SheetSpec[] = [
  {
    name: "Summary",
    header: ["Metric", "Value", "Meaning"],
    rows: [
      ["Packages priced", rows.length, `of ${core.packages.length} in the catalogue`],
      ["UNDER published", counts.UNDER, "Generated below the brochure price — we would undercut ourselves"],
      ["OK", counts.OK, `Within 0 to +${TOLERANCE.warnOverPct}% of published — the intended outcome`],
      ["HIGH", counts.HIGH, `+${TOLERANCE.warnOverPct}% to +${TOLERANCE.failOverPct}%`],
      ["TOO HIGH", counts["TOO HIGH"], `Above +${TOLERANCE.failOverPct}% — traveller sees far more than advertised`],
      ["Median delta", `${deltas[deltas.length >> 1].toFixed(1)}%`, "Half the packages are closer than this"],
      ["Test configuration", "3 Star / Outskirts / LCC / Economy / breakfast / twin share", "The cheapest legitimate setup, matching a 'from' price"],
      ["Departure city", "cheapest of 10 Indian metros", "Published price says 'from any city in India'"],
      ["Month", "each destination's cheapest, by its own price index", "A 'from' price implies low season"],
      ["Package floor", "DISABLED", "Otherwise every package would trivially match itself"],
    ],
    widths: [24, 56, 72],
  },
  {
    name: "Per Package",
    header: [
      "Package", "Region", "Nights", "Places", "Published pp", "Generated pp", "Delta INR", "Delta %", "Verdict",
      "Cheapest from", ...allComponents.map((c) => `${c} pp`),
    ],
    rows: rows.map((r) => [
      r.pkg.name,
      regionName.get(r.pkg.regionId) ?? r.pkg.regionId,
      r.pkg.nights,
      r.pkg.placeIds.length,
      Math.round(r.published),
      Math.round(r.generated),
      Math.round(r.generated - r.published),
      Number(r.deltaPct.toFixed(1)),
      r.verdict,
      r.departureCity,
      ...allComponents.map((c) => Math.round(r.componentPerPerson[c] ?? 0)),
    ]),
    widths: [40, 20, 8, 8, 14, 14, 12, 10, 12, 14, ...allComponents.map(() => 14)],
  },
  {
    name: "By Region",
    header: ["Region", "Packages", "Median delta %", "Min %", "Max %", "Under", "Too high"],
    rows: [...new Set(rows.map((r) => r.pkg.regionId))].map((regionId) => {
      const group = rows.filter((r) => r.pkg.regionId === regionId);
      const d = group.map((r) => r.deltaPct).sort((a, b) => a - b);
      return [
        regionName.get(regionId) ?? regionId,
        group.length,
        Number(d[d.length >> 1].toFixed(1)),
        Number(d[0].toFixed(1)),
        Number(d[d.length - 1].toFixed(1)),
        group.filter((r) => r.verdict === "UNDER").length,
        group.filter((r) => r.verdict === "TOO HIGH").length,
      ];
    }),
    widths: [22, 12, 16, 12, 12, 10, 12],
  },
  {
    name: "Your Corrections",
    header: [
      "Scope", "Id", "Name", "What is wrong", "Correct price pp (fill in)", "Or component to fix", "Your factor",
    ],
    rows: rows
      .filter((r) => r.verdict !== "OK")
      .map((r) => [
        "package", r.pkg.id, r.pkg.name,
        r.verdict === "UNDER" ? "Generated below the published price" : `Generated ${pct(r.deltaPct)} above published`,
        null, "", null,
      ]),
    widths: [12, 34, 40, 40, 26, 26, 14],
  },
];

// Regenerating the workbook would wipe any corrections the agency has typed
// into it, so in --apply mode the existing file is read, never rewritten.
if (!apply) {
  writeWorkbook(REPORT, sheets);
  console.log(`\n  report  ${REPORT}`);
} else {
  console.log(`\n  reading corrections from ${REPORT}`);
}

// --- feedback loop --------------------------------------------------------
if (apply) {
  const { packageFactors, applied, skipped } = applyCorrections(rows);
  if (applied.length) {
    const existing = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8"));
    existing.package = { ...existing.package, ...packageFactors };
    existing._appliedAt = new Date().toISOString();
    writeFileSync(CALIBRATION_FILE, `${JSON.stringify(existing, null, 2)}\n`);
    console.log(`\n  Applied ${applied.length} correction(s) from the workbook:`);
    for (const a of applied) {
      console.log(
        `    ${a.name.slice(0, 40).padEnd(42)} target ${a.target ? inr(a.target) + " pp" : "(factor given)"}  ->  x${a.factor}`,
      );
    }
    console.log(`\n  Written to ${CALIBRATION_FILE}. Re-run \`npm run calibrate\` to verify.`);
  } else {
    console.log("\n  No corrections found in the workbook's 'Your Corrections' sheet.");
    console.log("  Fill in either 'Correct price pp' or 'Your factor', save, then re-run with --apply.");
  }
  for (const s of skipped) console.log(`    skipped: ${s}`);
} else if (write) {
  const fitted = fitFactors(rows);
  const existing = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8"));
  existing.region = { ...existing.region, ...fitted };
  existing._fittedAt = new Date().toISOString();
  writeFileSync(CALIBRATION_FILE, `${JSON.stringify(existing, null, 2)}\n`);
  console.log(`  fitted  ${Object.keys(fitted).length} region factor(s) written to ${CALIBRATION_FILE}`);
  console.log("          re-run `npm run calibrate` to see the effect.");
} else if (counts.UNDER || counts["TOO HIGH"]) {
  console.log("\n  Next steps:");
  console.log("    npm run calibrate -- --write   fit region factors automatically");
  console.log("    npm run calibrate -- --apply   apply your own numbers from the 'Your Corrections' sheet");
}
