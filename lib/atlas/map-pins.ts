/**
 * Pin layout for the region maps.
 *
 * Kept out of the picker component because it is pure geometry that has
 * already produced one user-visible bug — clicking one Seychelles island
 * selected its neighbour — and is far easier to reason about, and to hold to
 * a regression test, on its own.
 */

/**
 * How far apart, in map units, two pins are pulled when they would otherwise
 * sit on top of each other.
 *
 * Kept deliberately small. This used to be 15, which was fine on a sparse
 * island map but wrecked a dense one: on India 48 of 54 pins ended up more
 * than 20px from the city they mark, Mumbai rendered 81px from Mumbai, and
 * whole clusters were shoved off the coastline into the sea. A map that
 * misplaces a city to make it easier to click has stopped being a map.
 *
 * Separation is no longer what keeps crowded pins clickable — `pinHitRadius`
 * caps each hit target at half the distance to its nearest neighbour, so
 * targets never overlap however close the pins are, and zooming grows the gap
 * on screen. This nudge now only rescues pins so nearly coincident that the
 * one underneath could not be seen at all.
 */
export const MIN_PIN_GAP = 5;

export type PinInput = { cx: number; cy: number };
export type PlacedPin<T> = T & {
  /** Final drawn position, after nudging away from any neighbour. */
  cx: number;
  cy: number;
  /** Distance to the closest other pin, in map units. */
  nearest: number;
};

/**
 * Separates pins that would otherwise be drawn on top of one another, while
 * keeping every pin as close to its true position as possible.
 *
 * Displacement is capped at `MIN_PIN_GAP`: a pin may be eased aside, never
 * relocated. Where a cluster is too tight to resolve within that budget the
 * pins simply stay put and overlap — honest, and still individually clickable
 * thanks to the hit-target capping and zoom.
 */
export function layoutPins<T extends PinInput>(pins: T[]): PlacedPin<T>[] {
  const placed: { x: number; y: number }[] = [];
  const positioned = pins.map((pin) => {
    let { cx, cy } = pin;
    // A ring of candidate offsets at one fixed radius, tried in turn; the
    // first that clears the neighbours wins. Because the radius never grows,
    // no pin can drift further than MIN_PIN_GAP from where it belongs.
    for (let attempt = 0; attempt < 8; attempt++) {
      const clash = placed.some((p) => Math.hypot(p.x - cx, p.y - cy) < MIN_PIN_GAP);
      if (!clash) break;
      const angle = (attempt / 8) * Math.PI * 2;
      cx = pin.cx + Math.cos(angle) * MIN_PIN_GAP;
      cy = pin.cy + Math.sin(angle) * MIN_PIN_GAP;
    }
    placed.push({ x: cx, y: cy });
    return { ...pin, cx, cy };
  });

  return positioned.map((pin, i) => {
    let nearest = Infinity;
    for (let j = 0; j < positioned.length; j++) {
      if (j === i) continue;
      nearest = Math.min(nearest, Math.hypot(positioned[j].cx - pin.cx, positioned[j].cy - pin.cy));
    }
    return { ...pin, nearest };
  });
}

/**
 * Radius of a pin's invisible click target, in map units.
 *
 * The bug this exists to prevent: a flat, generous radius makes targets wider
 * than the gap between crowded pins, so the circles overlap and whichever pin
 * painted last swallows its neighbour's clicks. Capping at half the distance
 * to the nearest neighbour makes overlap impossible by construction, while a
 * pin with room to breathe still gets the full, easy-to-hit target.
 *
 * The floor is deliberately half `MIN_PIN_GAP` rather than an independent
 * number: it exists so a target never collapses to nothing, but set any higher
 * than half the closest two pins can be it would override the no-overlap cap
 * and hand the original bug straight back.
 *
 * `zoom` shrinks the map-unit radius so the target holds a constant *screen*
 * size where there is room. Where the neighbour cap binds the radius stays
 * fixed in map units instead, which means the target still grows on screen in
 * proportion to the zoom — which is what makes zooming in actually help.
 */
export function pinHitRadius(
  base: number,
  nearest: number,
  zoom: number,
  minimum = MIN_PIN_GAP / 2,
): number {
  return Math.max(minimum / zoom, Math.min(base / zoom, nearest / 2));
}
