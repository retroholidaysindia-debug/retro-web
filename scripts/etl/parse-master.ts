/**
 * Parses `travel_agency_dataset.json` (the master catalogue) and the ten
 * per-region transport files into the geography, package and route tables.
 *
 * The catalogue nests as:
 *
 *   region ─┬─ countries[] ─ places[]
 *           └─ packages[]  ─ countries[] + places[]
 *
 * with two shape rules that drive most of the logic here:
 *
 *  - **India is a region, not a country.** Its `countries[]` entries are Indian
 *    *states*, each tagged with a `subregion` (North/South/West). They are
 *    reshaped into one India country with states beneath it, giving the
 *    intended region > subregion > state > city hierarchy.
 *
 *  - **A multi-country package repeats its place list on every member
 *    country.** France, Switzerland, Luxembourg and Belgium each list all four
 *    as their `places`. Place ownership therefore resolves by name match first,
 *    so Switzerland is not filed under France.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Matcher, normalise, slugify } from "./normalise";
import type {
  Country,
  Package,
  Place,
  Region,
  Route,
  RouteOption,
  State,
  Subregion,
  TransportMode,
} from "../../lib/atlas/schema";

type MasterPackage = {
  name: string;
  duration: string;
  price: string | number;
  countries?: string[];
  places?: string[];
  description?: string;
  highlights?: string[];
};

type MasterCountry = {
  country: string;
  subregion?: string;
  places?: string[];
};

type MasterRegion = {
  region: string;
  countries?: MasterCountry[];
  packages?: MasterPackage[];
};

type MasterFile = { version: string; description: string; regions: MasterRegion[] };

/** Regions whose `countries[]` are really states of a single country. */
const STATE_REGIONS: Record<string, { country: string; iso3: string }> = {
  india: { country: "India", iso3: "IND" },
};

/**
 * ISO-3166-1 alpha-3 for the catalogue's countries. Needed because visa rules
 * are keyed on (passport country, destination country) and the source spellings
 * are inconsistent ("Hungery", "Linchestine", "Phillipines").
 */
const ISO3: Record<string, string> = {
  egypt: "EGY", kenya: "KEN", mauritius: "MUS", seychelles: "SYC", "south africa": "ZAF",
  georgia: "GEO", azerbaijan: "AZE", kazakhstan: "KAZ", uzbekistan: "UZB",
  kyrgisthan: "KGZ", kyrgyzstan: "KGZ", russia: "RUS",
  "sri lanka": "LKA", nepal: "NPL", bhutan: "BTN", maldives: "MDV",
  japan: "JPN", "south korea": "KOR", korea: "KOR", china: "CHN",
  "hong kong and macau": "HKG", "hong kong": "HKG",
  france: "FRA", switzerland: "CHE", luxembourg: "LUX", belgium: "BEL",
  germany: "DEU", austria: "AUT", netherlands: "NLD",
  linchestine: "LIE", liechtenstein: "LIE",
  czech: "CZE", "czech republic": "CZE", hungery: "HUN", hungary: "HUN", poland: "POL",
  spain: "ESP", portugal: "PRT", greece: "GRC", italy: "ITA",
  denmark: "DNK", norway: "NOR", sweden: "SWE", finland: "FIN", iceland: "ISL",
  scandinivia: "SWE", scandinavia: "SWE",
  "united kingdom": "GBR", england: "GBR", scotland: "GBR", ireland: "IRL",
  uae: "ARE", turkey: "TUR", oman: "OMN", jordan: "JOR",
  "new zealand": "NZL", australia: "AUS", fiji: "FJI",
  vietnam: "VNM", thailand: "THA", singapore: "SGP", malaysia: "MYS",
  indonesia: "IDN", cambodia: "KHM", laos: "LAO",
  phillipines: "PHL", philippines: "PHL",
  india: "IND", romania: "ROU", tahiti: "PYF",
};

