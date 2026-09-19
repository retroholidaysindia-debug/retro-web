import { describe, it, expect } from "vitest";
import { loadDestinations, loadDestination } from "@/lib/destinations";
import { getPackagesForDestination, getPackage } from "@/lib/packages";

describe("packages", () => {
  it("every destination's packages equal its groups, each with a unique packageSlug", () => {
    for (const dest of loadDestinations()) {
      const packages = getPackagesForDestination(dest);
      expect(packages).toEqual(dest.groups ?? []);
      const slugs = packages.map((p) => p.packageSlug);
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  it("resolves Europe's 'Germany' cluster to the 'Europe at a Glance' package (the exact example from the spec)", () => {
    const europe = loadDestination("europe");
    expect(europe).toBeDefined();
    const withGermany = getPackagesForDestination(europe!).find((p) => p.places.includes("Germany"));
    expect(withGermany?.packageName).toBe("Europe at a Glance");
    expect(withGermany?.packageSlug).toBe("europe-at-a-glance");
    expect(withGermany?.places).toEqual(
      expect.arrayContaining(["Germany", "Austria", "Netherlands", "Linchestine"])
    );
  });

  it("getPackage looks up a single package by slug, returning undefined for an unknown slug", () => {
    const europe = loadDestination("europe");
    expect(getPackage(europe!, "europe-at-a-glance")?.packageName).toBe("Europe at a Glance");
    expect(getPackage(europe!, "not-a-real-package")).toBeUndefined();
  });
});
