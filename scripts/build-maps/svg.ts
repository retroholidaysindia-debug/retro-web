export type SvgMarker = {
  name: string;
  cx: number;
  cy: number;
  type: "city" | "poi";
  subtype?: string;
  group?: number;
  labelX: number;
  labelY: number;
  labelSide: "left" | "right";
};

export type BuildMapSvgInput = {
  viewBox: [number, number, number, number];
  countryPath: string;
  contextPath?: string;
  highlightPaths: string[];
  accent: string;
  markers: SvgMarker[];
};

function buildMarker(m: SvgMarker): string {
  const dotR = m.type === "city" ? 4.5 : 3;
  const anchor = m.labelSide === "left" ? "end" : "start";
  // Leader line ends 4px from the text edge so it doesn't overlap glyphs
  const leaderX2 = m.labelSide === "left" ? m.labelX + 4 : m.labelX - 4;
  const fontSize = m.name.length > 12 ? 9 : m.name.length > 8 ? 10 : 11;

  return `<g data-marker-name="${escapeXml(m.name)}" data-marker-type="${m.type}"${m.group != null ? ` data-marker-group="${m.group}"` : ""}>
  <line x1="${m.cx.toFixed(1)}" y1="${m.cy.toFixed(1)}" x2="${leaderX2.toFixed(1)}" y2="${m.labelY.toFixed(1)}" stroke="var(--hairline)" stroke-width="0.8" class="marker-leader"/>
  <circle cx="${m.cx.toFixed(1)}" cy="${m.cy.toFixed(1)}" r="${dotR}" fill="var(--muted)" stroke="var(--deep)" stroke-width="1.5" class="marker-dot"/>
  <text x="${m.labelX.toFixed(1)}" y="${(m.labelY + 4).toFixed(1)}" font-size="${fontSize}" font-weight="600" text-anchor="${anchor}" class="marker-label-text" fill="var(--muted)">${escapeXml(m.name)}</text>
</g>`;
}

export function buildMapSvg(input: BuildMapSvgInput): string {
  const [x, y, w, h] = input.viewBox;

  // Context outline (e.g. parent country behind a state-level destination).
  // Rendered first so it sits below the main shape and highlights.
  const contextPath = input.contextPath
    ? `<path d="${input.contextPath}" fill="none" stroke="var(--muted)" stroke-width="0.6" stroke-dasharray="3,5" stroke-opacity="0.22" data-role="context" />`
    : "";

  const highlights = input.highlightPaths
    .map((d) => `<path d="${d}" fill="${input.accent}" fill-opacity="0.18" />`)
    .join("");

  const markers = input.markers.map(buildMarker).join("\n");

  return (
    `<svg viewBox="${x} ${y} ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    contextPath +
    `<path d="${input.countryPath}" fill="none" stroke="var(--hairline)" stroke-width="1" data-role="coastline" />` +
    highlights +
    markers +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
