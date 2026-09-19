import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CoreBundle, type DestinationBundle, type Route, type VisaRule } from "@/lib/atlas/schema";
import { generateQuotation, STYLE_FOR_TRAVELLER } from "@/lib/atlas/engine";
import { QuoteRequest } from "@/lib/atlas/engine/types";
import { QuotationView } from "@/components/plan/QuotationView";

const DIR = path.join("public", "atlas");
const core = CoreBundle.parse(JSON.parse(readFileSync(path.join(DIR, "core.json"), "utf8")));
const routes = (JSON.parse(readFileSync(path.join(DIR, "routes.json"), "utf8")) as { routes: Route[] }).routes;
const visaRules = (JSON.parse(readFileSync(path.join(DIR, "visa.json"), "utf8")) as { rules: VisaRule[] }).rules;

function bundlesFor(placeIds: string[]): Map<string, DestinationBundle> {
  const map = new Map<string, DestinationBundle>();
  for (const id of placeIds) {
    const place = core.places.find((p) => p.id === id);
    if (!place) continue;
    try {
      map.set(id, JSON.parse(readFileSync(path.join(DIR, "destinations", `${place.slug}.json`), "utf8")));
    } catch {
      /* no bundle for this place */
    }
  }
  return map;
}

function build(overrides: Partial<QuoteRequest> = {}) {
  const request = QuoteRequest.parse({
    placeIds: ["cairo", "luxor"],
    nights: 6,
    startDate: "2026-11-15",
    adults: 2,
    childAges: [],
    travellerType: "couple",
    tripStyle: STYLE_FOR_TRAVELLER.couple,
    nationality: "IND",
    departureCity: "DEL",
    hotelStar: "4 Star",
    hotelZone: "Central",
    carrier: "FSC",
    cabin: "Economy",
    mealPlan: "breakfast",
    food: "no-preference",
    pace: "balanced",
    includeVisa: true,
    includeInsurance: true,
    includeFlight: true,
    ...overrides,
  });
  const quote = generateQuotation(request, { core, routes, visaRules, bundles: bundlesFor(request.placeIds) });
  return { request, quote };
}

/**
 * The row for one cost component in the flat price breakdown.
 *
 * Scoped to the label span rather than a bare text query, because the same
 * words ("Flights", "Travel insurance") also appear in the trip options above
 * and would match several nodes.
 */
function group(container: HTMLElement, label: string): HTMLElement {
  const labels = [...container.querySelectorAll("span.font-medium")];
  const hit = labels.find((s) => s.textContent?.trim().startsWith(label));
  if (!hit || !hit.parentElement) {
    throw new Error(
      `No breakdown row for "${label}". Found: ${labels
        .map((s) => JSON.stringify(s.textContent?.replace(/\s+/g, " ").trim()))
        .join(", ")}`,
    );
  }
  return hit.parentElement;
}

function renderQuote(overrides: Partial<QuoteRequest> = {}) {
  const { request, quote } = build(overrides);
  const { container } = render(
    <QuotationView quote={quote} request={request} onChange={() => {}} onBack={() => {}} />,
  );
  return { quote, container };
}

describe("quotation breakdown inclusion tags", () => {
  it("marks the structural land package as included", () => {
    const { container } = renderQuote();
    for (const label of ["Accommodation", "Airport transfers", "Intercity transport", "City & tourism tax"]) {
      expect(group(container, label)).toHaveTextContent(/Included/i);
    }
  });

  it("marks everything the traveller can drop as optional", () => {
    const { container } = renderQuote();
    for (const label of ["Flights", "Sightseeing & entrances", "Visa support", "Travel insurance"]) {
      expect(group(container, label)).toHaveTextContent(/Optional/i);
    }
  });

  it("never labels a component both included and optional", () => {
    const { container } = renderQuote();
    for (const label of ["Accommodation", "Flights", "Travel insurance"]) {
      const text = group(container, label).textContent ?? "";
      expect(/Included/i.test(text) && /Optional/i.test(text)).toBe(false);
    }
  });

  it("offers a remove control on the components that are a single yes/no", () => {
    const { container } = renderQuote();
    for (const label of ["Flights", "Visa support", "Travel insurance"]) {
      expect(within(group(container, label)).getByRole("button", { name: /remove/i })).toBeInTheDocument();
    }
  });

  it("offers no toggle where the component is tuned elsewhere, rather than a control that would not work", () => {
    const { container } = renderQuote();
    // Sightseeing is dropped outing-by-outing in the day plan, so a single
    // remove button here would be a lie.
    expect(within(group(container, "Sightseeing & entrances")).queryByRole("button")).toBeNull();
  });

  it("keeps a switched-off component visible and addable instead of dropping it from the bill", () => {
    // The gap this closes: with no line items the group used to vanish, so
    // "not charged for" was indistinguishable from "not offered".
    const { quote, container } = renderQuote({ includeFlight: false });
    expect(quote.lineItems.some((i) => i.component === "flight")).toBe(false);

    const flights = group(container, "Flights");
    expect(flights).toHaveTextContent(/not in this quote/i);
    expect(within(flights).getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });
});
