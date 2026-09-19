export type ProjectionKind = "conicConformal" | "conicEqualArea" | "mercator";

export function selectProjection(
  bbox: [number, number, number, number]
): ProjectionKind {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const centroidLat = (minLat + maxLat) / 2;
  const widthDeg = maxLng - minLng;

  if (Math.abs(centroidLat) > 45) return "conicConformal";
  if (widthDeg > 30) return "conicEqualArea";
  return "mercator";
}
