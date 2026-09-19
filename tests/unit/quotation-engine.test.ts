import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CoreBundle, type DestinationBundle, type Route, type TravellerType, type TripStyle, type VisaRule } from "@/lib/atlas/schema";
import { generateQuotation, STYLE_FOR_TRAVELLER } from "@/lib/atlas/engine";
import { QuoteRequest } from "@/lib/atlas/engine/types";
import { allocateNights, matchReferencePackage, sequencePlaces, buildRouteLookup } from "@/lib/atlas/engine/itinerary";
import { dayBudget } from "@/lib/atlas/engine/dayplan";
import { plausibleModes } from "@/lib/atlas/engine/geo";
import { evaluateRule, type RuleFacts } from "@/lib/atlas/engine/rules";
import { resolvePax, resolveRate, seasonMultiplier, vehiclePlan } from "@/lib/atlas/engine/pricing";
import {
  computeNightsBounds,
  evaluatePlaceSelectability,
  filterRealisticSelection,
  hotelStarForStyle,
  isHotelStarAvailable,
} from "@/lib/atlas/engine/bounds";
import policy from "@/content/quote-policy.json";

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

function request(overrides: Partial<QuoteRequest> & Pick<QuoteRequest, "placeIds" | "nights">): QuoteRequest {
  return QuoteRequest.parse({
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
}

function quote(overrides: Partial<QuoteRequest> & Pick<QuoteRequest, "placeIds" | "nights">) {
  const req = request(overrides);
  return generateQuotation(req, { core, routes, visaRules, bundles: bundlesFor(req.placeIds) });
}

describe("compiled data", () => {
  it("covers every place with a rate card", () => {
    expect(core.places.length).toBeGreaterThan(400);
    expect(core.places.every((p) => p.hasRates)).toBe(true);
  });

  it("carries every published package with a price", () => {
    expect(core.packages.length).toBeGreaterThan(70);
    expect(core.packages.every((p) => p.priceFromInr > 0)).toBe(true);
    expect(core.packages.every((p) => p.placeIds.length > 0)).toBe(true);
    expect(core.packages.every((p) => p.countryIds.length > 0)).toBe(true);
  });

  it("marks every published price as land-only, since the master file excludes airfare", () => {
    // The agency's "from" prices cover the land package and quote the flight
    // on top. If this ever flips silently, the engine's package floor would
    // compare a land-only quote against an all-in price and under-quote.
    expect(core.packages.every((p) => p.priceIncludesFlight === false)).toBe(true);
  });

  it("models India as one country with states under subregions", () => {
    const india = core.countries.filter((c) => c.regionId === "india");
    expect(india).toHaveLength(1);
    expect(india[0].name).toBe("India");
    expect(core.states.length).toBeGreaterThan(20);
    expect(core.states.every((s) => s.countryId === india[0].id)).toBe(true);
    expect(core.subregions.map((s) => s.name).sort()).toEqual([
      "North India", "South India", "West India",
    ]);
  });

  it("gives each country exactly one row", () => {
    const names = core.countries.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("lets a package span several countries", () => {
    const kailash = core.packages.find((p) => /kailash/i.test(p.name));
    expect(kailash).toBeDefined();
    const names = kailash!.countryIds.map(
      (id) => core.countries.find((c) => c.id === id)?.name,
    );
    expect(names).toContain("Nepal");
    expect(names).toContain("China");
  });

  it("assigns a cross-border route's places to the right country", () => {
    const countryOf = (placeName: string) => {
      const place = core.places.find((p) => p.name === placeName);
      return core.countries.find((c) => c.id === place?.countryId)?.name;
    };
    // The Kailash route crosses into Tibet at Kerung; billing those nights to
    // Nepal would silently drop the China visa from the quotation.
    expect(countryOf("Kathmandu")).toBe("Nepal");
    expect(countryOf("Lake Mansarovar")).toBe("China");
    expect(countryOf("Dolma La Pass")).toBe("China");
  });

  it("resolves every reference", () => {
    const countryIds = new Set(core.countries.map((c) => c.id));
    const stateIds = new Set(core.states.map((s) => s.id));
    const placeIds = new Set(core.places.map((p) => p.id));
    for (const p of core.places) {
      expect(countryIds.has(p.countryId)).toBe(true);
      if (p.stateId) expect(stateIds.has(p.stateId)).toBe(true);
    }
    for (const pkg of core.packages) {
      for (const id of pkg.placeIds) expect(placeIds.has(id)).toBe(true);
      for (const id of pkg.countryIds) expect(countryIds.has(id)).toBe(true);
      for (const id of pkg.stateIds) expect(stateIds.has(id)).toBe(true);
    }
  });

  it("gives every place exactly four star ratings in two zones", () => {
    const cairo = core.hotelRates.filter((r) => r.placeId === "cairo");
    expect(cairo).toHaveLength(8);
    expect(new Set(cairo.map((r) => r.star)).size).toBe(4);
    expect(new Set(cairo.map((r) => r.zone)).size).toBe(2);
  });

  it("derives airfare from real distance, per departure city", () => {
    const thailand = core.countries.find((c) => c.name === "Thailand")!;
    const fare = (origin: string) =>
      core.flightBands.find(
        (b) =>
          b.destCountryId === thailand.id &&
          b.originCity === origin &&
          b.carrier === "FSC" &&
          b.cabin === "Economy",
      )!;
    // Kolkata is materially closer to Bangkok than Delhi is, so it must be cheaper.
    expect(fare("CCU").priceLow).toBeLessThan(fare("DEL").priceLow);
    // A short haul must cost less than a long one from the same city.
    const uae = core.countries.find((c) => c.name === "UAE")!;
    const australia = core.countries.find((c) => c.name === "Australia")!;
    const from = (id: string) =>
      core.flightBands.find(
        (b) => b.destCountryId === id && b.originCity === "DEL" && b.carrier === "FSC" && b.cabin === "Economy",
      )!.priceLow;
    expect(from(uae.id)).toBeLessThan(from(australia.id));
  });

  it("prices low-cost carriers below full-service and skips their long-haul business cabin", () => {
    const uae = core.countries.find((c) => c.name === "UAE")!;
    const band = (carrier: "LCC" | "FSC") =>
      core.flightBands.find(
        (b) => b.destCountryId === uae.id && b.originCity === "BOM" && b.carrier === carrier && b.cabin === "Economy",
      )!;
    expect(band("LCC").priceLow).toBeLessThan(band("FSC").priceLow);
    expect(core.flightBands.some((b) => b.carrier === "LCC" && b.cabin === "Business")).toBe(false);
  });
});

describe("pax resolution", () => {
  it("puts two adults in one room", () => {
    expect(resolvePax(2, []).rooms).toBe(1);
  });

  it("opens a second room for a fifth adult", () => {
    expect(resolvePax(5, []).rooms).toBe(3);
  });

  it("treats an under-five as sharing, with no extra bed", () => {
    const pax = resolvePax(2, [3]);
    expect(pax.infants).toBe(1);
    expect(pax.extraBeds).toBe(0);
  });

  it("bills an extra bed for a school-age child", () => {
    const pax = resolvePax(2, [9]);
    expect(pax.children).toBe(1);
    expect(pax.extraBeds).toBe(1);
  });

  it("counts a teenager as an adult for rooming", () => {
    expect(resolvePax(2, [15]).rooms).toBe(2);
  });

  it("charges children a reduced share of activities", () => {
    expect(resolvePax(2, [9]).activityHeads).toBeCloseTo(2.6, 5);
  });
});

describe("vehicle amortisation", () => {
  it("uses one sedan for a couple", () => {
    expect(vehiclePlan(2)).toMatchObject({ count: 1, label: "Sedan" });
  });

  it("scales up rather than multiplying sedans", () => {
    expect(vehiclePlan(6).label).toBe("MPV");
    expect(vehiclePlan(20).label).toBe("Mini coach");
  });
});

describe("seasonality", () => {
  const summary = { monthPrice: { "1": 100, "6": 50, "12": 0 } } as never;

  it("is neutral at the midpoint index", () => {
    expect(seasonMultiplier(summary, 6)).toBeCloseTo(1, 5);
  });

  it("costs more in a peak month than a trough", () => {
    expect(seasonMultiplier(summary, 1)).toBeGreaterThan(seasonMultiplier(summary, 12));
  });

  it("stays inside the configured bounds", () => {
    expect(seasonMultiplier(summary, 1)).toBeLessThanOrEqual(1.35);
    expect(seasonMultiplier(summary, 12)).toBeGreaterThanOrEqual(0.85);
  });

  it("falls back to neutral without data", () => {
    expect(seasonMultiplier(undefined, 3)).toBe(1);
  });
});

describe("live-rate override", () => {
  const fresh = () => new Date().toISOString();

  it("keeps the baseline when no live rate is supplied", () => {
    expect(resolveRate(1000, "workbook", undefined, "hotel")).toEqual({ inr: 1000, source: "workbook" });
  });

  it("applies a volatility margin to an accepted live rate", () => {
    const out = resolveRate(1000, "workbook", { component: "hotel", key: "k", inr: 1100, fetchedAt: fresh() }, "hotel");
    expect(out.source).toBe("live");
    expect(out.inr).toBeCloseTo(1100 * 1.08, 5);
  });

  it("ignores a stale live rate", () => {
    const old = new Date(Date.now() - 72 * 3600_000).toISOString();
    const out = resolveRate(1000, "workbook", { component: "flight", key: "k", inr: 5, fetchedAt: old }, "flight");
    expect(out).toEqual({ inr: 1000, source: "workbook" });
  });

  it("clamps an implausible live rate instead of trusting it", () => {
    const out = resolveRate(1000, "workbook", { component: "flight", key: "k", inr: 100_000, fetchedAt: fresh() }, "flight");
    // Clamped to baseline * 1.6, then the flight margin applied.
    expect(out.inr).toBeCloseTo(1600 * 1.12, 5);
  });
});

describe("night allocation", () => {
  const summaries = new Map([
    ["a", { placeId: "a", minNights: 1, idealNights: 4, maxNights: 7, clusterCount: 6, activityCount: 9, styleScores: { culture: 90 }, monthPrice: {} }],
    ["b", { placeId: "b", minNights: 1, idealNights: 2, maxNights: 3, clusterCount: 2, activityCount: 3, styleScores: { culture: 60 }, monthPrice: {} }],
  ]);

  it("distributes exactly the nights requested", () => {
    const out = allocateNights(["a", "b"], 7, summaries as never, "culture");
    expect([...out.values()].reduce((x, y) => x + y, 0)).toBe(7);
  });

  it("favours the place with more to do", () => {
    const out = allocateNights(["a", "b"], 7, summaries as never, "culture");
    expect(out.get("a")!).toBeGreaterThan(out.get("b")!);
  });

  it("respects an explicit override", () => {
    const out = allocateNights(["a", "b"], 8, summaries as never, "culture", { b: 3 });
    expect(out.get("b")).toBe(3);
    expect(out.get("a")).toBe(5);
  });

  it("never exceeds a documented maximum", () => {
    const out = allocateNights(["a", "b"], 9, summaries as never, "culture");
    expect(out.get("b")!).toBeLessThanOrEqual(3);
  });
});

describe("routing", () => {
  const lookup = buildRouteLookup(routes);

  it("returns the same set of places it was given", () => {
    const input = ["cairo", "luxor", "alexandria"];
    expect([...sequencePlaces(input, lookup)].sort()).toEqual([...input].sort());
  });

  it("handles a single place", () => {
    expect(sequencePlaces(["cairo"], lookup)).toEqual(["cairo"]);
  });

  it("finds a connection between two places in the same country", () => {
    expect(lookup.best("cairo", "luxor")).not.toBeNull();
  });

  it("reports no connection between unlinked places", () => {
    expect(lookup.best("cairo", "not-a-place")).toBeNull();
  });
});

describe("geographic routing", () => {
  const lookup = buildRouteLookup(routes, core.places, core.countries);

  it("locates virtually every place", () => {
    // The engine reasons about distance now, so an unlocated place silently
    // degrades every leg touching it.
    const located = core.places.filter((p) => p.lat != null && p.lon != null);
    expect(located.length / core.places.length).toBeGreaterThan(0.95);
  });

  it("gives each place its own coordinate", () => {
    // Several Kerala towns used to inherit Kochi airport's coordinate because
    // they all list it as their nearest airport, which put Alleppey,
    // Thekkady and Kanyakumari on one point and made every distance between
    // them zero.
    const seen = new Map<string, string[]>();
    for (const p of core.places) {
      if (p.lat == null || p.lon == null) continue;
      const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      const list = seen.get(key);
      if (list) list.push(p.name);
      else seen.set(key, [p.name]);
    }
    const collisions = [...seen.values()].filter((names) => names.length > 1);
    expect(collisions).toEqual([]);
  });

  it("measures the distance between two places", () => {
    // Cairo to Luxor is roughly 500km.
    const km = lookup.distanceKm("cairo", "luxor");
    expect(km).toBeGreaterThan(400);
    expect(km).toBeLessThan(700);
  });

  it("prices an unrouted pair from its real distance rather than a flat regional median", () => {
    // Every pair used to fall back to one median fare for the whole region,
    // so a short hop and an intercontinental one were quoted the same.
    const near = lookup.best("alleppey", "cochin");
    const far = lookup.best("cochin", "leh");
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(far!.priceInr).toBeGreaterThan(near!.priceInr * 2);
  });

  it("does not offer a bus across a continent", () => {
    const options = lookup.options("cairo", "cape-town");
    const road = options.filter((o) => o.mode === "bus" || o.mode === "private_vehicle");
    expect(road).toEqual([]);
  });

  it("does not offer a flight between neighbouring towns", () => {
    // Applies to legs the engine has to synthesise. Where the agency authored
    // a route, its own data wins — including any oddity in it.
    expect(plausibleModes(45, true)).not.toContain("flight");
    expect(plausibleModes(120, true)).not.toContain("flight");
  });

  it("offers a real choice of modes on the overwhelming majority of domestic pairs", () => {
    // The authored graph covers ~1.4% of pairs and breaks into 63 components,
    // so without synthesis most legs had exactly one option, or none. Scoped
    // to one country because an intercontinental pair genuinely has only one
    // sane mode, and counting those would measure geography, not coverage.
    const india = core.countries.find((c) => c.name === "India")!;
    const sample = core.places.filter((p) => p.countryId === india.id).slice(0, 50).map((p) => p.id);
    let withChoice = 0;
    let total = 0;
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        total++;
        if (lookup.options(sample[i], sample[j]).length > 1) withChoice++;
      }
    }
    expect(withChoice / total).toBeGreaterThan(0.8);
  });

  it("orders a regional circuit geographically rather than by a flat fare", () => {
    // Kerala's authored fares are all ₹1,075, so before distance entered the
    // hop cost the sequencer had nothing to order on and returned a zigzag.
    const kerala = ["thekkady", "cochin", "alleppey", "munnar", "trivandrum", "kanyakumari"];
    const order = sequencePlaces(kerala, lookup);

    const index = (id: string) => order.indexOf(id);
    // Munnar and Thekkady are the two hill stations and sit next to each
    // other; Trivandrum and Kanyakumari are the southern pair.
    expect(Math.abs(index("munnar") - index("thekkady"))).toBe(1);
    expect(Math.abs(index("trivandrum") - index("kanyakumari"))).toBe(1);
  });

  it("starts a trip at the place nearest the traveller's gateway", () => {
    const points = new Map(
      core.places
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => [p.id, { lat: p.lat!, lon: p.lon! }]),
    );
    const delhi = core.departureCities.find((c) => c.code === "DEL")!;
    const gateway = { lat: delhi.lat!, lon: delhi.lon! };

    // An open path and its reverse visit the same two places at the ends, so
    // only the gateway can decide which way round the trip runs. Leh is far
    // north and much closer to Delhi than the Kerala coast.
    const ids = ["kanyakumari", "leh"];
    expect(sequencePlaces(ids, lookup, gateway, points)[0]).toBe("leh");
    // Same set, opposite input order — the answer must not depend on it.
    expect(sequencePlaces([...ids].reverse(), lookup, gateway, points)[0]).toBe("leh");
  });

  it("leaves the order alone when no gateway is known", () => {
    const ids = ["kanyakumari", "leh"];
    expect(sequencePlaces(ids, lookup)).toHaveLength(2);
  });
});

describe("transport mode selection", () => {
  const lookup = buildRouteLookup(routes, core.places, core.countries);

  it("times every enabled option it offers", () => {
    // A missing duration used to collapse to a flat default, which cancelled
    // travel time out of the comparison and handed almost every leg to a bus.
    const options = lookup.options("cairo", "luxor");
    expect(options.length).toBeGreaterThan(1);
    expect(options.every((o) => o.minutes > 0)).toBe(true);
  });

  it("offers a slower, cheaper option and a faster, dearer one", () => {
    const options = lookup.options("cairo", "luxor");
    const cheapest = [...options].sort((a, b) => a.priceInr - b.priceInr)[0];
    const quickest = [...options].sort((a, b) => a.minutes - b.minutes)[0];
    expect(quickest.mode).not.toBe(cheapest.mode);
    expect(quickest.priceInr).toBeGreaterThan(cheapest.priceInr);
    expect(quickest.minutes).toBeLessThan(cheapest.minutes);
  });

  it("picks the cheapest fare when asked for the cheapest", () => {
    const options = lookup.options("cairo", "luxor");
    const cheapest = [...options].sort((a, b) => a.priceInr - b.priceInr)[0];
    expect(lookup.best("cairo", "luxor", "cheapest")?.mode).toBe(cheapest.mode);
  });

  it("picks a quicker mode when asked for the fastest", () => {
    const cheap = lookup.best("cairo", "luxor", "cheapest")!;
    const fast = lookup.best("cairo", "luxor", "fastest")!;
    expect(fast.minutes).toBeLessThanOrEqual(cheap.minutes);
    expect(fast.priceInr).toBeGreaterThanOrEqual(cheap.priceInr);
  });

  it("drives, rather than flies, a leg with no scheduled service", () => {
    // Both ends sit on the same island, so every mode is explicitly
    // unavailable. Falling through to a regional airfare priced a beach
    // transfer at tens of thousands of rupees.
    const hit = lookup.best("port-louis", "ile-aux-cerfs");
    expect(hit).not.toBeNull();
    expect(hit!.mode).toBe("private_vehicle");
    expect(hit!.priceInr).toBeLessThan(10_000);
  });

  it("never prices an explicitly unavailable leg as a flight", () => {
    const unavailable = routes.filter(
      (r) =>
        r.originPlaceId &&
        r.destPlaceId &&
        r.options.length > 0 &&
        r.options.every((o) => !o.enabled),
    );
    expect(unavailable.length).toBeGreaterThan(0);
    for (const r of unavailable) {
      expect(lookup.best(r.originPlaceId!, r.destPlaceId!)?.mode).not.toBe("flight");
    }
  });

  it("does not default a long, uncomfortable land journey over a short flight", () => {
    // Cairo -> Luxor is ~500km: a real bus/train option exists at roughly
    // 9-10 hours, and a ~90-minute flight is also on offer. A traveller who
    // did not ask to prioritise fare should not be defaulted onto the
    // day-eating bus just because it scores marginally cheaper on a flat
    // money-plus-time formula — that is realistic-sounding, not realistic.
    const balanced = lookup.best("cairo", "luxor", "balanced")!;
    expect(balanced.mode).toBe("flight");
  });

  it("still prefers cheap road transport on a short, comfortable hop", () => {
    // The comfort ceiling must not become a blanket bias towards flying —
    // a short hop well within a bus's comfort window should still win on a
    // balanced preference.
    const balanced = lookup.best("cairo", "alexandria", "balanced")!;
    expect(["bus", "train"]).toContain(balanced.mode);
  });

  it("still allows a long, cheap journey when the traveller explicitly asks for cheapest", () => {
    // "Cheapest" is an informed, explicit request to prioritise fare over
    // comfort — the comfort ceiling must not override it.
    const cheapest = lookup.best("cairo", "luxor", "cheapest")!;
    expect(cheapest.mode).not.toBe("flight");
  });

  it("still lists the long/cheap option as a selectable alternative", () => {
    // The comfort ceiling changes the *default*, not what is offered — the
    // traveller who wants the cheap overnight bus can still pick it.
    const options = lookup.options("cairo", "luxor", "balanced");
    expect(options.some((o) => o.mode === "bus")).toBe(true);
  });
});

describe("international airfare", () => {
  const flightItems = (q: ReturnType<typeof quote>) =>
    q.lineItems.filter((i) => i.component === "flight");

  it("charges one return fare when the trip starts and ends in the same country", () => {
    const q = quote({ placeIds: ["cairo", "luxor"], nights: 5, includeFlight: true });
    const flights = flightItems(q);
    expect(flights).toHaveLength(1);
    expect(flights[0].detail).toContain("round trip");
  });

  it("prices an open jaw when the trip ends in a different country from where it started", () => {
    // A return fare to the *first* country assumes the traveller doubles back
    // to fly home from where they arrived, which is plainly wrong for a
    // multi-country itinerary — the return leg was simply never priced.
    const q = quote({ placeIds: ["cairo", "nairobi"], nights: 6, includeFlight: true });
    const flights = flightItems(q);
    expect(flights).toHaveLength(2);

    const out = flights.find((f) => f.label.startsWith("Airfare out"));
    const home = flights.find((f) => f.label.startsWith("Airfare home"));
    expect(out).toBeDefined();
    expect(home).toBeDefined();
    // The homeward leg must depart from the trip's final destination.
    expect(home!.label).toContain(q.stays[q.stays.length - 1].placeName);
    expect(out!.label).toContain(q.stays[0].placeName);
  });

  it("does not double-count the airfare on a multi-country trip", () => {
    // Two half-fares, not two full ones.
    const single = quote({ placeIds: ["cairo", "luxor"], nights: 6, includeFlight: true });
    const multi = quote({ placeIds: ["cairo", "nairobi"], nights: 6, includeFlight: true });

    const total = (q: ReturnType<typeof quote>) =>
      flightItems(q).reduce((sum, i) => sum + i.totalInr, 0);

    expect(total(multi)).toBeLessThan(total(single) * 1.6);
    expect(total(multi)).toBeGreaterThan(total(single) * 0.5);
  });

  it("omits airfare entirely when the traveller asked for a land-only quote", () => {
    const q = quote({ placeIds: ["cairo", "nairobi"], nights: 6, includeFlight: false });
    expect(flightItems(q)).toHaveLength(0);
  });
});

describe("destination knowledge drives advisories", () => {
  it("warns when a stay falls in a month the destination itself rates poorly", () => {
    // Munnar's own file scores the monsoon months far below its winter peak.
    // The engine used to read only the month *price* index, so it could quote
    // the monsoon as a bargain without ever mentioning the rain.
    const monsoon = quote({ placeIds: ["munnar"], nights: 3, startDate: "2026-07-05" });
    const winter = quote({ placeIds: ["munnar"], nights: 3, startDate: "2026-02-05" });

    const seasonal = (q: ReturnType<typeof quote>) =>
      q.warnings.filter((w) => /seasonal rating/.test(w.message));

    expect(seasonal(monsoon).length).toBeGreaterThan(0);
    expect(seasonal(winter)).toHaveLength(0);
  });

  it("names a better month when one is clearly better", () => {
    const monsoon = quote({ placeIds: ["munnar"], nights: 3, startDate: "2026-07-05" });
    const message = monsoon.warnings.find((w) => /seasonal rating/.test(w.message))!.message;
    expect(message).toMatch(/strongest month/);
  });

  it("prices each stay in the month it actually falls in", () => {
    // Seasonality used to be read once from the departure date and applied to
    // the whole trip, so a long itinerary crossing into a peak month was
    // priced entirely at the cheaper departure month's rate.
    const hotelTotal = (startDate: string) =>
      quote({ placeIds: ["munnar"], nights: 6, startDate })
        .lineItems.filter((i) => i.component === "hotel")
        .reduce((sum, i) => sum + i.totalInr, 0);

    // Starting in late December runs the stay into January; starting in early
    // December keeps it inside December.
    expect(hotelTotal("2026-12-28")).not.toBe(hotelTotal("2026-12-02"));
  });

  it("keeps advisories out of the price", () => {
    // An advisory is a note, never a surcharge or a dropped place.
    const monsoon = quote({ placeIds: ["munnar"], nights: 3, startDate: "2026-07-05" });
    expect(monsoon.stays.map((s) => s.placeId)).toContain("munnar");
  });
});

describe("destination decision rules", () => {
  const rulesFor = (placeId: string) => bundlesFor([placeId]).get(placeId)!.decisionRules;

  const facts = (over: Partial<RuleFacts> = {}): RuleFacts => ({
    nights: 2,
    travellerType: "couple",
    tripStyle: "romantic",
    childAges: [],
    month: 11,
    monthWeather: 85,
    interests: [],
    firstTimeVisitor: true,
    ...over,
  });

  it("parses section 33 into evaluable rules", () => {
    const rules = rulesFor("jaipur");
    expect(rules.length).toBeGreaterThan(10);
    expect(rules.every((r) => r.conditions.length > 0 && r.action.length > 0)).toBe(true);
  });

  it("parses rules from files that use non-standard emphasis", () => {
    // Most files write `**IF:**`; a good number write `****IF:****`, which
    // left the line no longer starting with `IF:` and silently dropped every
    // rule in those files.
    const raw = readFileSync(
      path.join("input_files", "Destination Files markdown", "India", "Rajasthan", "Jaipur.md"),
      "utf8",
    );
    expect(raw).toContain("****IF:****");
    expect(rulesFor("jaipur").length).toBeGreaterThan(0);
  });

  it("compares trip length in the unit the rule used", () => {
    // "3 days" is two nights; comparing a night count against a day threshold
    // would be off by one on every such rule.
    const dayRule = rulesFor("jaipur").find(
      (r) => r.conditions[0]?.variable === "trip_length" && r.conditions[0]?.unit === "days"
        && r.conditions[0]?.operator === "==" && r.conditions[0]?.number === 3,
    );
    expect(dayRule).toBeDefined();
    expect(evaluateRule(dayRule!, facts({ nights: 2 })).status).toBe("fired");
    expect(evaluateRule(dayRule!, facts({ nights: 5 })).status).toBe("not-applicable");
  });

  it("does not fire a rule written for a different traveller", () => {
    const familyRule = rulesFor("jaipur").find(
      (r) => r.conditions.length === 1 && r.conditions[0].value === "FAMILY",
    );
    expect(familyRule).toBeDefined();
    expect(evaluateRule(familyRule!, facts({ travellerType: "couple", tripStyle: "romantic" })).status)
      .toBe("not-applicable");
    expect(evaluateRule(familyRule!, facts({ travellerType: "family", tripStyle: "family" })).status)
      .toBe("fired");
  });

  it("skips rather than guesses when a condition rests on an input we never collect", () => {
    // route, hotel_priority, visibility and the rest describe things the
    // planner does not ask. Treating them as false would swallow the rule;
    // treating them as true would fire advice at the wrong traveller.
    const rule = {
      placeId: "x", id: "x:rule:0",
      conditions: [{
        variable: "hotel_priority", operator: "==" as const, value: "VIEW",
        number: null, unit: null, joiner: null,
      }],
      action: "Book a fort-facing room.", reason: null, effects: [],
    };
    const result = evaluateRule(rule, facts());
    expect(result.status).toBe("skipped");
    expect(result.undecided[0]).toContain("hotel_priority");
  });

  it("leaves an unstated interest undecided, but a stated one decisive", () => {
    const rule = {
      placeId: "x", id: "x:rule:1",
      conditions: [{
        variable: "traveler_interest", operator: "==" as const, value: "PHOTOGRAPHY",
        number: null, unit: null, joiner: null,
      }],
      action: "Add a sunrise photography slot.", reason: null, effects: [],
    };
    expect(evaluateRule(rule, facts({ interests: [] })).status).toBe("skipped");
    expect(evaluateRule(rule, facts({ interests: ["PHOTOGRAPHY"] })).status).toBe("fired");
    expect(evaluateRule(rule, facts({ interests: ["FOOD"] })).status).toBe("not-applicable");
  });

  it("requires every part of an AND, and any part of an OR", () => {
    const cond = (variable: string, value: string, joiner: "AND" | "OR" | null) => ({
      variable, operator: "==" as const, value, number: null, unit: null, joiner,
    });
    const and = {
      placeId: "x", id: "x:rule:2", action: "do something", reason: null, effects: [],
      conditions: [cond("traveler_type", "FAMILY", null), cond("trip_type", "HONEYMOON", "AND")],
    };
    const or = {
      ...and, id: "x:rule:3",
      conditions: [cond("traveler_type", "FAMILY", null), cond("trip_type", "HONEYMOON", "OR")],
    };
    const couple = facts({ travellerType: "couple", tripStyle: "romantic" });
    expect(evaluateRule(and, couple).status).toBe("not-applicable");
    expect(evaluateRule(or, couple).status).toBe("fired");
  });

  it("matches symbols on word boundaries, not raw prefixes", () => {
    const rule = {
      placeId: "x", id: "x:rule:4", action: "do something", reason: null, effects: [],
      conditions: [{
        variable: "traveler_interest", operator: "==" as const, value: "FOOD_AND_GASTRONOMY",
        number: null, unit: null, joiner: null,
      }],
    };
    expect(evaluateRule(rule, facts({ interests: ["FOOD"] })).status).toBe("fired");
    expect(evaluateRule(rule, facts({ interests: ["FOODIE_TRAIL"] })).status).toBe("not-applicable");
  });

  it("reads an avoid instruction as an avoid, not a recommendation", () => {
    const cairo = rulesFor("cairo");
    const avoiding = cairo.filter((r) => r.effects.some((e) => e.kind === "avoid"));
    expect(avoiding.length).toBeGreaterThan(0);
    expect(avoiding.every((r) => r.effects.every((e) => e.kind !== "prioritise"))).toBe(true);
  });

  it("surfaces only the rules that fired, on a real quotation", () => {
    const q = quote({ placeIds: ["jaipur"], nights: 2, travellerType: "family", tripStyle: "family", childAges: [8] });
    expect(q.appliedRules.length).toBeGreaterThan(0);
    expect(q.appliedRules.every((r) => r.placeId === "jaipur")).toBe(true);
    // Honeymoon advice must not appear on a family quote.
    expect(q.appliedRules.some((r) => /honeymoon/i.test(r.conditions.join(" ")))).toBe(false);
  });

  it("fires a different set of rules for a different traveller", () => {
    const family = quote({
      placeIds: ["jaipur"], nights: 2, travellerType: "family", tripStyle: "family", childAges: [8],
    });
    const honeymoon = quote({
      placeIds: ["jaipur"], nights: 2, travellerType: "couple", tripStyle: "honeymoon",
    });
    const ids = (q: ReturnType<typeof quote>) => q.appliedRules.map((r) => r.ruleId).sort().join(",");
    expect(ids(family)).not.toBe(ids(honeymoon));
  });

  it("tells the agent how many rules it could not decide", () => {
    const q = quote({ placeIds: ["jaipur"], nights: 2 });
    expect(
      q.warnings.some((w) => w.audience === "internal" && /could not be evaluated/.test(w.message)),
    ).toBe(true);
  });

  it("keeps rule advice out of the traveller-facing warnings", () => {
    // Rules are guidance on the quotation, not alarms.
    const q = quote({ placeIds: ["jaipur"], nights: 2 });
    expect(
      q.warnings.filter((w) => w.audience === "traveller").every((w) => !/IF |trip_length/.test(w.message)),
    ).toBe(true);
  });
});

describe("planner guidance reaches the quotation", () => {
  it("captures the sections the parser used to skip entirely", () => {
    // 21 of the files' 36 sections — airport transfer logic, the per-audience
    // travel guidance, the worked itinerary patterns, the agent insights and
    // the destination's own decision rules — were read by nothing at all.
    const cairo = bundlesFor(["cairo"]).get("cairo")!;
    const sections = new Set(cairo.guidance.map((g) => g.section));
    expect(sections.has(12)).toBe(true); // airport transfer logic
    expect(sections.has(33)).toBe(true); // destination decision rules
    expect(cairo.guidance.length).toBeGreaterThan(5);
  });

  it("selects guidance written for the traveller actually being quoted", () => {
    const honeymoon = quote({
      placeIds: ["cairo"], nights: 4, travellerType: "couple", tripStyle: "honeymoon",
    });
    const family = quote({
      placeIds: ["cairo"], nights: 4, travellerType: "family", tripStyle: "family",
      childAges: [6],
    });

    const audiences = (q: ReturnType<typeof quote>) =>
      new Set(q.planningNotes.map((n) => n.audience).filter(Boolean));

    expect(audiences(honeymoon)).toContain("honeymoon");
    expect(audiences(honeymoon)).not.toContain("family");
    expect(audiences(family)).toContain("family");
    expect(audiences(family)).not.toContain("honeymoon");
  });

  it("always includes the guidance that applies to everyone", () => {
    const q = quote({ placeIds: ["cairo"], nights: 4 });
    // Decision rules carry no audience, so they must survive the filter.
    expect(q.planningNotes.some((n) => n.audience === null)).toBe(true);
  });

  it("attributes every note to the place it came from", () => {
    const q = quote({ placeIds: ["cairo", "luxor"], nights: 6 });
    const stayIds = new Set(q.stays.map((s) => s.placeId));
    expect(q.planningNotes.length).toBeGreaterThan(0);
    expect(q.planningNotes.every((n) => stayIds.has(n.placeId))).toBe(true);
    expect(q.planningNotes.every((n) => n.bullets.length > 0 || n.body.length > 0)).toBe(true);
  });

  it("caps guidance so a long itinerary does not bury the quote", () => {
    const q = quote({ placeIds: ["cairo", "luxor", "alexandria"], nights: 9 });
    const perPlace = new Map<string, number>();
    for (const n of q.planningNotes) perPlace.set(n.placeId, (perPlace.get(n.placeId) ?? 0) + 1);
    expect([...perPlace.values()].every((c) => c <= 6)).toBe(true);
  });
});

describe("published package price is land-only", () => {
  // "Hong Kong & Macau" publishes ₹1,22,000 for 5 nights across exactly two
  // places, and its own component rates come in well under that — so it
  // reliably exercises the package floor.
  const placeIds = ["hong-kong", "macau"];
  const nights = 5;

  it("floors the land component, then adds airfare on top rather than absorbing it", () => {
    const land = quote({ placeIds, nights, includeFlight: false });
    const allIn = quote({ placeIds, nights, includeFlight: true });

    // Both should have been raised to the published land-only "from" price.
    expect(land.totals.flooredToPackage).toBeTruthy();
    expect(allIn.totals.flooredToPackage).toBeTruthy();

    const airfare = allIn.lineItems
      .filter((i) => i.component === "flight")
      .reduce((a, i) => a + i.totalInr, 0);
    expect(airfare).toBeGreaterThan(0);

    // The regression this guards: the floor used to overwrite the whole
    // total, so a floored quote came out identical with and without flights
    // — the airfare silently vanished. The all-in quote must now exceed the
    // land-only one by at least the raw airfare.
    expect(allIn.totals.total).toBeGreaterThan(land.totals.total + airfare * 0.9);
  });

  it("floors against the published price without the flight inflating the comparison", () => {
    const land = quote({ placeIds, nights, includeFlight: false });
    const pkg = core.packages.find((p) => p.name === "Hong Kong & Macau")!;
    const floor = pkg.priceFromInr * (1 - policy.guardrails.packageFloorTolerance);

    // Land-only per person lands on the published floor, not above it: proof
    // the comparison used the land share rather than an all-in total.
    expect(land.totals.perPerson).toBeGreaterThanOrEqual(Math.floor(floor) - 1);
    expect(land.totals.perPerson).toBeLessThan(pkg.priceFromInr * 1.05);
  });

  it("tells the traveller plainly when a quote carries no airfare", () => {
    const land = quote({ placeIds, nights, includeFlight: false });
    expect(
      land.warnings.some(
        (w) => w.audience === "traveller" && /land-only price/i.test(w.message),
      ),
    ).toBe(true);
  });
});

describe("nights bounds", () => {
  it("never freezes the slider when a place's own maximum collides with the region floor", () => {
    // Portugal's destination file caps a "first visit" at 4 nights but goes
    // on to say slower/regional trips run 5+ — and Europe's minimum trip
    // length (to justify the flight from India) is 5. Taking the place's
    // "first visit" cap as an absolute ceiling used to force min === max,
    // freezing the slider at a single value.
    const bounds = computeNightsBounds(core, ["portugal"]);
    expect(bounds.max).toBeGreaterThan(bounds.min);
  });

  it("keeps the recommended value inside the realistic range", () => {
    const bounds = computeNightsBounds(core, ["portugal"]);
    expect(bounds.recommended).toBeGreaterThanOrEqual(bounds.min);
    expect(bounds.recommended).toBeLessThanOrEqual(bounds.max);
  });

  it("gives a multi-country trip proportionally more headroom", () => {
    const one = computeNightsBounds(core, ["portugal"]);
    const four = computeNightsBounds(core, ["poland", "czech", "denmark", "austria"]);
    expect(four.max).toBeGreaterThan(one.max);
    expect(four.min).toBeGreaterThan(one.min);
  });

  it("never exceeds the policy-wide realism ceiling", () => {
    // A long chain of places, each contributing its own per-place max, used
    // to be able to push the sum well past what any agency would sell as a
    // single trip. The trip-wide ceiling (28, see quote-policy.json) must
    // win regardless of how many places are combined.
    const many = computeNightsBounds(core, [
      "france", "switzerland", "luxembourg", "belgium", "germany",
      "austria", "netherlands", "ha-noi", "bangkok", "sentosa-island",
    ]);
    expect(many.max).toBeLessThanOrEqual(policy.guardrails.maxNights);
    expect(many.min).toBeLessThanOrEqual(many.max);
  });
});

describe("nights sized by who is travelling", () => {
  // Two Egyptian cities: enough content that the profile factor has room to
  // move the number, rather than the region floor swamping it.
  const placeIds = ["cairo", "luxor"];
  const bounds = (travellerType: TravellerType, tripStyle: TripStyle) =>
    computeNightsBounds(core, placeIds, { travellerType, tripStyle });

  it("gives a family longer than a stag party for the very same destinations", () => {
    // The whole point of the feature: children set the rhythm, a stag trip is
    // a long weekend, and the same two cities should not be offered as the
    // same trip to both.
    const family = bounds("family", "family");
    const stags = bounds("stags", "adventure");
    expect(family.recommended).toBeGreaterThan(stags.recommended);
    expect(family.max).toBeGreaterThan(stags.max);
  });

  it("caps the kinds of trip that never run long", () => {
    // Nobody sells a three-week stag party or a fortnight-long business trip.
    for (const [traveller, style] of [["stags", "adventure"], ["business", "luxury"]] as const) {
      const b = bounds(traveller, style);
      const cap = policy.travellerProfiles.byTraveller[traveller].maxTripNights;
      // Allow the small slider span the bounds deliberately keeps (see
      // MIN_SLIDER_SPAN) so the control never pins to a single value.
      expect(b.max).toBeLessThanOrEqual(cap + 2);
      expect(b.max).toBeLessThan(computeNightsBounds(core, placeIds).max);
    }
  });

  it("lets trip style move the length independently of who is travelling", () => {
    const honeymoon = bounds("couple", "honeymoon");
    const budget = bounds("couple", "budget");
    expect(honeymoon.recommended).toBeGreaterThan(budget.recommended);
  });

  it("explains an adjustment only when it actually changed the number", () => {
    const stretched = bounds("family", "family");
    expect(stretched.recommended).toBeGreaterThan(computeNightsBounds(core, placeIds).recommended);
    expect(stretched.profileNote).toMatch(/longer for a family trip/i);

    // A single long-haul stop is pinned by its region floor, so nothing moves
    // and the note must stay quiet rather than claim an adjustment.
    const pinned = computeNightsBounds(core, ["portugal"], {
      travellerType: "family",
      tripStyle: "family",
    });
    expect(pinned.recommended).toBe(computeNightsBounds(core, ["portugal"]).recommended);
    expect(pinned.profileNote).toBeNull();
  });

  it("lets the destinations win when a cap and the region floor genuinely conflict", () => {
    // A stag party across four European countries is a contradiction: the cap
    // says 5 nights, the destinations need more. The destinations are physical
    // fact and must win — but the trip still must not be offered at the full
    // 28-night ceiling as though nothing were odd.
    const wide = ["poland", "czech", "denmark", "austria"];
    const unprofiled = computeNightsBounds(core, wide);
    const stags = computeNightsBounds(core, wide, { travellerType: "stags", tripStyle: "adventure" });

    expect(stags.min).toBe(unprofiled.min);
    expect(stags.max).toBeLessThan(unprofiled.max);
    expect(stags.profileNote).toMatch(/rarely runs beyond/i);
  });

  it("keeps every profile inside a usable, self-consistent range", () => {
    const travellers: TravellerType[] = [
      "family", "couple", "friends", "stags", "business", "pilgrimage", "solo",
    ];
    const styles: TripStyle[] = [
      "family", "romantic", "honeymoon", "luxury", "adventure", "culture", "budget", "pilgrimage",
    ];
    for (const t of travellers) {
      for (const s of styles) {
        const b = computeNightsBounds(core, placeIds, { travellerType: t, tripStyle: s });
        // Never inverted, never frozen, never past the trip-wide ceiling.
        expect(b.max).toBeGreaterThan(b.min);
        expect(b.max).toBeLessThanOrEqual(policy.guardrails.maxNights);
        expect(b.recommended).toBeGreaterThanOrEqual(b.min);
        expect(b.recommended).toBeLessThanOrEqual(b.max);
      }
    }
  });

  it("leaves the unprofiled result exactly as it was", () => {
    // The profile argument is optional; existing callers must be unaffected.
    const before = computeNightsBounds(core, placeIds);
    expect(before.profileNote).toBeNull();
    expect(before.recommended).toBe(
      computeNightsBounds(core, placeIds, { travellerType: "couple", tripStyle: "romantic" })
        .recommended,
    );
  });
});

describe("hotel category follows trip style", () => {
  it("determines a category for every trip style, not just a few", () => {
    const styles: TripStyle[] = [
      "family", "romantic", "honeymoon", "luxury", "adventure", "culture", "budget", "pilgrimage",
    ];
    for (const s of styles) {
      expect(hotelStarForStyle(s)).toBeTruthy();
    }
  });

  it("offers Luxury 5 Star only on a luxury trip", () => {
    // It also carries the higher agent markup, so it must not be reachable
    // by accident from a budget or pilgrimage itinerary.
    expect(hotelStarForStyle("luxury")).toBe("Luxury 5 Star");
    expect(isHotelStarAvailable("luxury", "Luxury 5 Star")).toBe(true);

    for (const s of ["family", "romantic", "honeymoon", "adventure", "culture", "budget", "pilgrimage"] as TripStyle[]) {
      expect(hotelStarForStyle(s)).not.toBe("Luxury 5 Star");
      expect(isHotelStarAvailable(s, "Luxury 5 Star")).toBe(false);
    }
  });

  it("keeps every other category freely selectable on any style", () => {
    const styles: TripStyle[] = [
      "family", "romantic", "honeymoon", "luxury", "adventure", "culture", "budget", "pilgrimage",
    ];
    for (const s of styles) {
      for (const star of ["3 Star", "4 Star", "5 Star"] as const) {
        expect(isHotelStarAvailable(s, star)).toBe(true);
      }
    }
  });

  it("sends the frugal styles down and the indulgent ones up", () => {
    expect(hotelStarForStyle("budget")).toBe("3 Star");
    expect(hotelStarForStyle("adventure")).toBe("3 Star");
    expect(hotelStarForStyle("pilgrimage")).toBe("3 Star");
    expect(hotelStarForStyle("honeymoon")).toBe("5 Star");
  });
});

describe("realistic combination caps", () => {
  it("disables a 6th country once the 5-country cap is reached", () => {
    const fiveCountries = ["france", "switzerland", "luxembourg", "belgium", "germany"];
    const selectability = evaluatePlaceSelectability(core, fiveCountries);
    const austria = selectability.get("austria");
    expect(austria?.allowed).toBe(false);
    expect(austria?.reason).toMatch(/maximum of 5 countries/);
    // Already-selected places must always remain selectable (so they can be
    // toggled off), even once a cap is reached.
    for (const id of fiveCountries) expect(selectability.get(id)?.allowed).toBe(true);
  });

  it("disables a 3rd region once the 2-region cap is reached", () => {
    // Nepal + Tibet/China is the one real cross-region pairing in the
    // catalogue (the Kailash Mansarovar pilgrimage) — using it here means
    // the region cap itself is what blocks the 3rd region, not an
    // incidental pairwise-incompatibility with the first two places.
    const twoRegions = ["kathmandu", "lake-mansarovar"]; // south-asia + east-asia
    const selectability = evaluatePlaceSelectability(core, twoRegions);
    const cairo = selectability.get("cairo"); // africa — a 3rd region
    expect(cairo?.allowed).toBe(false);
    expect(cairo?.reason).toMatch(/maximum of 2 regions/);
  });

  it("disables any further place once the 12-place cap is reached", () => {
    const twelve = [
      "ha-noi", "ha-long-bay", "danang", "hochiminh",
      "bangkok", "pattaya", "phuket", "krabi",
      "sentosa-island", "universal-studios", "garden-by-bay", "marina-bay-sands",
    ];
    const selectability = evaluatePlaceSelectability(core, twelve);
    const kualaLumpur = selectability.get("kuala-lumpur");
    expect(kualaLumpur?.allowed).toBe(false);
    expect(kualaLumpur?.reason).toMatch(/maximum of 12 places/);
  });

  it("filterRealisticSelection keeps the realistic prefix and drops the rest, in order, with reasons", () => {
    const ordered = ["france", "switzerland", "luxembourg", "belgium", "germany", "austria", "netherlands"];
    const { kept, dropped } = filterRealisticSelection(core, ordered);
    expect(kept).toEqual(["france", "switzerland", "luxembourg", "belgium", "germany"]);
    expect(dropped.map((d) => d.placeId)).toEqual(["austria", "netherlands"]);
    for (const d of dropped) expect(d.reason).toMatch(/maximum of 5 countries/);
  });

  it("filterRealisticSelection drops a 3rd region's place while keeping the first two regions", () => {
    const ordered = ["kathmandu", "lake-mansarovar", "cairo"];
    const { kept, dropped } = filterRealisticSelection(core, ordered);
    expect(kept).toEqual(["kathmandu", "lake-mansarovar"]);
    expect(dropped).toEqual([{ placeId: "cairo", reason: "trip already covers the maximum of 2 regions" }]);
  });

  it("generateQuotation drops an unrealistic 3rd-region place and warns the traveller instead of silently pricing it", () => {
    const q = quote({ placeIds: ["kathmandu", "lake-mansarovar", "cairo"], nights: 10 });
    expect(q.stays.some((s) => s.placeId === "cairo")).toBe(false);
    expect(q.stays.some((s) => s.placeId === "kathmandu")).toBe(true);
    expect(q.stays.some((s) => s.placeId === "lake-mansarovar")).toBe(true);
    expect(q.warnings.some((w) => /Cairo/.test(w.message) && /2 regions/.test(w.message))).toBe(true);
  });
});

describe("transport choice in a quotation", () => {
  const placeIds = ["cairo", "luxor", "aswan"];

  it("spends more but travels less when asked for the fastest", () => {
    const cheap = quote({ placeIds, nights: 7, transportPreference: "cheapest" });
    const fast = quote({ placeIds, nights: 7, transportPreference: "fastest" });
    const minutes = (q: typeof cheap) =>
      q.days.reduce((a, d) => a + (d.transfer?.durationMinutes ?? 0), 0);
    const transport = (q: typeof cheap) =>
      q.lineItems.filter((i) => i.component === "intercity-transport").reduce((a, i) => a + i.totalInr, 0);

    expect(minutes(fast)).toBeLessThan(minutes(cheap));
    expect(transport(fast)).toBeGreaterThan(transport(cheap));
  });

  it("offers the alternatives for each intercity leg", () => {
    const q = quote({ placeIds, nights: 7 });
    const legs = q.days.filter((d) => d.isTransferDay && d.transfer?.alternatives.length);
    expect(legs.length).toBeGreaterThan(0);
    for (const d of legs) {
      // The quoted mode must be one the traveller was actually offered.
      expect(d.transfer!.alternatives.map((a) => a.mode)).toContain(d.transfer!.mode);
    }
  });

  it("honours a per-leg mode the traveller pinned", () => {
    const base = quote({ placeIds, nights: 7 });
    const leg = base.days.find((d) => d.isTransferDay && (d.transfer?.alternatives.length ?? 0) > 1)!;
    const other = leg.transfer!.alternatives.find((a) => a.mode !== leg.transfer!.mode)!;

    const pinned = quote({ placeIds, nights: 7, legModes: { [leg.placeId]: other.mode } });
    const got = pinned.days.find((d) => d.placeId === leg.placeId)!.transfer!;
    expect(got.mode).toBe(other.mode);
    expect(got.userChosen).toBe(true);
  });
});

describe("multi-day transfers", () => {
  // Johannesburg → Cape Town by bus is a real ~33-hour overland leg in the
  // catalogue — long enough to spill past a single calendar day but still
  // comfortably shorter than the nights booked at Cape Town in this test.
  const placeIds = ["johannesburg", "cape-town"];

  it("spreads a journey longer than one day's waking hours across as many days as it actually needs", () => {
    const q = quote({ placeIds, nights: 6, legModes: { "cape-town": "bus" } });
    const leg = q.days.find((d) => d.isTransferDay && d.transfer?.mode === "bus")!;
    expect(leg).toBeDefined();
    expect(leg.transfer!.durationMinutes).toBeGreaterThan(24 * 60);

    // The arrival day and however many continuation days the journey needs
    // must all show reduced sightseeing — the traveller is still travelling,
    // if not for the entire day then for a large share of it.
    const continuation = q.days.filter(
      (d) => d.placeId === "cape-town" && d.notes.some((n) => n.includes("Still travelling")),
    );
    expect(continuation.length).toBeGreaterThan(0);
    expect(leg.activeHours).toBe(0);
    for (const d of continuation) {
      expect(d.activeHours).toBeLessThan(policy.dayPlanning.pace.balanced);
    }

    // Only the arrival day is ever priced or offered mode alternatives —
    // a multi-day leg must never be billed once per day it spans.
    const transportLines = q.lineItems.filter(
      (i) => i.component === "intercity-transport" && i.label.includes("Cape Town"),
    );
    expect(transportLines.length).toBe(1);
  });

  it("warns the traveller when the chosen mode's journey time does not fit in the nights booked", () => {
    // Two nights is nowhere near enough for a journey of well over a day.
    const q = quote({ placeIds, nights: 2, legModes: { "cape-town": "bus" } });
    const told = q.warnings.some(
      (w) => w.audience === "traveller" && /bus from Johannesburg to Cape Town/i.test(w.message) && /Add nights/i.test(w.message),
    );
    expect(told).toBe(true);
  });

  it("never lets transit swallow the final stay's departure day", () => {
    const q = quote({ placeIds, nights: 2, legModes: { "cape-town": "bus" } });
    const last = q.days[q.days.length - 1];
    expect(last.notes).toContain("Check-out and departure transfer");
  });

  it("does not change a short transfer's single-day plan at all", () => {
    // A same-day journey (well under the 14-hour ceiling) must behave
    // exactly as before: one arrival day, zero continuation days.
    const q = quote({ placeIds: ["luxor", "cairo"], nights: 6, legModes: { cairo: "train" } });
    const continuation = q.days.filter((d) => d.notes.some((n) => n.includes("Still travelling")));
    expect(continuation.length).toBe(0);
    expect(q.warnings.some((w) => /Add nights/i.test(w.message))).toBe(false);
  });
});

describe("day budget", () => {
  const group = { hasYoungChildren: false, hasSeniors: false, paxTotal: 2 };

  it("always leaves at least ten hours of rest", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      expect(dayBudget(pace, group, "full")).toBeLessThanOrEqual(24 - 10);
    }
  });

  it("gives a packed pace more hours than a relaxed one", () => {
    expect(dayBudget("packed", group, "full")).toBeGreaterThan(dayBudget("relaxed", group, "full"));
  });

  it("shortens the day when young children are travelling", () => {
    const withKids = { ...group, hasYoungChildren: true };
    expect(dayBudget("balanced", withKids, "full")).toBeLessThan(dayBudget("balanced", group, "full"));
  });

  it("keeps arrival and departure days light", () => {
    expect(dayBudget("balanced", group, "arrival")).toBeLessThan(dayBudget("balanced", group, "full"));
    expect(dayBudget("balanced", group, "departure")).toBeLessThan(dayBudget("balanced", group, "full"));
  });

  it("never plans more than the daily sightseeing cap, even at the busiest pace", () => {
    const cap = policy.dayPlanning.maxSightseeingHoursPerDay;
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      for (const kind of ["arrival", "departure", "transfer", "full"] as const) {
        expect(dayBudget(pace, group, kind)).toBeLessThanOrEqual(cap);
      }
    }
  });
});

