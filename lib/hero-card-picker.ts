import type { HeroCardRegion } from "@/content/schema";

// The fully resolved shape a rendered hero card needs — one region's card
// info flattened together with the region-level metadata (palette, rating,
// destination slug) that every card in that region shares. Media (clip +
// poster) is per-card, not per-region, so each country/state can point at
// its own footage as real assets are uploaded.
//
// Deliberately isolated from lib/hero-cards.ts (which reads the JSON file via
// node:fs) — this module is imported by client components (AtlasScene,
// MediaLayer, CardRail), and bundling a node:fs import into client code
// breaks the Turbopack build ("chunking context does not support external
// modules"). Keep anything client-safe (pure data shaping, no fs/path) here.
export type HeroCard = {
  destinationSlug: string;
  destinationName: string;
  region: string;
  country: string;
  placeSlug: string;
  packageSlug: string;
  headline: string;
  tagline: string;
  buttonLabel: string;
  rating: number;
  palette: { accent: string; deep: string };
  media: { clip: string; poster: string };
};

function flatten(region: HeroCardRegion, cardIndex: number): HeroCard {
  const card = region.cards[cardIndex];
  return {
    destinationSlug: region.destinationSlug,
    destinationName: region.destinationName,
    region: region.region,
    country: card.country,
    placeSlug: card.placeSlug,
    packageSlug: card.packageSlug,
    headline: card.headline,
    tagline: card.tagline,
    buttonLabel: card.buttonLabel,
    rating: region.rating,
    palette: region.palette,
    media: card.media,
  };
}

// Deterministic pick (always the first card per region) — used as the
// server-rendered / pre-hydration default so markup matches on both sides.
export function defaultHeroCards(regions: HeroCardRegion[]): HeroCard[] {
  return regions.map((region) => flatten(region, 0));
}

// One random card per region — call this client-side only (e.g. in a
// useEffect after mount) so each fresh page load shows a different country
// per region without causing a server/client hydration mismatch.
export function pickRandomHeroCards(regions: HeroCardRegion[]): HeroCard[] {
  return regions.map((region) => flatten(region, Math.floor(Math.random() * region.cards.length)));
}
