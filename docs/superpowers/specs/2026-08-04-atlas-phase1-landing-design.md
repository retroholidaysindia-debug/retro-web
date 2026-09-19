# The Atlas — Phase 1 Design Spec

**Project:** Retro Reverbnation — AI-backed travel agency website
**Phase:** 1 of 2 (landing + destinations; quotation algorithm is Phase 2)
**Date:** 2026-08-04
**Status:** Awaiting product owner review

---

## 1. Purpose and deliverable

### What we are building

A **clickable, deployed web prototype** that the product owner can open on a phone or
desktop and navigate end to end. This is not production code. It exists to answer one
question: *does this experience feel right?*

Changes are expected. The architecture below optimises for cheap iteration — all
content, copy, imagery, colour and map data live in JSON config, so a revision round
means editing data, not rewriting components.

### Definition of done for Phase 1

1. Deployed at a public preview URL, reachable on mobile.
2. All four route types navigable, with no dead ends.
3. Five destinations complete with footage, generated maps and copy.
4. Performance budget (§9) met and enforced by the build.
5. Reduced-motion and no-WebGL paths verified working.

Production build begins only after the product owner confirms the prototype.

### Non-goals

Explicitly out of scope: the quotation algorithm, CMS, booking, payments,
authentication, destinations beyond the initial five, multi-language, and analytics
beyond basic page views.

---

## 2. Business context

Retro Reverbnation (also trading as Retro Holidays) is a Kolkata-based custom travel
agency founded by Gunjan Das and Pritha Basu. 4.9★ across 77 Google reviews. Bookings
happen by phone and email, not online checkout — the site's job is to make someone
want to start a conversation, not to transact.

Positioning: **the business sells memories and experiences, not itineraries.** Every
design decision below should be checked against that sentence.

The current site (retroreverbnation.com) presents destinations as bare clickable
thumbnails with no descriptions, itineraries or enquiry flow. The prototype's job is to
be unrecognisably better at conveying what a trip with them feels like.

---

## 3. Decisions already made

These were settled with the product owner and are not open in this spec.

| Decision | Choice | Rationale |
|---|---|---|
| Motion fidelity | Real video loops + thin WebGL transition layer | Photoreal motion needs footage; shaders handle stylised transitions |
| Footage source | Free commercial-licence stock now, swappable via config | Unblocks the build; owner's own footage drops in later |
| Stack | Next.js (static export) + React 19 + TypeScript | Pre-rendered HTML keeps destination pages searchable |
| Hosting | Cloudflare Pages | Free tier, global CDN for video, git-push deploys, preview URLs per change |
| Destinations | Kashmir, Bali, Dubai, Nordic, Kenya | Chosen for cartographic variety — see §7.4 |
| Art direction | Contemporary premium (dark, glass, editorial) | Owner's choice over the "modern retro" alternative |
| Landing concept | The Atlas — map as structural spine | Maps carry the page rather than decorating it |

### Adaptation note

The Mike Kus / Epic Travel maps that inspired this are warm paper-and-watercolour,
which conflicts with a dark premium palette. We keep the **structural** cartographic
language — hairline coastlines, dashed interior borders, one highlighted region, ring
markers, thin leader lines to outboard labels, distance pills — and translate the
**temperature**: luminous line-work on deep navy, stipple ocean as a faint dot grid,
markers as softly glowing rings.

---

## 4. Information architecture

| Route | Purpose | Phase |
|---|---|---|
| `/` | The Atlas landing page | 1 |
| `/destinations/[slug]` | Five destination pages | 1 |
| `/plan?destination=<slug>` | Quotation page — interactive stub | 1 stub, 2 real |
| `/contact` | Contact and enquiry | 1 |

Four page types total, matching the owner's "not much pages and links" constraint.

**Every call to action routes to `/plan` carrying the destination slug.** "Discover
location", "Plan Your Trip", card clicks and destination-page CTAs all deep-link with
context pre-selected. Phase 2 inherits a page that already knows what it is quoting.

---

## 5. The landing page — The Atlas

### 5.1 Concept

The map is not a section on the page; it is the connective tissue *between* sections.
Footage introduces a place, the map explains it, the map dissolves into the next place.
Scroll is a journey across an atlas, not a list of cards.

### 5.2 Scroll choreography

Five destination movements. Each movement occupies roughly 1.6 viewport heights and
runs four beats:

