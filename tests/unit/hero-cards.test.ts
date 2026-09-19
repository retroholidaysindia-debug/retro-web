import { describe, it, expect } from "vitest";
import { loadHeroCardRegions } from "@/lib/hero-cards";
import { defaultHeroCards, pickRandomHeroCards } from "@/lib/hero-card-picker";

describe("hero-cards content", () => {
  it("loads one region entry per destination with at least one card each", () => {
    const regions = loadHeroCardRegions();
    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) {
      expect(region.cards.length).toBeGreaterThan(0);
    }
  });

  it("every card has a non-empty headline, tagline, button label, place slug, package slug and its own media", () => {
    const regions = loadHeroCardRegions();
    for (const region of regions) {
      for (const card of region.cards) {
        expect(card.headline.length).toBeGreaterThan(0);
        expect(card.tagline.length).toBeGreaterThan(0);
        expect(card.buttonLabel.length).toBeGreaterThan(0);
        expect(card.placeSlug).toMatch(/^[a-z0-9-]+$/);
        expect(card.packageSlug).toMatch(/^[a-z0-9-]+$/);
        expect(card.media.clip.length).toBeGreaterThan(0);
        expect(card.media.poster.length).toBeGreaterThan(0);
      }
    }
  });

  it("defaultHeroCards returns exactly one card per region, deterministically the first", () => {
    const regions = loadHeroCardRegions();
    const cards = defaultHeroCards(regions);
    expect(cards).toHaveLength(regions.length);
    cards.forEach((card, i) => {
      expect(card.country).toBe(regions[i].cards[0].country);
    });
  });

  it("pickRandomHeroCards returns exactly one card per region, each a valid option for that region", () => {
    const regions = loadHeroCardRegions();
    const cards = pickRandomHeroCards(regions);
    expect(cards).toHaveLength(regions.length);
    cards.forEach((card, i) => {
      const validCountries = regions[i].cards.map((c) => c.country);
      expect(validCountries).toContain(card.country);
      expect(card.destinationSlug).toBe(regions[i].destinationSlug);
      expect(card.region).toBe(regions[i].region);
    });
  });

  it("india's region has a card for many distinct states", () => {
    const regions = loadHeroCardRegions();
    const india = regions.find((r) => r.destinationSlug === "india");
    expect(india).toBeDefined();
    expect(india!.cards.length).toBeGreaterThanOrEqual(20);
  });
});
