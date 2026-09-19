"use client";

/**
 * Browser-side loader for the compiled Atlas bundles.
 *
 * The core bundle covers the whole catalogue and is fetched once; per-place
 * content is fetched only for the places a traveller actually selects, which
 * keeps the initial payload to roughly 140 KB gzipped.
 */
import type { CoreBundle, DestinationBundle, Route, VisaRule } from "./schema";

const BASE = "/atlas";

let corePromise: Promise<CoreBundle> | null = null;
let routesPromise: Promise<Route[]> | null = null;
let visaPromise: Promise<VisaRule[]> | null = null;
let packageCardsPromise: Promise<PackageCard[]> | null = null;
const destinationCache = new Map<string, Promise<DestinationBundle | null>>();

/** One sellable package's card data, as published to `public/atlas/package-cards.json`
 *  by `scripts/build-package-cards.ts`. Declared here (not imported from that
 *  build script) so this client module never pulls in any Node-only code. */
export type PackageCard = {
  id: string;
  name: string;
  slug: string;
  destinationSlug: string;
  regionId: string;
  nights: number;
  days: number;
  priceFromInr: number;
  /** False when airfare is quoted on top of `priceFromInr`, so the card can
   *  say so rather than implying an all-in figure. */
  priceIncludesFlight: boolean;
  tagline: string | null;
  coverImage: string;
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export function loadCore(): Promise<CoreBundle> {
  corePromise ??= getJson<CoreBundle>("core.json");
  return corePromise;
}

export function loadRoutes(): Promise<Route[]> {
  routesPromise ??= getJson<{ routes: Route[] }>("routes.json").then((r) => r.routes);
  return routesPromise;
}

export function loadVisaRules(): Promise<VisaRule[]> {
  visaPromise ??= getJson<{ rules: VisaRule[] }>("visa.json").then((r) => r.rules);
  return visaPromise;
}

/** Every sellable package with its cover image, for the planner's browse rail. */
export function loadPackageCards(): Promise<PackageCard[]> {
  packageCardsPromise ??= getJson<PackageCard[]>("package-cards.json");
  return packageCardsPromise;
}

/** Resolves to null when a place has no compiled content bundle. */
export function loadDestination(slug: string): Promise<DestinationBundle | null> {
  let cached = destinationCache.get(slug);
  if (!cached) {
    cached = getJson<DestinationBundle>(`destinations/${slug}.json`).catch(() => null);
    destinationCache.set(slug, cached);
  }
  return cached;
}

export async function loadDestinations(
  slugs: string[],
): Promise<Map<string, DestinationBundle>> {
  const loaded = await Promise.all(slugs.map((slug) => loadDestination(slug)));
  const map = new Map<string, DestinationBundle>();
  loaded.forEach((bundle) => {
    if (bundle) map.set(bundle.place.id, bundle);
  });
  return map;
}

// ---------------------------------------------------------------------------
// Live rates (optional second-level check)
// ---------------------------------------------------------------------------

export type LiveRateResponse = {
  rates: { component: "flight" | "hotel"; key: string; inr: number; fetchedAt: string }[];
};

/**
 * Asks the backend Worker for live fares. Any failure — including no API keys
 * being configured — resolves to an empty map so the quotation falls back to
 * the compiled baseline rather than erroring.
 */
export async function loadLiveRates(query: {
  origin: string;
  destinationIata?: string;
  month?: string;
  cityName?: string;
  star?: string;
}): Promise<Map<string, { component: "flight" | "hotel"; key: string; inr: number; fetchedAt: string }>> {
  const map = new Map<string, { component: "flight" | "hotel"; key: string; inr: number; fetchedAt: string }>();
  try {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null) as [string, string][],
    );
    const res = await fetch(`/api/live-rates?${params}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return map;
    const body = (await res.json()) as LiveRateResponse;
    for (const rate of body.rates ?? []) map.set(`${rate.component}:${rate.key}`, rate);
  } catch {
    // Live rates are an enhancement; the compiled card is always authoritative.
  }
  return map;
}

// ---------------------------------------------------------------------------
// Enquiries and saved quotes (backend Worker + D1)
// ---------------------------------------------------------------------------

export type EnquiryInput = {
  name: string;
  email?: string;
  phone?: string;
  destination?: string;
  travelWindow?: string;
  travellers?: string;
  notes?: string;
  quoteId?: string;
  source?: "contact-form" | "quote" | "planner";
  /** Honeypot. Always left empty by real users; set means "drop this". */
  company?: string;
};

/**
 * Records a trip enquiry.
 *
 * Deliberately best-effort and non-blocking for the caller: the contact form
 * hands the traveller to WhatsApp either way, and a backend that is down must
 * never cost us the conversation. Returns the stored id when it worked, and
 * null when it did not.
 */
export async function submitEnquiry(input: EnquiryInput): Promise<string | null> {
  try {
    const res = await fetch("/api/enquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string | null };
    return body.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Saves a quote so it can be reopened from a link.
 *
 * Only the request and its headline totals are sent: the engine is pure, so
 * replaying the request reproduces the quotation exactly, and storing the
 * rendered itinerary as well would just create a second copy to drift.
 */
export async function saveQuote(input: {
  request: unknown;
  totals: { total: number; perPerson: number };
  datasetVersion?: string;
}): Promise<string | null> {
  try {
    const res = await fetch("/api/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  } catch {
    return null;
  }
}

/** Reopens a saved quote. Returns null when the id is unknown or unreachable. */
export async function loadSavedQuote(id: string): Promise<{
  id: string;
  createdAt: string;
  request: unknown;
  totals: { total: number; perPerson: number };
  datasetVersion: string | null;
} | null> {
  try {
    const res = await fetch(`/api/quotes/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Awaited<ReturnType<typeof loadSavedQuote>>;
  } catch {
    return null;
  }
}
