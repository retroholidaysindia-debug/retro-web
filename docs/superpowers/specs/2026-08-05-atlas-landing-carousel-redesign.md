# Atlas Landing Page — Carousel Redesign

**Project:** Retro Reverbnation — AI-backed travel agency website
**Scope:** Sub-project A of the post-Phase-1 audit (landing page only; destinations/maps section is a separate sub-project)
**Date:** 2026-08-05
**Status:** Approved by product owner, proceeding to implementation

---

## 1. Why this exists

A full audit of the Phase 1 prototype found the landing page didn't match the product
owner's actual expectations, despite passing all its own tests:

1. Scroll position drove which destination was active — scrolling the page felt like
   losing control of it ("scroll-jacking"), rather than just scrolling.
2. Cards had no images or ratings, and looked like a bare pill rail.
3. There was no per-destination overlay copy (headline/CTA) or trust-signal row
   (best price, secure payments, etc.) as seen in reference travel sites.
4. Only 5 destinations existed; 10 were wanted.
5. The WebGL shader dissolve transition (Three.js) was a major contributor to a
   Lighthouse performance budget failure already known and accepted as a Phase 1 gap.

This spec replaces the scroll-driven engine with an autoplay carousel and folds in a
fix for item 5 as a side effect of removing the dependency that caused it.

## 2. Decisions made with the product owner

| Decision | Choice |
|---|---|
| Advance model | Autoplay: active card's video plays once; on end, advances to the next card — but only while the hero is scrolled into view. Manual click on any card jumps to it directly. |
| Hero scroll geometry | Normal single-viewport-height section, in normal document flow. No sticky pinning, no scroll-height multiplier. Page scroll simply scrolls past it. |
| Transition effect | Plain CSS opacity crossfade between the outgoing/incoming video. The WebGL shader dissolve (`TransitionCanvas`, `three`, `@react-three/fiber`, `useWebglSupported`) is removed entirely — it's not needed once transitions are card-driven rather than scroll-driven, and removing it helps the open Lighthouse gap. |
| New destinations | 5 more (10 total), real content: Morocco, Santorini, Kyoto, Peru, Swiss Alps. Real stock video/photos sourced from Pexels/Pixabay/Coverr (free, commercial-use, no attribution required), run through the existing Task 8 encode/budget pipeline. |
| Card thumbnails | Reuse each destination's existing `media.poster` WebP — no new image asset pipeline. |
| Search/booking widget | Not included. This business sells packages, not separate flights/hotels — a fake flight-search form would misrepresent what's on offer. |
| Ratings | Static curated field per destination, same manual-authorship pattern as `tagline`/`palette` today. |
| Map / place list on landing | Removed from the hero entirely. Interactive map+place-list belongs to the destinations section (a separate sub-project), not the landing carousel. |

## 3. Architecture

### 3.1 State model

`lib/scroll.ts` (`deriveAtlasState`, `useAtlasScroll`) is replaced by a new
`lib/hero-carousel.ts`:

```ts
type HeroCarouselState = {
  activeIndex: number;
  inView: boolean;
};

function useHeroCarousel(count: number): {
  state: HeroCarouselState;
  select: (index: number) => void;
  handleVideoEnded: () => void;
};
```

- `inView` is derived from an `IntersectionObserver` watching the hero `<section>`
  (threshold ~0.5) — autoplay-advance only fires while true.
- `handleVideoEnded` is wired to the active `<video>`'s native `onEnded` event. It
  advances `activeIndex` by 1 (wrapping to 0 after the last card) only if
  `inView && !prefersReducedMotion`.
- `select(index)` is called directly by `CardRail` on click, unconditionally (works
  regardless of `inView`/reduced-motion, so keyboard/manual navigation always works).
- When `prefersReducedMotion` is true, no autoplay ever fires; the hero shows a static
  poster for the active card, and cards remain manually clickable.
- The active `<video>` element itself is paused when `inView` is false (not just the
  auto-advance callback) and resumes from where it left off when the hero scrolls back
  into view — avoids burning decode/CPU cycles on an off-screen video, consistent with
  the "only while hero is in view" decision above.

### 3.2 Component changes

