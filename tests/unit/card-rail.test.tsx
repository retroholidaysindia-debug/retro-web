import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CardRail } from "@/components/atlas/CardRail";
import type { HeroCard } from "@/lib/hero-card-picker";

afterEach(() => {
  vi.restoreAllMocks();
});

const card = (destinationSlug: string, country: string, region: string): HeroCard => ({
  destinationSlug,
  destinationName: country,
  region,
  country,
  placeSlug: "alpha",
  packageSlug: "alpha-package",
  headline: `Headline for ${country}`,
  tagline: `Tagline for ${country}`,
  buttonLabel: `View ${country}`,
  rating: 4.7,
  palette: { accent: "#ffffff", deep: "#000000" },
  media: { clip: destinationSlug, poster: destinationSlug },
});

// One card per region — exactly what CardRail renders (no per-country fan-out).
const cards = [
  card("kashmir", "Kashmir", "Asia"),
  card("bali", "Bali", "Asia"),
  card("dubai", "Dubai", "Middle East"),
];

describe("CardRail", () => {
  it("renders exactly one card per region", () => {
    render(<CardRail cards={cards} activeIndex={0} onSelect={vi.fn()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows the region on top and the country label below, linking to that country's package page", () => {
    render(<CardRail cards={cards} activeIndex={0} onSelect={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Bali/ });
    expect(within(link).getByText("Asia")).toBeInTheDocument();
    expect(within(link).getByText("Bali")).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/destinations/bali/packages/alpha-package");
  });

  it("marks the active card distinctly", () => {
    render(<CardRail cards={cards} activeIndex={0} onSelect={vi.fn()} />);
    const activeLink = screen.getByRole("link", { name: /Kashmir/ });
    expect(activeLink).toHaveAttribute("aria-current", "true");
  });

  it("renders each card's poster image and star rating", () => {
    render(<CardRail cards={cards} activeIndex={0} onSelect={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Bali/ });
    expect(link.querySelector("img")).toHaveAttribute("src", "/media/bali/poster.webp");
    expect(link).toHaveTextContent("4.7");
  });

  it("calls onSelect with the card index and prevents default navigation on click", () => {
    const onSelect = vi.fn();
    render(<CardRail cards={cards} activeIndex={0} onSelect={onSelect} />);
    const link = screen.getByRole("link", { name: /Bali/ });
    const event = fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(event).toBe(false);
  });

  it("re-syncs the active card when activeIndex changes externally", () => {
    const { rerender } = render(<CardRail cards={cards} activeIndex={0} onSelect={vi.fn()} />);
    rerender(<CardRail cards={cards} activeIndex={2} onSelect={vi.fn()} />);
    const activeLink = screen.getByRole("link", { name: /Dubai/ });
    expect(activeLink).toHaveAttribute("aria-current", "true");
  });

  it("lazy-loads card thumbnail images", () => {
    render(<CardRail cards={cards} activeIndex={0} onSelect={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Bali/ });
    const img = link.querySelector("img");
    expect(img).toHaveAttribute("loading", "lazy");
  });
});
