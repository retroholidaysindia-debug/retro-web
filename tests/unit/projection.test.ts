import { describe, it, expect } from "vitest";
import { selectProjection } from "@/scripts/build-maps/projection";

describe("selectProjection", () => {
  it("picks mercator for a compact mid-latitude bbox (Dubai)", () => {
    // UAE: roughly 51-56.5 lng, 22.5-26.5 lat
    expect(selectProjection([51, 22.5, 56.5, 26.5])).toBe("mercator");
  });

  it("picks conicConformal for a high-latitude bbox (Nordic)", () => {
    // Spans Norway to Iceland: centroid lat ~ (58+71)/2 = 64.5, well above 45
    expect(selectProjection([-24, 55, 31, 71])).toBe("conicConformal");
  });

  it("picks conicEqualArea for a wide low-latitude bbox (hypothetical wide equatorial region)", () => {
    // 40deg wide, centroid lat near equator
    expect(selectProjection([-10, -5, 30, 5])).toBe("conicEqualArea");
  });

  it("picks mercator for Kenya (compact, near-equatorial)", () => {
    expect(selectProjection([33.9, -4.7, 41.9, 5.5])).toBe("mercator");
  });

  it("high-latitude rule takes precedence over wide-bbox rule when both apply", () => {
    // Wide AND high-latitude: centroid lat 60, width 50deg
    expect(selectProjection([-10, 50, 40, 70])).toBe("conicConformal");
  });
});
