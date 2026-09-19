export type LabelSide = "left" | "right";
export type LabelPoint = { x: number; y: number; name: string; type: "city" | "poi" };
export type PlacedLabel = {
  name: string;
  x: number;
  y: number;
  side: LabelSide;
  anchorX: number;
  anchorY: number;
};

export function placeLabels(
  points: LabelPoint[],
  _centroidX: number,       // kept for API compat, ignored — we compute from data
  minLabelGapPx = 13        // label line height
): PlacedLabel[] {
  if (points.length === 0) return [];

  // Actual median X of markers — not the map centre — for balanced side assignment.
  // For an even count take the midpoint of the two central values; picking one of
  // them would put that marker on the wrong side and bunch labels together.
  const sortedX = [...points].sort((a, b) => a.x - b.x);
  const mid = sortedX.length / 2;
  const medianX =
    sortedX.length % 2 === 1
      ? sortedX[Math.floor(mid)].x
      : (sortedX[mid - 1].x + sortedX[mid].x) / 2;

  const labels: PlacedLabel[] = points.map((p) => ({
    name: p.name,
    x: p.x,
    y: p.y,
    side: (p.x <= medianX ? "left" : "right") as LabelSide,
    anchorX: p.x,
    anchorY: p.y,
  }));

  // Rebalance: if one side has >60% of labels, flip the markers on that side
  // that are closest to the median (least committed to their side).
  const rebalance = () => {
    const L = labels.filter((l) => l.side === "left").length;
    const R = labels.filter((l) => l.side === "right").length;
    const diff = Math.abs(L - R);
    if (diff <= 2) return;
    const heavy: LabelSide = L > R ? "left" : "right";
    const light: LabelSide = heavy === "left" ? "right" : "left";
    const toFlip = Math.floor(diff / 2);
    labels
      .filter((l) => l.side === heavy)
      .sort((a, b) => Math.abs(a.x - medianX) - Math.abs(b.x - medianX))
      .slice(0, toFlip)
      .forEach((l) => { l.side = light; });
  };
  rebalance();

  // Bidirectional spread: push labels apart on each side, alternating
  // forward (push down) and backward (push up) passes until stable.
  for (const side of ["left", "right"] as const) {
    const group = labels
      .filter((l) => l.side === side)
      .sort((a, b) => a.anchorY - b.anchorY);

    if (group.length < 2) continue;

    // Start each label at its marker's Y position.
    group.forEach((l) => { l.y = l.anchorY; });

    for (let pass = 0; pass < 8; pass++) {
      // Forward: push down overlapping pairs
      for (let i = 1; i < group.length; i++) {
        if (group[i].y - group[i - 1].y < minLabelGapPx) {
          group[i].y = group[i - 1].y + minLabelGapPx;
        }
      }
      // Backward: push up overlapping pairs
      for (let i = group.length - 2; i >= 0; i--) {
        if (group[i + 1].y - group[i].y < minLabelGapPx) {
          group[i].y = group[i + 1].y - minLabelGapPx;
        }
      }
    }
  }

  return labels;
}
