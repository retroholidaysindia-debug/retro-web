/**
 * Ad-hoc diagnostic: how well did the section 33 rule parser do, and how many
 * rules can the engine actually decide?
 *
 * `tsx scripts/etl/rule-coverage.ts`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { evaluateRule, type RuleFacts } from "../../lib/atlas/engine/rules";
import type { DestinationBundle } from "../../lib/atlas/schema";

const dir = path.join("public", "atlas", "destinations");

let places = 0;
let rules = 0;
let withEffects = 0;
const variables = new Map<string, number>();
const undecidedVars = new Map<string, number>();

const bundles: DestinationBundle[] = [];
for (const file of readdirSync(dir)) {
  const bundle = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as DestinationBundle;
  bundles.push(bundle);
  if (!bundle.decisionRules.length) continue;
  places++;
  for (const rule of bundle.decisionRules) {
    rules++;
    if (rule.effects.length) withEffects++;
    for (const c of rule.conditions) variables.set(c.variable, (variables.get(c.variable) ?? 0) + 1);
  }
}

console.log(`places with rules: ${places}   rules parsed: ${rules}   with executable effect: ${withEffects}`);

console.log("\ncondition variables seen:");
for (const [v, c] of [...variables].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(String(c).padStart(5), v);
}

// Evaluate every rule against a spread of representative trips.
const trips: { label: string; facts: RuleFacts }[] = [
  {
    label: "family, 3 nights, child 6, July",
    facts: {
      nights: 3, travellerType: "family", tripStyle: "family", childAges: [6],
      month: 7, monthWeather: 45, interests: [], firstTimeVisitor: true,
    },
  },
  {
    label: "honeymoon couple, 6 nights, February",
    facts: {
      nights: 6, travellerType: "couple", tripStyle: "honeymoon", childAges: [],
      month: 2, monthWeather: 90, interests: [], firstTimeVisitor: true,
    },
  },
  {
    label: "luxury, 8 nights, November",
    facts: {
      nights: 8, travellerType: "business", tripStyle: "luxury", childAges: [],
      month: 11, monthWeather: 85, interests: [], firstTimeVisitor: true,
    },
  },
  {
    label: "senior pilgrimage, 10 nights, January",
    facts: {
      nights: 10, travellerType: "pilgrimage", tripStyle: "pilgrimage", childAges: [],
      month: 1, monthWeather: 80, interests: [], firstTimeVisitor: true,
    },
  },
  {
    label: "culture couple, 7 nights, with interests stated",
    facts: {
      nights: 7, travellerType: "couple", tripStyle: "culture", childAges: [],
      month: 3, monthWeather: 82,
      interests: ["PHOTOGRAPHY", "FOOD", "HISTORY", "NATURE", "SHOPPING", "ARCHITECTURE"],
      firstTimeVisitor: true,
    },
  },
];

for (const trip of trips) {
  let fired = 0;
  let skipped = 0;
  let notApplicable = 0;
  for (const bundle of bundles) {
    for (const rule of bundle.decisionRules) {
      const r = evaluateRule(rule, trip.facts);
      if (r.status === "fired") fired++;
      else if (r.status === "skipped") {
        skipped++;
        for (const u of r.undecided) {
          const v = u.split(" ")[0];
          undecidedVars.set(v, (undecidedVars.get(v) ?? 0) + 1);
        }
      } else notApplicable++;
    }
  }
  const pct = (n: number) => `${((n / rules) * 100).toFixed(1)}%`;
  console.log(
    `\n${trip.label}\n  fired ${fired} (${pct(fired)})   ` +
      `not applicable ${notApplicable} (${pct(notApplicable)})   ` +
      `undecidable ${skipped} (${pct(skipped)})`,
  );
}

console.log("\nmost common undecidable variables:");
for (const [v, c] of [...undecidedVars].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(String(c).padStart(6), v);
}

// Show a worked example.
const agra = bundles.find((b) => b.place.id === "agra");
if (agra?.decisionRules.length) {
  console.log("\n--- Agra, first 3 parsed rules ---");
  for (const rule of agra.decisionRules.slice(0, 3)) {
    const conds = rule.conditions
      .map((c) => `${c.joiner ? c.joiner + " " : ""}${c.variable} ${c.operator} ${c.value}`)
      .join("  ");
    console.log(`  IF ${conds}`);
    console.log(`  THEN ${rule.action.slice(0, 90)}`);
    if (rule.effects.length) {
      console.log(`  EFFECT ${rule.effects.map((e) => `${e.kind}: ${e.tokens.join(" | ")}`).join("; ")}`);
    }
    console.log();
  }
}
