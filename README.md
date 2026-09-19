# Atlas

Travel quotation platform for Retro Holidays. A Next.js static export and a
deterministic quotation engine that prices any combination of destinations from
the agency's own rate card, destination knowledge and transport graph.

## Getting started

```bash
npm ci
npm run build-maps      # vendored Natural Earth -> SVG maps
npm run build-atlas     # source files -> compiled atlas bundles
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`build-maps` and `build-atlas` write into `public/`, which is gitignored build
output — run both once before `dev` or the planner will have nothing to load.

## How it works

| Doc | Covers |
| --- | --- |
| [docs/quotation-engine.md](docs/quotation-engine.md) | The data model, the ETL pipeline and the quotation algorithm |
| [docs/deployment.md](docs/deployment.md) | The two Cloudflare Workers, D1, and the GitHub Actions deploy |

In short: `input_files/` (the agency's spreadsheets, JSON and destination
markdown) is compiled by `scripts/etl/` into static JSON bundles, which the
browser loads and prices with `lib/atlas/engine/`. The engine is pure — the
same request against the same data always yields the same quotation — which is
why it runs client-side and re-prices instantly.

## Common commands

| Task | Command |
| --- | --- |
| Rebuild after editing the source files | `npm run build-atlas` |
| Check pricing against the published packages | `npm run calibrate` |
| See where the rate card is still estimated | `npm run gaps` |
| Measure transport routing coverage | `npm run route-coverage` |
| Measure destination-rule coverage | `npm run rule-coverage` |
| Inspect one package's quote | `npm run quote-probe -- "Kerala"` |
| Unit tests | `npm test` |
| Typecheck app, ETL and Workers | `npm run cf:typecheck` |
| Deploy | see [docs/deployment.md](docs/deployment.md) |
