"use client";

import { useState } from "react";
import { placeSlug } from "@/lib/trips";
import type { Group, Marker } from "@/content/schema";
import { DestinationExplorer } from "./DestinationExplorer";

type Props = {
  destinationSlug: string;
  mapSvg: string;
  groups: Group[];
  markers: Marker[];
};

export function DestinationMapSection({ destinationSlug, mapSvg, groups, markers }: Props) {
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  const markerGroups: Record<string, number> = {};
  for (const m of markers) {
    if (m.group != null) markerGroups[placeSlug(m.name)] = m.group;
  }

  const toggle = (id: number) =>
    setSelectedGroupId((prev) => (prev === id ? null : id));

  return (
    <div>
      {/* Group filter chips */}
      {groups.length > 0 && (
        <div className="no-scrollbar mb-5 flex gap-2 overflow-x-auto pb-1">
          {groups.map((g) => {
            const active = g.id === selectedGroupId;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => toggle(g.id)}
                className="shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wide transition-all duration-200 sm:px-4 sm:py-1.5 sm:text-xs"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--hairline)",
                  background: active ? "rgba(111,227,196,0.12)" : "transparent",
                  color: active ? "var(--accent)" : "var(--muted)",
                }}
              >
                {g.name}
                {g.offer?.price_from_usd && (
                  <span
                    className="ml-1.5 hidden font-normal sm:ml-2 sm:inline"
                    style={{ color: active ? "var(--accent)" : "var(--muted)", opacity: 0.7 }}
                  >
                    from ₹{g.offer.price_from_usd.toLocaleString("en-IN")}
                    {!g.offer.price_includes_flight && " + flights"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <DestinationExplorer
        destinationSlug={destinationSlug}
        mapSvg={mapSvg}
        groups={groups}
        markerGroups={markerGroups}
        selectedGroupId={selectedGroupId ?? undefined}
      />
    </div>
  );
}
