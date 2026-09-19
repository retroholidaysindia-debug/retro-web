import type { Destination, Group } from "@/content/schema";

// A "package" is simply one of a destination's Groups — each already carries
// its own places[] (see content/schema.ts GroupSchema). This module exists so
// destination pages and the package detail page share one lookup helper
// rather than re-implementing the group search independently.
export function getPackagesForDestination(dest: Destination): Group[] {
  return dest.groups ?? [];
}

export function getPackage(dest: Destination, packageSlug: string): Group | undefined {
  return getPackagesForDestination(dest).find((p) => p.packageSlug === packageSlug);
}