| Beat | Progress | What happens |
|---|---|---|
| Hold | 0.00–0.35 | Footage plays full-bleed. Headline and tagline in a glass panel. Card rail visible. |
| Recede | 0.35–0.50 | Footage desaturates to ~40% and scales to 1.06. Background darkens toward `--deep`. |
| Map draw | 0.50–0.80 | Coastline strokes in over ~900ms via `stroke-dashoffset`. Region fill fades to 18% opacity. Markers drop in on a 60ms stagger. Leader lines extend, labels fade. |
| Dissolve | 0.80–1.00 | Noise-threshold wipe carries the map away as the next clip fades up beneath. |

Above the five movements sits a short opening panel; below them, a resolution section
(§5.5). Total scroll length approximately 9–10 viewport heights on desktop.

### 5.2.1 Mobile behaviour

The prototype will be judged on a phone, so mobile is specified rather than inferred:

- Movements shorten to ~1.2 viewport heights each; total scroll ~7 viewport heights.
- Map viewBox switches to portrait aspect; POI markers beyond the first three are
  dropped and only `city` markers keep leader lines, with labels placed below rather
  than outboard.
- The card rail becomes a snap-scrolling carousel showing 1.5 cards, and gains explicit
  previous/next controls since hover cues do not exist.
- Video renditions drop to 720×1280 portrait crops at ≤ 320 KB.
- Glass blur reduces from 20px to 12px — heavy `backdrop-filter` is a measurable cost
  on mid-range Android.
- Below 380px width or when `navigator.hardwareConcurrency <= 4`, the shader path is
  skipped in favour of the CSS crossfade described in §10.

### 5.3 The card rail

Fixed to the bottom viewport edge, five cards, horizontally scrollable. Modelled on the
Globe Express reference. It serves two roles at once:

- **Index** — shows all five destinations with poster thumbnails, always reachable.
- **Scrub control** — clicking a card does *not* scroll through intervening
  destinations. The map flies directly from current country to target as a shared
  element (bbox interpolation), footage cross-dissolves, and scroll position snaps to
  that movement's Hold beat.

The active card is raised and accented with the destination's colour. Cards are real
anchors to `/destinations/[slug]`; the click handler intercepts for the fly transition,
so the rail works with JavaScript disabled and is keyboard navigable.

### 5.4 Overlay layer

Glass panels (`backdrop-filter: blur(20px)`, 7% white fill, 1px hairline border) carry
nav, headline and destination meta — the Wanderlust reference's exclusive feel, minus
the flight/hotel search widgets, which the business cannot fulfil. The single primary
action is **Plan Your Trip**.

### 5.5 Resolution section

Below the fifth movement: the 4.9★ / 77-review proof, the two founders, and contact
details. This gives the scroll somewhere to land and provides genuinely indexable
content beneath a motion-heavy page.

---

## 6. Rendering architecture

### 6.1 The critical decision — video is never a WebGL texture

Binding video to `THREE.VideoTexture` uploads a new frame to the GPU every frame and is
the main reason media-heavy WebGL sites stutter on mid-range phones. We avoid it
entirely.

Footage plays as an ordinary `<video>` element in the DOM. The R3F canvas sits above it
with `pointer-events: none`, is created with `alpha: true` and a fully transparent
clear colour — so wherever the shader outputs alpha below 1, the live video beneath
shows through — and is **idle except during transitions**. At transition start:

1. Snapshot the outgoing video's current frame once via `drawImage` into an offscreen
   canvas → one static `CanvasTexture`.
2. Start the incoming clip playing in the DOM layer beneath.
3. The shader dissolves the static snapshot away with a noise threshold, revealing the
   live incoming video underneath.
4. On completion, dispose the texture and idle the canvas (`frameloop="demand"`).

The GPU therefore handles **one static texture and a noise function**, never a
streaming upload. This is what makes shader transitions affordable within budget.

### 6.2 Video element policy

- Attributes: `muted autoplay loop playsinline preload="none"`, with `poster` set.
- **At most two `<video>` elements exist at any time**, recycled between movements.
- Destination N+1's clip begins loading when movement N reaches its Hold beat.
- All other destinations show poster stills.
- Any `error` or `stalled` event permanently falls back to the poster for that
  destination. The page remains fully functional.

### 6.3 The shader

A single fullscreen quad, one fragment shader, approximately 60 lines of GLSL:

- Two inputs: the snapshot texture and a dissolve progress uniform.
- Simplex-noise threshold producing a soft organic edge — the dark-palette translation
  of Epic's torn watercolour edge.
