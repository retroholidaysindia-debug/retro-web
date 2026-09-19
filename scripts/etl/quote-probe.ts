/**
 * Ad-hoc diagnostic: price one package and show how the money splits, plus
 * every intercity leg with its mode, distance and fare.
 *
 * Not part of the build. `tsx scripts/etl/quote-probe.ts "Kerala"`.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { generateQuotation, STYLE_FOR_TRAVELLER } from "../../lib/atlas/engine";
import { QuoteRequest } from "../../lib/atlas/engine/types";
import type { CoreBundle, DestinationBundle, Route, VisaRule } from "../../lib/atlas/schema";

const OUT = path.join("public", "atlas");
const core = JSON.parse(readFileSync(path.join(OUT, "core.json"), "utf8")) as CoreBundle;
const routes = (JSON.parse(readFileSync(path.join(OUT, "routes.json"), "utf8")) as { routes: Route[] }).routes;
const visaRules = (JSON.parse(readFileSync(path.join(OUT, "visa.json"), "utf8")) as { rules: VisaRule[] }).rules;

function loadBundles(ids: string[]): Map<string, DestinationBundle> {
  const map = new Map<string, DestinationBundle>();
  for (const id of ids) {
    const file = path.join(OUT, "destinations", `${id}.json`);
    if (existsSync(file)) map.set(id, JSON.parse(readFileSync(file, "utf8")) as DestinationBundle);
  }
  return map;
}

const wanted = (process.argv[2] ?? "Kerala").toLowerCase();
const pkg = core.packages.find((p) => p.name.toLowerCase().includes(wanted));
if (!pkg) throw new Error(`no package matching "${wanted}"`);

const request = QuoteRequest.parse({
  placeIds: pkg.placeIds,
  nights: pkg.nights,
  startDate: "2026-11-05",
  adults: 2,
  childAges: [],
  travellerType: "couple",
  tripStyle: STYLE_FOR_TRAVELLER.couple,
  nationality: "IND",
  departureCity: "DEL",
  hotelStar: "3 Star",
  hotelZone: "Outskirts",
  carrier: "LCC",
  cabin: "Economy",
  mealPlan: "breakfast",
  food: "no-preference",
  pace: "balanced",
  includeVisa: true,
  includeInsurance: false,
  includeFlight: pkg.priceIncludesFlight,
});

const quote = generateQuotation(request, {
  core, routes, visaRules,
  bundles: loadBundles(request.placeIds),
  ignorePackageFloor: true,
});

const names = new Map(core.places.map((p) => [p.id, p.name]));

console.log(`${pkg.name} — ${pkg.nights} nights, ${request.placeIds.length} places`);
console.log(`  published  ${pkg.priceFromInr.toLocaleString("en-IN")}`);
console.log(`  generated  ${Math.round(quote.totals.perPerson).toLocaleString("en-IN")} per person\n`);

console.log("  order:", quote.stays.map((s) => `${s.placeName}(${s.nights}n)`).join(" -> "));

const byComponent = new Map<string, number>();
for (const item of quote.lineItems) {
  byComponent.set(item.component, (byComponent.get(item.component) ?? 0) + item.totalInr / quote.pax.total);
}
console.log("\n  per-person cost mix:");
for (const [component, value] of [...byComponent].sort((a, b) => b[1] - a[1])) {
  const share = (value / [...byComponent.values()].reduce((a, b) => a + b, 0)) * 100;
  console.log(`    ${component.padEnd(22)} ${Math.round(value).toLocaleString("en-IN").padStart(10)}  ${share.toFixed(1)}%`);
}

console.log("\n  intercity legs:");
for (const day of quote.days) {
  const t = day.transfer;
  if (!t || t.mode === "transfer") continue;
  const via = t.via.length ? ` via ${t.via.map((id) => names.get(id) ?? id).join(", ")}` : "";
  const km = t.distanceKm != null ? `${t.distanceKm}km` : "?km";
  console.log(
    `    ${t.from} -> ${t.to}${via}`.padEnd(54) +
      `${t.mode.padEnd(16)} ${km.padStart(8)} ${Math.round(t.priceInr).toLocaleString("en-IN").padStart(9)}` +
      `${t.estimated ? "  (est)" : ""}`,
  );
}

const traveller = quote.warnings.filter((w) => w.audience === "traveller");
if (traveller.length) {
  console.log("\n  traveller warnings:");
  for (const w of traveller) console.log(`    [${w.level}] ${w.message}`);
}

if (quote.planningNotes.length) {
  console.log(`\n  planner guidance (${quote.planningNotes.length} blocks):`);
  for (const note of quote.planningNotes.slice(0, 4)) {
    const who = note.audience ? ` [${note.audience}]` : "";
    console.log(`    ${note.placeName} — ${note.sectionTitle}${who}`);
  }
}

if (quote.appliedRules.length) {
  console.log(`\n  decision rules that fired (${quote.appliedRules.length}):`);
  for (const rule of quote.appliedRules.slice(0, 8)) {
    console.log(`    ${rule.placeName}: IF ${rule.conditions.join(" ")}`);
    console.log(`      -> ${rule.action.slice(0, 110)}${rule.applied ? "   [ACTED ON]" : ""}`);
  }
}

const internal = quote.warnings.filter((w) => w.audience === "internal" && /rule/.test(w.message));
if (internal.length) {
  console.log("\n  rule engine notes:");
  for (const w of internal) console.log(`    ${w.message}`);
}
