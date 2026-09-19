import { describe, it, expect } from "vitest";
import { buildMapSvg } from "@/scripts/build-maps/svg";

const fakeCountryPath = "M0,0L100,0L100,100L0,100Z";
const fakeHighlightPaths = ["M20,20L80,20L80,80L20,80Z"];

describe("buildMapSvg", () => {
  it("produces an SVG string with the given viewBox", () => {
    const svg = buildMapSvg({
      viewBox: [0, 0, 600, 600],
      countryPath: fakeCountryPath,
      highlightPaths: fakeHighlightPaths,
      accent: "#A8D5D0",
      markers: [
        { name: "Test City", cx: 50, cy: 50, type: "city", labelX: 20, labelY: 50, labelSide: "left" },
      ],
    });
    expect(svg).toContain('viewBox="0 0 600 600"');
  });

  it("includes the country coastline path", () => {
    const svg = buildMapSvg({
      viewBox: [0, 0, 600, 600],
      countryPath: fakeCountryPath,
      highlightPaths: [],
      accent: "#A8D5D0",
      markers: [],
    });
    expect(svg).toContain(fakeCountryPath);
  });

  it("renders one <circle> per marker with a data-marker-name attribute", () => {
    const svg = buildMapSvg({
      viewBox: [0, 0, 600, 600],
      countryPath: fakeCountryPath,
      highlightPaths: [],
      accent: "#A8D5D0",
      markers: [
        { name: "A", cx: 10, cy: 10, type: "city", labelX: 0, labelY: 10, labelSide: "left" },
        { name: "B", cx: 20, cy: 20, type: "poi", labelX: 40, labelY: 20, labelSide: "right" },
      ],
    });
    expect((svg.match(/<circle/g) || []).length).toBe(2);
    expect(svg).toContain('data-marker-name="A"');
    expect(svg).toContain('data-marker-name="B"');
  });

  it("stays under the 12KB budget for a realistic marker count", () => {
    const markers = Array.from({ length: 6 }, (_, i) => ({
      name: `Marker ${i}`,
      cx: i * 10,
      cy: i * 10,
      type: "poi" as const,
      labelX: i * 10 + 20,
      labelY: i * 10,
      labelSide: "right" as const,
    }));
    const svg = buildMapSvg({
      viewBox: [0, 0, 600, 600],
      countryPath: fakeCountryPath,
      highlightPaths: fakeHighlightPaths,
      accent: "#A8D5D0",
      markers,
    });
    expect(new TextEncoder().encode(svg).length).toBeLessThan(12 * 1024);
  });
});
