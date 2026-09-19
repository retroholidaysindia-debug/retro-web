/**
 * Regenerates `content/destinations/*.json` from the master catalogue.
 *
 * Those files drive the public destination and package pages and were authored
 * against an older shape of `travel_agency_dataset.json`. This keeps their
 * package data (names, places, durations, prices, highlights) in step with the
 * master while preserving the hand-authored presentation fields — palette,
 * media, taglines, map geometry and marker coordinates — which are not derived
 * from the dataset and must not be clobbered.
 *
 *   npm run sync-content            # report drift only
 *   npm run sync-content -- --write # apply
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DestinationSchema, type Destination, type Group } from "../../content/schema";
import { parseMaster } from "./parse-master";
import { Matcher, normalise } from "./normalise";

const CONTENT_DIR = path.join("content", "destinations");
const ALIASES = path.join("content", "place-aliases.json");
const PLACE_COUNTRIES = path.join("content", "place-countries.json");
const write = process.argv.includes("--write");

/** Region slug in the master -> destination file slug on the site. */
const REGION_TO_SLUG: Record<string, string> = {
  africa: "africa",
  "eurasia-cis": "eurasia-cis",
  russia: "russia",
  "south-asia": "south-asia",
  "east-asia": "east-asia",
  europe: "europe",
  "middle-east-and-gulf": "middle-east",
  oceania: "oceania",
  "south-east-asia": "south-east-asia",
  india: "india",
};

function titleCaseNights(nights: number, days: number): string {
  return `${nights} Night${nights === 1 ? "" : "s"}, ${days} Day${days === 1 ? "" : "s"}`;
}

function main() {
  const aliasOverrides: Record<string, string> = existsSync(ALIASES)
    ? JSON.parse(readFileSync(ALIASES, "utf8"))
    : {};
  const countryOverrides: Record<string, string> = existsSync(PLACE_COUNTRIES)
    ? JSON.parse(readFileSync(PLACE_COUNTRIES, "utf8"))
    : {};

  const geo = parseMaster("input_files/travel_agency_dataset.json", countryOverrides);
  const placeName = new Map(geo.places.map((p) => [p.id, p.name]));
  const placeMatcher = new Matcher(
    geo.places.map((p) => ({ name: p.name, value: p })),
    aliasOverrides,
  );

  const unmatchedMarkers: string[] = [];
  const renamedMarkers: string[] = [];

  const bySlug = new Map<string, typeof geo.packages>();
  for (const pkg of geo.packages) {
    const slug = REGION_TO_SLUG[pkg.regionId];
    if (!slug) continue;
    const list = bySlug.get(slug);
    if (list) list.push(pkg);
    else bySlug.set(slug, [pkg]);
  }

  let changed = 0;
  const notes: string[] = [];

  for (const file of readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".json"))) {
    const filePath = path.join(CONTENT_DIR, file);
    const existing = DestinationSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
    const packages = bySlug.get(existing.slug);
    if (!packages) {
      notes.push(`${existing.slug}: no packages in the master for this region`);
      continue;
    }

    // Match existing groups by package name so hand-authored presentation
    // fields survive; anything new in the master is appended.
    const previous = new Map<string, Group>(
      (existing.groups ?? []).map((g) => [normalise(g.packageName), g]),
    );

    const groups: Group[] = packages.map((pkg, i) => {
      const prior = previous.get(normalise(pkg.name));
      const places = pkg.placeIds.map((id) => placeName.get(id) ?? id);
      // Indian packages are labelled by state ("Kerala"); everything else by
      // the countries it covers, falling back to the package's own name.
      const stateName = pkg.stateIds.length
        ? geo.states.find((s) => s.id === pkg.stateIds[0])?.name
        : undefined;
      const countryNames = pkg.countryIds
        .map((id) => geo.countries.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      const label =
        stateName ?? (countryNames.length === 1 ? countryNames[0] : undefined) ?? pkg.name;
      return {
        id: prior?.id ?? i + 1,
        name: prior?.name ?? label,
        packageName: pkg.name,
        packageSlug: pkg.slug,
        places,
        tagline: `${titleCaseNights(pkg.nights, pkg.days)} · ${places.join(", ")}`,
        offer: {
          days: pkg.days,
          price_from_usd: pkg.priceFromInr,
          price_includes_flight: pkg.priceIncludesFlight,
          summary: pkg.description,
          highlights: pkg.highlights,
        },
      };
    });

    // Markers reference groups by id; drop references that no longer resolve.
    const validIds = new Set(groups.map((g) => g.id));
    // Marker names are hand-authored against an older catalogue, so reconcile
    // them through the alias table and report any that no longer name a place.
    const markers = existing.map.markers.map((m) => {
      const hit = placeMatcher.match(m.name);
      if (!hit) unmatchedMarkers.push(`${existing.slug}: ${m.name}`);
      const name = hit ? hit.value.name : m.name;
      if (hit && name !== m.name) renamedMarkers.push(`${existing.slug}: ${m.name} -> ${name}`);
      return {
        ...m,
        name,
        group: m.group != null && !validIds.has(m.group) ? undefined : m.group,
      };
    });

    const next: Destination = { ...existing, groups, map: { ...existing.map, markers } };
    DestinationSchema.parse(next);

    const before = JSON.stringify(existing);
    const after = JSON.stringify(next);
    if (before === after) continue;

    changed++;
    const addedNames = groups
      .filter((g) => !previous.has(normalise(g.packageName)))
      .map((g) => g.packageName);
    const removedNames = [...previous.values()]
      .filter((g) => !groups.some((n) => normalise(n.packageName) === normalise(g.packageName)))
      .map((g) => g.packageName);

    notes.push(
      `${existing.slug}: ${groups.length} package(s)` +
        (addedNames.length ? `, added ${addedNames.join(", ")}` : "") +
        (removedNames.length ? `, removed ${removedNames.join(", ")}` : ""),
    );

    if (write) writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  }

  console.log(write ? "Synced content from the master catalogue" : "Drift against the master catalogue");
  for (const n of notes) console.log(`  ${n}`);
  console.log(`  ${changed} file(s) ${write ? "updated" : "would change"}`);

  if (renamedMarkers.length) {
    console.log(`\n  ${renamedMarkers.length} map marker(s) renamed to the master's spelling:`);
    for (const m of renamedMarkers) console.log(`    ${m}`);
  }
  if (unmatchedMarkers.length) {
    console.log(`\n  ${unmatchedMarkers.length} map marker(s) name no place in the catalogue:`);
    for (const m of unmatchedMarkers) console.log(`    ${m}`);
    console.log("    They stay on the map but cannot be selected in the planner.");
  }

  if (!write && changed) console.log("\n  Re-run with --write to apply.");
}

main();
