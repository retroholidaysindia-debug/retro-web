/**
 * Atlas ETL entry point.
 *
 * Compiles the four source inputs into the relational bundles the quotation
 * engine reads, plus a SQLite schema/seed pair for a future D1 migration and a
 * review workbook listing everything that had to be estimated.
 *
 *   npm run build-atlas            # incremental, uses the cached visa matrix
 *   npm run build-atlas -- --refresh   # re-fetch vendored datasets
 *   npm run build-atlas -- --geocode   # also look up places missing a coordinate
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CoreBundle,
  type DestinationBundle,
  type DestinationGuidance,
  type Place,
} from "../../lib/atlas/schema";
import { parseMaster, parseTransport } from "./parse-master";
import { parsePricing } from "./parse-pricing";
import { parseDestinations } from "./parse-destinations";
import {
  estimateInsuranceAndTax,
  estimatePlaceRates,
  reconcilePackagePrices,
  type Estimate,
} from "./estimate";
import { DEPARTURE_CITIES, deriveFlightBands, fetchLiveFlights } from "./enrich";
import { fetchAirports, parseAirports } from "./vendor-airports";
import { buildVisaRules, fetchVisaMatrix, SUPPORTED_NATIONALITIES } from "./vendor-visa";
import { emitSchemaSql, emitSeedSql } from "./emit-sql";
import { writeWorkbook, type SheetSpec } from "./xlsx-write";
import { normalise } from "./normalise";
import { buildCountryCompatibility, defaultNightsFor } from "./compatibility";
import { resolvePlaceCoords } from "./place-coords";
import { deriveTransport } from "./transport-derive";

const IN = {
  master: "input_files/travel_agency_dataset.json",
  pricing: "input_files/Pricing_Rules.xlsx",
  transport: "input_files/transport_json_regions",
  destinations: "input_files/Destination Files markdown",
  aliases: "content/place-aliases.json",
  placeCountries: "content/place-countries.json",
};

/**
 * Guidance sections the engine reasons with directly, and so ships inside the
 * destination bundle rather than only in the lazily-loaded guidance file:
 * §12 airport transfer logic and §33 destination decision rules. Everything
 * carrying an explicit audience (§18-23 and the per-audience blocks elsewhere)
 * is included too, wherever it appears.
 */
const ENGINE_GUIDANCE_SECTIONS = new Set([12, 33]);

const OUT = {
  // Bundles are fetched by the browser, so they ship as static assets.
  data: "public/atlas",
  destinations: "public/atlas/destinations",
  // Planner guidance is bulky and only needed once a place is actually being
  // planned, so it is fetched separately from the destination bundle.
  guidance: "public/atlas/guidance",
  // The SQL mirror and the review workbook are build artefacts, not web assets.
  sql: "data/atlas/sql",
  review: "data/atlas/Atlas_Rate_Review.xlsx",
};

const refresh = process.argv.includes("--refresh");
const geocode = process.argv.includes("--geocode");

