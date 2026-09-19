"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { placeSlug } from "@/lib/trips";
import { getPlaceImageUrl, getPlaceDescription } from "@/lib/place-images";
import type { Group } from "@/content/schema";

type Props = {
  destinationSlug: string;
  mapSvg: string;
  groups?: Group[];
  markerGroups?: Record<string, number>;
  // When set, dims all markers not belonging to this group.
  selectedGroupId?: number;
};

type TooltipPos = { x: number; y: number; flip: boolean };

export function DestinationExplorer({ destinationSlug, mapSvg, groups = [], markerGroups = {}, selectedGroupId }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<TooltipPos | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Reflect active + dimmed state onto SVG marker elements.
  useEffect(() => {
    const root = mapRef.current;
    if (!root) return;
    root.querySelectorAll("[data-marker-name]").forEach((el) => {
      const name = el.getAttribute("data-marker-name") ?? "";
      const groupAttr = el.getAttribute("data-marker-group");
      const groupId = groupAttr != null ? parseInt(groupAttr) : null;

      el.classList.toggle("marker-active", placeSlug(name) === active);

      // Dim markers not in the selected group (only when a filter is active).
      if (selectedGroupId != null && groupId != null) {
        el.classList.toggle("marker-dimmed", groupId !== selectedGroupId);
      } else {
        el.classList.remove("marker-dimmed");
      }
    });
  }, [active, selectedGroupId]);

  // Hover, click, and mousemove event delegation on the SVG container.
  useEffect(() => {
    const root = mapRef.current;
    if (!root) return;

    const markerFromEvent = (e: Event) => {
      const g = (e.target as Element).closest("[data-marker-name]");
      const name = g?.getAttribute("data-marker-name");
      return name ? { slug: placeSlug(name), name } : null;
    };

    const onOver = (e: Event) => {
      const m = markerFromEvent(e);
      if (m) {
        setActive(m.slug);
        setActiveName(m.name);
      }
    };

    const onOut = (e: Event) => {
      if (markerFromEvent(e)) {
        setActive(null);
        setActiveName(null);
        setTooltipPos(null);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const flip = x > rect.width * 0.55;
      setTooltipPos({ x, y, flip });
    };

    const onClick = (e: Event) => {
      const m = markerFromEvent(e);
      if (!m) return;
      // Every marker belongs to a group/package; navigate straight to that
      // package's detail page (multiple places can share one package, e.g.
      // clicking Germany or Austria both open "Europe at a Glance").
      const groupId = markerGroups[m.slug];
      const group = groupId != null ? groups.find((g) => g.id === groupId) : undefined;
      if (group) {
        router.push(`/destinations/${destinationSlug}/packages/${group.packageSlug}`);
      } else {
        router.push(`/destinations/${destinationSlug}`);
      }
    };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    root.addEventListener("mousemove", onMove);
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("click", onClick);
    };
  }, [destinationSlug, router, groups, markerGroups]);

  // Resolve group for the active marker (if any).
  const activeGroupId = active ? markerGroups[active] : undefined;
  const activeGroup = activeGroupId != null ? groups.find((g) => g.id === activeGroupId) : undefined;

  // Fall back to per-place data when no group is assigned.
  const imageUrl = activeName && !activeGroup ? getPlaceImageUrl(destinationSlug, activeName) : null;
  const description = activeName && !activeGroup ? getPlaceDescription(destinationSlug, activeName) : null;

  const showTooltip = active && activeName && tooltipPos && (activeGroup || imageUrl);

  return (
    <div ref={mapRef} className="destination-map-wrapper">
      {/* SVG map */}
      <div
        className="destination-map w-full"
        dangerouslySetInnerHTML={{ __html: mapSvg }}
      />

      {/* Tooltip */}
      {showTooltip && (
        <div
          className="pointer-events-none absolute z-30"
          style={{
            top: tooltipPos.y,
            left: tooltipPos.x,
            transform: tooltipPos.flip
              ? "translate(calc(-100% - 18px), -50%)"
              : "translate(18px, -50%)",
            width: activeGroup ? "240px" : "216px",
            borderRadius: "14px",
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.13)",
            background: "rgba(9, 24, 28, 0.82)",
            backdropFilter: "blur(24px) saturate(180%)",
            WebkitBackdropFilter: "blur(24px) saturate(180%)",
            boxShadow:
              "0 24px 64px rgba(0,0,0,0.65), 0 0 0 0.5px rgba(111,227,196,0.06), inset 0 1px 0 rgba(255,255,255,0.06)",
          }}
        >
          {activeGroup ? (
            /* ── Group offer tooltip ── */
            <GroupTooltip group={activeGroup} placeName={activeName!} />
          ) : (
            /* ── Per-place image tooltip ── */
            <PlaceTooltip name={activeName!} imageUrl={imageUrl!} description={description!} />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Group offer card ─────────────────────────────────── */
function GroupTooltip({ group, placeName }: { group: Group; placeName: string }) {
  const { offer } = group;
  return (
    <div style={{ padding: "16px" }}>
      {/* Label: which place was hovered */}
      <p style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)", marginBottom: "6px" }}>
        {placeName}
      </p>

      {/* Package name */}
      <p style={{ fontFamily: "var(--font-display)", fontSize: "20px", fontWeight: 400, color: "var(--text)", lineHeight: 1.1, marginBottom: "4px" }}>
        {group.packageName}
      </p>

      {/* Group tagline */}
      {group.tagline && (
        <p style={{ fontSize: "11.5px", color: "var(--muted)", lineHeight: 1.45, marginBottom: "12px" }}>
          {group.tagline}
        </p>
      )}

      {offer && (
        <>
          {/* Price + days */}
          {(offer.days || offer.price_from_usd) && (
            <div style={{ display: "flex", gap: "12px", marginBottom: "10px" }}>
              {offer.days && (
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)" }}>
                  {offer.days} days
                </span>
              )}
              {offer.price_from_usd && (
                <span style={{ fontSize: "12px", color: "var(--accent)", fontWeight: 600 }}>
                  from ₹{offer.price_from_usd.toLocaleString("en-IN")}
                  {!offer.price_includes_flight && (
                    <span style={{ color: "var(--muted)", fontWeight: 400 }}> + flights</span>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Highlights */}
          {offer.highlights && offer.highlights.length > 0 && (
            <>
              <div style={{ height: "1px", background: "rgba(255,255,255,0.08)", marginBottom: "10px" }} />
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {offer.highlights.slice(0, 3).map((h) => (
                  <li key={h} style={{ display: "flex", gap: "7px", alignItems: "flex-start", marginBottom: "5px" }}>
                    <span style={{ fontSize: "9px", color: "var(--accent)", marginTop: "3px", flexShrink: 0 }}>▸</span>
                    <span style={{ fontSize: "11px", color: "var(--muted)", lineHeight: 1.4 }}>{h}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {/* CTA */}
      <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--accent)" }}>
          View package
        </span>
        <span style={{ fontSize: "13px", color: "var(--accent)" }}>→</span>
      </div>
    </div>
  );
}

/* ── Per-place image card ─────────────────────────────── */
function PlaceTooltip({ name, imageUrl, description }: { name: string; imageUrl: string; description: string }) {
  return (
    <>
      {/* Photo */}
      <div style={{ position: "relative", height: "144px", overflow: "hidden" }}>
        <img
          src={imageUrl}
          alt={name}
          loading="eager"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(to bottom, transparent 45%, rgba(9,24,28,0.65) 100%)",
          }}
        />
      </div>

      {/* Body */}
      <div style={{ padding: "11px 14px 14px" }}>
        <p style={{ fontFamily: "var(--font-display)", fontSize: "17px", fontWeight: 400, color: "var(--text)", lineHeight: 1.15, marginBottom: "6px" }}>
          {name}
        </p>
        <p style={{ fontSize: "11.5px", color: "var(--muted)", lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {description}
        </p>
        <div style={{ marginTop: "10px", paddingTop: "9px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--accent)" }}>
            Explore
          </span>
          <span style={{ fontSize: "13px", color: "var(--accent)" }}>→</span>
        </div>
      </div>
    </>
  );
}
