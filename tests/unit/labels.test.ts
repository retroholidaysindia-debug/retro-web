import { describe, it, expect } from "vitest";
import { placeLabels } from "@/scripts/build-maps/labels";

describe("placeLabels", () => {
  it("assigns right side to a point left of centroid... and left side to a point right of centroid", () => {
    // Convention: label extends AWAY from center, so a marker on the map's
    // left gets its label further left (side: "left"), and vice versa.
    const points = [
      { x: 100, y: 200, name: "West City", type: "city" as const },
      { x: 500, y: 200, name: "East City", type: "city" as const },
    ];
    const [west, east] = placeLabels(points, 300);
    expect(west.side).toBe("left");
    expect(east.side).toBe("right");
  });

  it("keeps anchorX/anchorY equal to the original marker position", () => {
    const points = [{ x: 150, y: 250, name: "Anchor Test", type: "poi" as const }];
    const [label] = placeLabels(points, 300);
    expect(label.anchorX).toBe(150);
    expect(label.anchorY).toBe(250);
  });

  it("nudges a label vertically when it collides with another on the same side", () => {
    const points = [
      { x: 100, y: 200, name: "A", type: "city" as const },
      { x: 105, y: 202, name: "B", type: "city" as const }, // near-identical position
      // A third marker far right sets the median between the clusters, so A and
      // B share the left side and their labels genuinely collide.
      { x: 500, y: 400, name: "C", type: "city" as const },
    ];
    const placed = placeLabels(points, 300, 24);
    const a = placed.find((p) => p.name === "A")!;
    const b = placed.find((p) => p.name === "B")!;
    expect(a.side).toBe(b.side);
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(24);
  });

  it("does not nudge labels on opposite sides even if vertically close", () => {
    const points = [
      { x: 100, y: 200, name: "West", type: "city" as const },
      { x: 500, y: 202, name: "East", type: "city" as const },
    ];
    const placed = placeLabels(points, 300, 24);
    const west = placed.find((p) => p.name === "West")!;
    const east = placed.find((p) => p.name === "East")!;
    expect(west.y).toBe(200);
    expect(east.y).toBe(202);
  });

  it("processes points top-to-bottom so collision nudges cascade deterministically", () => {
    const points = [
      { x: 100, y: 300, name: "Bottom", type: "city" as const },
      { x: 100, y: 200, name: "Top", type: "city" as const },
      { x: 100, y: 210, name: "Middle", type: "city" as const },
    ];
    const placed = placeLabels(points, 300, 24);
    const byName = Object.fromEntries(placed.map((p) => [p.name, p.y]));
    // Top stays at 200; Middle collides with Top (10px apart) and nudges to >= 224;
    // Bottom must clear whatever Middle became nudged to.
    expect(byName.Top).toBe(200);
    expect(byName.Middle).toBeGreaterThanOrEqual(224);
    expect(byName.Bottom).toBeGreaterThanOrEqual(byName.Middle + 24);
  });
});
