/**
 * Saved quotes.
 *
 * A quotation is generated in the browser and is pure, so the authoritative
 * record of one is the request that produced it: replaying that request
 * through the same compiled dataset reproduces the quotation exactly. Only the
 * request and a few denormalised totals are stored, which keeps rows small and
 * avoids a second, staler copy of the itinerary drifting from the engine.
 *
 * `datasetVersion` is recorded alongside because a later rebuild may
 * legitimately price the same request differently; a reopened quote can then
 * say so rather than silently showing a new number under an old link.
 */
import type { Env } from "./http";
import { badRequest, json, notFound, readJson } from "./http";

type SaveQuoteBody = {
  request?: {
    placeIds?: unknown;
    nights?: unknown;
    startDate?: unknown;
    [key: string]: unknown;
  };
  totals?: { total?: unknown; perPerson?: unknown };
  datasetVersion?: unknown;
};

/** Quote requests are small; this is generous and still bounds abuse. */
const MAX_BODY_BYTES = 32 * 1024;

export async function handleSaveQuote(request: Request, env: Env): Promise<Response> {
  const body = await readJson<SaveQuoteBody>(request, MAX_BODY_BYTES);
  if (!body?.request) return badRequest("A quote request is required.");

  const req = body.request;
  const placeIds = Array.isArray(req.placeIds)
    ? req.placeIds.filter((p): p is string => typeof p === "string")
    : [];
  const nights = typeof req.nights === "number" ? req.nights : null;
  const startDate = typeof req.startDate === "string" ? req.startDate : null;

  if (!placeIds.length || nights == null || !startDate) {
    return badRequest("The quote request must carry placeIds, nights and startDate.");
  }

  const total = Number(body.totals?.total ?? 0);
  const perPerson = Number(body.totals?.perPerson ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(perPerson)) {
    return badRequest("Totals must be numeric.");
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO quote (
       id, created_at, request, place_ids, nights, start_date,
       total_inr, per_person_inr, dataset_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      new Date().toISOString(),
      JSON.stringify(req),
      placeIds.join(","),
      nights,
      startDate,
      total,
      perPerson,
      typeof body.datasetVersion === "string" ? body.datasetVersion : null,
    )
    .run();

  return json({ ok: true, id }, { status: 201 });
}

export async function handleGetQuote(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, created_at, request, total_inr, per_person_inr, dataset_version
       FROM quote WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      created_at: string;
      request: string;
      total_inr: number;
      per_person_inr: number;
      dataset_version: string | null;
    }>();

  if (!row) return notFound("No saved quote with that id.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.request);
  } catch {
    return json({ error: "Stored quote request is unreadable." }, { status: 500 });
  }

  return json({
    id: row.id,
    createdAt: row.created_at,
    request: parsed,
    totals: { total: row.total_inr, perPerson: row.per_person_inr },
    datasetVersion: row.dataset_version,
  });
}
