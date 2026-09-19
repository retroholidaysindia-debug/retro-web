/**
 * The backend Worker's environment contract.
 *
 * Everything except `DB` is optional, and the Worker degrades rather than
 * failing when one is absent: with no upstream API keys the live-rate endpoint
 * returns an empty result and the quotation falls back to its compiled
 * baseline, exactly as it does today.
 */
export type Env = {
  /** D1: enquiries and saved quotes. The only genuinely stateful dependency. */
  DB: D1Database;

  /** Travelpayouts Aviasales Data API token. Optional. */
  TRAVELPAYOUTS_TOKEN?: string;
  /** LiteAPI sandbox or production key. Optional. */
  LITEAPI_KEY?: string;
  /** Optional KV namespace for cross-request rate caching. */
  RATE_CACHE?: KVNamespace;

  /**
   * Comma-separated origins allowed to call this Worker directly.
   *
   * In production the frontend Worker forwards `/api/*` over a service
   * binding, so the browser never makes a cross-origin call and this is only
   * needed for local development against `next dev`.
   */
  ALLOWED_ORIGINS?: string;

  /** Deployment environment name, surfaced by `/api/health`. */
  ENVIRONMENT?: string;
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found"): Response {
  return json({ error: message }, { status: 404 });
}

/**
 * CORS for direct browser calls.
 *
 * Only origins named in `ALLOWED_ORIGINS` are echoed back — never `*` — because
 * these endpoints write to the database. Requests arriving over the service
 * binding from the frontend Worker are same-origin and never reach this.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};

  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Reads and validates a JSON body, with a size ceiling. */
export async function readJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T | null> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Trims a free-text field and caps its length, returning null when empty. */
export function field(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed.length ? trimmed : null;
}
