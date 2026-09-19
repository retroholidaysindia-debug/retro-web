# Atlas quotation engine

How the travel-agency data model and quotation algorithm fit together.

## Sources

Four inputs, all under [`input_files/`](../input_files).

| Source | What it provides | Scale |
| --- | --- | --- |
| `travel_agency_dataset.json` | The **mother file**: regions → countries → places, and the published packages. | 10 regions, 53 countries, 24 states, 431 places, 75 packages |
| `Pricing_Rules.xlsx` | Contracted rates per place: hotels (4 categories × 2 zones), transfers, meals, activities. Plus `Markup_Tax_Rules`. | 217 sheets, 209 priced places |
| `transport_json_regions/*.json` | The transport graph: fares, durations and mode availability between places. | 1,463 routes |
| `Destination Files markdown/**/*.md` | Destination knowledge: suitability scores, trip length, month-by-month weather/crowd/price index, hotel areas, attractions, activities by purpose, the geographical clusters used for day planning, and the planner guidance in sections 7 and 10-36 — airport transfer logic, per-audience travel advice, worked itinerary patterns, agent insights and the destination's own decision rules. | 216 files, 210 matched |

### The hierarchy

```
region ─┬─ countries[] ─ places[]
        └─ packages[]  ─ countries[] + places[]
```

A package belongs to a **region** and may span **several countries** — "European Delights" covers France, Switzerland, Luxembourg and Belgium; "Kailash Mansarovar Tour" crosses from Nepal into China. Its places are the actual itinerary.

**India is a region, not a country.** Its `countries[]` are Indian *states*, each tagged with a `subregion`, so the ETL reshapes them into one India country with 24 states under North/South/West India — giving the intended `region > subregion > state > city` hierarchy.

### Shape quirks the ETL absorbs

- **A multi-country package repeats its place list on every member country.** France, Switzerland, Luxembourg and Belgium each list all four as their `places`. Ownership resolves by name match first, so Switzerland is not filed under France.
- **A cross-border route can be filed under the wrong country.** The Kailash route lists its Tibetan legs under Nepal, which would drop the ₹9,500 China visa from every quotation. [`content/place-countries.json`](../content/place-countries.json) corrects ownership, and the ETL flags any remaining ambiguity in the review workbook.
- **A country can appear in two regions.** Nepal is listed under both South Asia and East Asia. Countries are globally unique — the first region to declare one owns it, and later references resolve to the same row.
- **Names drift between sources.** Cochin/Kochi, Ha Noi/Hanoi, Smarkand/Samarkand, Hong Kong-Disneyland/Hong Kong. Resolved by [`content/place-aliases.json`](../content/place-aliases.json) first, then a conservative fuzzy matcher that refuses ambiguous matches.
- **The transport files predate this catalogue** and still name the old marketing clusters ("Europen Cluster 1", "England"). The alias table maps them onto the country that anchors each route.
- **The workbook has seven different header layouts**, some omitting the Subcategory column, with baselines in USD on most sheets and EUR on the European ones. Columns are located by header text, never by index.
- **A third of the markdown files write fields as `**key:** value`** rather than `key:`, and clusters appear at `##`, `###` or `####` depth. Both forms are normalised before parsing.

## Pipeline

```
npm run build-atlas
```

[`scripts/etl/build.ts`](../scripts/etl/build.ts) compiles everything into:

| Output | Purpose |
| --- | --- |
| `public/atlas/core.json` | Whole catalogue + rate card, including a coordinate per place. Fetched once. |
| `public/atlas/destinations/*.json` | Per-place content, lazy-loaded. |
| `public/atlas/guidance/*.json` | The full planner guidance per place, lazy-loaded separately because it is bulky (~48 KB a place) and only needed once that place is actually being planned. The destination bundle carries the subset the engine reasons with. |
| `public/atlas/routes.json` | Transport graph (~32 KB gzipped). |
| `public/atlas/visa.json` | Visa matrix (~5 KB gzipped). |
| `data/atlas/sql/schema.sql` + `seed.sql` | The same model as SQLite DDL, ready for Cloudflare D1 — including the complete guidance, not just the engine subset. |
| `data/atlas/Atlas_Rate_Review.xlsx` | Every estimated value, for the agency to correct. |

