import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AtlasScene } from "@/components/atlas/AtlasScene";
import type { HeroCardRegion } from "@/content/schema";

// One card per region in the fixture so the random pick is deterministic
// (Math.random() * 1 always selects index 0) — keeps assertions stable
// without needing to stub Math.random.
const region = (slug: string, name: string, country: string): HeroCardRegion => ({
  region: `${name} Region`,
  destinationSlug: slug,
  destinationName: name,
  rating: 4.6,
  palette: { accent: "#ffffff", deep: "#000000" },
  cards: [
    {
      country,
      placeSlug: "x",
      packageSlug: "pkg-x",
      headline: `Headline for ${name}`,
      tagline: `Tagline for ${name}`,
      buttonLabel: `View ${country}`,
      media: { clip: slug, poster: slug },
    },
  ],
});

const heroCardRegions = [region("kashmir", "Kashmir", "Kashmir"), region("bali", "Bali", "Bali")];

describe("AtlasScene", () => {
  it("renders the active card's headline and tagline in the hero panel", () => {
    render(<AtlasScene heroCardRegions={heroCardRegions} />);
    const panel = screen.getByTestId("hero-panel");
    expect(within(panel).getByRole("heading", { name: "Headline for Kashmir" })).toBeInTheDocument();
    expect(within(panel).getByText("Tagline for Kashmir")).toBeInTheDocument();
  });

  it("renders the card rail with exactly one card per region", () => {
    render(<AtlasScene heroCardRegions={heroCardRegions} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders a View-country action linking to that country's package page", () => {
    render(<AtlasScene heroCardRegions={heroCardRegions} />);
    const panel = screen.getByTestId("hero-panel");
    const cta = within(panel).getByRole("link", { name: /view kashmir/i });
    expect(cta).toHaveAttribute("href", "/destinations/kashmir/packages/pkg-x");
  });

  it("renders the hero as a normal single-viewport section, not a tall scroll-spacer", () => {
    render(<AtlasScene heroCardRegions={heroCardRegions} />);
    const section = screen.getByTestId("hero-panel").closest("section");
    expect(section).toHaveClass("h-screen");
  });
});