/** Country nodes that stand for a group of countries rather than one. */
const CLUSTER_PATTERN = /scandinivia|scandinavia|cluster/i;

/**
 * Package prices in the master file are hand-typed and inconsistently
 * formatted — some plain ("180000"), some Indian comma-grouped ("1,50,000"),
 * occasionally with a stray "₹" or trailing space. `Number()` on the grouped
 * form silently returns `NaN` (coerced to a 0 price by the `|| 0` at the call
 * site), which is a real published price quietly turning into a free
 * package rather than a parse error surfacing anywhere. Strip everything but
 * digits and a leading minus so every one of those formats parses the same way.
 */
function parsePrice(price: unknown): number {
  const digits = String(price ?? "").replace(/[^\d-]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

function parseDuration(duration: string): { nights: number; days: number; flexible: boolean } {
  const nights = /(\d+)\s*N/i.exec(duration ?? "");
  const days = /(\d+)\s*D/i.exec(duration ?? "");
  if (!nights && !days) return { nights: 0, days: 1, flexible: true };
  const n = nights ? Number(nights[1]) : Math.max(0, Number(days![1]) - 1);
  const d = days ? Number(days[1]) : n + 1;
  return { nights: n, days: d, flexible: false };
}

export type Geography = {
  regions: Region[];
  countries: Country[];
  subregions: Subregion[];
  states: State[];
  places: Place[];
  packages: Package[];
  /** Canonical place name -> place, for the other parsers to join against. */
  placeByName: Map<string, Place>;
  /** Names in `package.countries` that matched no country node. */
  unresolvedPackageCountries: { packageName: string; country: string }[];
  /**
   * Places whose owning country is ambiguous because they appear in a
   * cross-country package but only one country's `places[]`. Reported for
   * review; resolve by adding an entry to `content/place-countries.json`.
   */
  ambiguousPlaces: { place: string; assignedTo: string; packageName: string; candidates: string[] }[];
  /** Places whose country was corrected by an override. */
  overriddenPlaces: { place: string; country: string }[];
};

export function parseMaster(
  file: string,
  /** `place name -> country name` corrections. */
  countryOverrides: Record<string, string> = {},
): Geography {
  const master = JSON.parse(readFileSync(file, "utf8")) as MasterFile;

  const regions: Region[] = [];
  const countries: Country[] = [];
  const subregions: Subregion[] = [];
  const states: State[] = [];
  const places: Place[] = [];
  const packages: Package[] = [];

  const placeByName = new Map<string, Place>();
  const unresolvedPackageCountries: Geography["unresolvedPackageCountries"] = [];
  const ambiguousPlaces: Geography["ambiguousPlaces"] = [];
  const overriddenPlaces: Geography["overriddenPlaces"] = [];

  // Overrides are keyed by normalised place name, ignoring comment keys.
  const overrideByPlace = new Map<string, string>();
  for (const [k, v] of Object.entries(countryOverrides)) {
    if (k.startsWith("_") || typeof v !== "string") continue;
    overrideByPlace.set(normalise(k), v);
  }
  /**
   * Countries are globally unique. The catalogue lists Nepal under both South
   * Asia and East Asia (the Kailash tour starts in Kathmandu); the first region
   * to declare a country owns it, and later references resolve to the same row.
   */
  const globalCountryByKey = new Map<string, Country>();

  for (const r of master.regions ?? []) {
    const regionId = slugify(r.region);
    regions.push({ id: regionId, name: r.region, slug: regionId });

    const stateRegion = STATE_REGIONS[regionId];

    /** Countries nameable from within this region, including borrowed ones. */
    const countryByName = new Map<string, Country>();
    const stateByName = new Map<string, State>();
    const subregionByName = new Map<string, Subregion>();

    // --- countries (or, for India, states of one country) -----------------
    let umbrella: Country | null = null;
    if (stateRegion) {
      const key = normalise(stateRegion.country);
      umbrella = globalCountryByKey.get(key) ?? {
        id: slugify(`${regionId}-${stateRegion.country}`),
        name: stateRegion.country,
        slug: slugify(stateRegion.country),
        regionId,
        iso3: stateRegion.iso3,
        isCluster: false,
        memberCountryIds: [],
      };
      if (!globalCountryByKey.has(key)) {
        globalCountryByKey.set(key, umbrella);
        countries.push(umbrella);
      }
      countryByName.set(key, umbrella);
    }

    for (const node of r.countries ?? []) {
      if (node.subregion) {
        const key = normalise(node.subregion);
        if (!subregionByName.has(key)) {
          const sr: Subregion = {
            id: slugify(`${regionId}-${node.subregion}`),
            name: node.subregion,
            regionId,
          };
          subregionByName.set(key, sr);
          subregions.push(sr);
        }
      }

      if (umbrella) {
        // The node names a state, not a country.
        const key = normalise(node.country);
        if (!stateByName.has(key)) {
          const st: State = {
            id: slugify(`${umbrella.id}-${node.country}`),
            name: node.country,
            slug: slugify(node.country),
            countryId: umbrella.id,
            subregionId: node.subregion
              ? (subregionByName.get(normalise(node.subregion))?.id ?? null)
              : null,
          };
          stateByName.set(key, st);
          states.push(st);
        }
        continue;
      }

      const key = normalise(node.country);
      const shared = globalCountryByKey.get(key);
      if (shared) {
        countryByName.set(key, shared);
        continue;
      }
      const country: Country = {
        id: slugify(`${regionId}-${node.country}`),
        name: node.country,
        slug: slugify(node.country),
        regionId,
        iso3: ISO3[key] ?? null,
        isCluster: CLUSTER_PATTERN.test(node.country),
        memberCountryIds: [],
      };
      globalCountryByKey.set(key, country);
      countryByName.set(key, country);
      countries.push(country);
    }

    // --- places ------------------------------------------------------------
    // A place whose name matches a country in this region belongs to that
    // country; otherwise it belongs to the node that listed it first. This is
    // what stops a cluster package's repeated place list mis-assigning places.
    const claimFirst = new Map<string, MasterCountry>();
    for (const node of r.countries ?? []) {
      for (const name of node.places ?? []) {
        const key = normalise(name);
        if (!claimFirst.has(key)) claimFirst.set(key, node);
      }
    }

    const ensurePlace = (name: string, fallbackCountry?: Country): Place => {
      const key = normalise(name);
      const existing = placeByName.get(key);
      if (existing) return existing;

      const selfCountry = countryByName.get(key);
      const owner = claimFirst.get(key);
      const ownerCountry = owner ? countryByName.get(normalise(owner.country)) : undefined;
      const ownerState = owner && umbrella ? stateByName.get(normalise(owner.country)) : undefined;

      // An explicit correction always wins — the catalogue files a
      // cross-border route's places under whichever country listed them.
      const overrideName = overrideByPlace.get(key);
      const override = overrideName
        ? (globalCountryByKey.get(normalise(overrideName)) ?? countryByName.get(normalise(overrideName)))
        : undefined;
      if (overrideName && override) overriddenPlaces.push({ place: name, country: override.name });

      // A place named only inside a package ("Nile", "Byzantium") has no
      // country node of its own, so it inherits the package's country.
      const country = override ?? selfCountry ?? ownerCountry ?? umbrella ?? fallbackCountry;

      const place: Place = {
        id: slugify(name),
        name,
        slug: slugify(name),
        countryId: country?.id ?? regionId,
        stateId: override ? null : (ownerState?.id ?? null),
        hasRates: false,
        hasContent: false,
        // Filled in later by `resolvePlaceCoords`, once airports and the
        // geocoder cache have been read.
        lat: null,
        lon: null,
      };
      placeByName.set(key, place);
      places.push(place);
      return place;
    };

    for (const node of r.countries ?? []) for (const name of node.places ?? []) ensurePlace(name);

    // --- packages ----------------------------------------------------------
    for (const pkg of r.packages ?? []) {
      const { nights, days, flexible } = parseDuration(String(pkg.duration ?? ""));

      const countryIds: string[] = [];
      for (const name of pkg.countries ?? []) {
        const hit = countryByName.get(normalise(name));
        if (!hit) {
          unresolvedPackageCountries.push({ packageName: pkg.name, country: name });
          continue;
        }
        if (!countryIds.includes(hit.id)) countryIds.push(hit.id);
        // A cluster records the real countries it stands for.
        if (hit.isCluster) {
          for (const memberName of pkg.places ?? []) {
            const iso = ISO3[normalise(memberName)];
            if (iso && !hit.memberCountryIds.includes(iso)) hit.memberCountryIds.push(iso);
          }
        }
      }

      const placeIds = (pkg.places ?? []).map(
        (name) => ensurePlace(name, countries.find((c) => c.id === countryIds[0])).id,
      );

      // A cross-country package lists its whole route under each member
      // country, so any place not explicitly claimed by exactly one of them is
      // ambiguous. Left unresolved this mis-prices visas and border transport,
      // so surface it rather than trusting the first claim.
      if (countryIds.length > 1) {
        const memberNames = countryIds.map((id) => countries.find((c) => c.id === id)?.name ?? id);
        for (const name of pkg.places ?? []) {
          const key = normalise(name);
          if (overrideByPlace.has(key)) continue;
          if (countryByName.has(key)) continue; // the place *is* a country

          const claimants = memberNames.filter((countryName) => {
            const node = (r.countries ?? []).find((n) => normalise(n.country) === normalise(countryName));
            return (node?.places ?? []).some((p) => normalise(p) === key);
          });
          if (claimants.length === 1) continue; // unambiguous

          const assigned = placeByName.get(key);
          ambiguousPlaces.push({
            place: name,
            assignedTo: countries.find((c) => c.id === assigned?.countryId)?.name ?? "unknown",
            packageName: pkg.name,
            candidates: memberNames,
          });
        }
      }

      // Indian packages sit under a state; infer it from the places covered.
      const stateIds: string[] = [];
      if (umbrella) {
        for (const id of placeIds) {
          const stateId = placeByName.get(normalise(id.replace(/-/g, " ")))?.stateId
            ?? places.find((p) => p.id === id)?.stateId;
          if (stateId && !stateIds.includes(stateId)) stateIds.push(stateId);
        }
      }

      packages.push({
        id: slugify(`${regionId}-${pkg.name}`),
        name: pkg.name,
        slug: slugify(pkg.name),
        regionId,
        countryIds: countryIds.length ? countryIds : umbrella ? [umbrella.id] : [],
        stateIds,
        nights,
        days,
        priceFromInr: parsePrice(pkg.price),
        // The master file's published prices are land-only: airfare from an
        // Indian gateway is quoted on top. Recorded explicitly so the engine,
        // the calibration harness and the UI all agree on what the number
        // covers rather than each assuming.
        priceIncludesFlight: false,
        flexibleDuration: flexible,
        description: pkg.description ?? "",
        highlights: pkg.highlights ?? [],
        placeIds,
      });
    }
  }

  return {
    regions, countries, subregions, states, places, packages,
    placeByName, unresolvedPackageCountries, ambiguousPlaces, overriddenPlaces,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type RawOption = {
  enabled?: boolean;
  price_estimate?: { low?: number; high?: number; currency?: string; as_of?: string } | null;
  currency?: string | null;
  duration_minutes?: number | null;
  terminals?: { from?: string; to?: string } | null;
  unavailable_reason?: string | null;
};

type RawRoute = {
  country?: string;
  origin?: string;
  destination?: string;
  origin_country?: string;
  destination_country?: string;
  transport_options?: Record<string, RawOption>;
  onsite_mode?: string | null;
  tour_type?: string[];
  route_type?: string | null;
};

const MODES = new Set<string>([
  "flight", "train", "bus", "cruise", "ferry", "seaplane", "shared_vehicle", "private_vehicle",
]);

function toOptions(raw: Record<string, RawOption> | undefined): RouteOption[] {
  const out: RouteOption[] = [];
  for (const [mode, o] of Object.entries(raw ?? {})) {
    if (!MODES.has(mode)) continue;
    out.push({
      mode: mode as TransportMode,
      enabled: o.enabled === true,
      priceLow: o.price_estimate?.low ?? null,
      priceHigh: o.price_estimate?.high ?? null,
      currency: o.price_estimate?.currency ?? o.currency ?? null,
      durationMinutes: o.duration_minutes ?? null,
      terminalFrom: o.terminals?.from ?? null,
      terminalTo: o.terminals?.to ?? null,
      unavailableReason: o.unavailable_reason ?? null,
      // Everything the source file supplies is the agency's own figure;
      // `transport-derive.ts` relabels only what it has to fill in.
      priceSource: "workbook",
      durationSource: "workbook",
      distanceKm: null,
    });
  }
  return out;
}

export type TransportParse = {
  routes: Route[];
  /** Endpoint names that could not be resolved to a known place. */
  unresolved: { name: string; region: string; scope: string }[];
};

export function parseTransport(
  dir: string,
  geo: Geography,
  overrides: Record<string, string> = {},
): TransportParse {
  const placeMatcher = new Matcher(
    geo.places.map((p) => ({ name: p.name, value: p })),
    overrides,
  );
  const countryMatcher = new Matcher(
    geo.countries.map((c) => ({ name: c.name, value: c })),
    overrides,
  );

  const routes: Route[] = [];
  const unresolved: TransportParse["unresolved"] = [];
  const seen = new Set<string>();

  const files = readdirSync(dir).filter((f) => f.endsWith("_transport.json") && f !== "index.json");

  for (const file of files) {
    const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
      region?: string;
      transport?: {
        within_country?: { routes?: RawRoute[] };
        between_countries?: { routes?: RawRoute[] };
      };
    };
    const regionName = raw.region ?? file;

    const ingest = (list: RawRoute[] | undefined, scope: Route["scope"]) => {
      for (const r of list ?? []) {
        const originName = r.origin ?? r.origin_country ?? "";
        const destName = r.destination ?? r.destination_country ?? "";

        const originPlace = originName ? placeMatcher.match(originName) : null;
        const destPlace = destName ? placeMatcher.match(destName) : null;

        // Between-country routes may name only countries.
        const originCountry = r.origin_country ? countryMatcher.match(r.origin_country) : null;
        const destCountry = r.destination_country ? countryMatcher.match(r.destination_country) : null;

        if (originName && !originPlace && !originCountry)
          unresolved.push({ name: originName, region: regionName, scope });
        if (destName && !destPlace && !destCountry)
          unresolved.push({ name: destName, region: regionName, scope });

        const id = slugify(
          `${scope}-${originPlace?.value.id ?? originCountry?.value.id ?? originName}-${
            destPlace?.value.id ?? destCountry?.value.id ?? destName
          }`,
        );
        if (seen.has(id)) continue;
        seen.add(id);

        routes.push({
          id,
          scope,
          countryContext: r.country ?? null,
          originPlaceId: originPlace?.value.id ?? null,
          destPlaceId: destPlace?.value.id ?? null,
          originCountryId: originCountry?.value.id ?? originPlace?.value.countryId ?? null,
          destCountryId: destCountry?.value.id ?? destPlace?.value.countryId ?? null,
          onsiteMode: r.onsite_mode ?? null,
          tourType: r.tour_type ?? [],
          routeType: r.route_type ?? null,
          options: toOptions(r.transport_options),
        });
      }
    };

    ingest(raw.transport?.within_country?.routes, "within_country");
    ingest(raw.transport?.between_countries?.routes, "between_countries");
  }

  return { routes, unresolved };
}
