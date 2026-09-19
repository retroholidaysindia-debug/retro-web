import { describe, expect, it, beforeEach } from "vitest";
import worker from "@/workers/api/src/index";
import type { Env } from "@/workers/api/src/http";

/**
 * A stand-in for D1 that records what was bound, so the handlers can be tested
 * without a database. Only the surface the Worker actually uses is modelled.
 */
type Executed = { sql: string; values: unknown[] };

function fakeDb(rows: Record<string, unknown>[] = []) {
  const executed: Executed[] = [];

  const database = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async run() {
          executed.push({ sql, values: bound });
          return { results: [], success: true, meta: {} };
        },
        async first() {
          executed.push({ sql, values: bound });
          return rows.length ? rows[0] : null;
        },
        async all() {
          executed.push({ sql, values: bound });
          return { results: rows, success: true, meta: {} };
        },
      };
      return statement;
    },
  };

  return { database: database as unknown as D1Database, executed };
}

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

function env(over: Partial<Env> = {}): Env {
  return { DB: fakeDb().database, ENVIRONMENT: "test", ...over };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: payload,
  });
}

describe("backend worker routing", () => {
  it("answers health without touching the database", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/health"), env(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; environment: string };
    expect(body.ok).toBe(true);
    expect(body.environment).toBe("test");
  });

  it("serves the same routes with and without the /api prefix", async () => {
    // The frontend forwards the full path over the service binding; on its own
    // workers.dev URL the Worker is mounted at the root.
    const withPrefix = await worker.fetch(new Request("https://x.dev/api/health"), env(), ctx);
    const without = await worker.fetch(new Request("https://x.dev/health"), env(), ctx);
    expect(withPrefix.status).toBe(200);
    expect(without.status).toBe(200);
  });

  it("404s an unknown route", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/nope"), env(), ctx);
    expect(res.status).toBe(404);
  });

  it("rejects a write on the wrong method", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/enquiries"), env(), ctx);
    expect(res.status).toBe(404);
  });
});

describe("enquiries", () => {
  let db: ReturnType<typeof fakeDb>;

  beforeEach(() => {
    db = fakeDb();
  });

  it("stores a valid enquiry", async () => {
    const res = await worker.fetch(
      post("/api/enquiries", { name: "Asha", email: "asha@example.com", notes: "Kerala in March" }),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();

    expect(db.executed).toHaveLength(1);
    expect(db.executed[0].sql).toContain("INSERT INTO enquiry");
    expect(db.executed[0].values).toContain("Asha");
  });

  it("requires a name", async () => {
    const res = await worker.fetch(
      post("/api/enquiries", { email: "a@b.com" }),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(db.executed).toHaveLength(0);
  });

  it("requires some way to reply", async () => {
    // A lead with neither an email nor a phone number cannot be followed up,
    // so it is worse than no lead — it looks like one.
    const res = await worker.fetch(
      post("/api/enquiries", { name: "Asha" }),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(db.executed).toHaveLength(0);
  });

  it("silently drops anything that fills the honeypot", async () => {
    const res = await worker.fetch(
      post("/api/enquiries", { name: "Bot", email: "b@b.com", company: "Acme" }),
      env({ DB: db.database }),
      ctx,
    );
    // 202 rather than an error, so a bot learns nothing from the response.
    expect(res.status).toBe(202);
    expect(db.executed).toHaveLength(0);
  });

  it("does not trust a caller-supplied source", async () => {
    await worker.fetch(
      post("/api/enquiries", { name: "Asha", phone: "+91", source: "'; DROP TABLE enquiry; --" }),
      env({ DB: db.database }),
      ctx,
    );
    expect(db.executed[0].values).toContain("contact-form");
  });

  it("binds values rather than interpolating them", async () => {
    await worker.fetch(
      post("/api/enquiries", { name: "Robert'); DROP TABLE enquiry;--", phone: "+91" }),
      env({ DB: db.database }),
      ctx,
    );
    // The name reaches the database as a bound parameter, never as SQL.
    expect(db.executed[0].sql).not.toContain("DROP TABLE");
    expect(db.executed[0].values).toContain("Robert'); DROP TABLE enquiry;--");
  });

  it("rejects an oversized body", async () => {
    const res = await worker.fetch(
      post("/api/enquiries", { name: "Asha", phone: "+91", notes: "x".repeat(200_000) }),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(db.executed).toHaveLength(0);
  });
});

describe("quotes", () => {
  it("saves a quote request and returns its id", async () => {
    const db = fakeDb();
    const res = await worker.fetch(
      post("/api/quotes", {
        request: { placeIds: ["cairo"], nights: 4, startDate: "2026-11-05" },
        totals: { total: 200000, perPerson: 100000 },
        datasetVersion: "2026-09-18T00:00:00.000Z",
      }),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(db.executed[0].sql).toContain("INSERT INTO quote");
    expect(db.executed[0].values).toContain("cairo");
  });

  it("refuses a quote with no itinerary", async () => {
    const db = fakeDb();
    const res = await worker.fetch(
      post("/api/quotes", { request: { nights: 4 }, totals: { total: 1, perPerson: 1 } }),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(db.executed).toHaveLength(0);
  });

  it("reopens a saved quote", async () => {
    const db = fakeDb([
      {
        id: "abc",
        created_at: "2026-09-18T00:00:00.000Z",
        request: JSON.stringify({ placeIds: ["cairo"], nights: 4 }),
        total_inr: 200000,
        per_person_inr: 100000,
        dataset_version: "v1",
      },
    ]);
    const res = await worker.fetch(
      new Request("https://example.com/api/quotes/abc"),
      env({ DB: db.database }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: { placeIds: string[] } };
    expect(body.request.placeIds).toEqual(["cairo"]);
  });

  it("404s an unknown quote id", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/api/quotes/missing"),
      env({ DB: fakeDb([]).database }),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("live rates degrade without keys", () => {
  it("returns an empty result rather than failing", async () => {
    // The whole layer is optional: with no upstream keys the quotation falls
    // back to the compiled card, so this must never error.
    const res = await worker.fetch(
      new Request("https://example.com/api/live-rates?origin=DEL"),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rates: unknown[] };
    expect(body.rates).toEqual([]);
  });
});

describe("cors", () => {
  it("does not echo an origin that was not allow-listed", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/api/health", { headers: { Origin: "https://evil.example" } }),
      env({ ALLOWED_ORIGINS: "https://good.example" }),
      ctx,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes an allow-listed origin", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/api/health", { headers: { Origin: "https://good.example" } }),
      env({ ALLOWED_ORIGINS: "https://good.example,http://localhost:3000" }),
      ctx,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://good.example");
  });

  it("never allows a wildcard, since these endpoints write", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/api/health", { headers: { Origin: "https://x.example" } }),
      env({ ALLOWED_ORIGINS: "*" }),
      ctx,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });
});
