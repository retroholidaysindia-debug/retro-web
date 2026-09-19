"use client";

/**
 * World map picker for "I know where I want to go".
 *
 * Shows one world map with the ten catalogue regions as hoverable, clickable
 * shapes (`public/maps/world.json`, built by `scripts/build-maps/world.ts`).
 * Clicking a region crossfades/zooms into that region's own detailed map —
 * the same per-region SVG + marker files the destinations pages already use —
 * where individual places become selectable pins.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CoreBundle } from "@/lib/atlas/schema";
import { evaluatePlaceSelectability, type PlaceSelectability } from "@/lib/atlas/engine/bounds";
import { layoutPins, pinHitRadius } from "@/lib/atlas/map-pins";

type WorldRegion = {
  id: string;
  name: string;
  path: string;
  bbox: [number, number, number, number];
  labelX: number;
  labelY: number;
};

type WorldMap = {
  viewBox: [number, number, number, number];
  /** Every country on Earth (bar Antarctica), merged into one inert
   *  backdrop path so unsupported places still "stay as it is" — visible,
   *  never interactive — instead of empty space. */
  land: string;
  regions: WorldRegion[];
};

type RegionMarker = {
  name: string;
  cx: number;
  cy: number;
  type: string;
  labelX: number;
  labelY: number;
  labelSide: "left" | "right";
};

type RegionMarkers = { viewBox: [number, number, number, number]; markers: RegionMarker[] };

/** Catalogue region id -> the per-region map asset built for it. */
const REGION_ASSET: Record<string, string> = {
  africa: "africa",
  "eurasia-cis": "eurasia-cis",
  russia: "russia",
  "south-asia": "south-asia",
  "east-asia": "east-asia",
  europe: "europe",
  "middle-east-and-gulf": "middle-east",
  oceania: "oceania",
  "south-east-asia": "south-east-asia",
  india: "india",
};

/** How far the world layer "pushes in" while the region layer fades over it. */
const ZOOM_SCALE = 5;
const TRANSITION_MS = 380;

/** Pin geometry: a rounded teardrop, tip at the origin, bulb centred above it. */
const PIN_PATH =
  "M0,0 C-6,-7 -9,-12.5 -9,-18 A9,9 0 1 1 9,-18 C9,-12.5 6,-7 0,0 Z";
const PIN_SCALE = 0.85;
/** Visible pin is small; the click/tap target is meaningfully larger so dense
 * clusters of nearby places stay individually selectable. */
const HIT_RADIUS = 15;

/**
 * Region-map zoom steps.
 *
 * Pins are drawn at a constant *screen* size, so zooming does not make them
 * bigger — it pushes genuinely-close places (La Digue and Vallée de Mai sit
 * about four map pixels apart) far enough apart on screen that each has its
 * own hit target. Three steps is plenty for that and keeps the control a
 * simple in/out pair rather than a slider nobody wants to fiddle with.
 */
const ZOOM_STEPS = [1, 2, 3] as const;

type Props = {
  core: CoreBundle;
  selected: string[];
  /**
   * Accepts an updater as well as a plain array, so a rapid burst of clicks
   * can never compute from a stale selection — React batches the state
   * updates, and a plain array would make every click in the batch overwrite
   * the previous one instead of adding to it.
   */
  onChange: (placeIds: string[] | ((current: string[]) => string[])) => void;
};

