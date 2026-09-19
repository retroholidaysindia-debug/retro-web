/**
 * Geography: the one place that knows how far apart two points are, and what
 * it costs and takes to travel between them by each mode.
 *
 * This model used to live inside the ETL (`scripts/etl/transport-derive.ts`),
 * where it could only ever fill gaps in routes that already existed in the
 * source table. That left the engine itself geographically blind: 437 places
 * share only 1,353 authored place-to-place routes — about 1.4% of all possible
 * pairs — and the usable graph breaks into 63 disconnected components, the
 * largest holding just 18 places. Every leg outside that thin scaffolding fell
 * through to a single region-wide median fare, so a 120 km hop and a 6,000 km
 * one were quoted the same number.
 *
 * Moving the model here makes it shared: the ETL still uses it to fill gaps at
 * build time, and the engine now uses it at runtime to synthesise a plausible,
 * mode-aware leg for any pair of places whose coordinates are known.
 */
import type { TransportMode } from "../schema";

export type GeoPoint = { lat: number; lon: number };

/** Great-circle distance in kilometres. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Per-mode journey model.
 *
 *  - `detour`      — how much longer the real path is than the straight line.
 *                    Roads wander; flight paths barely do.
 *  - `kmh`         — effective in-vehicle speed, already allowing for
 *                    intermediate stops.
 *  - `overheadMin` — the fixed, distance-independent part of the journey:
 *                    check-in and security for a flight, boarding for a train.
 *                    This is what makes a flight lose to a train over short
 *                    hops even though it is far faster in the air.
 */
export type ModeProfile = { detour: number; kmh: number; overheadMin: number };

export const MODE_PROFILES: Record<TransportMode, ModeProfile> = {
  flight: { detour: 1.05, kmh: 750, overheadMin: 150 },
  train: { detour: 1.25, kmh: 70, overheadMin: 40 },
  bus: { detour: 1.3, kmh: 50, overheadMin: 20 },
  private_vehicle: { detour: 1.3, kmh: 55, overheadMin: 10 },
  shared_vehicle: { detour: 1.3, kmh: 50, overheadMin: 20 },
  ferry: { detour: 1.1, kmh: 35, overheadMin: 45 },
  seaplane: { detour: 1.05, kmh: 250, overheadMin: 30 },
  cruise: { detour: 1.15, kmh: 30, overheadMin: 60 },
};

/**
 * Regions with a genuine high-speed rail network, where the generic ~70km/h
 * intercity average would badly understate the train.
 */
export const HIGH_SPEED_RAIL_REGIONS = new Set(["europe", "east-asia"]);
export const HIGH_SPEED_RAIL_KMH = 160;

/**
 * Fare per km by mode, in INR, with a fixed component. Short hops cost
 * disproportionately more per km because the fixed costs dominate.
 */
export const MODE_FARE: Record<TransportMode, { fixedInr: number; perKmInr: number }> = {
  flight: { fixedInr: 3200, perKmInr: 4.2 },
  train: { fixedInr: 250, perKmInr: 2.1 },
  bus: { fixedInr: 150, perKmInr: 1.4 },
  private_vehicle: { fixedInr: 900, perKmInr: 22 },
  shared_vehicle: { fixedInr: 300, perKmInr: 5.5 },
  ferry: { fixedInr: 400, perKmInr: 3.0 },
  seaplane: { fixedInr: 4000, perKmInr: 16 },
  cruise: { fixedInr: 6000, perKmInr: 9 },
};

export function deriveDurationMinutes(
  mode: TransportMode,
  distanceKm: number,
  regionId: string,
): number {
  const profile = MODE_PROFILES[mode];
  const kmh =
    mode === "train" && HIGH_SPEED_RAIL_REGIONS.has(regionId) ? HIGH_SPEED_RAIL_KMH : profile.kmh;
  const travelled = distanceKm * profile.detour;
  return Math.round(profile.overheadMin + (travelled / kmh) * 60);
}

export function deriveFareInr(mode: TransportMode, distanceKm: number): number {
  const curve = MODE_FARE[mode];
  return Math.round(curve.fixedInr + distanceKm * curve.perKmInr);
}

/**
 * Which modes are physically plausible over a given distance.
 *
 * Without this a synthesised leg would offer a 4,000 km bus (cheapest by fare,
 * and therefore the winner) or a 40 km flight (three hours of airport for
 * twenty minutes in the air). The bands below are deliberately generous — the
 * router's own comfort ceilings and the traveller's transport preference do
 * the fine-grained work — but they rule out the physically absurd.
 *
 * `sameLandmass` is false when the two ends are far enough apart, or separated
 * by enough water, that no road or rail option should be offered at all.
 */
export function plausibleModes(distanceKm: number, sameLandmass: boolean): TransportMode[] {
  const modes: TransportMode[] = [];

  if (sameLandmass) {
    // A car is only a sane intercity answer over short and medium hops.
    if (distanceKm <= 700) modes.push("private_vehicle");
    if (distanceKm >= 40 && distanceKm <= 1200) modes.push("bus");
    if (distanceKm >= 40 && distanceKm <= 2500) modes.push("train");
  }
  // Below ~250km the airport overhead makes a flight slower door-to-door than
  // the road, and airlines rarely serve the pair at all.
  if (distanceKm >= 250) modes.push("flight");
  if (!sameLandmass && distanceKm < 250) modes.push("ferry");

  // Always leave something on the table.
  if (!modes.length) modes.push(distanceKm >= 250 ? "flight" : "private_vehicle");
  return modes;
}
