import { describe, expect, it } from "vitest";
import { layoutPins, pinHitRadius, MIN_PIN_GAP } from "@/lib/atlas/map-pins";

describe("region map pin layout", () => {
  it("pushes pins that share a pixel at least the minimum gap apart", () => {
    // Seychelles: La Digue Island and Vallée de Mai sit a few map units apart.
    const pins = layoutPins([
      { id: "la-digue", cx: 100, cy: 100 },
      { id: "vallee-de-mai", cx: 102, cy: 101 },
    ]);
    const gap = Math.hypot(pins[0].cx - pins[1].cx, pins[0].cy - pins[1].cy);
    expect(gap).toBeGreaterThanOrEqual(MIN_PIN_GAP - 0.01);
  });

  it("leaves a pin with room to breathe exactly where it belongs", () => {
    const pins = layoutPins([
      { id: "a", cx: 10, cy: 10 },
      { id: "b", cx: 500, cy: 400 },
    ]);
    expect(pins[0]).toMatchObject({ cx: 10, cy: 10 });
    expect(pins[1]).toMatchObject({ cx: 500, cy: 400 });
  });

  it("reports each pin's distance to its nearest neighbour", () => {
    const pins = layoutPins([
      { id: "a", cx: 0, cy: 0 },
      { id: "b", cx: 40, cy: 0 },
      { id: "c", cx: 300, cy: 0 },
    ]);
    expect(pins[0].nearest).toBeCloseTo(40);
    expect(pins[1].nearest).toBeCloseTo(40);
    expect(pins[2].nearest).toBeCloseTo(260);
  });

  it("gives a lone pin an infinite neighbour distance rather than crashing", () => {
    const [only] = layoutPins([{ id: "a", cx: 5, cy: 5 }]);
    expect(only.nearest).toBe(Infinity);
    // …which must still resolve to the full, finite hit radius.
    expect(pinHitRadius(15, only.nearest, 1)).toBe(15);
  });

  it("never relocates a pin far from the place it marks", () => {
    // The regression this guards: separation used to grow without limit as a
    // cluster got denser, so on India 48 of 54 pins drifted more than 20px
    // from their city and whole groups were pushed off the coastline into the
    // sea. A pin may be eased aside; it may not be moved somewhere else.
    const dense = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      cx: 100 + (i % 10) * 3,
      cy: 100 + Math.floor(i / 10) * 3,
    }));
    const placed = layoutPins(dense);
    for (const [i, p] of placed.entries()) {
      const drift = Math.hypot(p.cx - dense[i].cx, p.cy - dense[i].cy);
      expect(drift).toBeLessThanOrEqual(MIN_PIN_GAP + 0.001);
    }
  });

  it("leaves a well-spaced map completely untouched", () => {
    const spaced = [
      { id: "a", cx: 0, cy: 0 },
      { id: "b", cx: 90, cy: 40 },
      { id: "c", cx: 300, cy: 250 },
    ];
    for (const [i, p] of layoutPins(spaced).entries()) {
      expect(p.cx).toBe(spaced[i].cx);
      expect(p.cy).toBe(spaced[i].cy);
    }
  });
});

describe("region map hit targets", () => {
  const BASE = 15; // HIT_RADIUS in the picker

  it("never lets two neighbouring targets overlap", () => {
    // The exact bug: a flat radius of 15 makes 30-wide targets while crowded
    // pins sit MIN_PIN_GAP apart, so each target swallowed its neighbour's
    // clicks and the last-painted pin won.
    const pins = layoutPins([
      { id: "la-digue", cx: 100, cy: 100 },
      { id: "vallee-de-mai", cx: 102, cy: 101 },
    ]);
    for (const zoom of [1, 2, 3]) {
      const gap = Math.hypot(pins[0].cx - pins[1].cx, pins[0].cy - pins[1].cy);
      const a = pinHitRadius(BASE, pins[0].nearest, zoom);
      const b = pinHitRadius(BASE, pins[1].nearest, zoom);
      expect(a + b).toBeLessThanOrEqual(gap + 0.01);
    }
  });

  it("keeps the full target for a pin with space around it", () => {
    expect(pinHitRadius(BASE, Infinity, 1)).toBe(BASE);
    expect(pinHitRadius(BASE, 400, 1)).toBe(BASE);
  });

  it("shrinks with zoom so the target holds a constant size on screen", () => {
    // Pins counter-scale as the map stretches, so half the map-unit radius at
    // 2x is the same number of pixels as the full radius at 1x.
    expect(pinHitRadius(BASE, Infinity, 2)).toBeCloseTo(BASE / 2);
    expect(pinHitRadius(BASE, Infinity, 3)).toBeCloseTo(BASE / 3);
  });

  it("grows a crowded pin's target on screen as you zoom, which is the point of zooming", () => {
    const pins = layoutPins([
      { id: "a", cx: 100, cy: 100 },
      { id: "b", cx: 102, cy: 101 },
    ]);
    // Where the neighbour cap binds, the radius is fixed in map units — so the
    // target still grows in proportion to the zoom on screen, which is what
    // makes a tight cluster workable at 3x.
    const screenAt = (zoom: number) => pinHitRadius(BASE, pins[0].nearest, zoom) * zoom;
    expect(screenAt(2)).toBeGreaterThan(screenAt(1));
    expect(screenAt(3)).toBeGreaterThan(screenAt(2));
    expect(screenAt(3)).toBeCloseTo(screenAt(1) * 3);
  });

  it("never collapses a target to nothing, however crowded", () => {
    const pins = layoutPins(
      Array.from({ length: 8 }, (_, i) => ({ id: String(i), cx: 100 + i * 0.1, cy: 100 })),
    );
    for (const p of pins) {
      expect(pinHitRadius(BASE, p.nearest, 3)).toBeGreaterThan(0);
    }
  });
});
