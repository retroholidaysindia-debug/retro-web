"use client";

import Link from "next/link";
import type { Group } from "@/content/schema";
import { useHorizontalScroll } from "@/lib/use-horizontal-scroll";
import { ScrollArrowButton } from "@/components/ui/ScrollArrowButton";
import { formatPrice } from "@/lib/trips";

export type PackageCardData = Group & { coverImage: string };

type Props = {
  destinationSlug: string;
  packages: PackageCardData[];
};

// Horizontally scrolling row of package cards, with always-visible prev/next
// arrows — not just touch/trackpad swipe — so the row is scrollable on every
// screen size, including mouse-only desktops at a narrower viewport.
export function PackagesRow({ destinationSlug, packages }: Props) {
  const { scrollerRef, atStart, atEnd, nudge } = useHorizontalScroll<HTMLDivElement>();

  return (
    <div className="flex items-center gap-2">
      <ScrollArrowButton dir="left" onClick={() => nudge(-1)} disabled={atStart} label="Scroll packages left" />

      <div
        ref={scrollerRef}
        className="no-scrollbar flex flex-1 gap-4 overflow-x-auto scroll-smooth pb-2"
        role="list"
      >
        {packages.map((pkg) => (
          <div key={pkg.id} role="listitem" className="contents">
            <Link
              href={`/destinations/${destinationSlug}/packages/${pkg.packageSlug}`}
              className="group flex w-48 shrink-0 flex-col overflow-hidden rounded-2xl border transition-colors duration-200 hover:border-[var(--accent)] sm:w-56"
              style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
            >
              <div className="relative aspect-[4/3] overflow-hidden">
                <img
                  src={pkg.coverImage}
                  alt={pkg.packageName}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
                {pkg.offer?.price_from_usd && (
                  <div
                    className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur-md"
                    style={{ background: "rgba(3,12,14,0.55)", color: "var(--accent)" }}
                  >
                    from {formatPrice(pkg.offer.price_from_usd)}
                    {!pkg.offer.price_includes_flight && (
                      <span style={{ color: "var(--muted)" }}> + flights</span>
                    )}
                  </div>
                )}
                {/* Hover overlay — transparent scrim with a centered Explore action */}
                <div
                  className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  style={{ background: "rgba(3,12,14,0.45)" }}
                >
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
                    style={{ background: "var(--accent)", color: "var(--deep)" }}
                  >
                    View package
                    <span aria-hidden="true">→</span>
                  </span>
                </div>
              </div>
              <div className="flex flex-1 flex-col p-3">
                <h3 className="font-display text-base leading-tight">{pkg.packageName}</h3>
                {pkg.tagline && (
                  <p className="mt-1 text-xs leading-snug" style={{ color: "var(--muted)" }}>
                    {pkg.tagline}
                  </p>
                )}
                <p className="mt-auto pt-3 text-[11px]" style={{ color: "var(--muted)" }}>
                  {pkg.places.length} {pkg.places.length === 1 ? "place" : "places"} ·{" "}
                  {pkg.offer?.days ? `${pkg.offer.days} days` : "Flexible"}
                </p>
              </div>
            </Link>
          </div>
        ))}
      </div>

      <ScrollArrowButton dir="right" onClick={() => nudge(1)} disabled={atEnd} label="Scroll packages right" />
    </div>
  );
}