### Why files and not a database

The app is a static export served by a Cloudflare Worker. Shipping the compiled tables as static assets means quoting runs entirely in the browser: instant re-pricing as the traveller adjusts anything, no database round trip, no per-request cost, and it stays inside the free tier permanently.

D1 exists alongside it, but deliberately holds only what a static site cannot — trip enquiries and saved quotes. The catalogue is not in it. The SQL mirror of the full model is still generated so moving more server-side later is a configuration change rather than a redesign; see [deployment.md](./deployment.md).

## Relational model

Defined once in [`lib/atlas/schema.ts`](../lib/atlas/schema.ts) as Zod schemas, which validate the ETL output, type the engine, and are mirrored by `schema.sql`.

```
region ─┬─ subregion ─── state ─── place ─┬─ destination        (content)
        │                                 ├─ suitability_score
        │   country ────────────┘         ├─ monthly_score      (seasonality)
        │                                 ├─ area               (hotel zones)
        │                                 ├─ attraction
        │                                 ├─ activity ── activity_rate
        │                                 ├─ cluster ── cluster_attraction  (day planning)
        │                                 ├─ destination_guidance ── _bullet (planner knowledge)
        │                                 ├─ decision_rule ─┬─ _condition   (section 33, evaluable)
        │                                 │                 └─ _effect
        │                                 ├─ hotel_rate / transfer_rate / meal_rate
        │                                 └─ city_tax
        │       flight_band, visa_rule ── country
        └─ package ─┬─ package_country    (a package may span countries)
                    ├─ package_state
                    └─ package_place
                    route ── route_option                       (transport graph)
                    markup_rule, insurance_rate
```

Every place carries a `lat`/`lon`, resolved at build time from its hand-placed map marker, its primary airport, or the cached geocoder. This is what lets the engine measure a leg it has no route for — see *Routing* below. An airport is only used when it serves that place alone: Thekkady, Alleppey and Kanyakumari all name Kochi as their nearest airport, and taking its coordinate put three towns hundreds of kilometres apart on one point, making every distance between them zero.

Every rate row carries a `source` of `workbook`, `estimated`, `live` or `manual`, which is surfaced per line item so a quotation can be audited back to its origin.

## Algorithm

[`lib/atlas/engine/`](../lib/atlas/engine) — pure, deterministic and synchronous. Same request plus same data always yields the same quotation. No model, no network.

1. **Match a reference package** ([`itinerary.ts`](../lib/atlas/engine/itinerary.ts)) — Jaccard overlap of the chosen places against all 75 packages. Quotes are always a modification of a real package, which is what anchors both the itinerary and the price floor.
2. **Allocate nights** — weighted by each place's documented `ideal_nights`, its suitability score for the chosen trip style, and how much there is to do there. Clamped to each place's own min/max, with largest-remainder assignment so the parts sum exactly.
3. **Sequence the route** — nearest-neighbour from every possible start, then 2-opt, scoring hops on money, time *and* ground covered. The distance term matters: large parts of the authored fare table are flat — a Kerala circuit prices five consecutive legs at the same ₹1,075 — which left the sequencer with nothing to order on and produced a geographically incoherent zigzag that happened to tie on price.

   The traveller's departure metro is modelled as a virtual first and last node, so the order reflects the whole journey rather than only its middle. An open path and its reverse always end at the same two places, so the exit leg is discounted slightly to break that tie in favour of entering at the gateway nearest home, which is how these itineraries are actually built.

4. **Plan the days** ([`dayplan.ts`](../lib/atlas/engine/dayplan.ts)) — each day gets an activity-hour budget from the pace, reduced for young children, seniors, heavy walking, and arrival/departure/transfer days. Geographical clusters are packed best-first into that budget. A cluster too long for the budget is *shortened* to a partial visit rather than dropped, so a relaxed pace never produces an empty itinerary. Every day leaves at least 10 hours of rest.