describe("daily sightseeing cap", () => {
  const cap = policy.dayPlanning.maxSightseeingHoursPerDay;
  const placeIds = ["cairo"];

  it("holds on every day of a busy itinerary", () => {
    const q = quote({ placeIds, nights: 3, pace: "packed" });
    for (const day of q.days) {
      expect(day.activeHours).toBeLessThanOrEqual(cap);
      expect(day.budgetHours).toBeLessThanOrEqual(cap);
    }
  });

  it("adds a requested outing rather than removing it", () => {
    // The "you could also add" button used to toggle the cluster's
    // *exclusion*, so clicking a suggestion deleted it instead of adding it.
    const base = quote({ placeIds, nights: 1, pace: "packed" });
    const wanted = base.suggestions.find((s) => s.clusterId && s.hours <= 4);
    expect(wanted).toBeDefined();

    const after = quote({ placeIds, nights: 1, pace: "packed", pinnedClusterIds: [wanted!.clusterId!] });
    const planned = after.days.flatMap((d) => d.activities).map((a) => a.clusterId);
    expect(planned).toContain(wanted!.clusterId);
  });

  it("holds the cap even when every suggestion is requested at once", () => {
    const base = quote({ placeIds, nights: 1, pace: "packed" });
    const everything = base.suggestions.map((s) => s.clusterId!).filter(Boolean);
    expect(everything.length).toBeGreaterThan(0);

    const stuffed = quote({ placeIds, nights: 1, pace: "packed", pinnedClusterIds: everything });
    for (const day of stuffed.days) {
      expect(day.activeHours).toBeLessThanOrEqual(cap);
    }
  });

  it("tells the traveller when a requested outing will not fit", () => {
    const base = quote({ placeIds, nights: 1, pace: "packed" });
    const everything = base.suggestions.map((s) => s.clusterId!).filter(Boolean);
    const stuffed = quote({ placeIds, nights: 1, pace: "packed", pinnedClusterIds: everything });

    const placed = new Set(stuffed.days.flatMap((d) => d.activities).map((a) => a.clusterId));
    const rejected = everything.filter((id) => !placed.has(id));
    expect(rejected.length).toBeGreaterThan(0);

    const told = stuffed.warnings.some(
      (w) => w.audience === "traveller" && /sightseeing limit/i.test(w.message),
    );
    expect(told).toBe(true);
  });

  it("warns the traveller instead of silently leaving free days when nights outrun the content", () => {
    // A single-destination stay long enough to exhaust every cluster on a
    // relaxed pace used to surface only as a quiet "Free day at leisure"
    // note buried on the day card — no traveller wants that as a surprise.
    const q = quote({ placeIds, nights: 10, pace: "relaxed" });
    const freeDays = q.days.filter((d) => d.notes.includes("Free day at leisure"));
    expect(freeDays.length).toBeGreaterThan(0);

    const told = q.warnings.some(
      (w) => w.audience === "traveller" && /free day/i.test(w.message) && /more nights/i.test(w.message),
    );
    expect(told).toBe(true);
  });
});

