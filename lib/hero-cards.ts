import { readFileSync } from "node:fs";
import path from "node:path";
import { HeroCardsFileSchema, type HeroCardRegion } from "@/content/schema";

// Server-only loader (reads content/hero-cards.json via node:fs) — import
// this from server components / route handlers only. Client components that
// need the HeroCard type or the random-pick helpers should import from
// @/lib/hero-card-picker instead, which has no fs/path dependency and is
// therefore safe to bundle into client JS.
const CONTENT_PATH = path.join(process.cwd(), "content", "hero-cards.json");

let cache: HeroCardRegion[] | null = null;

export function loadHeroCardRegions(): HeroCardRegion[] {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(CONTENT_PATH, "utf-8"));
  const result = HeroCardsFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid hero card content in content/hero-cards.json: ${result.error.message}`);
  }
  cache = result.data.regions;
  return cache;
}
