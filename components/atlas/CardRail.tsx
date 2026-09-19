"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { HeroCard } from "@/lib/hero-card-picker";
import { useHorizontalScroll } from "@/lib/use-horizontal-scroll";
import { ScrollArrowButton } from "@/components/ui/ScrollArrowButton";

type Props = {
  cards: HeroCard[];
  activeIndex: number;
  onSelect: (index: number) => void;
};

// One card per region — text reads region on top, country (whichever one was
// randomly picked for that region on this page load) below. Each card links
// straight to that country's own place/package page.
export function CardRail({ cards, activeIndex, onSelect }: Props) {
  const cardRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const isFirstRender = useRef(true);
  const { scrollerRef, atStart, atEnd, nudge } = useHorizontalScroll<HTMLDivElement>();

  useEffect(() => {
    // Skip on initial mount so the leading card isn't clipped; only react to
    // subsequent activeCardIndex changes (card clicks, video-ended auto-advance).
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // Scroll ONLY the horizontal rail — never call scrollIntoView, which also
    // scrolls every ancestor (including the window) and would drag the whole
    // page down to the rail each time the active card changes.
    const scroller = scrollerRef.current;
    const card = cardRefs.current[activeIndex];
    if (!scroller || !card) return;
    const target = card.offsetLeft - (scroller.clientWidth - card.clientWidth) / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [activeIndex, scrollerRef]);

  return (
    <div>
      <div className="mb-3 flex items-end justify-between px-1">
        <p className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text)" }}>
          Popular Destinations
        </p>
        <Link
          href="/destinations"
          className="text-sm font-medium transition-colors hover:brightness-110"
          style={{ color: "var(--accent)" }}
        >
          View all
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <ScrollArrowButton dir="left" onClick={() => nudge(-1, 260)} disabled={atStart} label="Scroll destinations left" />

        <div
          ref={scrollerRef}
          className="no-scrollbar flex flex-1 gap-4 overflow-x-auto scroll-smooth py-2"
          role="list"
        >
          {cards.map((card, i) => {
            const isActive = i === activeIndex;
            const key = `${card.destinationSlug}-${card.placeSlug}`;
            const href = `/destinations/${card.destinationSlug}/packages/${card.packageSlug}`;
            return (
              <div key={key} role="listitem" className="contents">
                <Link
                  ref={(el) => {
                    cardRefs.current[i] = el;
                  }}
                  href={href}
                  aria-current={isActive ? "true" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    onSelect(i);
                  }}
                  className="relative h-44 w-40 shrink-0 overflow-hidden rounded-2xl border transition-all duration-300 active:scale-[0.96] active:brightness-90"
                  style={{
                    borderColor: isActive ? card.palette.accent : "var(--hairline)",
                    borderWidth: isActive ? 2 : 1,
                    transform: isActive ? "translateY(-8px)" : "none",
                    boxShadow: isActive
                      ? `0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px ${card.palette.accent}55`
                      : "0 10px 24px rgba(0,0,0,0.35)",
                  }}
                >
                  <img
                    src={`/media/${card.media.poster}/poster.webp`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <div className="card-overlay absolute inset-0" aria-hidden="true" />

                  <div
                    className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur-md"
                    style={{ background: "rgba(3,12,14,0.55)", color: "var(--accent)" }}
                  >
                    <span aria-hidden="true">★</span>
                    {card.rating.toFixed(1)}
                  </div>

                  <div className="absolute inset-x-0 bottom-0 p-3">
                    <p className="text-[11px] uppercase tracking-wide" style={{ color: "rgba(242,247,246,0.75)" }}>
                      {card.region}
                    </p>
                    <p className="font-display text-xl leading-tight" style={{ color: "var(--text)" }}>
                      {card.country}
                    </p>
                  </div>
                </Link>
              </div>
            );
          })}
        </div>

        <ScrollArrowButton dir="right" onClick={() => nudge(1, 260)} disabled={atEnd} label="Scroll destinations right" />
      </div>
    </div>
  );
}
