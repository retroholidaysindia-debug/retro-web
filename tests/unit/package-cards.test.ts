import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CoreBundle } from "@/lib/atlas/schema";
import type { PackageCard } from "@/lib/atlas/client";

const DIR = path.join("public", "atlas");
const core = CoreBundle.parse(JSON.parse(readFileSync(path.join(DIR, "core.json"), "utf8")));
const cards = JSON.parse(readFileSync(path.join(DIR, "package-cards.json"), "utf8")) as PackageCard[];

// Verifies scripts/build-package-cards.ts, exercised via its committed output
// (not re-run here — it needs the full ETL bundle already built) — this is
// the manifest the planner's auto-scrolling package rail fetches.
describe("package-cards manifest", () => {
  it("carries every published package", () => {
    expect(cards.length).toBe(core.packages.length);
  });

  it("cross-references a real price from core.json for every card", () => {
    const priceById = new Map(core.packages.map((p) => [p.id, p.priceFromInr]));
    for (const card of cards) {
      expect(card.priceFromInr).toBe(priceById.get(card.id));
      expect(card.priceFromInr).toBeGreaterThan(0);
    }
  });

  it("gives every card a cover image and a valid destination/package link", () => {
    for (const card of cards) {
      expect(card.coverImage.length).toBeGreaterThan(0);
      expect(card.destinationSlug.length).toBeGreaterThan(0);
      expect(card.slug.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate ids", () => {
    const ids = new Set(cards.map((c) => c.id));
    expect(ids.size).toBe(cards.length);
  });
});