function writeJson(file: string, value: unknown): number {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(value);
  writeFileSync(file, body);
  return Buffer.byteLength(body);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const started = Date.now();
  console.log("Atlas ETL");

  // Hand-maintained overrides win over any fuzzy match.
  const aliasOverrides: Record<string, string> = existsSync(IN.aliases)
    ? JSON.parse(readFileSync(IN.aliases, "utf8"))
    : {};
  const countryOverrides: Record<string, string> = existsSync(IN.placeCountries)
    ? JSON.parse(readFileSync(IN.placeCountries, "utf8"))
    : {};

  // --- 1. master catalogue ------------------------------------------------
  const geo = parseMaster(IN.master, countryOverrides);
  console.log(
    `  master      ${geo.regions.length} regions, ${geo.countries.length} countries, ` +
      `${geo.subregions.length} subregions, ${geo.states.length} states, ` +
      `${geo.places.length} places, ${geo.packages.length} packages`,
  );
  if (geo.overriddenPlaces.length) {
    console.log(`              ${geo.overriddenPlaces.length} place(s) re-assigned by content/place-countries.json`);
  }
  if (geo.ambiguousPlaces.length) {
    console.log(`              ${geo.ambiguousPlaces.length} place(s) with an ambiguous country — see the review workbook`);
  }

  // --- 2. pricing workbook ------------------------------------------------
  const pricing = parsePricing(IN.pricing, geo.places, aliasOverrides);
  console.log(
    `  pricing     ${pricing.hotelRates.length} hotel, ${pricing.transferRates.length} transfer, ` +
      `${pricing.mealRates.length} meal, ${pricing.activityRates.length} activity rates ` +
      `across ${pricing.pricedPlaceIds.size} places`,
  );

  // --- 3. destination content --------------------------------------------
  const content = parseDestinations(IN.destinations, geo.places, aliasOverrides);
  console.log(`  content     ${content.byPlaceId.size} destination files matched`);

  // --- 4. transport network -----------------------------------------------
  const transport = parseTransport(IN.transport, geo, aliasOverrides);
  console.log(`  transport   ${transport.routes.length} routes`);

  // --- 5. fill the gaps ----------------------------------------------------
  const costLevels = new Map<string, string | null>();
  for (const [placeId, c] of content.byPlaceId) costLevels.set(placeId, c.destination.overallCostLevel);

  // Airport coordinates turn each place's IATA code into a point on the globe,
  // which is what lets airfare be derived from real distance.
  const airports = parseAirports(await fetchAirports(refresh));
  const airportsByPlace = new Map<string, string[]>();
  for (const [placeId, c] of content.byPlaceId) {
    const codes = c.destination.primaryAirports.filter((code) => airports.has(code));
    if (codes.length) airportsByPlace.set(placeId, codes);
  }
  console.log(
    `  airports    ${airports.size} served airports vendored; ` +
      `${airportsByPlace.size}/${geo.places.length} places resolved to one`,
  );

  // A coordinate per place is what lets the router reason about how *long* a
  // leg takes, not just what it costs.
  const placeCoords = await resolvePlaceCoords(
    geo.places, geo.countries, airportsByPlace, airports, geocode,
  );
  const bySource = (s: string) => [...placeCoords.source.values()].filter((v) => v === s).length;
  console.log(
    `  coords      ${placeCoords.points.size}/${geo.places.length} places located ` +
      `(${bySource("marker")} marker, ${bySource("airport")} airport, ${bySource("geocode")} geocoded)` +
      (placeCoords.pendingGeocode
        ? `; ${placeCoords.pendingGeocode} awaiting a --geocode pass`
        : ""),
  );

  // The source data prices most legs but times almost none of them, which
  // made every mode look the same length and handed 84% of routes to a bus.
  const placeCountry = new Map(geo.places.map((p) => [p.id, p.countryId]));
  const countryRegion = new Map(geo.countries.map((c) => [c.id, c.regionId]));
  const derivedTransport = deriveTransport(
    transport.routes, placeCoords.points, placeCountry, countryRegion,
  );
  transport.routes = derivedTransport.routes;
  console.log(
    `  transport+  ${derivedTransport.stats.distancesResolved} legs measured; ` +
      `${derivedTransport.stats.durationsDerived} duration(s) and ` +
      `${derivedTransport.stats.faresDerived} fare(s) derived from distance` +
      (derivedTransport.stats.durationsStillMissing
        ? `; ${derivedTransport.stats.durationsStillMissing} still untimed`
        : ""),
  );

  const gaps = estimatePlaceRates({
    places: geo.places,
    countries: geo.countries,
    hotelRates: pricing.hotelRates,
    transferRates: pricing.transferRates,
    mealRates: pricing.mealRates,
    costLevels,
  });
  console.log(
    `  estimated   ${gaps.hotelRates.length} hotel, ${gaps.transferRates.length} transfer, ` +
      `${gaps.mealRates.length} meal rates for unpriced places ` +
      `(${gaps.unresolved.length} still unresolved)`,
  );

  const flights = deriveFlightBands(
    geo.countries, geo.regions, geo.places, airportsByPlace, airports,
  );
  const distanceDerived = flights.workings.filter((w) => w.method === "distance").length;
  console.log(
    `  flights     ${flights.bands.length} bands; ${distanceDerived}/${flights.workings.length} ` +
      `routes priced from real distance, the rest from a regional fallback`,
  );

  // Live fares upgrade the derived bands where credentials are configured.
  const liveMonth = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 7);
  const livePairs = flights.workings
    .filter((w) => w.method === "distance" && w.fromCity === "DEL" && w.airport)
    .map((w) => ({ origin: "DEL", destination: w.airport!.slice(0, 3), month: liveMonth }));
  const liveFlights = await fetchLiveFlights(
    livePairs, process.env.TRAVELPAYOUTS_TOKEN, console.log,
  );
  for (const sample of liveFlights) {
    for (const band of flights.bands) {
      if (band.originCity !== sample.origin || band.carrier !== sample.carrier) continue;
      const dest = flights.workings.find(
        (w) => w.country === geo.countries.find((c) => c.id === band.destCountryId)?.name,
      );
      if (!dest?.airport?.startsWith(sample.destination)) continue;
      const factor = band.cabin === "Economy" ? 1 : band.cabin === "Premium Economy" ? 1.7 : 3.2;
      band.priceLow = Math.round(sample.inr * factor * 0.9);
      band.priceHigh = Math.round(sample.inr * factor * 1.3);
      band.source = "live";
    }
  }

  const cover = estimateInsuranceAndTax(geo.regions, geo.places, geo.countries);

  const visaCsv = await fetchVisaMatrix(refresh);
  const visaRules = buildVisaRules(visaCsv, geo.countries);
  console.log(
    `  visa        ${visaRules.length} rules across ${SUPPORTED_NATIONALITIES.length} nationalities`,
  );

  // --- 6. merge and flag ---------------------------------------------------
  const hotelRates = [...pricing.hotelRates, ...gaps.hotelRates];
  const transferRates = [...pricing.transferRates, ...gaps.transferRates];
  const mealRates = [...pricing.mealRates, ...gaps.mealRates];

  const ratedPlaces = new Set(hotelRates.map((r) => r.placeId));
  const places: Place[] = geo.places.map((p) => {
    const point = placeCoords.points.get(p.id);
    return {
      ...p,
      hasRates: ratedPlaces.has(p.id),
      hasContent: content.byPlaceId.has(p.id),
      // Carried into the bundle so the engine can measure any pair of places,
      // not just the ~1.4% that share an authored route.
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
    };
  });

  // --- 7. per-place summaries used by the allocator ------------------------
  const activityRatesByPlace = new Map<string, typeof pricing.activityRates>();
  for (const r of pricing.activityRates) {
    const list = activityRatesByPlace.get(r.placeId);
    if (list) list.push(r);
    else activityRatesByPlace.set(r.placeId, [r]);
  }

  const placeSummaries: CoreBundle["placeSummaries"] = places.map((p) => {
    const c = content.byPlaceId.get(p.id);
    const styleScores: Record<string, number> = {};
    for (const s of c?.suitability ?? []) styleScores[normalise(s.category)] = s.score;
    const monthPrice: Record<string, number> = {};
    const monthWeather: Record<string, number> = {};
    const monthOverall: Record<string, number> = {};
    for (const m of c?.months ?? []) {
      if (m.price != null) monthPrice[String(m.month)] = m.price;
      if (m.weather != null) monthWeather[String(m.month)] = m.weather;
      if (m.overall != null) monthOverall[String(m.month)] = m.overall;
    }
    const clusterCount = c?.clusters.length ?? 0;
    const activityCount = activityRatesByPlace.get(p.id)?.length ?? 0;
    // Roughly half the catalogue has no destination write-up with its own
    // minimum/ideal/maximum nights — fall back to a content-driven estimate
    // rather than leaving the field null, so the nights slider always has a
    // sane bound to show.
    const fallback = defaultNightsFor(clusterCount, activityCount);
    return {
      placeId: p.id,
      minNights: c?.destination.minNights ?? fallback.minNights,
      idealNights: c?.destination.idealNights ?? fallback.idealNights,
      maxNights: c?.destination.maxNights ?? fallback.maxNights,
      clusterCount,
      activityCount,
      styleScores,
      monthPrice,
      monthWeather,
      monthOverall,
    };
  });

  const countryCompatibility = buildCountryCompatibility(geo.countries, transport.routes, geo.packages);
  console.log(
    `  compat      ${Object.keys(countryCompatibility).length} countries with at least one combinable partner`,
  );

  // --- 8. emit bundles -----------------------------------------------------
  rmSync(OUT.destinations, { recursive: true, force: true });

  const core: CoreBundle = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    regions: geo.regions,
    countries: geo.countries,
    subregions: geo.subregions,
    states: geo.states,
    places,
    packages: geo.packages,
    hotelRates,
    transferRates,
    mealRates,
    markupRules: pricing.markupRules,
    flightBands: flights.bands,
    insuranceRates: cover.insurance,
    cityTaxes: cover.cityTax,
    departureCities: DEPARTURE_CITIES.map((c) => {
      const airport = airports.get(c.iata);
      return {
        code: c.iata,
        label: c.label,
        lat: airport?.lat ?? null,
        lon: airport?.lon ?? null,
      };
    }),
    countryCompatibility,
    placeSummaries,
  };
  CoreBundle.parse(core);

  const coreBytes = writeJson(path.join(OUT.data, "core.json"), core);
  const routeBytes = writeJson(path.join(OUT.data, "routes.json"), { routes: transport.routes });
  const visaBytes = writeJson(path.join(OUT.data, "visa.json"), { rules: visaRules });

  const destinationBundles: DestinationBundle[] = [];
  let destBytes = 0;
  let guidanceBytes = 0;
  let guidanceRows = 0;
  /** Every guidance block, for the SQL mirror — which is the complete model. */
  const everyGuidanceRow: DestinationGuidance[] = [];
  rmSync(OUT.guidance, { recursive: true, force: true });

  for (const place of places) {
    const c = content.byPlaceId.get(place.id);
    const rates = activityRatesByPlace.get(place.id) ?? [];
    if (!c && !rates.length) continue;

    // Activity identity comes from the workbook where it exists (it carries the
    // priced codes) and falls back to section 15 of the destination file.
    const activities = rates.length
      ? pricing.activities.filter((a) => a.placeId === place.id)
      : (c?.activities ?? []);

    // Guidance is the bulkiest thing these files carry — ~48KB per place once
    // all 21 previously-skipped sections are captured, which would triple the
    // lazily-loaded destination bundle. So it ships in two tiers: the blocks
    // the engine actually reasons about travel with the bundle, and the
    // complete, lossless set in its own file for the destination page and the
    // agent to draw on.
    const allGuidance = c?.guidance ?? [];
    const forEngine = allGuidance.filter(
      (g) => g.audience != null || ENGINE_GUIDANCE_SECTIONS.has(g.section),
    );
    if (allGuidance.length) {
      guidanceRows += allGuidance.length;
        everyGuidanceRow.push(...allGuidance);
        guidanceBytes += writeJson(path.join(OUT.guidance, `${place.slug}.json`), {
          placeId: place.id,
          guidance: allGuidance,
        });
      }

    const bundle: DestinationBundle = {
      place,
      destination: c?.destination ?? null,
      suitability: c?.suitability ?? [],
      tags: c?.tags ?? [],
      months: c?.months ?? [],
      areas: c?.areas ?? [],
      attractions: c?.attractions ?? [],
      activities,
      activityRates: rates,
      purposeActivities: c?.purposeActivities ?? [],
      clusters: c?.clusters ?? [],
      guidance: forEngine,
      decisionRules: c?.decisionRules ?? [],
    };
    destinationBundles.push(bundle);
    destBytes += writeJson(path.join(OUT.destinations, `${place.slug}.json`), bundle);
  }

  console.log(
    `  bundles     core ${kb(coreBytes)}, routes ${kb(routeBytes)}, visa ${kb(visaBytes)}, ` +
      `${destinationBundles.length} destinations ${kb(destBytes)}`,
  );
  console.log(
    `  guidance    ${guidanceRows} blocks from the 21 previously-unread sections ` +
      `(${kb(guidanceBytes)}, lazily loaded)`,
  );

  // --- 9. SQLite mirror ----------------------------------------------------
  mkdirSync(OUT.sql, { recursive: true });
  writeFileSync(path.join(OUT.sql, "schema.sql"), emitSchemaSql());
  const seed = emitSeedSql(core, destinationBundles, transport.routes, visaRules, everyGuidanceRow);
  writeFileSync(path.join(OUT.sql, "seed.sql"), seed);
  console.log(`  sql         schema.sql + seed.sql (${kb(Buffer.byteLength(seed))})`);


  // --- 10. review workbook -------------------------------------------------
  // Two sections: what we filled in ourselves, and what only the agency can
  // supply. Every "missing" row names the exact file and section to update.
  const estimates: Estimate[] = [...gaps.estimates, ...cover.estimates];
  const countryName = new Map(geo.countries.map((c) => [c.id, c.name]));
  const stateName = new Map(geo.states.map((s) => [s.id, s.name]));
  const regionName = new Map(geo.regions.map((r) => [r.id, r.name]));
  const regionOfPlace = (placeId: string) => {
    const countryId = places.find((p) => p.id === placeId)?.countryId;
    const country = geo.countries.find((c) => c.id === countryId);
    return country ? (regionName.get(country.regionId) ?? "") : "";
  };

  // Minimum land cost per person, used to show how far each published package
  // price is from what its own components imply.
  const landCost = new Map<string, number>();
  const rate = <T extends { placeId: string }>(rows: T[], placeId: string) =>
    rows.filter((r) => r.placeId === placeId);
  for (const pkg of geo.packages) {
    const nights = pkg.nights || 1;
    const per = nights / Math.max(1, pkg.placeIds.length);
    let total = 0;
    for (const placeId of pkg.placeIds) {
      const hotel = rate(hotelRates, placeId).find((h) => h.star === "3 Star" && h.zone === "Outskirts");
      if (hotel) total += (hotel.inr * per) / 2; // twin share
      const sightseeing = rate(transferRates, placeId).find((t) => t.service === "Hotel→Sightseeing");
      if (sightseeing) total += (sightseeing.inr * per) / 2;
      for (const a of activityRatesByPlace.get(placeId) ?? []) total += a.inr;
    }
    const first = pkg.placeIds[0];
    const arrive = rate(transferRates, first).find((t) => t.service === "Airport→Hotel");
    const depart = rate(transferRates, first).find((t) => t.service === "Hotel→Airport");
    total += ((arrive?.inr ?? 0) + (depart?.inr ?? 0)) / 2;
    landCost.set(pkg.id, total);
  }

  const markupChain = (() => {
    const get = (rule: string) => pricing.markupRules.find((m) => m.rule === rule)?.value ?? 0;
    const contingency = 0.03;
    return (
      (1 + contingency) *
      (1 + get("Base Agent Markup")) *
      (1 + get("Sales / VAT")) *
      (1 + get("Payment Gateway Fee") + get("FX / Currency Buffer"))
    );
  })();

  const reconciliation = reconcilePackagePrices(
    geo.packages, landCost, markupChain, flights.bands,
  );

  const missingRateSheet = places.filter((p) => !pricing.pricedPlaceIds.has(p.id));
  const missingContent = places.filter((p) => !content.byPlaceId.has(p.id));
  const noClusters = places.filter((p) => !(content.byPlaceId.get(p.id)?.clusters.length));
  const noActivities = places.filter((p) => !(activityRatesByPlace.get(p.id)?.length));
  const overPriced = reconciliation.filter((r) => r.headroom < 0);
  const liveCount = flights.bands.filter((b) => b.source === "live").length;

  const inconsistencies: [string, string, string][] = [
    ["Published price below component cost",
      `${overPriced.length} of ${reconciliation.length} packages`,
      "Priced from its own rate card at 3-star/breakfast-only/twin-share, the land cost plus markup already exceeds the published land-only 'from' price (airfare is quoted on top and is not part of this comparison). See Package Reconciliation. Either the published prices or the rate card needs revising."],
    ["Country repeats its package's place list",
      "All multi-country packages",
      "France, Switzerland, Luxembourg and Belgium each list all four as their places. We resolve ownership by name match, but the source would be cleaner if each country listed only its own cities."],
    ["Country appears in two regions", "Nepal (South Asia and East Asia)",
      "Deduplicated to a single country row owned by South Asia; the Kailash package references it across regions."],
    ["Pseudo-country still present", "Scandinivia",
      "Holds Denmark, Norway, Sweden, Finland and Iceland as places rather than being five countries. Flagged isCluster."],
    ["Country listed but no city breakdown",
      `${geo.countries.filter((c) => places.filter((p) => p.countryId === c.id).length <= 1).length} countries`,
      "France, Germany, Spain and others have no cities of their own, so the whole country is treated as one place and cannot be day-planned at city level."],
    ["Spelling drift from standard names",
      "Hungery, Linchestine, Czech, Scandinivia, Edinburg, Phillipines, Kyrgisthan, Nathrang, Seol",
      "Handled by content/place-aliases.json for joins, but display names should be corrected at source."],
    ["State without a subregion", stateName.get(geo.states.find((s) => !s.subregionId)?.id ?? "") ?? "none",
      "Every other Indian state is tagged North/South/West. This one has no subregion, so it sorts outside the hierarchy."],
    ["No East India subregion", "India has North, South and West only",
      "West Bengal, Odisha, Sikkim and Jharkhand are filed under North India or nothing."],
    ["Places named only inside a package", "Nile, Byzantium",
      "They appear in a package's places but in no country's list, so their country is inherited from the package."],
    ["Cross-border route filed under one country",
      `${geo.ambiguousPlaces.length} place(s) still ambiguous, ${geo.overriddenPlaces.length} corrected`,
      "A package spanning countries lists its whole route under each member country, so a place can end up owned by the country the traveller merely started in. This mis-prices visas and border transport. Corrections live in content/place-countries.json — see the Place Ownership sheet."],
  ];

  /**
   * Section 2. Each row names the file and the section within it, so a gap can
   * be closed without having to work out where the data belongs.
   */
  const missingData: (string | number)[][] = [
    ["Flight fares",
      liveCount ? "Partly live" : "Estimated from distance",
      "input_files/Pricing_Rules.xlsx",
      "New sheet: Flight_Rules (its INDEX1 lists it, but the sheet is absent)",
      `${flights.bands.length} bands across ${geo.countries.length} countries x ${DEPARTURE_CITIES.length} departure cities`,
      "Columns: Origin IATA, Destination country, Carrier (LCC/FSC), Cabin, Trip type, Low INR, High INR",
      liveCount
        ? `${liveCount} band(s) are live from Travelpayouts; the rest are derived from great-circle distance. Your contracted fares would replace both.`
        : "Currently derived from great-circle distance between each Indian metro and the destination airport. Set TRAVELPAYOUTS_TOKEN to pull live fares, or supply contracted fares.",
    ],
    ["Visa fees",
      "Estimated (requirement is real)",
      "input_files/Pricing_Rules.xlsx",
      "New sheet: Other_Costs",
      `${geo.countries.filter((c) => c.iso3).length} countries x ${SUPPORTED_NATIONALITIES.length} nationalities`,
      "Columns: Nationality ISO3, Destination country, Government fee INR, Your handling fee INR, Processing days",
      "The requirement (visa-free / e-visa / on-arrival / required) is auto-updated from an open dataset and is correct. Only the fee is invented — no free source publishes it.",
    ],
    ["Travel insurance rates", "Estimated",
      "input_files/Pricing_Rules.xlsx", "New sheet: Other_Costs",
      `${geo.regions.length} regions, or one row per policy band`,
      "Columns: Zone, Per person per day INR, Cover level, Insurer",
      "Currently a typical retail day rate per region. Your insurer's actual card is required.",
    ],
    ["City / tourism tax", "Estimated",
      "input_files/Pricing_Rules.xlsx", "New sheet: Other_Costs",
      "Per destination, per person per night",
      "Columns: Destination, Per person per night INR, Applies to star categories",
      "Currently a regional average. These are statutory and vary by city and hotel class.",
    ],
    ["Guide day rates", "Not priced separately",
      "input_files/Pricing_Rules.xlsx", "Destination sheets, Transport block",
      "Per destination, per language",
      "Add rows: Category=Transport, Parameter=Guide Full Day / Guide Half Day",
      "Guide cost is currently folded into activity rates, so it cannot be shown or removed as its own line.",
    ],
    ["Hotel modifiers", "Policy defaults",
      "input_files/Pricing_Rules.xlsx", "New sheet: Hotel_Modifiers",
      "Single supplement, extra bed, child sharing, upgrades",
      "Columns: Modifier, Applies to star category, Percent or flat INR",
      "Currently defaults in content/quote-policy.json (extra bed = 35% of room). Your contracted modifiers should replace them.",
    ],
    ["Contracted hotel, transfer and meal rates", "Estimated from peers",
      "input_files/Pricing_Rules.xlsx", `One new destination sheet per place (${missingRateSheet.length} needed)`,
      `${missingRateSheet.length} places`,
      "Copy an existing destination sheet's layout: Hotel / Transport / Meals blocks, then the Activities block",
      "See the 'Our Estimates' sheet for every inferred value and what it was inferred from.",
    ],
    ["Attraction entry tickets", "Missing",
      "input_files/Pricing_Rules.xlsx", "Destination sheets, Activities block",
      `${noActivities.length} places have no priced activity`,
      "Rows: Category=Activities, Activities_ID={DEST}_A_{AREA}, Unit, Baseline, Local Currency INR",
      "No free API publishes entry-ticket prices; we checked Wikidata (23 priced items in all of India) and OpenStreetMap (effectively unpopulated). These must be curated.",
    ],
    ["Destination knowledge files", "Missing",
      "input_files/Destination Files markdown/", `One .md per place (${missingContent.length} needed)`,
      `${missingContent.length} places`,
      "Follow the existing 36-section template. Sections 6, 8, 14, 15, 16, 17 and 27 are the ones the engine reads.",
      "Without these a place gets a generic day plan: no attractions, no clusters, no suitability scores, no seasonality.",
    ],
    ["Missing Indian states", "Not in the catalogue",
      "input_files/travel_agency_dataset.json", "regions[] where region = 'India', countries[]",
      "Assam and Meghalaya",
      "Add a country node with subregion (e.g. 'East India') and its places",
      "You have destination files for Kaziranga, Shillong and Guwahati with nowhere to file them.",
    ],
    ["Places with data but no catalogue entry", "Orphaned",
      "input_files/travel_agency_dataset.json", "The relevant region's countries[].places[]",
      "Nabadwip, Wuhan, Romania, Tahiti",
      "Add the place to its country, or tell us the destination is discontinued",
      "Rates and/or destination files exist for these but the master does not list them, so they cannot be sold.",
    ],
    ["East India subregion", "Missing",
      "input_files/travel_agency_dataset.json", "regions[] where region = 'India', countries[].subregion",
      "West Bengal, Odisha, Sikkim, Jharkhand",
      "Set subregion = 'East India'",
      "Only North, South and West India exist, so eastern states are filed under North India or left unassigned.",
    ],
    ["City breakdown for whole-country destinations", "Coarse",
      "input_files/travel_agency_dataset.json", "regions[] > countries[].places[]",
      `${geo.countries.filter((c) => places.filter((p) => p.countryId === c.id).length <= 1).length} countries`,
      "Replace the single country-as-place with its actual cities",
      "France, Germany and Spain are each one 'place', so they cannot be day-planned or priced at city level.",
    ],
    ["Domestic Indian airfare", "Over-stated",
      "input_files/Pricing_Rules.xlsx", "New sheet: Flight_Rules, rows where destination is India",
      "27 Indian packages",
      "Columns: Origin IATA, Destination IATA, Carrier, Low INR, High INR",
      "Fares are derived per country, and India resolves to a single destination airport, so a Delhi-Jaipur trip is priced off a long domestic hop. Sector-level domestic fares would fix this.",
    ],
    ["Published package prices", "Contradictory",
      "input_files/travel_agency_dataset.json", "regions[] > packages[].price",
      `${overPriced.length} of ${reconciliation.length} packages`,
      "Confirm the published price, or the rate card behind it",
      "For these, land cost plus markup at 3-star/breakfast-only already exceeds the published land-only price (airfare is quoted on top and excluded from this comparison). See 'Package Reconciliation'.",
    ],
  ];

  const sheets: SheetSpec[] = [
    {
      name: "READ ME",
      header: ["Section", "Sheet", "What it holds"],
      rows: [
        ["", "READ ME", "This page"],
        ["1. OUR ESTIMATES", "Our Estimates", `${estimates.length} rates we inferred, each with its method and a blank column for your value`],
        ["1. OUR ESTIMATES", "Flight Fares (derived)", `${flights.bands.length} fare bands derived from real great-circle distance${liveCount ? `, ${liveCount} upgraded to live fares` : ""}`],
        ["1. OUR ESTIMATES", "Visa Requirements", "Auto-updated from an open dataset — the requirement is real, only the fee is estimated"],
        ["2. MISSING DATA", "Missing Data", `${missingData.length} categories, each naming the file and section to update`],
        ["2. MISSING DATA", "Missing Files", `${missingRateSheet.length} rate sheets and ${missingContent.length} destination files, listed per place`],
        ["2. MISSING DATA", "Inconsistencies", `${inconsistencies.length} contradictions between the sources`],
        ["2. MISSING DATA", "Package Reconciliation", "Published price vs what each package's own components cost"],
        ["2. MISSING DATA", "Place Ownership", `${geo.overriddenPlaces.length} corrected, ${geo.ambiguousPlaces.length} still ambiguous`],
        ["2. MISSING DATA", "Unmatched Names", "Source data that matches no place in the catalogue"],
        ["2. MISSING DATA", "Content Gaps", `${noClusters.length} places with no day-planning clusters`],
      ],
      widths: [20, 26, 84],
    },

    // --- Section 1: our estimates ------------------------------------------
    {
      name: "Our Estimates",
      header: ["Table", "Key", "Field", "Our Estimate (INR)", "Your Value (INR)", "How we worked it out", "Confidence"],
      rows: estimates.map((e) => [e.table, e.key, e.field, e.value, null, e.basis, e.confidence]),
      widths: [16, 52, 20, 18, 18, 50, 12],
    },
    {
      name: "Flight Fares (derived)",
      header: ["Destination Country", "Destination Airport", "From", "Distance km", "Mid return fare INR", "Method", "Your fare INR"],
      rows: flights.workings.map((w) => [
        w.country, w.airport ?? "no airport resolved", w.fromCity,
        w.distanceKm, w.midFareInr,
        w.method === "distance" ? "great-circle distance" : "regional fallback",
        null,
      ]),
      widths: [26, 40, 10, 14, 20, 24, 16],
    },
    {
      name: "Visa Requirements",
      header: ["Destination Country", "ISO3", "Indian passport requirement", "Source", "Fee incl. handling (INR)", "Your Fee (INR)"],
      rows: geo.countries
        .filter((c) => c.iso3)
        .map((c) => {
          const rule = visaRules.find((v) => v.nationality === "IND" && v.destCountryId === c.id);
          return [
            c.name, c.iso3, rule?.requirement ?? "unknown",
            "passport-index open dataset (real)", rule?.feeInr ?? 0, null,
          ];
        }),
      widths: [28, 10, 26, 32, 24, 18],
    },

    // --- Section 2: missing data -------------------------------------------
    {
      name: "Missing Data",
      header: ["What", "Status now", "File to update", "Section within that file", "Scope", "Expected shape", "Why it matters"],
      rows: missingData,
      widths: [34, 26, 40, 52, 42, 72, 96],
    },
    {
      name: "Missing Files",
      header: ["What is required", "For", "Region", "Country", "State", "Impact today"],
      rows: [
        ...missingRateSheet.map((p) => [
          "Sheet in Pricing_Rules.xlsx", p.name, regionOfPlace(p.id),
          countryName.get(p.countryId) ?? "", p.stateId ? (stateName.get(p.stateId) ?? "") : "",
          ratedPlaces.has(p.id) ? "Estimated from peers" : "Cannot be quoted",
        ]),
        ...missingContent.map((p) => [
          "Destination knowledge file (.md)", p.name, regionOfPlace(p.id),
          countryName.get(p.countryId) ?? "", p.stateId ? (stateName.get(p.stateId) ?? "") : "",
          "Generic day plan, no attractions",
        ]),
      ],
      widths: [32, 30, 20, 22, 20, 30],
    },
    {
      name: "Inconsistencies",
      header: ["Issue", "Where", "Detail"],
      rows: inconsistencies.map((r) => [...r]),
      widths: [38, 46, 96],
    },
    {
      name: "Package Reconciliation",
      header: ["Package", "Published land-only (INR pp)", "Land cost (INR pp)", "Land sell price (INR pp)", "Headroom", "Airfare quoted on top", "Verdict"],
      rows: reconciliation.map((r) => [
        r.name, r.published, r.land, r.landSellPrice, r.headroom, r.flightOnTop,
        r.headroom < 0 ? "Land cost plus markup exceeds the published price" : "Consistent",
      ]),
      widths: [44, 26, 18, 24, 14, 22, 46],
    },
    {
      name: "Place Ownership",
      header: ["Place", "Currently assigned to", "Status", "Package", "Possible countries", "Correct country (fill in)"],
      rows: [
        ...geo.overriddenPlaces.map((o) => {
          const place = places.find((p) => p.name === o.place);
          return [
            o.place, o.country, "Corrected by us — please confirm",
            place ? (geo.packages.find((pk) => pk.placeIds.includes(place.id))?.name ?? "") : "",
            "", null,
          ];
        }),
        ...geo.ambiguousPlaces.map((a) => [
          a.place, a.assignedTo, "AMBIGUOUS — needs your decision",
          a.packageName, a.candidates.join(" / "), null,
        ]),
      ],
      widths: [26, 24, 32, 34, 40, 26],
    },
    {
      name: "Unmatched Names",
      header: ["Source", "Name", "Note"],
      rows: [
        ...pricing.orphanSheets.map((s) => ["Pricing_Rules.xlsx sheet", s, "no place in the master catalogue"]),
        ...content.orphanFiles.map((s) => ["destination markdown file", s, "no place in the master catalogue"]),
        ...[...new Set(transport.unresolved.map((u) => u.name))].map((s) => ["transport route endpoint", s, "no place in the master catalogue"]),
        ...geo.unresolvedPackageCountries.map((u) => ["package country", u.country, `named by package "${u.packageName}" but not declared as a country`]),
      ],
      widths: [30, 40, 60],
    },
    {
      name: "Content Gaps",
      header: ["Place", "Region", "Country", "Destination file?", "Day-plan clusters", "Priced activities"],
      rows: noClusters.map((p) => {
        const c = content.byPlaceId.get(p.id);
        return [
          p.name, regionOfPlace(p.id), countryName.get(p.countryId) ?? "",
          c ? "yes" : "no", c?.clusters.length ?? 0,
          activityRatesByPlace.get(p.id)?.length ?? 0,
        ];
      }),
      widths: [32, 20, 26, 18, 18, 18],
    },
  ];

  writeWorkbook(OUT.review, sheets);
  console.log(
    `  review      ${OUT.review}\n` +
      `              section 1: ${estimates.length} estimated rates + ${flights.bands.length} derived fares\n` +
      `              section 2: ${missingData.length} missing categories, ${missingRateSheet.length + missingContent.length} missing files`,
  );

  // --- 11. summary ---------------------------------------------------------
  const quotable = places.filter((p) => p.hasRates).length;
  const withContent = places.filter((p) => p.hasContent).length;
  console.log(
    `\n  ${quotable}/${places.length} places quotable, ${withContent} with content, ` +
      `${DEPARTURE_CITIES.length} departure cities, done in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (gaps.unresolved.length) {
    console.log(`  WARNING: ${gaps.unresolved.length} places have no rates at all and cannot be quoted.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