- Light film grain and a subtle vignette, both driven by the destination accent colour.

### 6.4 Scroll orchestration

`lib/scroll.ts` owns **one** scroll listener and **one** `requestAnimationFrame` loop.
It publishes a single derived state object:

```ts
type AtlasState = {
  activeIndex: number;      // 0–4
  localProgress: number;    // 0–1 within the current movement
  phase: 'hold' | 'recede' | 'map' | 'dissolve';
  velocity: number;
}
```

Consumers subscribe; **no component attaches its own scroll listener.** This is the
main defence against the jank that kills scroll-driven sites, and it keeps the
choreography debuggable from one place.

---

## 7. The map generator

The most technically demanding component, and the one that determines whether the
system scales past five destinations.

### 7.1 Build-time only

`d3-geo` and `mapshaper` run in `prebuild` and are **never shipped to the browser**.
Output is a static SVG plus a small JSON of projected marker coordinates, so the
runtime positions markers and leader lines without any geo library.

```
content/destinations/*.json  +  Natural Earth (admin-0, admin-1)
        │
        ├─ mapshaper: simplify to ~2–4KB per country
        ├─ d3-geo:    select projection, fitExtent to viewBox
        │
        └─→ public/maps/<slug>.svg          (≤12KB, inlined at build)
            public/maps/<slug>.markers.json (projected x/y, label anchors)
```

Data source: **Natural Earth** (public domain, no attribution required) — admin-0 for
countries, admin-1 for sub-national regions. Covers every country and subdivision
worldwide, which satisfies the "maps for anywhere in the world" requirement.

### 7.2 Projection selection

Deterministic and testable, not hand-tuned per destination:

| Condition | Projection |
|---|---|
| Centroid absolute latitude > 45° | `geoConicConformal`, parallels at bbox latitude quartiles |
| Bounding box wider than 30° longitude | `geoConicEqualArea` |
| Otherwise | `geoMercator` |

All cases then `fitExtent` into the viewBox with 8% padding. Markers outside the
country bbox (offshore islands) extend the bbox before fitting.

### 7.3 Destination config contract

One file per destination — the single source of truth for content, colour, media and
cartography:

```json
{
  "slug": "kashmir",
  "name": "Kashmir",
  "region": "India",
  "tagline": "Where the mountains keep quiet.",
  "palette": { "accent": "#A8D5D0", "deep": "#0A1F24" },
  "media": { "clip": "kashmir.webm", "poster": "kashmir.webp" },
  "map": {
    "countries": ["IND"],
    "highlight": { "admin1": ["Jammu and Kashmir", "Ladakh"] },
    "markers": [
      { "name": "Srinagar", "lat": 34.083, "lng": 74.797, "type": "city" },
      { "name": "Gulmarg",  "lat": 34.048, "lng": 74.380, "type": "poi"  }
    ]
  }
}
```

Marker types: `city` (ring marker, larger label) and `poi` (solid dot, smaller label).
Label sides are auto-assigned left/right by whether the marker sits left or right of
the map centroid; collisions resolve by vertical nudge.

### 7.4 The five destinations and what each proves

| Destination | ISO | Highlight | Capability exercised |
|---|---|---|---|
| Kashmir | IND | admin-1: Jammu and Kashmir, Ladakh | Region highlighted inside a large country |
| Bali | IDN | admin-1: Bali | Island + archipelago, stipple ocean |
| Dubai | ARE | none | Tiny state requiring city-scale zoom |
| Nordic | NOR, SWE, FIN, ISL | none | **Multi-country union** — the hardest case |
| Kenya | KEN | none | Large single country with interior POI markers |

Markers (initial set, editable in config):

- **Kashmir** — Srinagar, Gulmarg, Pahalgam, Sonamarg, Leh
- **Bali** — Denpasar, Ubud, Seminyak, Nusa Penida, Mount Batur
- **Dubai** — Dubai, Abu Dhabi, Hatta, Liwa Oasis
- **Nordic** — Oslo, Bergen, Tromsø, Stockholm, Reykjavík, Rovaniemi
- **Kenya** — Nairobi, Maasai Mara, Amboseli, Lake Nakuru, Diani Beach

Nordic additionally renders **distance pills** on dotted connectors between countries
(the Epic "1446 km" device), which is the natural way to express a multi-country region.

### 7.5 Reveal choreography

Driven by `AtlasState.localProgress` during the map beat:

1. Coastline paths stroke in via `stroke-dashoffset`, outermost country first.
2. Interior admin-1 borders fade in as 2px dashed hairlines.
3. Highlighted region fills to 18% accent opacity.
4. Stipple-ocean dot grid fades in, masked to a 40px band outside the coast.
5. Markers scale from 0 with a 60ms stagger, cities before POIs.
6. Leader lines extend horizontally; labels fade at 80% extension.

Under `prefers-reduced-motion`, the finished state renders immediately.

---

## 8. Visual system

### 8.1 Palette

| Token | Value | Use |
|---|---|---|
| `--deep` | `#06181C` | Page base, near-black teal |
| `--surface` | `#0D2A30` | Raised panels |
| `--glass` | `rgba(255,255,255,0.07)` | Overlay panels, with 20px blur |
| `--hairline` | `rgba(255,255,255,0.14)` | Borders, map coastlines |
| `--text` | `#F2F7F6` | Primary text |
| `--muted` | `#9BB3B4` | Secondary text, map labels |
| `--brand` | `#5FD3B8` | Primary actions, brand accent |

Per-destination accent overrides `--accent` at the movement level, re-theming map,
glow and active card together:

Kashmir `#A8D5D0` · Bali `#6FD3A8` · Dubai `#E8B96A` · Nordic `#7FA8D9` · Kenya `#E0864F`

### 8.2 Typography

Two families, self-hosted and subset (no external font requests, per the CDN-only
asset policy):

- **Display — Instrument Serif.** Editorial serif for destination names and headlines.
  Provides the premium register the Wanderlust reference achieves with its serif
  headline, against an otherwise geometric interface.
- **Interface — Inter Variable.** Nav, body, map labels, cards. `font-variant-numeric:
  tabular-nums` for distance pills and statistics.

Destination names set large, tight tracking, sentence case. Taglines set small in
`--muted` with generous line height.

### 8.3 Copy

Minimal words, per the brief. First draft below — the product owner is expected to
revise, and copy lives in config so revision costs nothing.

**Landing hero:**
> You will not remember the itinerary.

Sub: *Twelve years of trips people still talk about.*
Action: **Plan your trip**

**Destination taglines:**

| Destination | Tagline |
|---|---|
| Kashmir | Where the mountains keep quiet. |
| Bali | Green, and then more green. |
| Dubai | Nothing here was inevitable. |
| Nordic | Light that forgets to leave. |
| Kenya | The herds decide the season. |

---

## 9. Performance budget

Enforced as a **build gate**, not an aspiration. Lighthouse CI fails the build on
breach.

| Metric | Budget |
|---|---|
| JavaScript, gzipped | ≤ 230 KB |
| Active destination clip | ≤ 500 KB — AV1/WebM, 1280×720, ~7s seamless loop |
| Poster still | ≤ 45 KB WebP |
| Map SVG | ≤ 12 KB, inlined |
| Largest Contentful Paint, 4G | ≤ 2.0 s |
| Cumulative Layout Shift | < 0.05 |
| Scroll frame rate, mid-range Android | ≥ 55 fps sustained |

### Known risk: three.js weight

three.js accounts for roughly 110 KB of the JS budget to render what is ultimately a
single fullscreen quad. Raw WebGL would do the same job in about 3 KB.

R3F is used as the product owner requested, because it keeps richer effects available
later. **If the budget is breached, the documented remedy is to replace
`TransitionCanvas` with a raw WebGL implementation** — no visual change, roughly 107 KB
recovered. This is a deliberate, recorded trade, not an oversight.

### Video encoding

Each clip is cut to a seamless 6–8s loop and encoded three ways: AV1/WebM (primary),
VP9/WebM (fallback), H.264/MP4 (Safari fallback), served via `<source>` negotiation.

---

## 10. Accessibility and resilience

Three degradation paths, all mandatory, each leaving the site **fully functional**:

| Condition | Behaviour |
|---|---|
| `prefers-reduced-motion: reduce` | No shader dissolve — instant crossfade. Posters instead of video. Maps render finished. Card rail still navigates. |
| WebGL unavailable | Canvas never mounts. CSS opacity crossfade replaces the dissolve. |
| Video fails or stalls | Permanent fallback to poster still for that destination. |

Additional requirements:

- Card rail fully keyboard navigable with visible focus rings.
- Map markers are `<a>` elements with accessible names, not decorative shapes.
- Colour contrast ≥ 4.5:1 for body text against every destination accent background.
- All copy present in server-rendered HTML — the motion layer costs nothing in search
  indexing.