- **`AtlasScene.tsx`**: rewritten. Hero becomes `<section className="relative h-screen w-full overflow-hidden">` — no wrapping tall spacer div, no `position: sticky`. Renders `MediaLayer` (crossfade, no `TransitionCanvas`), the overlay panel (headline/tagline/CTA), the new feature-icon row, and `CardRail`.
- **`MediaLayer.tsx`**: keeps its existing max-2-video-mounted policy and permanent poster-on-error fallback (both proven in Phase 1). Crossfade changes from being driven by scroll `phase` to being driven by `activeIndex` changing — a plain CSS opacity transition (~600ms) between outgoing/incoming video layers.
- **`CardRail.tsx`**: adds the destination's poster image and star rating to each card. The active card is visually enlarged (~1.1x scale) and styled distinctly (existing accent-border/elevated pattern extends naturally). The rail auto-scrolls (`scrollIntoView({ behavior: "smooth", inline: "center" })`) to keep the active card visible as `activeIndex` changes, whether from autoplay or a click elsewhere.
- **New: feature-icon row** — a static (non-per-destination) transparent overlay row with 4 items: Best Price Guarantee, 24/7 Travel Support, Flexible Bookings, Secure Payments. Plain `Button`/icon primitives, no new dependency.
- **`NavBar.tsx`**: adds a "Plan your trip" button linking to `/plan`.
- **Deleted**: `TransitionCanvas.tsx`, the `three`/`@react-three/fiber` dependency, `useWebglSupported` (in `lib/reduced-motion.ts`), and their tests. `usePrefersReducedMotion` is kept — still needed for the autoplay gate.
- **Deleted**: `MapReveal.tsx` usage from `AtlasScene` (component itself may still be reused later by the destinations sub-project, so isn't necessarily deleted from the repo — just unused by the landing page after this change).

### 3.3 Content schema

`content/schema.ts` `DestinationSchema` gains two fields:

```ts
rating: z.number().min(0).max(5),
headline: z.string().min(1).max(120), // bigger display line, distinct from the existing shorter `tagline`
```

All 10 destinations (5 existing + 5 new) get `rating` and `headline` values. The 5 new
destinations get full new JSON content files plus real sourced media run through the
existing `npm run prepare-media` pipeline and its budget tests (`media-budget`).

Existing `map` data on all destinations is left untouched — it's unused by the landing
page after this change, but the destinations sub-project (not yet spec'd) will decide
its own data shape and may reuse or replace it then.

## 4. Accessibility & degradation

- `prefers-reduced-motion`: no video autoplay, no auto-advance ever fires; static
  poster shown for the active card; manual card clicks still work.
- Video load errors: existing permanent-poster-fallback behavior from `MediaLayer`
  (Task 12) is unchanged.
- Cards remain real `<a href="/destinations/{slug}">` links (`preventDefault` +
  `select()` on click) for progressive enhancement and keyboard/screen-reader nav,
  matching the existing pattern.

## 5. Testing plan

- **New unit tests** (`tests/unit/hero-carousel.test.ts`): advances on video-end only
  when in view and motion isn't reduced; never advances on reduced motion; `select()`
  always works regardless of `inView`; wraps from last card to first.
- **Updated component tests**: `CardRail` renders image + rating, active-card styling;
  hero panel renders `headline`/`tagline` for the active destination and updates when
  `activeIndex` changes.
- **Removed tests**: anything covering `TransitionCanvas`/`useWebglSupported`, and the
  scroll-`phase`-driven assertions in the old `atlas-scene`/`media-layer` suites that no
  longer apply.
- **Updated e2e specs** (`routes.spec.ts`, `degradation.spec.ts`): replace
  `window.scrollTo`-based destination switching with card clicks; add a test that
  dispatches a video `ended` event and asserts the carousel advances only while the
  hero is in the viewport.
- **Media budget tests**: extended to cover the 5 new destinations' encoded output
  (same CRF/size budget process as Task 8).
- **Lighthouse**: re-run at the end of implementation. Removing the Three.js bundle
  should produce a real, measurable improvement — report actual before/after numbers,
  not adjust the budget thresholds to force a pass (per the existing project rule from
  Task 22).

## 6. Non-goals (this sub-project)

Destinations index page, region view with map/place-list hover-linking, per-place
detail pages with pricing, and any restructuring of `/destinations/[slug]` routing —
all deferred to a separate spec ("Sub-project B").

## 7. Deployment checkpoint

Per product-owner feedback after the Phase 1 audit: after this sub-project is
implemented and tested, build the static export and serve it locally
(`npx serve out`) for a visual check *before* moving on to Sub-project B — not only at
the very end of all work.
