// ---------------------------------------------------------------------------
// Small shared helpers used across the destinations map/marker UI. Trip and
// package detail content itself now lives in lib/packages.ts (see
// getPackage/getPackagesForDestination) — every marker on every current
// destination map belongs to a group/package, so per-place fallback content
// generation was removed along with the old /destinations/[slug]/[place]
// route it existed for.
// ---------------------------------------------------------------------------

export function placeSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatPrice(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}