describe("reference package matching", () => {
  it("recognises a package from its places", () => {
    const hit = matchReferencePackage(["cairo", "luxor", "alexandria", "nile"], core.packages);
    expect(hit?.name).toBe("Mystic Egypt");
    expect(hit?.matchRatio).toBe(1);
  });

  it("returns nothing for places in no package", () => {
    expect(matchReferencePackage(["not-a-place"], core.packages)).toBeNull();
  });
});

describe("end-to-end quotation", () => {
  const q = quote({ placeIds: ["cairo", "luxor", "alexandria", "nile"], nights: 12 });

  it("produces one more day than nights", () => {
    expect(q.days).toHaveLength(13);
    expect(q.stays.reduce((a, s) => a + s.nights, 0)).toBe(12);
  });

  it("anchors on the published package", () => {
    expect(q.referencePackage?.name).toBe("Mystic Egypt");
  });

  it("never breaches the rest requirement", () => {
    for (const day of q.days) expect(day.activeHours).toBeLessThanOrEqual(24 - 10);
  });

  it("locks the land package so it cannot be removed", () => {
    const locked = q.lineItems.filter((i) => i.locked).map((i) => i.component);
    expect(locked).toContain("hotel");
    expect(locked).toContain("airport-transfer");
    expect(locked).toContain("local-transport");
  });

  it("includes visa support by default", () => {
    expect(q.lineItems.some((i) => i.component === "visa")).toBe(true);
  });

  it("drops visa when the traveller deselects it", () => {
    const without = quote({ placeIds: ["cairo", "luxor"], nights: 6, includeVisa: false });
    expect(without.lineItems.some((i) => i.component === "visa")).toBe(false);
    expect(without.totals.total).toBeLessThan(
      quote({ placeIds: ["cairo", "luxor"], nights: 6 }).totals.total,
    );
  });

  it("applies the markup chain in order", () => {
    const t = q.totals;
    expect(t.costBeforeMarkup).toBe(t.directCost + t.contingency);
    expect(t.total).toBeGreaterThan(t.costBeforeMarkup);
    expect(t.perPerson).toBe(Math.round(t.total / 2));
  });

  it("records the provenance of every rate", () => {
    for (const item of q.lineItems) {
      expect(["workbook", "estimated", "live", "manual"]).toContain(item.source);
    }
  });

  it("charges more for a better hotel", () => {
    const budget = quote({ placeIds: ["cairo"], nights: 4, hotelStar: "3 Star", hotelZone: "Outskirts" });
    const luxe = quote({ placeIds: ["cairo"], nights: 4, hotelStar: "5 Star", hotelZone: "Central" });
    expect(luxe.totals.total).toBeGreaterThan(budget.totals.total);
  });

  it("charges more for full board than breakfast only", () => {
    const bb = quote({ placeIds: ["cairo"], nights: 4, mealPlan: "breakfast" });
    const fb = quote({ placeIds: ["cairo"], nights: 4, mealPlan: "full-board" });
    expect(fb.totals.total).toBeGreaterThan(bb.totals.total);
  });

  it("plans something to do on most days", () => {
    const planned = q.days.filter((d) => d.activities.length).length;
    expect(planned).toBeGreaterThanOrEqual(q.days.length / 2);
  });

  it("never repeats a cluster across the trip", () => {
    const ids = q.days.flatMap((d) => d.activities.map((a) => a.clusterId)).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("guardrails", () => {
  it("extends the trip so every destination gets a night", () => {
    const q = quote({ placeIds: ["cairo", "luxor", "alexandria"], nights: 1 });
    expect(q.stays.reduce((a, s) => a + s.nights, 0)).toBeGreaterThanOrEqual(3);
    expect(q.warnings.some((w) => /at least one night/.test(w.message))).toBe(true);
  });

  it("rejects a selection with no known places", () => {
    expect(() => quote({ placeIds: ["nope"], nights: 3 })).toThrow();
  });

  it("prices a family differently from a couple", () => {
    const couple = quote({ placeIds: ["cairo"], nights: 4 });
    const family = quote({
      placeIds: ["cairo"], nights: 4, adults: 2, childAges: [4, 9],
      travellerType: "family", tripStyle: "family",
    });
    expect(family.totals.total).toBeGreaterThan(couple.totals.total);
    expect(family.pax.total).toBe(4);
  });

  it("varies visa cost with nationality", () => {
    const indian = quote({ placeIds: ["tokyo"], nights: 4, nationality: "IND" });
    const american = quote({ placeIds: ["tokyo"], nights: 4, nationality: "USA" });
    const fee = (q: typeof indian) =>
      q.lineItems.filter((i) => i.component === "visa").reduce((a, i) => a + i.totalInr, 0);
    // Japan is visa-free for a US passport and e-visa for an Indian one.
    expect(fee(indian)).toBeGreaterThan(fee(american));
  });

  it("varies airfare with the departure city", () => {
    const fare = (departureCity: string) =>
      quote({ placeIds: ["bangkok"], nights: 4, departureCity })
        .lineItems.filter((i) => i.component === "flight")
        .reduce((a, i) => a + i.totalInr, 0);
    // Both must be priced, and Kolkata must be cheaper than Delhi to Bangkok.
    expect(fare("DEL")).toBeGreaterThan(0);
    expect(fare("CCU")).toBeGreaterThan(0);
    expect(fare("CCU")).toBeLessThan(fare("DEL"));
  });

  it("is deterministic", () => {
    const a = quote({ placeIds: ["cairo", "luxor"], nights: 6 });
    const b = quote({ placeIds: ["cairo", "luxor"], nights: 6 });
    expect(a.totals).toEqual(b.totals);
    expect(a.days.map((d) => d.activities.map((x) => x.title))).toEqual(
      b.days.map((d) => d.activities.map((x) => x.title)),
    );
  });
});