5. **Price it** ([`pricing.ts`](../lib/atlas/engine/pricing.ts)) — follows the workbook's own `Quotation_Calculation` structure:

   ```
   direct cost = hotel + flight + transfers + local transport + intercity
               + sightseeing + meals + visa + insurance + city tax
   + contingency (3%)
   + agent markup (15%, or 20% for luxury)
   + sales/VAT
   + payment gateway + FX buffer (2% + 2%)
   ```

   Hotel rates are multiplied by a seasonality factor derived from the destination's monthly price index, blended across the months a stay actually spans rather than read once from the departure date. Transfers are billed per vehicle and amortised across the group. Children are priced by age band.

   The international airfare is an open jaw whenever the trip ends in a different country from the one it started in — the outbound half of the fare to the first country plus the inbound half from the last. Pricing a return to the *first* destination assumed the traveller doubled back to fly home from where they arrived, so the journey home was simply never costed.

6. **Advise** ([`advisories.ts`](../lib/atlas/engine/advisories.ts)) — the destination knowledge that should shape a trip rather than merely price it. A stay is flagged when it falls in a month the destination itself rates poorly, with that month's own recommendation text and the strongest month named. The test is mostly relative — how far below the destination's own best month — because the files do not share a scale. Places whose file marks them *not ideal for* this kind of trip are flagged too. Nothing here changes a price or drops a place: the traveller asked for this trip and is entitled to take it.

   The same stage selects the planner guidance written for this traveller — how airport transfers really work in each city, what to do and avoid on a honeymoon or with small children, and the destination's own decision rules — and returns it as `planningNotes`.

7. **Apply the destination's own rules** ([`rules.ts`](../lib/atlas/engine/rules.ts)) — see *Decision rules* below.

8. **Floor to the published price** — a quote covering ≥80% of a package's scope is never allowed to undercut that package's published "from" price, scaled by duration.

### Decision rules

Section 33 of each destination file is a real rule block, not prose — 3,469 rules across 199 places:

```
IF:
trip_length <= 3 nights
AND:
traveler_type == FAMILY
THEN:
do not recommend Saqqara, Dahshur or other distant day trips by default.
Reason:
Short Cairo stays work best concentrated around Giza …
```

[`rules.ts`](../lib/atlas/engine/rules.ts) parses these into a small AST at build time and evaluates them against the actual request at runtime, so a traveller sees the handful of rules their trip genuinely meets rather than all twenty-one of a destination's.

`trip_length` means nights **at that destination**, not across the whole trip — the rules live in a destination's own file and talk about its attractions. Rules stated in days are compared against nights + 1.

**Three-valued logic.** The rule vocabulary is wider than the request: `trip_length`, `traveler_type`, `children_age` and `trip_type` map cleanly onto a quote, but `route`, `hotel_priority`, `visibility` and a long tail of others describe things the planner never asks. Conditions therefore evaluate to **true, false or unknown**, and a rule fires only when decisively true. Anything resting on an unknown is reported to the agent as skipped rather than guessed at — treating it as false would silently swallow rules, and treating it as true would fire advice at people it was never written for.

`traveler_interest` alone accounts for 1,241 conditions, which is why [`QuoteRequest`](../lib/atlas/engine/types.ts) carries an `interests` list. With no interests stated about 46% of rules are undecidable; with them stated that falls to **12.4%**, and the remainder are the genuinely unanswerable variables. The gap is an input gap, not a parser one.

**What it is allowed to do.** Firing a rule surfaces its advice as `appliedRules`. Two action shapes are also *executed*, because their meaning is unambiguous: `prioritize_X + Y` boosts matching clusters in the day plan and `do not recommend X` demotes them, via a bounded additive bias worth roughly one purpose-phrase match. Everything else ("book a sunrise slot", "combine with a Nile cruise") is prose written for a human and is surfaced, never acted on. That boundary is deliberate — a rule engine that half-understands an instruction and reorders someone's holiday is worse than one that hands the instruction over intact.

Run `npm run rule-coverage` to see how many rules parse, how many fire for representative trips, and which variables most often leave a rule undecidable.


### Routing

The transport graph is far sparser than its 1,463 routes suggest: 437 places share 1,353 place-to-place routes, about **1.4% of all possible pairs**, and the usable graph breaks into **63 disconnected components**, the largest holding just 18 places. Most legs a real multi-country trip needs were therefore never authored at all, and used to fall through to a single region-wide median fare — so a 120 km hop and a 6,000 km one were quoted the same number.

