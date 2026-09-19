"use client";

import { useEffect, useState } from "react";
import type { HeroCardRegion } from "@/content/schema";
import { defaultHeroCards, pickRandomHeroCards, type HeroCard } from "@/lib/hero-card-picker";
import { useHeroCarousel } from "@/lib/hero-carousel";
import { MediaLayer } from "./MediaLayer";
import { CardRail } from "./CardRail";
import { Button } from "@/components/ui/Button";

type Props = { heroCardRegions: HeroCardRegion[] };

export function AtlasScene({ heroCardRegions }: Props) {
  // Deterministic default (first card per region) so the server-rendered and
  // pre-hydration client markup match exactly; the effect below reshuffles to
  // a random country per region right after mount, so every fresh page load
  // (a real browser reload re-runs this client JS) shows a different pick.
  const [cards, setCards] = useState<HeroCard[]>(() => defaultHeroCards(heroCardRegions));

  useEffect(() => {
    // This is a deliberate one-time client-only randomization (not state
    // derived from props/state available during render), matching the same
    // default-then-correct pattern already used by usePrefersReducedMotion
    // (lib/reduced-motion.ts) for the same SSR/hydration-safety reason.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCards(pickRandomHeroCards(heroCardRegions));
    // Runs once per mount, deliberately not on every heroCardRegions
    // re-render — this data is static content, not something that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { activeIndex, inView, sectionRef, select, handleVideoEnded } = useHeroCarousel(cards.length);
  const active = cards[activeIndex];

  return (
    <section
      ref={sectionRef}
      className="relative h-screen min-h-[720px] w-full overflow-hidden"
      style={{ background: active.palette.deep }}
    >
      <MediaLayer
        cards={cards}
        activeIndex={activeIndex}
        inView={inView}
        onVideoEnded={handleVideoEnded}
      />

      {/* Legibility scrim over the full-bleed media — no panel behind the copy */}
      <div className="scrim-hero pointer-events-none absolute inset-0 z-[5]" aria-hidden="true" />

      {/* Hero copy — sits directly on the media, no background box */}
      <div
        className="absolute left-6 top-32 z-10 max-w-xl md:left-12 md:top-36"
        data-testid="hero-panel"
      >
        <p
          className="mb-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em]"
          style={{ color: "var(--accent)" }}
        >
          <span className="inline-block h-px w-8" style={{ background: "var(--accent)" }} />
          {active.region}
        </p>
        <h2
          className="font-display text-4xl leading-[1.0] sm:text-5xl md:text-6xl"
          style={{ color: "var(--text)", textShadow: "0 2px 30px rgba(0,0,0,0.55)" }}
        >
          {active.headline}
        </h2>
        <p
          className="mt-4 max-w-md text-base md:text-lg"
          style={{ color: "rgba(242,247,246,0.86)", textShadow: "0 1px 12px rgba(0,0,0,0.6)" }}
        >
          {active.tagline}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button href="/destinations">
            Explore Destinations
            <span aria-hidden="true">→</span>
          </Button>
          <Button href={`/destinations/${active.destinationSlug}/packages/${active.packageSlug}`} variant="ghost">
            {active.buttonLabel}
          </Button>
        </div>
      </div>

      {/* Bottom region: card rail */}
      <div className="absolute inset-x-0 bottom-0 z-30 px-4 pb-5 md:px-12 md:pb-8">
        <CardRail cards={cards} activeIndex={activeIndex} onSelect={select} />
      </div>
    </section>
  );
}
