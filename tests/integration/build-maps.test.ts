import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const CONTENT_DIR = path.join("content", "destinations");
const MAPS_DIR = path.join("public", "maps");

/**
 * Driven off the destination catalogue rather than a hardcoded list, so the
 * test follows the dataset instead of going stale when packages are re-grouped.
 */
const SLUGS = readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

/** Keeps map SVGs small enough to inline over the wire. */
const SIZE_BUDGET_BYTES = 32 * 1024;

describe("build-maps orchestrator (integration, uses vendored Natural Earth data)", () => {
  beforeAll(() => {
    execSync("npx tsx scripts/build-maps/index.ts", { stdio: "inherit" });
  }, 120_000);

  it("builds a map for every destination in the catalogue", () => {
    expect(SLUGS.length).toBeGreaterThan(0);
  });

  it.each(SLUGS)("generates an SVG for %s", (slug) => {
    expect(existsSync(path.join(MAPS_DIR, `${slug}.svg`))).toBe(true);
  });

  it.each(SLUGS)("%s.svg stays within the size budget", (slug) => {
    const svg = readFileSync(path.join(MAPS_DIR, `${slug}.svg`), "utf-8");
    expect(Buffer.byteLength(svg, "utf-8")).toBeLessThan(SIZE_BUDGET_BYTES);
  });

  it("renders admin1 highlights wherever a destination asks for them", () => {
    const highlighted = SLUGS.filter((slug) => {
      const content = JSON.parse(readFileSync(path.join(CONTENT_DIR, `${slug}.json`), "utf-8"));
      return (
        content.map_area?.type === "state" || (content.map?.highlight?.admin1?.length ?? 0) > 0
      );
    });

    // No destination currently highlights states; the assertion is written to
    // start working the moment one does, rather than to fail meanwhile.
    for (const slug of highlighted) {
      const svg = readFileSync(path.join(MAPS_DIR, `${slug}.svg`), "utf-8");
      expect((svg.match(/fill-opacity="0.18"/g) ?? []).length).toBeGreaterThanOrEqual(1);
    }
    expect(highlighted.length).toBeGreaterThanOrEqual(0);
  });

  it.each(SLUGS)("%s.markers.json has one entry per content marker", (slug) => {
    const content = JSON.parse(readFileSync(path.join(CONTENT_DIR, `${slug}.json`), "utf-8"));
    const markers = JSON.parse(readFileSync(path.join(MAPS_DIR, `${slug}.markers.json`), "utf-8"));
    expect(markers.markers).toHaveLength(content.map.markers.length);
  });

  it.each(SLUGS)("%s places every marker inside its viewBox", (slug) => {
    const { viewBox, markers } = JSON.parse(
      readFileSync(path.join(MAPS_DIR, `${slug}.markers.json`), "utf-8"),
    ) as { viewBox: [number, number, number, number]; markers: { cx: number; cy: number }[] };
    const [minX, minY, width, height] = viewBox;
    for (const marker of markers) {
      expect(marker.cx).toBeGreaterThanOrEqual(minX);
      expect(marker.cx).toBeLessThanOrEqual(minX + width);
      expect(marker.cy).toBeGreaterThanOrEqual(minY);
      expect(marker.cy).toBeLessThanOrEqual(minY + height);
    }
  });

  it("gives a multi-country region more path data than a smaller one", () => {
    const europe = readFileSync(path.join(MAPS_DIR, "europe.svg"), "utf-8");
    const oceania = readFileSync(path.join(MAPS_DIR, "oceania.svg"), "utf-8");
    expect(europe.length).toBeGreaterThan(oceania.length);
  });

  it("keeps every country's own landmass in a multi-country region map, however small", () => {
    // Regression test for a real bug: unioning several countries into one
    // feature *before* simplifying let mapshaper's "keep-shapes" guard —
    // which only protects whole features, not individual polygons inside one
    // — miss that a tiny country's entire polygon had fallen under the
    // retention threshold. Mauritius and the Seychelles were both silently
    // dropped from Africa's coastline (5 countries listed, only 3 rendered)
    // while Egypt, Kenya and South Africa still looked fine, so it was never
    // obviously broken. Every polygon is now simplified as its own feature,
    // so no landmass can be swallowed by its neighbours' point budget.
    const africaContent = JSON.parse(
      readFileSync(path.join(CONTENT_DIR, "africa.json"), "utf-8"),
    );
    const countries: string[] = africaContent.map_area?.countries ?? africaContent.map.countries;
    expect(countries.length).toBeGreaterThanOrEqual(5); // still the same 5-country region

    const svg = readFileSync(path.join(MAPS_DIR, "africa.svg"), "utf-8");
    const coastline = svg.match(/<path\s+d="([^"]+)"[^>]*data-role="coastline"/)?.[1];
    expect(coastline).toBeTruthy();

    // Each disjoint landmass is its own "M...Z" subpath. At least one per
    // country — more is fine and expected, since protecting every polygon
    // also preserves genuine offshore islands the old code discarded.
    const subpaths = coastline!.split("Z").filter((s) => s.trim());
    expect(subpaths.length).toBeGreaterThanOrEqual(countries.length);
  });

  it("draws India's own outline in enough detail to hold its markers", () => {
    // India was simplified to 1.5%, crushing an 875-point outline down to a
    // fifteen-sided blob: the Kashmir salient vanished, so the whole northern
    // marker cluster floated in the sea above a country that no longer looked
    // like India.
    const svg = readFileSync(path.join(MAPS_DIR, "india.svg"), "utf-8");
    const coastline = svg.match(/<path\s+d="([^"]+)"[^>]*data-role="coastline"/)?.[1];
    expect(coastline).toBeTruthy();

    const subpaths = coastline!.split("Z").filter((s) => s.trim());
    const points = (s: string) =>
      [...s.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);

    // The mainland alone needs far more than a blob's worth of detail.
    const mainland = points(subpaths[0]);
    expect(mainland.length).toBeGreaterThan(80);

    // …and the offshore territories we sell must be drawn, not omitted.
    expect(subpaths.length).toBeGreaterThan(1);
  });

  it("leaves no Indian marker stranded in open ocean", () => {
    // The user-facing property: a pin must sit on land, or at worst a pixel or
    // two off a simplified coastline — never adrift in blank sea, which is
    // where Lakshadweep's and the Andamans' pins used to sit.
    const svg = readFileSync(path.join(MAPS_DIR, "india.svg"), "utf-8");
    const coastline = svg.match(/<path\s+d="([^"]+)"[^>]*data-role="coastline"/)![1];
    const polys = coastline
      .split("Z")
      .filter((s) => s.trim())
      .map((s) => [...s.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]));

    const inside = (pt: [number, number], ring: [number, number][]) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };

    const { markers } = JSON.parse(
      readFileSync(path.join(MAPS_DIR, "india.markers.json"), "utf-8"),
    ) as { markers: { name: string; cx: number; cy: number }[] };

    const OFFSHORE_TOLERANCE_PX = 6;
    const adrift = markers.filter((m) => {
      const pt: [number, number] = [m.cx, m.cy];
      if (polys.some((p) => inside(pt, p))) return false;
      let nearest = Infinity;
      for (const p of polys) {
        for (const [x, y] of p) nearest = Math.min(nearest, Math.hypot(x - m.cx, y - m.cy));
      }
      return nearest > OFFSHORE_TOLERANCE_PX;
    });
    expect(adrift.map((m) => m.name)).toEqual([]);
  });
});
