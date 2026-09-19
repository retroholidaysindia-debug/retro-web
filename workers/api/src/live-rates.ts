/**
 * Live-rate proxy — the second-level check over the compiled rate card.
 *
 * Moved here from `functions/api/live-rates.ts` when the deployment split into
 * a frontend and a backend Worker; the logic is unchanged. It runs server-side
 * so API keys stay off the client, and both upstreams stay optional: with no
 * keys configured this returns an empty result and the quotation falls back to
 * the compiled baseline, so the site works identically without any integration.
 *
 * Responses are cached (KV when bound) because both providers ask callers to
 * cache rather than hammer them, and because it keeps the free tiers
 * comfortable.
 */
import type { Env } from "./http";
import { json } from "./http";

export type LiveRate = {
  component: "flight" | "hotel";
  key: string;
  inr: number;
  fetchedAt: string;
};

const CACHE_SECONDS = 6 * 60 * 60;

/** Carriers that price as low-cost, so the engine can honour the LCC/FSC choice. */
const LCC_CARRIERS = new Set([
  "6E", "SG", "QP", "IX", "G8", "AK", "D7", "FD", "TR", "JT", "QZ", "VJ",
  "5J", "Z2", "PQ", "U2", "FR", "W6", "VY", "PC", "XY", "J9", "G9", "3L",
]);

async function fromCache(env: Env, key: string): Promise<LiveRate[] | null> {
  if (env.RATE_CACHE) {
    const hit = await env.RATE_CACHE.get(key, "json");
    return (hit as LiveRate[] | null) ?? null;
  }
  return null;
}

async function toCache(env: Env, key: string, rates: LiveRate[]): Promise<void> {
  if (env.RATE_CACHE) {
    await env.RATE_CACHE.put(key, JSON.stringify(rates), { expirationTtl: CACHE_SECONDS });
  }
}

/**
 * Cheapest cached round-trip fare for a month. Travelpayouts returns prices
 * already converted when `currency=inr` is passed.
 */
async function fetchFlight(
  env: Env,
  origin: string,
  destination: string,
  month: string,
  carrier: "LCC" | "FSC",
): Promise<LiveRate | null> {
  if (!env.TRAVELPAYOUTS_TOKEN) return null;

  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("departure_at", month);
  url.searchParams.set("one_way", "false");
  url.searchParams.set("currency", "inr");
  url.searchParams.set("sorting", "price");
  url.searchParams.set("limit", "30");

  const res = await fetch(url.toString(), {
    headers: { "X-Access-Token": env.TRAVELPAYOUTS_TOKEN },
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    data?: { price?: number; airline?: string }[];
  };
  const offers = (body.data ?? []).filter((o) => typeof o.price === "number" && o.price > 0);
  if (!offers.length) return null;

  // Honour the traveller's carrier preference where the data supports it.
  const matching = offers.filter((o) => {
    const isLcc = LCC_CARRIERS.has((o.airline ?? "").toUpperCase());
    return carrier === "LCC" ? isLcc : !isLcc;
  });
  const pool = matching.length ? matching : offers;
  const cheapest = Math.min(...pool.map((o) => o.price!));

  return {
    component: "flight",
    key: `${origin}:${destination}:${carrier}`,
    inr: cheapest,
    fetchedAt: new Date().toISOString(),
  };
}

/** Lowest nightly rate for a city, used to sanity-check the compiled hotel card. */
async function fetchHotel(
  env: Env,
  cityName: string,
  countryCode: string,
  checkin: string,
  checkout: string,
): Promise<LiveRate | null> {
  if (!env.LITEAPI_KEY) return null;

  const res = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", {
    method: "POST",
    headers: {
      "X-API-Key": env.LITEAPI_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cityName,
      countryCode,
      checkin,
      checkout,
      occupancies: [{ adults: 2 }],
      currency: "INR",
      guestNationality: "IN",
      limit: 25,
    }),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    data?: { roomTypes?: { rates?: { retailRate?: { total?: { amount?: number }[] } }[] }[] }[];
  };

  const amounts: number[] = [];
  for (const hotel of body.data ?? []) {
    for (const room of hotel.roomTypes ?? []) {
      for (const rate of room.rates ?? []) {
        for (const total of rate.retailRate?.total ?? []) {
          if (typeof total.amount === "number" && total.amount > 0) amounts.push(total.amount);
        }
      }
    }
  }
  if (!amounts.length) return null;

  // Median rather than minimum: the cheapest listing is rarely comparable to a
  // contracted category rate.
  amounts.sort((a, b) => a - b);
  const median = amounts[amounts.length >> 1];

  return {
    component: "hotel",
    key: `${cityName}`,
    inr: median,
    fetchedAt: new Date().toISOString(),
  };
}

export async function handleLiveRates(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.searchParams.get("origin") ?? "";
  const destinationIata = url.searchParams.get("destinationIata") ?? "";
  const month = url.searchParams.get("month") ?? "";
  const carrier = (url.searchParams.get("carrier") ?? "FSC") as "LCC" | "FSC";
  const cityName = url.searchParams.get("cityName") ?? "";
  const countryCode = url.searchParams.get("countryCode") ?? "";
  const checkin = url.searchParams.get("checkin") ?? "";
  const checkout = url.searchParams.get("checkout") ?? "";

  const cacheKey = `live:${origin}:${destinationIata}:${month}:${carrier}:${cityName}:${checkin}`;

  const respond = (rates: LiveRate[], cached: boolean) =>
    json({ rates, cached }, {
      headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    });

  const cached = await fromCache(env, cacheKey);
  if (cached) return respond(cached, true);

  const results = await Promise.allSettled([
    origin && destinationIata && month
      ? fetchFlight(env, origin, destinationIata, month, carrier)
      : Promise.resolve(null),
    cityName && countryCode && checkin && checkout
      ? fetchHotel(env, cityName, countryCode, checkin, checkout)
      : Promise.resolve(null),
  ]);

  const rates = results
    .filter((r): r is PromiseFulfilledResult<LiveRate | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((r): r is LiveRate => r != null);

  if (rates.length) ctx.waitUntil(toCache(env, cacheKey, rates));

  return respond(rates, false);
}