[`buildRouteLookup`](../lib/atlas/engine/itinerary.ts) now falls through a tiered cascade:

| Tier | What it uses |
| --- | --- |
| 1 | The exact authored place-to-place route. |
| 2 | A local road transfer, when a route exists but every mode on it is explicitly unavailable. |
| 3 | A **composed multi-hop path** over real authored routes, when both ends sit in the same component but share no direct edge. Two real fares beat one invented one; the intermediate stops are reported as `via`. |
| 4 | A country-to-country route, where one is authored at that coarser scope. |
| 5 | A **geographically synthesised leg** — great-circle distance run through the same per-mode speed and fare curves the ETL uses to fill gaps in the authored table ([`geo.ts`](../lib/atlas/engine/geo.ts)), offering every mode that is plausible over that distance. |
| 6 | The regional median, kept only for the few places with no coordinate at all. |

Measured over every same-region place pair, this takes legs with no option at all from 6.6% to **0.1%**, and legs offering a real choice of modes to **85%**. Fares now track distance — a median of ₹900 under 300 km against ₹13,465 over 2,000 km, where before both were the same regional median.


### Commercial policy

Everything commercial lives in [`content/quote-policy.json`](../content/quote-policy.json) — room occupancy and child age bands, vehicle classes, day-planning budgets, meal plans, the markup chain, seasonality sensitivity, live-rate margins and guardrails. Changing a value there re-prices every quote on the next build.

## Pricing calibration

The published package prices are the ground truth the engine has to match. `npm run calibrate` prices all 75 packages through the engine and reports the delta.

The test builds the cheapest legitimate configuration — 3★ outskirts, twin share, LCC economy, breakfast only, each destination's cheapest month, and the cheapest of the ten Indian departure metros — because the published figure is a *minimum* per-person price including flight. The package price floor is **disabled** during the test, otherwise every package would trivially reproduce its own price.

| Verdict | Meaning |
| --- | --- |
| `UNDER` | Generated below the brochure price — we would undercut ourselves |
| `OK` | 0 to +25% — the intended outcome |
| `HIGH` | +25% to +60% |
| `TOO HIGH` | Above +60% — the traveller sees far more than advertised |

### The feedback loop

```
npm run calibrate              # report; writes Atlas_Pricing_Calibration.xlsx
npm run calibrate -- --write   # fit region factors automatically
npm run calibrate -- --apply   # apply your own numbers from the workbook
```

`--write` fits a correction factor per region from the median observed ratio, targeting +5% over the published price.

`--apply` reads the workbook's **Your Corrections** sheet back. State what a package *should* cost per person and the engine derives the factor — far easier than guessing a multiplier. It converges to the stated figure in one pass.

Factors live in [`content/pricing-calibration.json`](../content/pricing-calibration.json), scoped `package > country > region > global`. **Scopes do not compound** — the most specific wins outright, so one number is the whole story for that scope. `--apply` carries the region factor forward into the package factor so a per-package correction never silently undoes a regional one.

Only components the agency can plausibly have mispriced are scaled: hotel, flight, local and intercity transport, sightseeing and meals. Visa, insurance and city tax are pass-through costs, so distorting them to hit a headline number would hide the error somewhere worse.



A second-level check over the compiled card, in [`workers/api/src/live-rates.ts`](../workers/api/src/live-rates.ts) (the backend Worker, so keys stay server-side).

| Category | Source | Why |
| --- | --- | --- |
| Flights | Travelpayouts Aviasales Data API | Free, self-serve token, 600 req/min, returns the IATA carrier code so LCC vs full-service is derivable. |
| Hotels | LiteAPI | Free sandbox key, no card, real bookable rates. |
| Visa requirement | `imorte/passport-index-data`, vendored at build time | MIT, 199 × 199 pairs. No runtime call needed. |
| Attraction tickets | The workbook, hand-curated | No viable free source exists — OpenTripMap is dead, Wikidata has 23 priced items in all of India, and OSM's `charge` tag is effectively unpopulated. |

Amadeus Self-Service is **deprecated** (every `amadeus4dev` repo is archived) and is deliberately not used.

