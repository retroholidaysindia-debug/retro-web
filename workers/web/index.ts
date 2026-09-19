/**
 * Atlas frontend Worker.
 *
 * Serves the Next.js static export from the `ASSETS` binding, and forwards
 * `/api/*` to the backend Worker over a **service binding** rather than the
 * public internet.
 *
 * That forwarding is the whole reason this Worker has any code at all. It
 * means the browser only ever talks to one origin, so there is no CORS
 * preflight on the enquiry POST and no second hostname to configure; the hop
 * to the backend stays inside Cloudflare's network, so it costs nothing and
 * adds no measurable latency. `lib/atlas/client.ts` can go on calling
 * relative `/api/...` paths exactly as it did under Pages Functions.
 *
 * Everything else — the app shell, the compiled atlas bundles, the maps and
 * media — is handled by the static asset server, which is faster than anything
 * this Worker could do by hand and is not billed as a Worker request.
 */
export type Env = {
  /** The static asset server, bound automatically by `[assets]`. */
  ASSETS: Fetcher;
  /** The backend Worker. Absent only if the binding was not configured. */
  API?: Fetcher;
};

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!env.API) {
        return new Response(
          JSON.stringify({ error: "Backend service binding is not configured." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      return env.API.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;
