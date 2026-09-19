/**
 * Fills the gaps in the transport graph from real geography.
 *
 * The source data prices most legs but almost never times them — only ~7% of
 * enabled options carry a `duration_minutes`. That matters more than it
 * sounds: the router scores a leg on money *and* time, so when every mode
 * falls back to the same default duration, time cancels out and the cheapest
 * option wins unconditionally. In practice that made a bus the chosen mode on
 * 84% of all routes, including hops far too long to sanely take one.
 *
 * So for every option that is enabled but untimed, this derives a journey
 * time from the great-circle distance between the two endpoints and a
 * per-mode speed profile. Where a leg has no fare at all (and is not
 * explicitly marked unavailable) a distance-based fare is derived too.
 *
 * Values the agency actually supplied are never overwritten — only gaps are
 * filled, and everything derived is labelled `estimated` so a quotation can
 * still be audited line by line.
 *
 * The journey model itself lives in [`lib/atlas/engine/geo.ts`](../../lib/atlas/engine/geo.ts)
 * so the engine can apply exactly the same curves at runtime to pairs that
 * have no authored route at all.
 */
import type { Route, RouteOption } from "../../lib/atlas/schema";
import type { GeoPoint } from "./vendor-geocode";
import { haversineKm } from "./vendor-airports";
import { deriveDurationMinutes, deriveFareInr } from "../../lib/atlas/engine/geo";

/** Spread around the mid fare, so a derived option still has a low and high. */
const BAND_SPREAD = 0.25;

export { deriveDurationMinutes, deriveFareInr };

export type TransportDerivation = {
  routes: Route[];
  stats: {
    durationsDerived: number;
    faresDerived: number;
    distancesResolved: number;
    /** Enabled options still missing a duration because no distance existed. */
    durationsStillMissing: number;
    faresStillMissing: number;
  };
};

/**
 * Returns a copy of the route table with derived durations, fares and
 * distances filled in.
 */
export function deriveTransport(
  routes: Route[],
  coords: Map<string, GeoPoint>,
  placeCountry: Map<string, string>,
  countryRegion: Map<string, string>,
): TransportDerivation {
  let durationsDerived = 0;
  let faresDerived = 0;
  let distancesResolved = 0;
  let durationsStillMissing = 0;
  let faresStillMissing = 0;

  const out = routes.map((route) => {
    const a = route.originPlaceId ? coords.get(route.originPlaceId) : undefined;
    const b = route.destPlaceId ? coords.get(route.destPlaceId) : undefined;
    const distanceKm = a && b ? Math.round(haversineKm(a, b)) : null;
    if (distanceKm != null) distancesResolved++;

    const regionId =
      countryRegion.get(
        route.originCountryId ?? placeCountry.get(route.originPlaceId ?? "") ?? "",
      ) ?? "";

    const options: RouteOption[] = route.options.map((option) => {
      // An explicitly unavailable option is a statement of fact about the
      // world ("no rail service on this pair"), not a data gap — deriving a
      // time or a fare for it would invent a journey that cannot be taken.
      if (!option.enabled) return { ...option, distanceKm };

      let { durationMinutes, priceLow, priceHigh, currency } = option;
      let durationSource = option.durationSource ?? "workbook";
      let priceSource = option.priceSource ?? "workbook";

      if (durationMinutes == null) {
        if (distanceKm != null && distanceKm > 0) {
          durationMinutes = deriveDurationMinutes(option.mode, distanceKm, regionId);
          durationSource = "estimated";
          durationsDerived++;
        } else {
          durationsStillMissing++;
        }
      }

      if (priceLow == null && priceHigh == null) {
        if (distanceKm != null && distanceKm > 0) {
          const mid = deriveFareInr(option.mode, distanceKm);
          priceLow = Math.round(mid * (1 - BAND_SPREAD));
          priceHigh = Math.round(mid * (1 + BAND_SPREAD));
          currency = currency ?? "INR";
          priceSource = "estimated";
          faresDerived++;
        } else {
          faresStillMissing++;
        }
      }

      return {
        ...option,
        durationMinutes,
        priceLow,
        priceHigh,
        currency,
        durationSource,
        priceSource,
        distanceKm,
      };
    });

    return { ...route, options };
  });

  return {
    routes: out,
    stats: { durationsDerived, faresDerived, distancesResolved, durationsStillMissing, faresStillMissing },
  };
}
