/**
 * Reports what the transport graph still cannot answer.
 *
 *   npx tsx scripts/etl/transport-gaps.ts
 *
 * Everything listed here is a genuine hole: a leg the quotation engine would
 * have to guess at, or a place it cannot locate. Each row says whether the
 * engine has a fallback (so a quote still completes) or whether the agency
 * needs to supply the number.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CoreBundle, Route } from "../../lib/atlas/schema";
import { buildRouteLookup } from "../../lib/atlas/engine/itinerary";

const DATA = "public/atlas";
const core = JSON.parse(readFileSync(path.join(DATA, "core.json"), "utf8")) as CoreBundle;
const routes = (JSON.parse(readFileSync(path.join(DATA, "routes.json"), "utf8")) as { routes: Route[] }).routes;

const placeName = new Map(core.places.map((p) => [p.id, p.name]));
const countryName = new Map(core.countries.map((c) => [c.id, c.name]));
const countryOf = new Map(core.places.map((p) => [p.id, p.countryId]));

function heading(title: string) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

console.log("Transport coverage report");

// --- 1. options per leg -----------------------------------------------------
heading("1. Choice available per leg");
const hist = new Map<number, number>();
for (const r of routes) {
  const n = r.options.filter((o) => o.enabled && (o.priceLow != null || o.priceHigh != null)).length;
  hist.set(n, (hist.get(n) ?? 0) + 1);
}
for (const n of [...hist.keys()].sort((a, b) => a - b)) {
  const label = n === 0 ? "no priced mode" : `${n} priced mode(s)`;
  console.log(`  ${label.padEnd(18)} ${hist.get(n)} route(s)`);
}

// --- 2. durations -----------------------------------------------------------
heading("2. Journey times");
let supplied = 0;
let derived = 0;
let missing = 0;
for (const r of routes) {
  for (const o of r.options) {
    if (!o.enabled) continue;
    if (o.durationMinutes == null) missing++;
    else if (o.durationSource === "estimated") derived++;
    else supplied++;
  }
}
console.log(`  supplied by the agency : ${supplied}`);
console.log(`  derived from distance  : ${derived}`);
console.log(`  STILL MISSING          : ${missing}  (these fall back to a flat 4h assumption)`);

// --- 3. places we cannot locate --------------------------------------------
heading("3. Places with no coordinate");
const located = new Set<string>();
for (const r of routes) {
  for (const o of r.options) {
    if (o.distanceKm == null) continue;
    if (r.originPlaceId) located.add(r.originPlaceId);
    if (r.destPlaceId) located.add(r.destPlaceId);
  }
}
const unlocated = core.places.filter((p) => !located.has(p.id));
console.log(`  ${unlocated.length} place(s) never appear on a measured leg:`);
for (const p of unlocated.slice(0, 40)) {
  console.log(`    ${p.name} (${countryName.get(p.countryId) ?? p.countryId})`);
}
if (unlocated.length > 40) console.log(`    ... and ${unlocated.length - 40} more`);

// --- 4. country pairs with no route at all ---------------------------------
heading("4. Country pairs in the same region with no route");
const countryPairs = new Set<string>();
for (const r of routes) {
  if (r.originCountryId && r.destCountryId) {
    countryPairs.add(`${r.originCountryId}|${r.destCountryId}`);
    countryPairs.add(`${r.destCountryId}|${r.originCountryId}`);
  }
}
const byRegion = new Map<string, string[]>();
for (const c of core.countries) {
  const list = byRegion.get(c.regionId);
  if (list) list.push(c.id);
  else byRegion.set(c.regionId, [c.id]);
}
const missingPairs: [string, string, string][] = [];
for (const [regionId, ids] of byRegion) {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (!countryPairs.has(`${ids[i]}|${ids[j]}`)) {
        missingPairs.push([regionId, countryName.get(ids[i]) ?? ids[i], countryName.get(ids[j]) ?? ids[j]]);
      }
    }
  }
}
console.log(`  ${missingPairs.length} uncovered pair(s) — the engine falls back to a regional median fare:`);
const byRegionCount = new Map<string, number>();
for (const [r] of missingPairs) byRegionCount.set(r, (byRegionCount.get(r) ?? 0) + 1);
for (const [r, n] of [...byRegionCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${r.padEnd(22)} ${n}`);
}
for (const [, a, b] of missingPairs.slice(0, 25)) console.log(`      ${a} <-> ${b}`);
if (missingPairs.length > 25) console.log(`      ... and ${missingPairs.length - 25} more`);

// --- 5. legs the engine cannot answer at all -------------------------------
heading("5. Legs with no answer at any fallback tier");
const lookup = buildRouteLookup(routes, core.places, core.countries);
const dead: string[] = [];
for (const r of routes) {
  if (!r.originPlaceId || !r.destPlaceId) continue;
  if (!lookup.best(r.originPlaceId, r.destPlaceId)) {
    dead.push(`${placeName.get(r.originPlaceId) ?? r.originPlaceId} -> ${placeName.get(r.destPlaceId) ?? r.destPlaceId}`);
  }
}
console.log(`  ${dead.length} leg(s)`);
for (const d of dead.slice(0, 20)) console.log(`    ${d}`);

// --- 6. flat fare bands -----------------------------------------------------
heading("6. Fares that look like a flat placeholder");
const byMode = new Map<string, Map<number, number>>();
for (const r of routes) {
  for (const o of r.options) {
    if (!o.enabled || o.priceSource !== "workbook") continue;
    const p = o.priceLow != null && o.priceHigh != null ? (o.priceLow + o.priceHigh) / 2 : (o.priceLow ?? o.priceHigh);
    if (p == null) continue;
    if (!byMode.has(o.mode)) byMode.set(o.mode, new Map());
    const m = byMode.get(o.mode)!;
    m.set(p, (m.get(p) ?? 0) + 1);
  }
}
console.log("  A single fare repeated across hundreds of legs means distance is not priced in:");
for (const [mode, m] of [...byMode.entries()].sort()) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = ((top[1] / total) * 100).toFixed(0);
  console.log(
    `    ${mode.padEnd(16)} ${String(m.size).padStart(3)} distinct fare(s) over ${String(total).padStart(4)} leg(s); ` +
      `the single value INR${top[0]} covers ${share}%`,
  );
}

console.log("\nWhat the agency needs to supply, in priority order:");
console.log("  a) Real fares per leg (or a per-km rate per mode per region) — the flat");
console.log("     bands in section 6 are the largest remaining source of price error.");
console.log("  b) Routes for the country pairs in section 4, especially in Europe.");
console.log("  c) Anything in section 5, which currently cannot be quoted at all.");
