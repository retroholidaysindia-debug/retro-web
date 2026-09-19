import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PackagesRow, type PackageCardData } from "@/components/destinations/PackagesRow";

const pkg = (id: number, packageName: string, packageSlug: string): PackageCardData => ({
  id,
  name: packageName,
  packageName,
  packageSlug,
  places: ["Place A", "Place B"],
  tagline: `Tagline for ${packageName}`,
  offer: { days: 7, price_from_usd: 50000 },
  coverImage: `/packages/placeholders/placeholder-${id}.webp`,
});

const packages = [pkg(1, "Alpha Package", "alpha-package"), pkg(2, "Beta Package", "beta-package")];

describe("PackagesRow", () => {
  it("renders one linked card per package, going to its package page", () => {
    render(<PackagesRow destinationSlug="testland" packages={packages} />);
    const link = screen.getByRole("link", { name: /Alpha Package/ });
    expect(link).toHaveAttribute("href", "/destinations/testland/packages/alpha-package");
  });

  it("shows the price, tagline and places/duration summary for each package", () => {
    render(<PackagesRow destinationSlug="testland" packages={packages} />);
    const link = screen.getByRole("link", { name: /Beta Package/ });
    expect(link).toHaveTextContent("Tagline for Beta Package");
    expect(link).toHaveTextContent("from ₹50,000");
    expect(link).toHaveTextContent("2 places");
    expect(link).toHaveTextContent("7 days");
  });

  it("always renders left/right scroll arrow buttons regardless of viewport", () => {
    render(<PackagesRow destinationSlug="testland" packages={packages} />);
    expect(screen.getByRole("button", { name: /scroll packages left/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /scroll packages right/i })).toBeInTheDocument();
  });

  it("disables the left arrow at the start of the row (jsdom scrollLeft defaults to 0)", () => {
    render(<PackagesRow destinationSlug="testland" packages={packages} />);
    expect(screen.getByRole("button", { name: /scroll packages left/i })).toBeDisabled();
  });

  it("clicking either scroll arrow does not throw", () => {
    render(<PackagesRow destinationSlug="testland" packages={packages} />);
    const leftArrow = screen.getByRole("button", { name: /scroll packages left/i });
    const rightArrow = screen.getByRole("button", { name: /scroll packages right/i });
    expect(() => rightArrow.click()).not.toThrow();
    expect(() => leftArrow.click()).not.toThrow();
  });

  it("says airfare is extra when the published price is land-only", () => {
    // The agency's "from" prices exclude the flight, so a bare "from ₹50,000"
    // would read as all-in and undercut the real cost of the trip.
    render(<PackagesRow destinationSlug="testland" packages={packages} />);
    expect(screen.getByRole("link", { name: /Alpha Package/ })).toHaveTextContent("from ₹50,000 + flights");
  });

  it("drops the airfare caveat for a package whose price already includes it", () => {
    const allIn = [{ ...pkg(3, "Gamma Package", "gamma-package"), offer: { days: 7, price_from_usd: 50000, price_includes_flight: true } }];
    render(<PackagesRow destinationSlug="testland" packages={allIn} />);
    const link = screen.getByRole("link", { name: /Gamma Package/ });
    expect(link).toHaveTextContent("from ₹50,000");
    expect(link).not.toHaveTextContent("+ flights");
  });
});
