/**
 * Minimal ambient types for the Cloudflare Workers runtime.
 *
 * Only the surface these Workers actually use is declared here. That is a
 * deliberate continuation of what `functions/cloudflare.d.ts` did for the
 * Pages Functions layer: it keeps the Workers type-checked by the same `tsc`
 * run as the app, without pulling `@cloudflare/workers-types` into the global
 * scope — where its `Request`/`Response`/`fetch` declarations would collide
 * with the DOM lib the Next.js app is compiled against.
 */

declare interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown | null>;
  get(key: string, type?: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A bound Worker, called over a service binding rather than the network. */
declare interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

declare interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Cloudflare attaches request metadata to `Request.cf`. Only the fields used
 * for coarse spam triage are declared.
 */
declare interface IncomingRequestCfProperties {
  country?: string;
  colo?: string;
}

interface Request {
  readonly cf?: IncomingRequestCfProperties;
}
