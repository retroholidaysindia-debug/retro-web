/**
 * Ad-hoc diagnostic: how well does the route lookup cover real place pairs?
 * Not part of the build — run with tsx to compare tiers before/after a change.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRouteLookup } from "../../lib/atlas/engine/itinerary";
import type { CoreBundle, Route } from "../../lib/atlas/schema";

const core = JSON.parse(readFileSync(path.join("public", "atlas", "core.json"), "utf8")) as CoreBundle;
const routes = (JSON.parse(readFileSync(path.join("public", "atlas", "routes.json"), "utf8")) as { routes: Route[] }).routes;

const lookup = buildRouteLookup(routes, core.places, core.countries);

// Sample pairs within the same region, which is what a real trip looks like.
const countryRegion = new Map(core.countries.map((c) => [c.id, c.regionId]));
const byRegion = new Map<string, string[]>();
for (const p of core.places) {
  const region = countryRegion.get(p.countryId);
  if (!region) continue;
  const list = byRegion.get(region);
  if (list) list.push(p.id);
  else byRegion.set(region, [p.id]);
}

let total = 0;
let none = 0;
let single = 0;
let multi = 0;
let composed = 0;
const priced: number[] = [];
const distances: { km: number; inr: number }[] = [];

for (const [, ids] of byRegion) {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      total++;
      const options = lookup.options(ids[i], ids[j]);
      if (!options.length) {
        none++;
        continue;
      }
      if (options.length === 1) single++;
      else multi++;
      if (options.some((o) => o.via?.length)) composed++;
      priced.push(options[0].priceInr);
      const km = lookup.distanceKm(ids[i], ids[j]);
      if (km != null) distances.push({ km, inr: options[0].priceInr });
    }
  }
}

const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`same-region place pairs sampled: ${total}`);
console.log(`  no option at all          ${none} (${pct(none)})`);
console.log(`  exactly one option        ${single} (${pct(single)})`);
console.log(`  a real choice of modes    ${multi} (${pct(multi)})`);
console.log(`  used a composed multi-hop ${composed} (${pct(composed)})`);

priced.sort((a, b) => a - b);
console.log(
  `  best-option fare  p10 ${Math.round(priced[Math.floor(priced.length * 0.1)])}` +
    `  median ${Math.round(priced[priced.length >> 1])}` +
    `  p90 ${Math.round(priced[Math.floor(priced.length * 0.9)])}`,
);

// Does price actually track distance now?
const near = distances.filter((d) => d.km < 300).map((d) => d.inr).sort((a, b) => a - b);
const far = distances.filter((d) => d.km > 2000).map((d) => d.inr).sort((a, b) => a - b);
if (near.length && far.length) {
  console.log(
    `  median fare <300km  ${Math.round(near[near.length >> 1])} (n=${near.length})\n` +
      `  median fare >2000km ${Math.round(far[far.length >> 1])} (n=${far.length})`,
  );
}
