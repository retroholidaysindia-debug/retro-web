# Deployment

Two Cloudflare Workers and one D1 database.

```
                    ┌──────────────────────────────┐
  browser  ───────► │  atlas-web  (frontend)       │
                    │  • serves out/ via [assets]  │
                    │  • forwards /api/* ──────────┼──┐  service binding
                    └──────────────────────────────┘  │  (private, no egress)
                                                      ▼
                                      ┌──────────────────────────────┐
                                      │  atlas-api  (backend)        │
                                      │  • /api/live-rates           │
                                      │  • /api/enquiries            │
                                      │  • /api/quotes[/:id]         │
                                      │  • /api/health               │
                                      └───────────┬──────────────────┘
                                                  │
                                       ┌──────────▼──────────┐
                                       │  D1: atlas          │
                                       │  enquiry, quote     │
                                       └─────────────────────┘
```

## Why this shape

**The quotation engine stays in the browser.** It is pure and synchronous — the same request against the same compiled data always yields the same quotation — so running it server-side would add a round trip and a per-request cost while producing an identical number. Keeping it client-side is what makes re-pricing instant as the traveller drags the nights slider.

**The catalogue stays in static assets.** `core.json`, the per-place bundles, the routes and the guidance are served by the asset server, which is not billed as a Worker request and is faster than any database query. D1 would be slower, dearer and no more correct.

**D1 holds only what a static site cannot**: trip enquiries, and quotes a traveller asked us to keep. That is real state that has to outlive the page.

**The frontend forwards `/api/*` over a service binding** rather than the browser calling a second hostname. One origin means no CORS preflight on the enquiry POST, no second domain to configure, and the hop stays inside Cloudflare's network — free and effectively instant. `lib/atlas/client.ts` keeps calling relative `/api/...` paths exactly as it did under Pages Functions.

## One-time setup

You need the Cloudflare account and `npx wrangler login` (or an API token).

### 1. Create the database and cache

From `workers/api`:

```bash
npx wrangler d1 create atlas
npx wrangler kv namespace create RATE_CACHE
```

Each prints an id. Put them into `workers/api/wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID`.

For the preview environment, repeat with `atlas-preview` and
`RATE_CACHE --preview`, filling the `[env.preview]` placeholders.

### 2. Apply the schema

```bash
npm run cf:d1:migrate          # remote
npm run cf:d1:migrate:local    # local dev database
```

Migrations are `CREATE TABLE IF NOT EXISTS`, so re-running them is safe.

### 3. Add the optional API keys

Both are optional. Without them the live-rate layer no-ops and the compiled
rate card is used, which is a fully working site.

```bash
cd workers/api
npx wrangler secret put TRAVELPAYOUTS_TOKEN
npx wrangler secret put LITEAPI_KEY
```

### 4. Deploy, backend first

The frontend's service binding resolves `atlas-api` **by name**, so the backend
has to exist before the frontend deploys.

```bash
npm run build-maps && npm run build-atlas && npm run build-package-cards
npm run build          # produces out/
npm run cf:check       # dry-run both configs first
npm run cf:deploy      # api, then web
```

## GitHub Actions

`.github/workflows/deploy.yml` does all of the above. It is `workflow_dispatch`
only for now — uncomment the `push` trigger once CI is settled.

Two repository secrets are required:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens. Needs **Workers Scripts: Edit** and **D1: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar |

`.github/workflows/ci.yml` has a `workers` job that runs `npm run cf:check` —
`wrangler deploy --dry-run` for both configs. That bundles exactly as a real
deploy would and catches a broken binding or a missing entrypoint, without
deploying and without needing credentials.

## Local development

```bash
npm run build            # out/ must exist — the frontend serves it
npm run cf:d1:migrate:local
npm run cf:dev           # both Workers together on http://127.0.0.1:8787
```

`cf:dev` runs the frontend and the backend as one session, which is what wires
the service binding — a Worker started on its own shows
`env.API ... [not connected]` and every `/api/*` call fails.

Every command uses `--persist-to .wrangler/state` so the migration and the dev
server use the same local SQLite file. Without it Wrangler resolves the state
directory relative to whichever config it was given, so
`d1 migrations apply --local --config workers/api/wrangler.toml` writes to
`workers/api/.wrangler/state` while `wrangler dev` from the repo root reads
`.wrangler/state` — and every write fails with `no such table: enquiry`.

They also pass `--env=""`. Both configs declare a `preview` environment, and
Wrangler refuses to guess which one an ambiguous command meant.

Inspect what landed:

```bash
npm run cf:d1:query -- --command "SELECT * FROM enquiry;"
```

To let `next dev` on :3000 call a separately-running backend, set
`ALLOWED_ORIGINS = "http://localhost:3000"` in `workers/api/wrangler.toml` —
that is the only reason the CORS path exists.

### Verified locally

The whole stack was run end to end before this was written:

| Check | Result |
| --- | --- |
| `GET /` , `/contact`, `/destinations/africa` | 200, served from `out/` |
| `GET /contact/` and `/contact.html` | 307 → `/contact` |
| `GET /nonexistent-page` | 404 with the exported 404 page |
| `GET /atlas/core.json` | 200, 2.1 MB static asset |
| `GET /api/health` | 200 through the service binding |
| `POST /api/enquiries` | 201, row in D1 with `country` from `request.cf` |
| `POST /api/enquiries` missing name / contact | 400, nothing written |
| `POST /api/enquiries` with honeypot filled | 202, nothing written |
| `POST /api/quotes` → `GET /api/quotes/:id` | 201 then 200, request JSON round-trips |
| `GET /api/live-rates` with no keys | 200 `{"rates":[]}` |


## API

All routes are reachable as `/api/...` through the frontend, or at the
backend's own URL during development.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Liveness and which environment answered |
| `/api/live-rates` | GET | Live flight/hotel sanity check. Empty when no keys are set |
| `/api/enquiries` | POST | Record a trip enquiry |
| `/api/quotes` | POST | Save a quote, returns its id |
| `/api/quotes/:id` | GET | Reopen a saved quote |

Saving a quote stores the `QuoteRequest`, not the rendered itinerary: the
engine is pure, so replaying the request reproduces the quotation exactly, and
a second stored copy would only drift. The `datasetVersion` is recorded so a
reopened quote can tell when a later rebuild would price it differently.

## Cost

Everything here fits the free tier: 100,000 Worker requests/day, 5 GB of D1
storage with 5 million row reads/day, and static asset requests are not billed.
Asset serving — which is nearly all the traffic — does not consume Worker
requests at all, because assets are matched before the Worker runs. Only
`/api/*` does, via `run_worker_first`.

## Migrating from Pages

The previous Cloudflare Pages project and `functions/api/live-rates.ts` are
replaced by this setup; the function's logic moved unchanged to
`workers/api/src/live-rates.ts`. Delete the old Pages project once the Workers
are live and DNS points at `atlas-web`.