A live figure only overrides the baseline when it is fresh (< 24h) and within a plausible distance of it; it is then marked up by a per-component volatility margin so the quote survives movement before booking. A figure more than 60% away from the baseline is clamped rather than trusted, so one bad API response cannot wreck a quotation. **With no keys configured the whole layer no-ops** and the compiled card is used — the site is fully functional without any integration.

### Configuration

Set on the **backend Worker** (`atlas-api`), all optional — see [deployment.md](./deployment.md):

| Variable | How | Purpose |
| --- | --- | --- |
| `TRAVELPAYOUTS_TOKEN` | `wrangler secret put` | Live flight fares |
| `LITEAPI_KEY` | `wrangler secret put` | Live hotel rates |
| `RATE_CACHE` | KV binding in `workers/api/wrangler.toml` | Cross-request caching |

## Known gaps

The review workbook at `data/atlas/Atlas_Rate_Review.xlsx` has a sheet for each of these:

- **222 of 431 places have no sheet in the pricing workbook.** Their rates are inferred from priced peers in the same country (then region), adjusted by the destination's documented cost level. Every inferred value is listed with its basis.
- **221 places have no destination knowledge file**, so their days fall back to a generic plan.
- **Flight, visa fee, insurance, city tax, guide rates and hotel modifiers do not exist in the workbook** despite being listed in its own `INDEX1`. All are currently estimated — see the *Cannot Estimate* sheet.
- **Published package prices and the component rate card disagree.** Priced from its own components at 3★/breakfast-only, a number of packages already exceed their published all-in "from" price. `npm run calibrate` currently reports a median of +36% with every correction factor still at 1.0 — the calibration loop below exists to close this, and it has not been run against real contracted rates yet. The engine treats the published price as a floor; the *Package Reconciliation* sheet shows the gap per package.
- **Airport transfers are charged at every stay**, per the agency's stated land-package policy, and on an estimated rate card they can reach a third of a quote. That is a rate-card problem rather than an algorithm one, but it is the single largest driver of the calibration gap above and should be checked against real contracted transfer rates first.
- **Nine places have rates or content but are not in the master** (Nabadwip, Wuhan, Romania, Tahiti, Kaziranga, Shillong), which also means **Assam and Meghalaya are missing as states**.
- **The decision rules in section 33 are executed, but only partly.** They parse and evaluate ([`rules.ts`](../lib/atlas/engine/rules.ts)), and the unambiguous `prioritise`/`avoid` actions drive the day plan. The rest are surfaced as advice for a human, because their actions are prose. Roughly 12% of rules stay undecidable even with interests stated, resting on inputs the planner does not collect (`route`, `hotel_priority`, `movement`, `visibility`, `departure_time`); adding those as planner questions is the next step.
- **12 of 437 places still have no coordinate.** Their legs fall back to the country centroid, which keeps them proportionate but imprecise; `npm run build-atlas -- --geocode` will resolve new ones as they appear.

## Maintenance

| Task | Command |
| --- | --- |
| Rebuild after editing the workbook or dataset | `npm run build-atlas` |
| Refresh vendored visa + airport data | `npm run build-atlas -- --refresh` |
| Check pricing against the published packages | `npm run calibrate` |
| Auto-fit region correction factors | `npm run calibrate -- --write` |
| Apply your own corrections from the workbook | `npm run calibrate -- --apply` |
| Read the gaps report in the terminal | `npm run gaps` |
| Measure how well the router covers real place pairs | `npm run route-coverage` |
| Measure how many destination rules parse and fire | `npm run rule-coverage` |
| Inspect one package's cost mix, ordering and legs | `npm run quote-probe -- "Kerala"` |
| Check the site content against the master | `npm run sync-content` |
| Apply that sync (also reconciles map marker names) | `npm run sync-content -- --write` |
| Add a name reconciliation | Edit [`content/place-aliases.json`](../content/place-aliases.json) |
| Correct which country a place belongs to | Edit [`content/place-countries.json`](../content/place-countries.json) |
| Change commercial policy | Edit [`content/quote-policy.json`](../content/quote-policy.json) |
| Change pricing corrections | Edit [`content/pricing-calibration.json`](../content/pricing-calibration.json) |
