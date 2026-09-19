import { describe, it, expect } from "vitest";
import type { FeatureCollection } from "geojson";
import {
  loadCountryFeature,
  unionCountries,
  filterAdmin1,
  bboxOf,
  expandBboxForMarkers,
} from "@/scripts/build-maps/geometry";

const countries: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { ADM0_A3: "NOR" },
      geometry: { type: "Polygon", coordinates: [[[4, 58], [4, 71], [31, 71], [31, 58], [4, 58]]] },
    },
    {
      type: "Feature",
      properties: { ADM0_A3: "SWE" },
      geometry: { type: "Polygon", coordinates: [[[11, 55], [11, 69], [24, 69], [24, 55], [11, 55]]] },
    },
    {
      type: "Feature",
      properties: { ADM0_A3: "ARE" },
      geometry: { type: "Polygon", coordinates: [[[51, 22.5], [51, 26.5], [56.5, 26.5], [56.5, 22.5], [51, 22.5]]] },
    },
    {
      type: "Feature",
      properties: { ADM0_A3: "IDN" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[95, -5], [95, 5], [105, 5], [105, -5], [95, -5]]],
          [[[120, -8], [120, -2], [130, -2], [130, -8], [120, -8]]],
        ],
      },
    },
  ],
};

const admin1: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { adm0_a3: "IND", name: "Jammu and Kashmir" },
      geometry: { type: "Polygon", coordinates: [[[74, 32], [74, 36], [77, 36], [77, 32], [74, 32]]] },
    },
    {
      type: "Feature",
      properties: { adm0_a3: "IND", name: "Ladakh" },
      geometry: { type: "Polygon", coordinates: [[[76, 32], [76, 36], [80, 36], [80, 32], [76, 32]]] },
    },
    {
      type: "Feature",
      properties: { adm0_a3: "IND", name: "Punjab" },
      geometry: { type: "Polygon", coordinates: [[[74, 29], [74, 32], [77, 32], [77, 29], [74, 29]]] },
    },
  ],
};

describe("loadCountryFeature", () => {
  it("finds a country by ISO alpha-3 code", () => {
    const feature = loadCountryFeature(countries, "ARE");
    expect(feature?.properties?.ADM0_A3).toBe("ARE");
  });

  it("returns undefined for an unknown code", () => {
    expect(loadCountryFeature(countries, "ZZZ")).toBeUndefined();
  });
});

describe("unionCountries", () => {
  it("combines multiple countries into one multi-geometry feature", () => {
    const union = unionCountries(countries, ["NOR", "SWE"]);
    expect(union.geometry.type).toBe("MultiPolygon");
    expect((union.geometry as GeoJSON.MultiPolygon).coordinates).toHaveLength(2);
  });

  it("throws when a requested country code is missing", () => {
    expect(() => unionCountries(countries, ["NOR", "ZZZ"])).toThrow(/ZZZ/);
  });

  it("correctly flattens MultiPolygon geometry into the union", () => {
    const union = unionCountries(countries, ["NOR", "IDN"]);
    expect(union.geometry.type).toBe("MultiPolygon");
    // NOR contributes 1 polygon ring, IDN (MultiPolygon) contributes 2 polygon rings
    expect((union.geometry as GeoJSON.MultiPolygon).coordinates).toHaveLength(3);
    // Verify that all rings from IDN are present in the result
    const coordinates = (union.geometry as GeoJSON.MultiPolygon).coordinates;
    expect(coordinates.some((ring) => ring[0][0][0] === 95)).toBe(true); // First IDN ring
    expect(coordinates.some((ring) => ring[0][0][0] === 120)).toBe(true); // Second IDN ring
  });
});

describe("filterAdmin1", () => {
  it("returns only the named regions for the given country", () => {
    const result = filterAdmin1(admin1, "IND", ["Jammu and Kashmir", "Ladakh"]);
    expect(result.map((f) => f.properties?.name).sort()).toEqual([
      "Jammu and Kashmir",
      "Ladakh",
    ]);
  });

  it("excludes regions from the same country not requested", () => {
    const result = filterAdmin1(admin1, "IND", ["Jammu and Kashmir"]);
    expect(result.map((f) => f.properties?.name)).not.toContain("Punjab");
  });
});

describe("bboxOf", () => {
  it("computes the bounding box of a single feature", () => {
    const are = loadCountryFeature(countries, "ARE")!;
    const box = bboxOf(are);
    expect(box[0]).toBeCloseTo(51, 1);
    expect(box[1]).toBeCloseTo(22.5, 1);
    expect(box[2]).toBeCloseTo(56.5, 1);
    expect(box[3]).toBeCloseTo(26.5, 1);
  });

  it("computes the union bbox across a multi-country FeatureCollection", () => {
    const box = bboxOf(countries);
    expect(box[0]).toBeCloseTo(4, 1);   // min lng across all
    expect(box[2]).toBeCloseTo(130, 1); // max lng across all (IDN extends to 130)
  });
});

describe("expandBboxForMarkers", () => {
  it("grows the bbox to include an offshore marker outside it", () => {
    const base: [number, number, number, number] = [51, 22.5, 56.5, 26.5];
    const expanded = expandBboxForMarkers(base, [{ lat: 20, lng: 60 }]);
    expect(expanded[2]).toBeGreaterThanOrEqual(60);
    expect(expanded[1]).toBeLessThanOrEqual(20);
  });

  it("leaves the bbox unchanged when all markers are already inside it", () => {
    const base: [number, number, number, number] = [51, 22.5, 56.5, 26.5];
    const result = expandBboxForMarkers(base, [{ lat: 25.2, lng: 55.3 }]);
    expect(result).toEqual(base);
  });
});