- Every page has a unique title, meta description and Open Graph image.

---

## 11. Module structure

Small, independently testable units:

```
content/destinations/*.json      Single source of truth (content + map + media)
scripts/build-maps.ts            Map generator; pure functions, unit-tested
lib/scroll.ts                    One scroll source, one rAF loop, publishes AtlasState
components/atlas/
  AtlasScene.tsx                 Orchestrates movements from AtlasState
  MediaLayer.tsx                 Video element policy, preload, poster fallback
  TransitionCanvas.tsx           R3F canvas; idle except during transitions
  MapReveal.tsx                  SVG map + choreographed reveal
  CardRail.tsx                   Index and scrub control
components/ui/                   Nav, glass panel, button, footer
app/                             Routes
```

Boundaries: `MapReveal` knows nothing about video; `MediaLayer` knows nothing about
maps; both know only `AtlasState`. `scripts/build-maps.ts` has no runtime dependency on
any of it and can be tested in isolation.

---

## 12. Page specifications

### 12.1 `/destinations/[slug]`

1. Hero — footage loop, destination name, tagline, glass treatment.
2. **Discover `<name>`** — the large generated map as the section centrepiece,
   mirroring the Epic reference layout: prose left, map right.
3. Three to four experience cards — the Wild Horizons photo-album register.
4. A short "how it works" strip: enquire, we design it, you travel.
5. Closing CTA → `/plan?destination=<slug>`.

### 12.2 `/plan` — Phase 2 stub

Must be **clickable, not a dead end**, so the owner can test the full flow:

- Reads `?destination=` and displays the chosen destination with its accent and poster.
- Renders the intended quotation inputs as real, focusable UI — dates, travellers,
  trip style, budget band — with no algorithm behind them.
- A clear banner marking it as Phase 2.
- Falls back to a destination picker when no slug is supplied.

This establishes the seam so Phase 2 changes logic, not navigation.

### 12.3 `/contact`

Deliberately minimal, matching a phone-and-email business: both founders, the Kolkata
address, phone, both email addresses, and prominent WhatsApp and call actions.

**The enquiry form is presentation-only in the prototype.** Static export has no
backend, and wiring a form service is Phase 2 scope.

Precisely: the form renders and validates client-side, but **submits nothing to any
server**. On valid submit it composes the entered details into a pre-filled WhatsApp
message and opens it, so the enquiry still reaches the business. A visible note states
that the form is not yet connected. Nothing silently fails, and no visitor is left
believing a message was sent when it was not.

---

## 13. Testing

| Layer | Tool | Coverage |
|---|---|---|
| Map generator | Vitest | Projection selection rule, multi-country union, admin-1 filtering, marker coordinate accuracy against known lat/lng, bbox fitting, label collision resolution |
| Scroll state | Vitest | `AtlasState` derivation across movement boundaries; no negative or out-of-range indices |
| Routes | Playwright | Every route renders; card rail navigates; CTAs carry the slug; `/plan` handles a missing slug |
| Degradation | Playwright | Reduced-motion path; WebGL-disabled path; video-error path |
| Budget | Lighthouse CI | §9 thresholds as a hard build gate |

The map generator carries the heaviest test weight because it is the only genuinely
algorithmic component, and the only one where a silent error (a marker two degrees
off) would survive visual review.

---

## 14. Iteration workflow

Built for the revision rounds the product owner has flagged.

- Every push to a branch produces a **Cloudflare Pages preview URL**, openable on the
  owner's phone. Feedback references a live build, not a screenshot.
- **Content changes never require code changes.** Copy, taglines, colours, markers,
  footage and posters all live in `content/destinations/*.json`. Swapping stock footage
  for the agency's own is a one-line edit plus a file drop.
- Adding a sixth destination is one JSON file; the map generates itself.
- Review checkpoints: after the map generator works for all five; after the first
  complete movement; after the full landing page; after the remaining routes.

---

## 15. Open items for the product owner

None blocking — the prototype can be built end to end on stock footage and Natural
Earth data. When convenient:

1. Own tour footage to replace stock, ideally 10s+ steady wide shots with natural
   motion (water, foliage, crowds, cloud).
2. Final destination list beyond the initial five.
3. Logo files and any existing brand colour or type constraints.
4. Confirmation of the §8.3 copy, which is a first draft written to be replaced.
