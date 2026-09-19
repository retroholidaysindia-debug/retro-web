/**
 * Destination-compatibility and nights-defaults rules.
 *
 * Real packages already prove which country combinations the agency actually
 * sells; this derives a general rule from that data plus geography, rather
 * than hand-listing every pair, so it stays correct as the catalogue grows.
 */
import type { Country, Package, Route } from "../../lib/atlas/schema";

// ---------------------------------------------------------------------------
// Country compatibility
// ---------------------------------------------------------------------------

/**
 * Which other countries a country can realistically be combined with in one
 * land package.
 *
 *  1. Same region — ordinary multi-country travel (Poland + Austria, Vietnam
 *     + Cambodia). This is deliberately permissive: within one broad
 *     geographic area, connectivity is normally good even where our own
 *     transport table happens not to have priced that exact pair yet (the
 *     pricing engine's regional-median fallback covers that gap).
 *  2. Cross-region, proven by a real published package (e.g. Kailash
 *     Mansarovar legitimately crosses south-asia -> east-asia).
 *  3. Cross-region, proven by a real authored transport route between the
 *     two countries.
 *
 * Anything else — an unrelated cross-region jump with no package or route
 * precedent (Iceland + Fiji, India + Iceland) — is not offered together.
 */
export function buildCountryCompatibility(
  countries: Country[],
  routes: Route[],
  packages: Package[],
): Record<string, string[]> {
  const adjacency = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };

  for (const a of countries) {
    for (const b of countries) {
      if (a.id !== b.id && a.regionId === b.regionId) add(a.id, b.id);
    }
  }
  for (const pkg of packages) {
    for (const a of pkg.countryIds) {
      for (const b of pkg.countryIds) add(a, b);
    }
  }
  for (const r of routes) {
    if (r.originCountryId && r.destCountryId) add(r.originCountryId, r.destCountryId);
  }

  const out: Record<string, string[]> = {};
  for (const [id, set] of adjacency) out[id] = [...set].sort();
  return out;
}

// ---------------------------------------------------------------------------
// Nights defaults
// ---------------------------------------------------------------------------

/**
 * Fills a place's min/ideal/max nights when its destination file did not
 * specify them (roughly half the catalogue), from how much there is to do
 * there, so every place — not just the ones with a detailed write-up — gets
 * a sane bound for the nights slider and the night allocator.
 */
export function defaultNightsFor(
  clusterCount: number,
  activityCount: number,
): { minNights: number; idealNights: number; maxNights: number } {
  const depth = clusterCount + activityCount / 3;
  const idealNights = Math.min(6, Math.max(1, Math.round(1 + Math.log2(1 + depth))));
  return { minNights: 1, idealNights, maxNights: Math.min(10, idealNights + 3) };
}
