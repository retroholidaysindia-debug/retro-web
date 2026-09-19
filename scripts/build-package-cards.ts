/**
 * Generates `public/atlas/package-cards.json` — a static, client-fetchable
 * manifest of every sellable package with its cover image, for the planner's
 * "browse all packages" rail.
 *
 * The `/plan` flow runs entirely client-side against `public/atlas/*.json`
 * (see `lib/atlas/client.ts`), but package cover images live in
 * `content/destinations/*.json` + `content/package-images.json`, both of
 * which are only ever read server-side (`lib/destinations.ts`,
 * `lib/package-images.ts`, both use `node:fs`). Rather than duplicate that
 * lookup logic in a browser-safe form, this script runs it once at build
 * time — the same way `scripts/etl/build.ts` compiles the quotation engine's
 * own bundles — and writes the result as plain, fetchable JSON.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadDestinations } from "../lib/destinations";
import { getPackageImages } from "../lib/package-images";
import type { PackageCard } from "../lib/atlas/client";

const OUT_FILE = path.join(process.cwd(), "public", "atlas", "package-cards.json");

function main() {
  // Every package slug is unique across the whole catalogue (verified: 75
  // packages, 75 distinct slugs), so joining against core.json's own
  // regionId/id/price by slug is exact — no need to reconstruct the ETL's
  // id-slugify scheme (`${regionId}-${name}`) independently and risk it
  // drifting out of sync with scripts/etl/parse-master.ts.
  const corePath = path.join(process.cwd(), "public", "atlas", "core.json");
  const core = JSON.parse(readFileSync(corePath, "utf8")) as {
    packages: { id: string; slug: string; regionId: string; priceFromInr: number; priceIncludesFlight: boolean }[];
  };
  const bySlug = new Map(core.packages.map((p) => [p.slug, p]));

  const cards: PackageCard[] = [];
  const unmatched: string[] = [];

  for (const dest of loadDestinations()) {
    for (const group of dest.groups ?? []) {
      const match = bySlug.get(group.packageSlug);
      if (!match) {
        unmatched.push(`${dest.slug}/${group.packageSlug}`);
        continue;
      }
      const images = getPackageImages(dest.slug, group.packageSlug);
      cards.push({
        id: match.id,
        name: group.packageName,
        slug: group.packageSlug,
        destinationSlug: dest.slug,
        regionId: match.regionId,
        nights: group.offer?.days ? Math.max(0, group.offer.days - 1) : 0,
        days: group.offer?.days ?? 0,
        priceFromInr: match.priceFromInr,
        priceIncludesFlight: match.priceIncludesFlight,
        tagline: group.tagline ?? null,
        coverImage: images[0] ?? `/media/${dest.media.poster}/poster.webp`,
      });
    }
  }

  if (unmatched.length) {
    console.warn(`  package-cards: ${unmatched.length} group(s) had no matching core package: ${unmatched.join(", ")}`);
  }

  writeFileSync(OUT_FILE, JSON.stringify(cards));
  const kb = (Buffer.byteLength(JSON.stringify(cards), "utf-8") / 1024).toFixed(1);
  console.log(`package-cards.json: ${cards.length} packages, ${kb} KB`);
}

main();
