import { describe, it, expect } from "vitest";
import { loadDestinations, loadDestination } from "@/lib/destinations";
import { DestinationSchema } from "@/content/schema";

describe("loadDestinations", () => {
  it("loads exactly the ten regions from the travel agency dataset", () => {
    const slugs = loadDestinations().map((d) => d.slug).sort();
    expect(slugs).toEqual([
      "africa", "east-asia", "eurasia-cis", "europe", "india",
      "middle-east", "oceania", "russia", "south-asia", "south-east-asia",
    ]);
  });

  it("every destination has at least one marker", () => {
    for (const d of loadDestinations()) {
      expect(d.map.markers.length).toBeGreaterThan(0);
    }
  });

  it("every destination has a group (country/state package) per its dataset entry", () => {
    for (const d of loadDestinations()) {
      expect(d.groups && d.groups.length).toBeGreaterThan(0);
    }
  });

  it("india covers the whole country and has a group for every one of its 27 states", () => {
    const india = loadDestination("india");
    expect(india?.map_area).toEqual({ type: "country", countries: ["IND"] });
    expect(india?.groups?.length).toBe(27);
  });

  it("russia spans exactly one country", () => {
    const russia = loadDestination("russia");
    expect(russia?.map.countries).toEqual(["RUS"]);
  });

  it("returns undefined for an unknown slug", () => {
    expect(loadDestination("atlantis")).toBeUndefined();
  });

  it("rejects content with an out-of-range latitude", () => {
    // Sanity check the schema itself is wired up, not just present.
    const bad = {
      slug: "x", name: "X", region: "X", tagline: "x",
      palette: { accent: "#ffffff", deep: "#000000" },
      media: { clip: "x", poster: "x" },
      map: { countries: ["XXX"], markers: [{ name: "x", lat: 999, lng: 0, type: "city" }] },
    };
    expect(DestinationSchema.safeParse(bad).success).toBe(false);
  });

  it("every destination has a rating between 0 and 5 and a non-empty headline", () => {
    for (const d of loadDestinations()) {
      expect(d.rating).toBeGreaterThanOrEqual(0);
      expect(d.rating).toBeLessThanOrEqual(5);
      expect(d.headline.length).toBeGreaterThan(0);
    }
  });
});