export function WorldMapPicker({ core, selected, onChange }: Props) {
  const [world, setWorld] = useState<WorldMap | null>(null);
  const [regionId, setRegionId] = useState<string | null>(null);
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null);
  const [hoveredPlace, setHoveredPlace] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    // A one-shot client capability check — window/matchMedia only exist after
    // mount, and this value doesn't feed any other effect, so it can't cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduceMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    fetch("/maps/world.json")
      .then((r) => r.json())
      .then(setWorld)
      .catch(() => setWorld(null));
  }, []);

  const activeRegion = world?.regions.find((r) => r.id === regionId) ?? null;
  const duration = reduceMotion ? 0 : TRANSITION_MS;

  // Transform-origin for the world layer's "push through" zoom, expressed as
  // percentages of its own viewBox so it lines up with the clicked region.
  const zoomOrigin = activeRegion
    ? {
        x: ((activeRegion.bbox[0] + activeRegion.bbox[2] / 2) / (world?.viewBox[2] ?? 1)) * 100,
        y: ((activeRegion.bbox[1] + activeRegion.bbox[3] / 2) / (world?.viewBox[3] ?? 1)) * 100,
      }
    : { x: 50, y: 50 };

  const placeByName = useMemo(() => {
    const m = new Map<string, CoreBundle["places"][number]>();
    for (const p of core.places) m.set(p.name.toLowerCase(), p);
    return m;
  }, [core.places]);

  const countryName = useMemo(
    () => new Map(core.countries.map((c) => [c.id, c.name])),
    [core.countries],
  );

  const selectedSet = new Set(selected);
  const selectability = useMemo(() => evaluatePlaceSelectability(core, selected), [core, selected]);
  const placesByRegion = useMemo(() => {
    const countryToRegion = new Map(core.countries.map((c) => [c.id, c.regionId]));
    const m = new Map<string, string[]>();
    for (const p of core.places) {
      const regionId = countryToRegion.get(p.countryId);
      if (!regionId) continue;
      const list = m.get(regionId);
      if (list) list.push(p.id);
      else m.set(regionId, [p.id]);
    }
    return m;
  }, [core.places, core.countries]);
  const toggle = (placeId: string) => {
    onChange((current) =>
      current.includes(placeId) ? current.filter((id) => id !== placeId) : [...current, placeId],
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        {regionId
          ? "Click a pin to add it to your trip — click again to remove it. Zoom in to separate places that sit close together, and drag to move around. Greyed-out pins aren't realistically combinable with what you've already picked."
          : "Hover a region to preview it, then click to zoom in and pick your places. Once you've picked somewhere, regions and places that don't sensibly combine with it grey out."}
      </p>

      <div
        className="relative overflow-hidden rounded-2xl border"
        style={{
          borderColor: "var(--hairline)",
          background: "color-mix(in srgb, var(--accent) 4%, transparent)",
          aspectRatio: world ? `${world.viewBox[2]} / ${world.viewBox[3]}` : "960 / 500",
        }}
      >
        {!world && (
          <p className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: "var(--muted)" }}>
            Loading map…
          </p>
        )}

        {world && (
          <>
            {/* World layer: always mounted, pushed through and faded out while a region is open. */}
            <div
              className="absolute inset-0"
              style={{
                opacity: regionId ? 0 : 1,
                transform: regionId ? `scale(${ZOOM_SCALE})` : "scale(1)",
                transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
                transition: `opacity ${duration}ms ease, transform ${duration}ms ease`,
                pointerEvents: regionId ? "none" : "auto",
              }}
            >
              <svg viewBox={world.viewBox.join(" ")} className="h-full w-full" role="group" aria-label="World regions">
                {/* Inert backdrop: every country on Earth, so the picker reads as an
                    ordinary atlas instead of ten shapes floating in empty space.
                    Unsupported countries "stay as it is" — visible, never interactive. */}
                <path
                  d={world.land}
                  fill="var(--surface)"
                  stroke="var(--hairline)"
                  strokeWidth={0.6}
                  pointerEvents="none"
                />
                {world.regions.map((r) => {
                  const isHovered = hoveredRegion === r.id;
                  const regionPlaces = placesByRegion.get(r.id) ?? [];
                  const regionEntries = regionPlaces.map((id) => selectability.get(id));
                  const isDisabled = !regionEntries.some((e) => e?.allowed);
                  const disabledReason = regionEntries.find((e) => e && !e.allowed)?.reason
                    ?? "Not realistically combinable with your current selection";
                  return (
                    <g
                      key={r.id}
                      role="button"
                      tabIndex={isDisabled ? -1 : 0}
                      aria-disabled={isDisabled}
                      aria-label={isDisabled ? `${r.name} — ${disabledReason}` : `Explore ${r.name}`}
                      className={isDisabled ? "cursor-not-allowed" : "cursor-pointer"}
                      style={{ outline: "none" }}
                      onMouseEnter={() => !isDisabled && setHoveredRegion(r.id)}
                      onMouseLeave={() => setHoveredRegion((c) => (c === r.id ? null : c))}
                      onFocus={() => !isDisabled && setHoveredRegion(r.id)}
                      onBlur={() => setHoveredRegion((c) => (c === r.id ? null : c))}
                      onClick={() => !isDisabled && setRegionId(r.id)}
                      onKeyDown={(e) => {
                        if (!isDisabled && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          setRegionId(r.id);
                        }
                      }}
                    >
                      <title>{isDisabled ? disabledReason : r.name}</title>
                      <path
                        d={r.path}
                        fill={isDisabled ? "var(--surface)" : isHovered ? "var(--accent)" : "var(--muted)"}
                        fillOpacity={isDisabled ? 0.35 : isHovered ? 0.35 : 0.16}
                        stroke={isDisabled ? "var(--hairline)" : isHovered ? "var(--accent)" : "var(--hairline)"}
                        strokeWidth={isHovered && !isDisabled ? 1.5 : 1}
                        style={{ transition: "fill-opacity 0.15s ease, stroke 0.15s ease" }}
                      />
                      {isHovered && !isDisabled && (
                        <text
                          x={r.labelX}
                          y={r.labelY}
                          textAnchor="middle"
                          fontSize={13}
                          fontWeight={700}
                          fill="var(--text)"
                          stroke="var(--deep)"
                          strokeWidth={3}
                          paintOrder="stroke"
                          pointerEvents="none"
                        >
                          {r.name}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Region layer: fades/scales in over the world layer once a region is picked. */}
            <div
              className="absolute inset-0"
              style={{
                opacity: regionId ? 1 : 0,
                transform: regionId ? "scale(1)" : "scale(0.92)",
                transition: `opacity ${duration}ms ease, transform ${duration}ms ease`,
                pointerEvents: regionId ? "auto" : "none",
              }}
            >
              {regionId && (
                <RegionView
                  regionId={regionId}
                  placeByName={placeByName}
                  selectedSet={selectedSet}
                  selectability={selectability}
                  countryName={countryName}
                  hoveredPlace={hoveredPlace}
                  onHoverPlace={setHoveredPlace}
                  onToggle={toggle}
                  onBack={() => setRegionId(null)}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zoomed-in region view
// ---------------------------------------------------------------------------

type RegionViewProps = {
  regionId: string;
  placeByName: Map<string, CoreBundle["places"][number]>;
  selectedSet: Set<string>;
  /** Selectability (allowed + reason) for every place in the catalogue,
   *  given the current selection. */
  selectability: Map<string, PlaceSelectability>;
  /** Country id -> display name, for labelling island nations the map is too
   *  coarse to draw. */
  countryName: Map<string, string>;
  hoveredPlace: string | null;
  onHoverPlace: (id: string | null) => void;
  onToggle: (placeId: string) => void;
  onBack: () => void;
};

function RegionView({
  regionId, placeByName, selectedSet, selectability, countryName, hoveredPlace, onHoverPlace, onToggle, onBack,
}: RegionViewProps) {
  const asset = REGION_ASSET[regionId];
  // Held together so a stale response from the previous region can never be
  // rendered under the new region's key, and "loading" is derived rather than
  // tracked as a separate flag that could fall out of sync.
  const [loaded, setLoaded] = useState<{ asset: string; svg: string; markers: RegionMarkers } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/maps/${asset}.svg`).then((r) => r.text()),
      fetch(`/maps/${asset}.markers.json`).then((r) => r.json() as Promise<RegionMarkers>),
    ])
      .then(([svg, markers]) => {
        if (!cancelled) setLoaded({ asset, svg, markers });
      })
      .catch(() => {
        /* leave loaded as-is; the loading placeholder stays visible */
      });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  const data = loaded?.asset === asset ? loaded : null;

  // Zoom/pan for this region. `pan` is the top-left of the visible window in
  // the map's own viewBox units, so it composes directly into the viewBox.
  // Held together with the asset it belongs to and reset during render when
  // the region changes — leaving a zoomed view behind would drop the
  // traveller into a corner of the next map with no idea where they are.
  const [nav, setNav] = useState({ asset, zoom: 1, pan: { x: 0, y: 0 } });
  const { zoom, pan } = nav.asset === asset ? nav : { zoom: 1, pan: { x: 0, y: 0 } };
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  /** Set once a drag travels far enough to be a pan rather than a click, so
   *  releasing over a pin does not also select it. */
  const panned = useRef(false);

  const setPan = (next: { x: number; y: number }) => setNav({ asset, zoom, pan: next });

  const base = useMemo<[number, number, number, number]>(
    () => data?.markers.viewBox ?? [0, 0, 1, 1],
    [data],
  );
  const view = useMemo(() => {
    const [bx, by, bw, bh] = base;
    const w = bw / zoom;
    const h = bh / zoom;
    // Keep the window inside the map however the traveller drags or zooms.
    const x = Math.min(Math.max(pan.x, bx), bx + bw - w);
    const y = Math.min(Math.max(pan.y, by), by + bh - h);
    return { x, y, w, h };
  }, [base, zoom, pan]);

  /** Re-centre on the current middle when stepping zoom, so the view does not
   *  jump to a corner. */
  const stepZoom = (next: number) => {
    const [bx, by, bw, bh] = base;
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const w = bw / next;
    const h = bh / next;
    setNav({
      asset,
      zoom: next,
      pan: {
        x: Math.min(Math.max(cx - w / 2, bx), bx + bw - w),
        y: Math.min(Math.max(cy - h / 2, by), by + bh - h),
      },
    });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (zoom === 1) return; // nothing to pan at full extent
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, panX: view.x, panY: view.y };
    panned.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // A few pixels of travel is a shaky click, not a pan; only past that does
    // the gesture take over and cancel the pending selection.
    if (Math.hypot(dx, dy) > 4) {
      panned.current = true;
      // Capture only once this is definitely a drag. Capturing on pointerdown
      // retargets a click on a pin to the SVG root, so zoomed pins stop
      // receiving their click handler.
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    }
    // Convert the pixel drag into viewBox units so the map tracks the cursor.
    setPan({
      x: d.panX - (dx / rect.width) * view.w,
      y: d.panY - (dy / rect.height) * view.h,
    });
  };
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // The generated maps draw the country outline as a single unfilled
  // `data-role="coastline"` path. Pulled out and drawn as a real filled shape
  // here so the landmass reads as a country with a defined border, rather
  // than a faint floating squiggle, and so the rest of the source SVG
  // (context outline, group highlights) can still be layered under the pins.
  const coastline = data?.svg.match(/<path\s+d="([^"]+)"[^>]*data-role="coastline"/)?.[1] ?? null;

  /** Bounding box of each landmass the coastline actually draws. */
  const landBoxes = useMemo(() => {
    if (!coastline) return [];
    return coastline
      .split("Z")
      .filter((s) => s.trim())
      .map((sub) => {
        const pts = [...sub.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
        if (!pts.length) return null;
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      })
      .filter((b): b is { x0: number; x1: number; y0: number; y1: number } => b !== null);
  }, [coastline]);

  const decorations = useMemo(() => {
    if (!data) return "";
    return data.svg
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/<g data-marker-name="[^"]*"[\s\S]*?<\/g>/g, "")
      .replace(/<path\s+[^>]*data-role="coastline"[^>]*\/>/g, "");
  }, [data]);

  const selectable = useMemo(() => {
    if (!data) return [];
    const resolved = data.markers.markers
      .map((m) => ({ marker: m, place: placeByName.get(m.name.toLowerCase()) }))
      .filter((x): x is { marker: RegionMarker; place: CoreBundle["places"][number] } => Boolean(x.place));

    // The generated marker files repeat some pins across multiple `group`
    // values (a leftover of how they were laid out) which this view does not
    // otherwise consult, so the same place can appear more than once at the
    // same coordinates. Keep only the first occurrence — one pin, one place —
    // or it would render as a stacked duplicate and collide on `place.id` as
    // a React key.
    const seen = new Set<string>();
    const deduped = resolved.filter(({ place }) => {
      if (seen.has(place.id)) return false;
      seen.add(place.id);
      return true;
    });

    return layoutPins(
      deduped.map(({ marker, place }) => ({ marker, place, cx: marker.cx, cy: marker.cy })),
    );
  }, [data, placeByName]);

  /**
   * Island nations are too small to survive the map simplification — Mauritius
   * and Seychelles vanish entirely from Africa's coastline — so their pins
   * would float in open sea with nothing to say which country they belong to.
   * Where a country's pins sit outside every landmass the map actually drew,
   * enclose them in a labelled territory boundary instead, so every country on
   * the map carries some border.
   */
  const territories = useMemo(() => {
    if (!selectable.length) return [];
    const byCountry = new Map<string, { cx: number; cy: number }[]>();
    for (const { place, cx, cy } of selectable) {
      const list = byCountry.get(place.countryId);
      if (list) list.push({ cx, cy });
      else byCountry.set(place.countryId, [{ cx, cy }]);
    }

    const out: { countryId: string; name: string; cx: number; cy: number; rx: number; ry: number }[] = [];
    for (const [countryId, pts] of byCountry) {
      const onLand = pts.some((p) =>
        landBoxes.some((b) => p.cx >= b.x0 - 4 && p.cx <= b.x1 + 4 && p.cy >= b.y0 - 4 && p.cy <= b.y1 + 4),
      );
      if (onLand) continue;
      const xs = pts.map((p) => p.cx);
      const ys = pts.map((p) => p.cy);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      // A pin's bulb is drawn ~18 units *above* its anchor point, so padding
      // by the pin height keeps the ring clear of the pins it encloses rather
      // than cutting through them.
      const pad = 20;
      out.push({
        countryId,
        name: countryName.get(countryId) ?? "",
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2,
        rx: (x1 - x0) / 2 + pad,
        ry: (y1 - y0) / 2 + pad,
      });
    }
    return out;
  }, [selectable, landBoxes, countryName]);

  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        onClick={onBack}
        className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-sm"
        style={{ borderColor: "var(--hairline)", background: "color-mix(in srgb, var(--deep) 70%, transparent)" }}
      >
        ‹ All regions
      </button>

      {!data && (
        <p className="flex h-full items-center justify-center text-sm" style={{ color: "var(--muted)" }}>
          Loading…
        </p>
      )}

      {data && (
        <>
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
            <button
              type="button"
              onClick={() => stepZoom(ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(zoom as 1 | 2 | 3) - 1)])}
              disabled={zoom === ZOOM_STEPS[0]}
              aria-label="Zoom out"
              className="flex h-7 w-7 items-center justify-center rounded-full border text-sm font-medium backdrop-blur-sm disabled:opacity-35"
              style={{ borderColor: "var(--hairline)", background: "color-mix(in srgb, var(--deep) 70%, transparent)" }}
            >
              −
            </button>
            <span className="w-7 text-center text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>
              {zoom}×
            </span>
            <button
              type="button"
              onClick={() =>
                stepZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(zoom as 1 | 2 | 3) + 1)])
              }
              disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              aria-label="Zoom in"
              className="flex h-7 w-7 items-center justify-center rounded-full border text-sm font-medium backdrop-blur-sm disabled:opacity-35"
              style={{ borderColor: "var(--hairline)", background: "color-mix(in srgb, var(--deep) 70%, transparent)" }}
            >
              +
            </button>
          </div>

          <svg
            ref={svgRef}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            className={`h-full w-full${zoom > 1 ? " cursor-grab active:cursor-grabbing" : ""}`}
            role="group"
            aria-label="Selectable places"
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/* Country boundary: filled so the landmass reads as solid ground
                with a defined border, instead of a faint outline the pins
                appear to float over. Round joins *and* caps matter here more
                than cosmetically: a genuinely tiny country (Mauritius and the
                Seychelles are both under a pixel across on Africa's map) has
                a real but near-zero-area outline, which a plain stroke can
                render as nothing at all. A round cap still draws a small dot
                at a degenerate path's vertices, so the island stays visible
                at its true position instead of needing a synthetic marker. */}
            {coastline && (
              <path
                d={coastline}
                fill="color-mix(in srgb, var(--muted) 14%, transparent)"
                stroke="var(--muted)"
                strokeWidth={1.4 / zoom}
                strokeLinejoin="round"
                strokeLinecap="round"
                pointerEvents="none"
              />
            )}

            {/* Whatever else the generated map carries (context outline, group
                highlights). Its own marker <g> elements are stripped so we can
                draw richer pins on top without double rendering or
                double hit-testing. */}
            <g opacity={0.55} pointerEvents="none" dangerouslySetInnerHTML={{ __html: decorations }} />

            {/* Territory boundary for island nations the map is too coarse to
                draw, so no country's pins sit in unmarked open sea. */}
            {territories.map((t) => (
              <g key={t.countryId} pointerEvents="none">
                <ellipse
                  cx={t.cx}
                  cy={t.cy}
                  rx={t.rx}
                  ry={t.ry}
                  fill="color-mix(in srgb, var(--muted) 8%, transparent)"
                  stroke="var(--muted)"
                  strokeWidth={0.9 / zoom}
                  strokeDasharray={`${4 / zoom},${3 / zoom}`}
                  opacity={0.7}
                />
                {t.name && (
                  <text
                    x={t.cx}
                    y={t.cy - t.ry - 5 / zoom}
                    textAnchor="middle"
                    fontSize={9 / zoom}
                    fontWeight={600}
                    letterSpacing={0.4 / zoom}
                    fill="var(--muted)"
                  >
                    {t.name.toUpperCase()}
                  </text>
                )}
              </g>
            ))}

            {selectable.map(({ marker, place, cx, cy, nearest }) => {
              const isSelected = selectedSet.has(place.id);
              const entry = selectability.get(place.id);
              const isDisabled = !isSelected && entry?.allowed === false;
              const disabledReason = entry?.reason ?? "Not realistically combinable with your current selection";
              // Keyboard focus gets the same treatment as a mouse hover (label
              // + highlight) rather than the browser's default focus rectangle,
              // which would otherwise draw an ungainly box around the whole
              // pin-plus-leader-line-plus-label group.
              const isHovered = !isDisabled && hoveredPlace === place.id;
              const showLabel = isSelected || isHovered;
              const anchor = marker.labelSide === "left" ? "end" : "start";
              const leaderX2 = marker.labelSide === "left" ? marker.labelX + 4 : marker.labelX - 4;
              // Everything drawn for a pin is counter-scaled by the zoom, so
              // the pin, its label and its hit target keep a constant size on
              // screen. That is the whole point of zooming here: the map
              // stretches underneath while the targets stay put, so places a
              // few pixels apart at 1x become comfortably separate at 3x.
              const k = 1 / zoom;

              return (
                <g
                  key={place.id}
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-disabled={isDisabled}
                  aria-label={isDisabled ? `${place.name} — ${disabledReason}` : place.name}
                  tabIndex={isDisabled ? -1 : 0}
                  className={isDisabled ? "cursor-not-allowed" : "cursor-pointer"}
                  style={{ outline: "none" }}
                  onMouseEnter={() => !isDisabled && onHoverPlace(place.id)}
                  onMouseLeave={() => onHoverPlace(null)}
                  onFocus={() => !isDisabled && onHoverPlace(place.id)}
                  onBlur={() => onHoverPlace(null)}
                  onClick={() => !isDisabled && !panned.current && onToggle(place.id)}
                  onKeyDown={(e) => {
                    if (!isDisabled && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onToggle(place.id);
                    }
                  }}
                >
                  <title>{isDisabled ? disabledReason : place.name}</title>
                  {showLabel && (
                    <>
                      <line
                        x1={cx} y1={cy - 18 * PIN_SCALE * k}
                        x2={leaderX2} y2={marker.labelY}
                        stroke="var(--accent)" strokeWidth={0.8 * k} pointerEvents="none"
                      />
                      <text
                        x={marker.labelX} y={marker.labelY + 4 * k}
                        textAnchor={anchor} fontSize={11 * k} fontWeight={700}
                        fill="var(--text)" stroke="var(--deep)" strokeWidth={3 * k} paintOrder="stroke"
                        pointerEvents="none"
                      >
                        {place.name}
                      </text>
                    </>
                  )}

                  {/* Invisible hit target, sized as generously as the pin's
                      breathing room allows — see `pinHitRadius`. */}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={pinHitRadius(isDisabled ? 6 : HIT_RADIUS, nearest, zoom)}
                    fill="transparent"
                  />

                  <g transform={`translate(${cx}, ${cy}) scale(${PIN_SCALE * k})`} opacity={isDisabled ? 0.3 : 1}>
                    <path
                      d={PIN_PATH}
                      fill={isSelected ? "var(--accent)" : isHovered ? "color-mix(in srgb, var(--accent) 55%, var(--surface))" : "var(--surface)"}
                      stroke={isDisabled ? "var(--muted)" : "var(--accent)"}
                      strokeWidth={isSelected || isHovered ? 2 : 1.4}
                    />
                    <circle cx={0} cy={-18} r={3.4} fill={isSelected ? "var(--deep)" : "var(--accent)"} />
                    {isSelected && (
                      <path
                        d="M-3.2,-18 L-1,-15.5 L3.4,-20.5"
                        fill="none" stroke="var(--deep)" strokeWidth={1.4}
                        strokeLinecap="round" strokeLinejoin="round"
                      />
                    )}
                  </g>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}
