# Atlas Landing Carousel Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scroll-driven Atlas hero with a normal-height, autoplay card carousel (video plays once per card, advances to the next on end, only while the hero is in view), add images/ratings to cards, add 5 new destinations with real sourced media, and remove the WebGL shader dissolve that was a known Lighthouse performance contributor.

**Architecture:** A new dependency-free `useHeroCarousel` hook (IntersectionObserver + video `onEnded` + a plain index) replaces the old scroll-position-driven `lib/scroll.ts` state machine. `MediaLayer` crossfades via CSS opacity keyed off `activeIndex` instead of a scroll `phase`. `CardRail` gains images/ratings and auto-scrolls itself to keep the active card visible. `AtlasScene` becomes a normal single-viewport `<section>` in the page's document flow — no more sticky pinning or scroll-height spacer div.

**Tech Stack:** Next.js 16 (static export) + React 19 + TypeScript, Vitest + Testing Library, Playwright, zod. No new runtime dependencies.

## Global Constraints

- No new runtime npm dependencies — the crossfade is plain CSS, not a carousel/animation library (per approved design; see spec §2).
- Do not change pinned versions: `next@16.3.0`, `react@19.2.8`, `react-dom@19.2.8`, `zod@^4.4.3`.
- Videos must never have the `loop` attribute — they play once and fire `onEnded`.
- Card thumbnails reuse each destination's existing `media.poster` WebP — do not add a new image asset pipeline.
- All destination content lives in `content/destinations/*.json`, validated by `content/schema.ts` — never hardcode destination copy/data in a component.
- New destinations' source video must come only from Pexels' direct CDN file URLs (`videos.pexels.com/video-files/...`) obtained via the `https://www.pexels.com/download/video/{id}/` redirect — free, commercial-use, no attribution required, no API key/login needed (same licensing basis as the existing 5 sources in `scripts/media-sources.json`).
- `lighthouserc.json`'s budget thresholds must never be loosened to force a passing build — report real before/after numbers only (standing project rule from the Task 22 performance fix).
- Every task must leave its own new/modified test file(s) green (as each task's steps specify via `npm test -- <name>`). Tasks 2, 3, and 8 leave unrelated pre-existing test files red on purpose — they still reference dead code that isn't deleted until Task 9 — so the full suite (`npm test` with no filter) is only required to be fully green starting at Task 9.

---

### Task 1: Content schema — add `rating` and `headline`

**Files:**
- Modify: `content/schema.ts`
- Modify: `content/destinations/kashmir.json`, `bali.json`, `dubai.json`, `nordic.json`, `kenya.json`
- Test: `tests/unit/destinations.test.ts`

**Interfaces:**
- Produces: `Destination` type gains `rating: number` (0–5) and `headline: string` (1–120 chars). Every later task that constructs a `Destination` fixture must include both fields.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/destinations.test.ts`, inside the existing `describe("loadDestinations", ...)` block:

```ts
  it("every destination has a rating between 0 and 5 and a non-empty headline", () => {
    for (const d of loadDestinations()) {
      expect(d.rating).toBeGreaterThanOrEqual(0);
      expect(d.rating).toBeLessThanOrEqual(5);
      expect(d.headline.length).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- destinations`
Expected: FAIL — `d.rating`/`d.headline` are `undefined` (property doesn't exist on the current content yet, and the schema doesn't require it).

- [ ] **Step 3: Add the fields to the schema**

In `content/schema.ts`, inside `DestinationSchema`, add two lines right after `tagline`:

```ts
  tagline: z.string().min(1).max(80),
  headline: z.string().min(1).max(120),
  rating: z.number().min(0).max(5),
```

- [ ] **Step 4: Add real values to all 5 existing destination content files**

In each file, add `"headline"` and `"rating"` right after the existing `"tagline"` key.

`content/destinations/kashmir.json`:
```json
  "tagline": "Where the mountains keep quiet.",
  "headline": "Where the Mountains Keep Every Secret",
  "rating": 4.8,
```

`content/destinations/bali.json`:
```json
  "tagline": "Green, and then more green.",
  "headline": "Green Until You Forget Every Other Color",
  "rating": 4.9,
```

`content/destinations/dubai.json`:
```json
  "tagline": "Nothing here was inevitable.",
  "headline": "Built From Nothing, Felt as Everything",
  "rating": 4.7,
```

`content/destinations/nordic.json`:
```json
  "tagline": "Light that forgets to leave.",
  "headline": "Chasing Light That Never Says Goodnight",
  "rating": 4.8,
```

`content/destinations/kenya.json`:
```json
  "tagline": "The herds decide the season.",
  "headline": "The Herds Write the Only Schedule That Matters",
  "rating": 4.9,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- destinations`
Expected: PASS

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: All existing tests still pass. (Test files that construct ad-hoc `Destination` fixtures without `rating`/`headline` — e.g. `atlas-scene.test.tsx`, `card-rail.test.tsx`, `media-layer.test.tsx` — will still run fine: Vitest doesn't type-check by default, so missing optional-in-practice fields on a test fixture object don't fail at runtime. Tasks 4, 5, and 8 rewrite those fixtures anyway.)

- [ ] **Step 7: Commit**

```bash
git add content/schema.ts content/destinations/kashmir.json content/destinations/bali.json content/destinations/dubai.json content/destinations/nordic.json content/destinations/kenya.json tests/unit/destinations.test.ts
git commit -m "feat: add rating and headline fields to destination content schema"
```

---

### Task 2: Hero carousel hook

**Files:**
- Create: `lib/hero-carousel.ts`
- Delete: `lib/scroll.ts`
- Test: `tests/unit/hero-carousel.test.ts` (new)
- Delete: `tests/unit/scroll.test.ts`
- Modify: `tests/setup.ts` (add an `IntersectionObserver` stub; jsdom has none, same pattern as the existing `ResizeObserver`/`matchMedia` stubs)

**Interfaces:**
- Consumes: `usePrefersReducedMotion` from `@/lib/reduced-motion` (unchanged, already exists).
- Produces: `useHeroCarousel(count: number): { activeIndex: number; inView: boolean; sectionRef: (node: HTMLElement | null) => void; select: (index: number) => void; handleVideoEnded: () => void }` and the pure helper `nextIndex(current: number, count: number): number`. `MediaLayer` (Task 4), `CardRail` (Task 5), and `AtlasScene` (Task 8) all consume this exact shape.

- [ ] **Step 1: Add the IntersectionObserver test stub**

Add to `tests/setup.ts`, right after the existing `ResizeObserver` stub block (that block gets deleted in Task 9 — leave it for now, this just adds alongside it):

```ts
// jsdom does not implement IntersectionObserver. useHeroCarousel (lib/hero-carousel.ts)
// observes the hero section's visibility to gate autoplay; without this stub, any test
// that renders a component using the hook (without individually mocking
// IntersectionObserver, as tests/unit/hero-carousel.test.ts does) crashes with
// "IntersectionObserver is not defined".
if (typeof window !== "undefined" && !window.IntersectionObserver) {
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.IntersectionObserver;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/hero-carousel.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHeroCarousel, nextIndex } from "@/lib/hero-carousel";

class MockIntersectionObserver {
  static lastInstance: MockIntersectionObserver | null = null;
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.lastInstance = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fireIntersection(isIntersecting: boolean) {
  MockIntersectionObserver.lastInstance?.callback(
    [{ isIntersecting } as IntersectionObserverEntry],
    MockIntersectionObserver.lastInstance as unknown as IntersectionObserver
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockIntersectionObserver.lastInstance = null;
});

describe("nextIndex", () => {
  it("advances by one", () => {
    expect(nextIndex(0, 3)).toBe(1);
  });

  it("wraps from the last index back to 0", () => {
    expect(nextIndex(2, 3)).toBe(0);
  });
});

describe("useHeroCarousel", () => {
  it("starts at index 0", () => {
    const { result } = renderHook(() => useHeroCarousel(3));
    expect(result.current.activeIndex).toBe(0);
  });

  it("select() jumps to the given index immediately", () => {
    const { result } = renderHook(() => useHeroCarousel(3));
    act(() => {
      result.current.select(2);
    });
    expect(result.current.activeIndex).toBe(2);
  });

  it("handleVideoEnded advances to the next index while in view", () => {
    const { result } = renderHook(() => useHeroCarousel(3));
    act(() => {
      result.current.handleVideoEnded();
    });
    expect(result.current.activeIndex).toBe(1);
  });

  it("handleVideoEnded wraps from the last card back to the first", () => {
    const { result } = renderHook(() => useHeroCarousel(3));
    act(() => {
      result.current.select(2);
    });
    act(() => {
      result.current.handleVideoEnded();
    });
    expect(result.current.activeIndex).toBe(0);
  });

  it("does not advance on video end when the hero has scrolled out of view", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { result } = renderHook(() => useHeroCarousel(3));
    act(() => {
      result.current.sectionRef(document.createElement("div"));
    });
    act(() => {
      fireIntersection(false);
    });
    expect(result.current.inView).toBe(false);
    act(() => {
      result.current.handleVideoEnded();
    });
    expect(result.current.activeIndex).toBe(0);
  });

  it("select() still works when the hero is out of view", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { result } = renderHook(() => useHeroCarousel(3));
    act(() => {
      result.current.sectionRef(document.createElement("div"));
    });
    act(() => {
      fireIntersection(false);
    });
    act(() => {
      result.current.select(1);
    });
    expect(result.current.activeIndex).toBe(1);
  });

  it("does not advance on video end when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { result } = renderHook(() => useHeroCarousel(3));
    act(() => {
      result.current.handleVideoEnded();
    });
    expect(result.current.activeIndex).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- hero-carousel`
Expected: FAIL with "Cannot find module '@/lib/hero-carousel'".

- [ ] **Step 4: Implement `lib/hero-carousel.ts`**

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/reduced-motion";

export function nextIndex(current: number, count: number): number {
  return (current + 1) % count;
}

export type HeroCarouselApi = {
  activeIndex: number;
  inView: boolean;
  sectionRef: (node: HTMLElement | null) => void;
  select: (index: number) => void;
  handleVideoEnded: () => void;
};

export function useHeroCarousel(count: number): HeroCarouselApi {
  const [activeIndex, setActiveIndex] = useState(0);
  // Optimistic default: the hero is almost always in view on initial page
  // load (it's the top of the page), so we don't want to hold autoplay
  // hostage to the observer's first callback firing.
  const [inView, setInView] = useState(true);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const sectionRef = useCallback((el: HTMLElement | null) => {
    setNode(el);
  }, []);

  useEffect(() => {
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.5 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  const select = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  const handleVideoEnded = useCallback(() => {
    if (!inView || reducedMotion) return;
    setActiveIndex((current) => nextIndex(current, count));
  }, [inView, reducedMotion, count]);

  return { activeIndex, inView, sectionRef, select, handleVideoEnded };
}
```

- [ ] **Step 5: Delete the old scroll engine**

```bash
rm lib/scroll.ts tests/unit/scroll.test.ts
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- hero-carousel`
Expected: PASS (9/9)

Note: `npm test` as a whole will now show failures in `tests/unit/atlas-scene.test.tsx`, `tests/unit/card-rail.test.tsx`, and `tests/unit/media-layer.test.tsx` (they still import `AtlasState` from the now-deleted `@/lib/scroll`) — that's expected and fixed in Tasks 4, 5, and 8. Confirm via `npm test -- hero-carousel` specifically for this task, not the full suite.

- [ ] **Step 7: Commit**

```bash
git add lib/hero-carousel.ts tests/unit/hero-carousel.test.ts tests/setup.ts
git rm lib/scroll.ts tests/unit/scroll.test.ts
git commit -m "feat: add useHeroCarousel hook, replacing the scroll-driven state machine"
```

---

### Task 3: Reduced-motion cleanup

**Files:**
- Modify: `lib/reduced-motion.ts`
- Modify: `tests/unit/reduced-motion.test.ts`

**Interfaces:**
- Produces: `usePrefersReducedMotion(): boolean` (unchanged, kept). `detectWebglSupport`/`useWebglSupported` are removed — no longer needed once the WebGL shader dissolve is gone (Task 9).

- [ ] **Step 1: Remove the WebGL exports**

In `lib/reduced-motion.ts`, delete `detectWebglSupport` and `useWebglSupported`, leaving only:

```ts
import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);
    const listener = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);

  return reduced;
}
```

- [ ] **Step 2: Update the test file**

In `tests/unit/reduced-motion.test.ts`, delete the `import { ..., detectWebglSupport } ...` reference and the entire `describe("detectWebglSupport", ...)` block, leaving only the `describe("usePrefersReducedMotion", ...)` block and its import line updated to:

```ts
import { usePrefersReducedMotion } from "@/lib/reduced-motion";
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test -- reduced-motion`
Expected: PASS (2/2)

Note: `tests/unit/transition-canvas.test.tsx` and `components/atlas/TransitionCanvas.tsx` still reference `useWebglSupported` at this point — they will fail to compile/import until Task 9 deletes them. Confirm via `npm test -- reduced-motion` specifically, not the full suite, same caveat as Task 2.

- [ ] **Step 4: Commit**

```bash
git add lib/reduced-motion.ts tests/unit/reduced-motion.test.ts
git commit -m "refactor: drop WebGL-detection hook, no longer needed without the shader dissolve"
```

---

### Task 4: MediaLayer — index-driven crossfade, no loop, pause off-screen

**Files:**
- Modify: `components/atlas/MediaLayer.tsx`
- Modify: `tests/unit/media-layer.test.tsx`

**Interfaces:**
- Consumes: `usePrefersReducedMotion` from `@/lib/reduced-motion`.
- Produces: `MediaLayer(props: { destinations: Destination[]; activeIndex: number; inView: boolean; onVideoEnded: () => void })`. Replaces the old `{ destinations, atlasState }` prop shape. Consumed by `AtlasScene` (Task 8).

- [ ] **Step 1: Write the failing test**

Replace `tests/unit/media-layer.test.tsx` entirely:

```tsx
// tests/unit/media-layer.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MediaLayer } from "@/components/atlas/MediaLayer";
import type { Destination } from "@/content/schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

const dest = (slug: string): Destination => ({
  slug,
  name: slug,
  region: "x",
  tagline: "x",
  headline: "x",
  rating: 4.5,
  palette: { accent: "#ffffff", deep: "#000000" },
  media: { clip: slug, poster: slug },
  map: { countries: ["XXX"], markers: [{ name: "x", lat: 0, lng: 0, type: "city" }] },
});

const destinations = [dest("kashmir"), dest("bali"), dest("dubai"), dest("nordic"), dest("kenya")];

describe("MediaLayer", () => {
  it("renders a video for the active destination", () => {
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    expect(screen.getByTestId("media-video-kashmir")).toBeInTheDocument();
  });

  it("renders poster stills for non-active destinations", () => {
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    expect(screen.getByTestId("media-poster-dubai")).toBeInTheDocument();
    expect(screen.getByTestId("media-poster-nordic")).toBeInTheDocument();
    expect(screen.getByTestId("media-poster-kenya")).toBeInTheDocument();
  });

  it("mounts at most two video elements during the crossfade window right after activeIndex changes", () => {
    const { rerender } = render(
      <MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />
    );
    rerender(<MediaLayer destinations={destinations} activeIndex={1} inView={true} onVideoEnded={vi.fn()} />);
    const videos = screen.getAllByTestId(/^media-video-/);
    expect(videos.length).toBeLessThanOrEqual(2);
  });

  it("does not set the loop attribute — the video plays once, not on a loop", () => {
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const video = screen.getByTestId("media-video-kashmir") as HTMLVideoElement;
    expect(video).not.toHaveAttribute("loop");
  });

  it("sets muted and playsInline on the active video element", () => {
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const video = screen.getByTestId("media-video-kashmir") as HTMLVideoElement;
    expect(video).toHaveAttribute("muted");
    expect(video).toHaveAttribute("playsinline");
  });

  it("calls onVideoEnded when the active video fires its native ended event", () => {
    const onVideoEnded = vi.fn();
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={onVideoEnded} />);
    const video = screen.getByTestId("media-video-kashmir") as HTMLVideoElement;
    video.dispatchEvent(new Event("ended"));
    expect(onVideoEnded).toHaveBeenCalledTimes(1);
  });

  it("falls back to the poster permanently after a video error event", () => {
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const video = screen.getByTestId("media-video-kashmir") as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));
    expect(screen.getByTestId("media-poster-kashmir")).toBeInTheDocument();
  });

  it("renders only posters, no video elements, when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<MediaLayer destinations={destinations} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    expect(screen.queryAllByTestId(/^media-video-/)).toHaveLength(0);
    expect(screen.getByTestId("media-poster-kashmir")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- media-layer`
Expected: FAIL (old component still expects `atlasState` prop, imports deleted `@/lib/scroll`).

- [ ] **Step 3: Rewrite `components/atlas/MediaLayer.tsx`**

```tsx
// components/atlas/MediaLayer.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Destination } from "@/content/schema";
import { usePrefersReducedMotion } from "@/lib/reduced-motion";

type Props = {
  destinations: Destination[];
  activeIndex: number;
  inView: boolean;
  onVideoEnded: () => void;
};

const CROSSFADE_MS = 700;

export function MediaLayer({ destinations, activeIndex, inView, onVideoEnded }: Props) {
  const [erroredSlugs, setErroredSlugs] = useState<Set<string>>(new Set());
  const [transitionFromIndex, setTransitionFromIndex] = useState<number | null>(null);
  const prevIndexRef = useRef(activeIndex);
  const reducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // When activeIndex changes, briefly keep the outgoing destination's video
  // mounted alongside the incoming one so the CSS opacity transition has
  // something to crossfade between, then drop it once the transition ends.
  useEffect(() => {
    if (prevIndexRef.current === activeIndex) return;
    const from = prevIndexRef.current;
    prevIndexRef.current = activeIndex;
    if (reducedMotion) return;
    setTransitionFromIndex(from);
    const timer = setTimeout(() => setTransitionFromIndex(null), CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [activeIndex, reducedMotion]);

  // Play/pause the active video based on hero visibility — avoids burning
  // decode cycles on an off-screen video, and never autoplays at all under
  // reduced motion.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (inView && !reducedMotion) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [inView, reducedMotion, activeIndex]);

  function markErrored(slug: string) {
    // flushSync: see components/atlas/MediaLayer.tsx history — keeps the
    // poster fallback committed synchronously within the same event-dispatch
    // call stack as the video's error event (React 19 batching otherwise
    // defers it a tick).
    flushSync(() => {
      setErroredSlugs((prev) => new Set(prev).add(slug));
    });
  }

  const videoSlugs = new Set<string>();
  if (!reducedMotion) {
    videoSlugs.add(destinations[activeIndex].slug);
    if (transitionFromIndex !== null) videoSlugs.add(destinations[transitionFromIndex].slug);
  }

  return (
    <div className="absolute inset-0" aria-hidden="true">
      {destinations.map((dest, i) => {
        const isVideo = videoSlugs.has(dest.slug) && !erroredSlugs.has(dest.slug);
        const layerOpacity = i === activeIndex ? 1 : 0;
        const isActive = i === activeIndex;

        return (
          <div
            key={dest.slug}
            className="absolute inset-0 transition-opacity"
            style={{ opacity: layerOpacity, zIndex: isActive ? 1 : 0, transitionDuration: `${CROSSFADE_MS}ms` }}
          >
            {isVideo ? (
              <video
                data-testid={`media-video-${dest.slug}`}
                ref={
                  isActive
                    ? (el) => {
                        videoRef.current = el;
                        // React only sets `muted` as an IDL property, not the
                        // reflected HTML attribute (facebook/react#10389).
                        if (el) el.setAttribute("muted", "");
                      }
                    : undefined
                }
                muted
                playsInline
                preload="none"
                poster={`/media/${dest.media.poster}/poster.webp`}
                onError={() => markErrored(dest.slug)}
                onEnded={isActive ? onVideoEnded : undefined}
                className="h-full w-full object-cover"
              >
                <source src={`/media/${dest.media.clip}/clip.av1.webm`} type='video/webm; codecs="av01.0.05M.08"' />
                <source src={`/media/${dest.media.clip}/clip.vp9.webm`} type="video/webm" />
                <source src={`/media/${dest.media.clip}/clip.mp4`} type="video/mp4" />
              </video>
            ) : (
              <img
                data-testid={`media-poster-${dest.slug}`}
                src={`/media/${dest.media.poster}/poster.webp`}
                alt=""
                className="h-full w-full object-cover"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- media-layer`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add components/atlas/MediaLayer.tsx tests/unit/media-layer.test.tsx
git commit -m "feat: drive MediaLayer crossfade from activeIndex, drop loop, pause when off-screen"
```

---

### Task 5: CardRail — images, ratings, active enlargement, auto-scroll

**Files:**
- Modify: `components/atlas/CardRail.tsx`
- Modify: `tests/unit/card-rail.test.tsx`
- Modify: `tests/setup.ts` (add a `scrollIntoView` stub; jsdom has none)

**Interfaces:**
- Produces: `CardRail(props: { destinations: Destination[]; activeIndex: number; onSelect: (index: number) => void })`. Replaces the old `{ destinations, atlasState, onSelect }` shape. Consumed by `AtlasScene` (Task 8).

- [ ] **Step 1: Add the scrollIntoView test stub**

Add to `tests/setup.ts`:

```ts
// jsdom does not implement Element.scrollIntoView. CardRail
// (components/atlas/CardRail.tsx) calls it to keep the active card visible
// as the carousel auto-advances; without a stub, any test rendering it
// crashes with "el.scrollIntoView is not a function".
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
```

- [ ] **Step 2: Write the failing test**

Replace `tests/unit/card-rail.test.tsx` entirely:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CardRail } from "@/components/atlas/CardRail";
import type { Destination } from "@/content/schema";

afterEach(() => {
  vi.restoreAllMocks();
});

const dest = (slug: string, name: string): Destination => ({
  slug,
  name,
  region: "x",
  tagline: `Tagline for ${name}`,
  headline: `Headline for ${name}`,
  rating: 4.7,
  palette: { accent: "#ffffff", deep: "#000000" },
  media: { clip: slug, poster: slug },
  map: { countries: ["XXX"], markers: [{ name: "x", lat: 0, lng: 0, type: "city" }] },
});

const destinations = [dest("kashmir", "Kashmir"), dest("bali", "Bali"), dest("dubai", "Dubai")];

describe("CardRail", () => {
  it("renders one real anchor per destination, linking to its page", () => {
    render(<CardRail destinations={destinations} activeIndex={0} onSelect={vi.fn()} />);
    for (const d of destinations) {
      const link = screen.getByRole("link", { name: new RegExp(d.name) });
      expect(link).toHaveAttribute("href", `/destinations/${d.slug}`);
    }
  });

  it("marks the active destination's card distinctly", () => {
    render(<CardRail destinations={destinations} activeIndex={0} onSelect={vi.fn()} />);
    const activeLink = screen.getByRole("link", { name: /Kashmir/ });
    expect(activeLink).toHaveAttribute("aria-current", "true");
  });

  it("renders each card's poster image and star rating", () => {
    render(<CardRail destinations={destinations} activeIndex={0} onSelect={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Bali/ });
    expect(link.querySelector("img")).toHaveAttribute("src", "/media/bali/poster.webp");
    expect(link).toHaveTextContent("4.7");
  });

  it("calls onSelect with the destination index and prevents default navigation on click", () => {
    const onSelect = vi.fn();
    render(<CardRail destinations={destinations} activeIndex={0} onSelect={onSelect} />);
    const link = screen.getByRole("link", { name: /Bali/ });
    const event = fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(event).toBe(false);
  });

  it("scrolls the newly active card into view when activeIndex changes", () => {
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const { rerender } = render(<CardRail destinations={destinations} activeIndex={0} onSelect={vi.fn()} />);
    rerender(<CardRail destinations={destinations} activeIndex={2} onSelect={vi.fn()} />);
    expect(scrollIntoViewSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- card-rail`
Expected: FAIL (old component expects `atlasState`, no image/rating markup).

- [ ] **Step 4: Rewrite `components/atlas/CardRail.tsx`**

```tsx
"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { Destination } from "@/content/schema";

type Props = {
  destinations: Destination[];
  activeIndex: number;
  onSelect: (index: number) => void;
};

export function CardRail({ destinations, activeIndex, onSelect }: Props) {
  const cardRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  useEffect(() => {
    cardRefs.current[activeIndex]?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [activeIndex]);

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-40 flex gap-3 overflow-x-auto px-4 py-4 md:px-12"
      role="list"
    >
      {destinations.map((dest, i) => {
        const isActive = i === activeIndex;
        return (
          <div key={dest.slug} role="listitem" className="contents">
            <Link
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              href={`/destinations/${dest.slug}`}
              aria-current={isActive ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                onSelect(i);
              }}
              className="min-w-[160px] shrink-0 overflow-hidden rounded-xl border transition-transform"
              style={{
                borderColor: isActive ? dest.palette.accent : "var(--hairline)",
                background: "var(--surface)",
                transform: isActive ? "scale(1.1) translateY(-6px)" : "scale(1)",
                zIndex: isActive ? 1 : 0,
              }}
            >
              <img
                src={`/media/${dest.media.poster}/poster.webp`}
                alt=""
                className="h-20 w-full object-cover"
              />
              <div className="p-3">
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {dest.region}
                </p>
                <p className="font-display text-lg">{dest.name}</p>
                <p className="mt-1 text-xs" style={{ color: "var(--accent)" }}>
                  {"★"} {dest.rating.toFixed(1)}
                </p>
              </div>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- card-rail`
Expected: PASS (5/5)

- [ ] **Step 6: Commit**

```bash
git add components/atlas/CardRail.tsx tests/unit/card-rail.test.tsx tests/setup.ts
git commit -m "feat: add images/ratings to CardRail, enlarge active card, auto-scroll into view"
```

---

### Task 6: FeatureRow component

**Files:**
- Create: `components/atlas/FeatureRow.tsx`
- Test: `tests/unit/feature-row.test.tsx` (new)

**Interfaces:**
- Produces: `FeatureRow(): JSX.Element` — no props. Consumed by `AtlasScene` (Task 8).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/feature-row.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FeatureRow } from "@/components/atlas/FeatureRow";

describe("FeatureRow", () => {
  it("renders the four trust-signal items", () => {
    render(<FeatureRow />);
    expect(screen.getByText("Best Price Guarantee")).toBeInTheDocument();
    expect(screen.getByText("24/7 Travel Support")).toBeInTheDocument();
    expect(screen.getByText("Flexible Bookings")).toBeInTheDocument();
    expect(screen.getByText("Secure Payments")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- feature-row`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `components/atlas/FeatureRow.tsx`**

```tsx
const FEATURES = ["Best Price Guarantee", "24/7 Travel Support", "Flexible Bookings", "Secure Payments"];

export function FeatureRow() {
  return (
    <div className="absolute bottom-24 left-0 right-0 z-30 hidden justify-center gap-8 px-6 md:flex md:px-12">
      {FEATURES.map((label) => (
        <div
          key={label}
          className="rounded-full px-4 py-2 text-xs"
          style={{ background: "var(--glass)", color: "var(--text)", backdropFilter: "blur(12px)" }}
        >
          {label}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- feature-row`
Expected: PASS (1/1)

- [ ] **Step 5: Commit**

```bash
git add components/atlas/FeatureRow.tsx tests/unit/feature-row.test.tsx
git commit -m "feat: add FeatureRow trust-signal band for the hero"
```

---

### Task 7: NavBar — "Plan your trip" CTA button

**Files:**
- Modify: `components/ui/NavBar.tsx`
- Test: `tests/unit/nav-bar.test.tsx` (new)

**Interfaces:**
- Consumes: `Button` from `@/components/ui/Button` (existing, unchanged).
- Produces: no change to `NavBar`'s exported shape (still a zero-prop component).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/nav-bar.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavBar } from "@/components/ui/NavBar";

describe("NavBar", () => {
  it("renders a Plan your trip call-to-action linking to /plan", () => {
    render(<NavBar />);
    const cta = screen.getByRole("link", { name: /plan your trip/i });
    expect(cta).toHaveAttribute("href", "/plan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- nav-bar`
Expected: FAIL — no element matches `/plan your trip/i`.

- [ ] **Step 3: Update `components/ui/NavBar.tsx`**

```tsx
import Link from "next/link";
import { Button } from "./Button";

const LINKS = [
  { href: "/destinations/kashmir", label: "Destinations" },
  { href: "/plan", label: "Plan" },
  { href: "/contact", label: "Contact" },
];

export function NavBar() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 md:px-12">
      <Link href="/" className="font-display text-xl" style={{ color: "var(--text)" }}>
        Retro Reverbnation
      </Link>
      <nav className="flex items-center gap-6 text-sm" style={{ color: "var(--muted)" }}>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="hover:text-[var(--text)] transition-colors">
            {l.label}
          </Link>
        ))}
        <Button href="/plan">Plan your trip</Button>
      </nav>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- nav-bar`
Expected: PASS (1/1)

- [ ] **Step 5: Commit**

```bash
git add components/ui/NavBar.tsx tests/unit/nav-bar.test.tsx
git commit -m "feat: add Plan your trip CTA button to NavBar"
```

---

### Task 8: Assemble the new AtlasScene

**Files:**
- Modify: `components/atlas/AtlasScene.tsx`
- Modify: `tests/unit/atlas-scene.test.tsx`

**Interfaces:**
- Consumes: `useHeroCarousel` (Task 2), `MediaLayer` (Task 4), `CardRail` (Task 5), `FeatureRow` (Task 6), `GlassPanel`/`Button` (existing, unchanged).
- Produces: `AtlasScene(props: { destinations: Destination[] })` — same external prop shape as before, so `app/page.tsx` needs no changes.

- [ ] **Step 1: Write the failing test**

Replace `tests/unit/atlas-scene.test.tsx` entirely:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AtlasScene } from "@/components/atlas/AtlasScene";
import type { Destination } from "@/content/schema";

const dest = (slug: string, name: string): Destination => ({
  slug,
  name,
  region: "x-region",
  tagline: `Tagline for ${name}`,
  headline: `Headline for ${name}`,
  rating: 4.6,
  palette: { accent: "#ffffff", deep: "#000000" },
  media: { clip: slug, poster: slug },
  map: { countries: ["XXX"], markers: [{ name: "x", lat: 0, lng: 0, type: "city" }] },
});

const destinations = [dest("kashmir", "Kashmir"), dest("bali", "Bali")];

describe("AtlasScene", () => {
  it("renders the active destination's headline and tagline in the hero panel", () => {
    render(<AtlasScene destinations={destinations} />);
    const panel = screen.getByTestId("hero-panel");
    expect(within(panel).getByRole("heading", { name: "Headline for Kashmir" })).toBeInTheDocument();
    expect(within(panel).getByText("Tagline for Kashmir")).toBeInTheDocument();
  });

  it("renders the card rail with a card per destination", () => {
    render(<AtlasScene destinations={destinations} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders an Explore Destinations action linking to /plan with the active slug", () => {
    render(<AtlasScene destinations={destinations} />);
    const panel = screen.getByTestId("hero-panel");
    const cta = within(panel).getByRole("link", { name: /explore destinations/i });
    expect(cta).toHaveAttribute("href", "/plan?destination=kashmir");
  });

  it("renders the feature guarantee row", () => {
    render(<AtlasScene destinations={destinations} />);
    expect(screen.getByText("Secure Payments")).toBeInTheDocument();
  });

  it("renders the hero as a normal single-viewport section, not a tall scroll-spacer", () => {
    render(<AtlasScene destinations={destinations} />);
    const section = screen.getByTestId("hero-panel").closest("section");
    expect(section).toHaveClass("h-screen");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- atlas-scene`
Expected: FAIL (old component imports deleted `@/lib/scroll`, renders `active.name` not `active.headline`, has no `hero-panel` testid).

- [ ] **Step 3: Rewrite `components/atlas/AtlasScene.tsx`**

```tsx
"use client";

import type { Destination } from "@/content/schema";
import { useHeroCarousel } from "@/lib/hero-carousel";
import { MediaLayer } from "./MediaLayer";
import { CardRail } from "./CardRail";
import { FeatureRow } from "./FeatureRow";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { Button } from "@/components/ui/Button";

type Props = { destinations: Destination[] };

export function AtlasScene({ destinations }: Props) {
  const { activeIndex, inView, sectionRef, select, handleVideoEnded } = useHeroCarousel(destinations.length);
  const active = destinations[activeIndex];

  return (
    <section
      ref={sectionRef}
      className="relative h-screen w-full overflow-hidden"
      style={{ background: active.palette.deep }}
    >
      <MediaLayer
        destinations={destinations}
        activeIndex={activeIndex}
        inView={inView}
        onVideoEnded={handleVideoEnded}
      />

      <div className="absolute left-6 top-28 max-w-md md:left-12" data-testid="hero-panel">
        <GlassPanel className="p-6">
          <p className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            {active.region}
          </p>
          <p className="text-sm font-medium uppercase tracking-widest" style={{ color: "var(--accent)" }}>
            {active.name}
          </p>
          <h2 className="font-display text-4xl">{active.headline}</h2>
          <p className="mt-2" style={{ color: "var(--muted)" }}>
            {active.tagline}
          </p>
          <div className="mt-4">
            <Button href={`/plan?destination=${active.slug}`}>Explore Destinations</Button>
          </div>
        </GlassPanel>
      </div>

      <FeatureRow />
      <CardRail destinations={destinations} activeIndex={activeIndex} onSelect={select} />
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- atlas-scene`
Expected: PASS (5/5)

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: All tests pass except `tests/unit/transition-canvas.test.tsx`, `tests/unit/dissolve-material.test.ts`, and `tests/unit/map-reveal.test.tsx` (those components are now fully unused — deleted in Task 9).

- [ ] **Step 6: Commit**

```bash
git add components/atlas/AtlasScene.tsx tests/unit/atlas-scene.test.tsx
git commit -m "feat: rebuild AtlasScene as a normal-height autoplay carousel hero"
```

---

### Task 9: Delete the WebGL shader dissolve and MapReveal (dead code)

**Files:**
- Delete: `components/atlas/TransitionCanvas.tsx`, `components/atlas/MapReveal.tsx`, `components/atlas/dissolveMaterial.ts`
- Delete: `tests/unit/transition-canvas.test.tsx`, `tests/unit/dissolve-material.test.ts`, `tests/unit/map-reveal.test.tsx`
- Modify: `tests/setup.ts` (remove the now-unused `ResizeObserver` stub)
- Modify: `app/globals.css` (remove the now-unused `.map-reveal` rules)
- Modify: `package.json` (remove `three`, `@react-three/fiber`, `@react-three/drei`)

**Interfaces:** None — this task only removes code nothing else references (confirmed via Tasks 4/8 no longer importing any of it).

- [ ] **Step 1: Delete the dead components and their tests**

```bash
rm components/atlas/TransitionCanvas.tsx components/atlas/MapReveal.tsx components/atlas/dissolveMaterial.ts
rm tests/unit/transition-canvas.test.tsx tests/unit/dissolve-material.test.ts tests/unit/map-reveal.test.tsx
```

- [ ] **Step 2: Remove the stale ResizeObserver stub from `tests/setup.ts`**

Delete this entire block (it existed only for `@react-three/fiber`'s `<Canvas>`, which no longer exists anywhere in the app):

```ts
// jsdom does not implement ResizeObserver. `useWebglSupported` (lib/reduced-motion.ts)
// ...
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver;
}
```

- [ ] **Step 3: Remove the dead `.map-reveal` CSS rules from `app/globals.css`**

Delete these rules (the `--reveal` custom property they reference is no longer set anywhere):

```css
.map-reveal path[data-role="coastline"] {
  stroke-dasharray: 3000;
  stroke-dashoffset: calc(3000 * (1 - var(--reveal, 0)));
  transition: stroke-dashoffset 0.1s linear;
}
.map-reveal g[data-marker-name] circle {
  transform: scale(var(--reveal, 0));
  transform-origin: center;
  transition: transform 0.3s ease-out;
}
.map-reveal g[data-marker-name] text,
.map-reveal g[data-marker-name] line {
  opacity: var(--reveal, 0);
  transition: opacity 0.3s ease-out;
}
```

- [ ] **Step 4: Remove the Three.js dependencies**

In `package.json`, delete these three lines from `"dependencies"`:

```json
    "@react-three/drei": "^10.7.7",
    "@react-three/fiber": "^9.7.0",
    "three": "^0.185.1",
```

Then run:

```bash
npm install
```

Expected: `package-lock.json` updates, removing the `three`/`@react-three/*` dependency trees.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: All tests pass (no more references to the deleted files anywhere).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove WebGL shader dissolve and MapReveal, no longer used by the landing page"
```

---

### Task 10: Source, encode, and add content for 5 new destinations

**Files:**
- Modify: `scripts/media-sources.json`
- Modify: `scripts/prepare-media.ts` (extend the CRF branching for the new slugs)
- Create: `content/destinations/morocco.json`, `santorini.json`, `kyoto.json`, `peru.json`, `swiss-alps.json`
- Modify: `tests/unit/destinations.test.ts` (slug count 5 → 10)
- Modify: `tests/integration/media-budget.test.ts` (SLUGS list 5 → 10)

**Interfaces:** None new — these are content/data additions consumed automatically by `loadDestinations()` (existing, reads every `.json` in `content/destinations/`) and by `scripts/build-maps/index.ts` (existing, iterates `loadDestinations()`).

- [ ] **Step 1: Add the 5 new source clips to `scripts/media-sources.json`**

These are direct, no-login Pexels CDN file URLs (confirmed reachable via `curl -IL`), same licensing basis as the existing 5 entries:

```json
{
  "kashmir": { "url": "https://videos.pexels.com/video-files/19674205/19674205-hd_1920_1080_30fps.mp4", "note": "Aerial Views of Kashmir Valley — Pexels video 19674205, landscape 1920x1080" },
  "bali": { "url": "https://videos.pexels.com/video-files/11685426/11685426-hd_1280_720_30fps.mp4", "note": "Drone Video of Rice Fields in Bali — Pexels video 11685426, landscape 1280x720" },
  "dubai": { "url": "https://videos.pexels.com/video-files/8359173/8359173-uhd_2560_1440_25fps.mp4", "note": "Aerial Footage of a Modernized City (Dubai skyline, Burj Khalifa) by Mikhail Nilov — Pexels video 8359173, landscape 2560x1440" },
  "nordic": { "url": "https://videos.pexels.com/video-files/33031598/14079789_2560_1440_60fps.mp4", "note": "Mesmerizing Aerial View of Norway's Serene Fjords — Pexels video 33031598, landscape 2560x1440" },
  "kenya": { "url": "https://videos.pexels.com/video-files/14556448/14556448-uhd_2558_1440_30fps.mp4", "note": "Zebras Grazing in a Field at Masai Mara National Reserve, Kenya — Pexels video 14556448, landscape 2558x1440" },
  "morocco": { "url": "https://videos.pexels.com/video-files/34535419/14632517_3840_2160_60fps.mp4", "note": "Camel Caravan at Sunset in Sahara Desert — Pexels video 34535419, landscape 3840x2160" },
  "santorini": { "url": "https://videos.pexels.com/video-files/20398401/20398401-hd_1920_1080_30fps.mp4", "note": "Fira Drone Flight, Santorini — Pexels video 20398401, landscape 1920x1080" },
  "kyoto": { "url": "https://videos.pexels.com/video-files/11834439/11834439-hd_1920_1080_30fps.mp4", "note": "Shrine in Kyoto — Pexels video 11834439, landscape 1920x1080" },
  "peru": { "url": "https://videos.pexels.com/video-files/29604765/12740973_3840_2160_30fps.mp4", "note": "Aerial View of Machu Picchu in Cloudy Weather — Pexels video 29604765, landscape 3840x2160" },
  "swiss-alps": { "url": "https://videos.pexels.com/video-files/33245569/14164415_3840_2160_24fps.mp4", "note": "Drone View of Majestic Swiss Alps Landscape — Pexels video 33245569, landscape 3840x2160" }
}
```

- [ ] **Step 2: Extend the CRF branching in `scripts/prepare-media.ts`**

In `encodeRenditions`, the new destinations start in the same moderate-compression bucket as `bali`/`nordic` (the existing default `else` branch already covers any slug not explicitly listed as `kashmir`/`kenya`/`dubai`, so **no code change is required here** — the 5 new slugs automatically fall into the `else` branch). Confirm this by reading the existing `if/else if/else` chain in `encodeRenditions` before proceeding — do not duplicate the branch.

- [ ] **Step 3: Create the 5 new destination content files**

`content/destinations/morocco.json`:
```json
{
  "slug": "morocco",
  "name": "Morocco",
  "region": "North Africa",
  "tagline": "Desert light, souks, and roads that wander on purpose.",
  "headline": "Deserts That Turn Gold Before Your Eyes",
  "rating": 4.7,
  "palette": { "accent": "#E0A458", "deep": "#241505" },
  "media": { "clip": "morocco", "poster": "morocco" },
  "map": {
    "countries": ["MAR"],
    "markers": [
      { "name": "Marrakech", "lat": 31.6295, "lng": -7.9811, "type": "city" },
      { "name": "Fes", "lat": 34.0331, "lng": -5.0003, "type": "city" },
      { "name": "Chefchaouen", "lat": 35.1688, "lng": -5.2636, "type": "poi" },
      { "name": "Merzouga", "lat": 31.0801, "lng": -4.0133, "type": "poi" },
      { "name": "Essaouira", "lat": 31.5085, "lng": -9.7595, "type": "poi" }
    ]
  }
}
```

`content/destinations/santorini.json`:
```json
{
  "slug": "santorini",
  "name": "Santorini",
  "region": "Greece",
  "tagline": "Cliffs, caldera, and sunsets that stop conversations.",
  "headline": "Blue and White, All the Way Down",
  "rating": 4.9,
  "palette": { "accent": "#8FCFEA", "deep": "#0A1620" },
  "media": { "clip": "santorini", "poster": "santorini" },
  "map": {
    "countries": ["GRC"],
    "markers": [
      { "name": "Fira", "lat": 36.4166, "lng": 25.4325, "type": "city" },
      { "name": "Oia", "lat": 36.4614, "lng": 25.3753, "type": "poi" },
      { "name": "Akrotiri", "lat": 36.3505, "lng": 25.4039, "type": "poi" },
      { "name": "Kamari", "lat": 36.3959, "lng": 25.4830, "type": "poi" }
    ]
  }
}
```

`content/destinations/kyoto.json`:
```json
{
  "slug": "kyoto",
  "name": "Kyoto",
  "region": "Japan",
  "tagline": "Temples, gardens, a stillness centuries in the making.",
  "headline": "A Thousand Years, Still Standing Still",
  "rating": 4.8,
  "palette": { "accent": "#D97757", "deep": "#1F0E0A" },
  "media": { "clip": "kyoto", "poster": "kyoto" },
  "map": {
    "countries": ["JPN"],
    "markers": [
      { "name": "Kyoto", "lat": 35.0116, "lng": 135.7681, "type": "city" },
      { "name": "Fushimi Inari", "lat": 34.9671, "lng": 135.7727, "type": "poi" },
      { "name": "Arashiyama", "lat": 35.0094, "lng": 135.6693, "type": "poi" },
      { "name": "Gion", "lat": 35.0037, "lng": 135.7788, "type": "poi" },
      { "name": "Kinkaku-ji", "lat": 35.0394, "lng": 135.7292, "type": "poi" }
    ]
  }
}
```

`content/destinations/peru.json`:
```json
{
  "slug": "peru",
  "name": "Peru",
  "region": "South America",
  "tagline": "Stone cities the clouds still haven't explained.",
  "headline": "Ruins the Clouds Refuse to Leave",
  "rating": 4.9,
  "palette": { "accent": "#C9A66B", "deep": "#1A140A" },
  "media": { "clip": "peru", "poster": "peru" },
  "map": {
    "countries": ["PER"],
    "markers": [
      { "name": "Cusco", "lat": -13.5320, "lng": -71.9675, "type": "city" },
      { "name": "Machu Picchu", "lat": -13.1631, "lng": -72.5450, "type": "poi" },
      { "name": "Aguas Calientes", "lat": -13.1547, "lng": -72.5256, "type": "poi" },
      { "name": "Pisac", "lat": -13.4270, "lng": -71.8500, "type": "poi" },
      { "name": "Lima", "lat": -12.0464, "lng": -77.0428, "type": "city" }
    ]
  }
}
```

`content/destinations/swiss-alps.json`:
```json
{
  "slug": "swiss-alps",
  "name": "Swiss Alps",
  "region": "Switzerland",
  "tagline": "Peaks and lakes that make silence feel earned.",
  "headline": "Peaks That Make the Sky Feel Closer",
  "rating": 4.8,
  "palette": { "accent": "#B8D8E8", "deep": "#0C1820" },
  "media": { "clip": "swiss-alps", "poster": "swiss-alps" },
  "map": {
    "countries": ["CHE"],
    "markers": [
      { "name": "Zermatt", "lat": 46.0207, "lng": 7.7491, "type": "city" },
      { "name": "Interlaken", "lat": 46.6863, "lng": 7.8632, "type": "city" },
      { "name": "Jungfraujoch", "lat": 46.5475, "lng": 7.9820, "type": "poi" },
      { "name": "Lauterbrunnen", "lat": 46.5936, "lng": 7.9080, "type": "poi" },
      { "name": "Grindelwald", "lat": 46.6244, "lng": 8.0410, "type": "poi" }
    ]
  }
}
```

- [ ] **Step 4: Update the destination-count test**

In `tests/unit/destinations.test.ts`, update:

```ts
  it("loads exactly the ten spec'd destinations", () => {
    const slugs = loadDestinations().map((d) => d.slug).sort();
    expect(slugs).toEqual([
      "bali", "dubai", "kashmir", "kenya", "kyoto", "morocco", "nordic", "peru", "santorini", "swiss-alps",
    ]);
  });
```

- [ ] **Step 5: Run the encode pipeline**

```bash
npm run prepare-media
```

Expected: downloads the 5 new raw clips to `data/raw-footage/`, encodes all rendition/poster files to `public/media/{morocco,santorini,kyoto,peru,swiss-alps}/`. This re-runs all 10 destinations, but existing raw footage is skipped (already cached from Task 8 of Phase 1), so only the 5 new ones actually download/encode.

- [ ] **Step 6: Extend and run the media budget test**

In `tests/integration/media-budget.test.ts`, update:

```ts
const SLUGS = ["kashmir", "bali", "dubai", "nordic", "kenya", "morocco", "santorini", "kyoto", "peru", "swiss-alps"];
```

Run: `npm test -- media-budget`
Expected: PASS for all 10. If any of the 5 new destinations exceeds a budget line, increase that destination's CRF values in `scripts/prepare-media.ts`'s `encodeRenditions` (add it to the `kashmir`/`kenya`-style high-compression branch, following the exact pattern already used for those two), re-run `npm run prepare-media`, and re-test — this mirrors the real, precedented tuning process from Phase 1's Task 8, not a placeholder step.

- [ ] **Step 7: Run the full unit suite**

Run: `npm test`
Expected: All tests pass, including the updated destination-count and media-budget tests.

- [ ] **Step 8: Commit**

```bash
git add scripts/media-sources.json content/destinations/morocco.json content/destinations/santorini.json content/destinations/kyoto.json content/destinations/peru.json content/destinations/swiss-alps.json public/media/morocco public/media/santorini public/media/kyoto public/media/peru public/media/swiss-alps tests/unit/destinations.test.ts tests/integration/media-budget.test.ts
git commit -m "feat: add 5 new destinations (Morocco, Santorini, Kyoto, Peru, Swiss Alps) with sourced media"
```

---

### Task 11: Wire the new destinations into the `/plan` picker

**Files:**
- Modify: `app/plan/page.tsx`

**Interfaces:** None — internal data wiring only.

- [ ] **Step 1: Add the 5 new imports and extend the `ALL` array**

In `app/plan/page.tsx`, add alongside the existing destination imports:

```ts
import moroccoData from "@/content/destinations/morocco.json";
import santoriniData from "@/content/destinations/santorini.json";
import kyotoData from "@/content/destinations/kyoto.json";
import peruData from "@/content/destinations/peru.json";
import swissAlpsData from "@/content/destinations/swiss-alps.json";

const ALL = [
  destinationsData, baliData, dubaiData, nordicData, kenyaData,
  moroccoData, santoriniData, kyotoData, peruData, swissAlpsData,
];
```

(`destinationsData` is the existing kashmir import, unchanged — see the current top of the file.)

- [ ] **Step 2: Manually verify**

```bash
npm run dev
```

Visit `http://localhost:3000/plan` — the destination picker should list all 10 destinations. Visit `http://localhost:3000/plan?destination=morocco` — should show "Planning your trip to Morocco". Stop the dev server after confirming (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add app/plan/page.tsx
git commit -m "feat: add the 5 new destinations to the /plan picker"
```

---

### Task 12: Update e2e specs for 10 destinations and card-driven navigation

**Files:**
- Modify: `tests/e2e/routes.spec.ts`
- Modify: `tests/e2e/degradation.spec.ts`

**Interfaces:** None — test-only changes.

- [ ] **Step 1: Extend the destination slug list in `routes.spec.ts`**

```ts
const SLUGS = ["kashmir", "bali", "dubai", "nordic", "kenya", "morocco", "santorini", "kyoto", "peru", "swiss-alps"];
```

(No other change needed in this file — the per-slug test loop already covers whatever's in `SLUGS`.)

- [ ] **Step 2: Update `degradation.spec.ts`'s reduced-motion test**

Replace the WebGL-era assertion (`canvas` no longer exists anywhere in the app after Task 9) with a check that no video autoplays under reduced motion:

```ts
  test("reduced motion: page is usable and shows static poster imagery, no video autoplay", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("video")).toHaveCount(0);
    await expect(page.getByRole("list")).toBeVisible();
    await context.close();
  });
```

- [ ] **Step 3: Delete the no-WebGL test**

Remove the entire `test("no WebGL: canvas never mounts, ...")` block — there is no WebGL/canvas code path left anywhere in the app to regress.

- [ ] **Step 4: Add a video-ended auto-advance test**

Add to `degradation.spec.ts`:

```ts
  test("video ended: auto-advances to the next card while the hero is in view", async ({ page }) => {
    await page.goto("/");
    const cardRail = page.getByRole("list");
    await cardRail.getByRole("link", { name: /kashmir/i }).click();
    await expect(cardRail.getByRole("link", { name: /kashmir/i })).toHaveAttribute("aria-current", "true");
    await page.locator('[data-testid="media-video-kashmir"]').evaluate((el) => {
      (el as HTMLVideoElement).dispatchEvent(new Event("ended"));
    });
    await expect(cardRail.getByRole("link", { name: /kashmir/i })).not.toHaveAttribute("aria-current", "true");
  });
```

- [ ] **Step 5: Run the e2e suite**

```bash
npm run build-maps && npm run build
npm run test:e2e
```

Expected: all specs pass, including the updated `routes` (10 destinations) and `degradation` (video-ended, reduced-motion, video-error) specs.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/routes.spec.ts tests/e2e/degradation.spec.ts
git commit -m "test: update e2e specs for 10 destinations and card-driven carousel navigation"
```

---

### Task 13: Full verification and local deploy preview

**Files:** None — verification only.

**Interfaces:** None.

- [ ] **Step 1: Run the full unit suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 2: Build maps and the static export**

```bash
npm run build-maps
npm run build
```
Expected: 21 static pages (11 from Phase 1 + 5 new `/destinations/{slug}` routes + no other new routes — note `/` and `/plan` etc. are unchanged route *count*, just the 5 new destination detail pages add to the `generateStaticParams` output). Confirm the build log shows all 10 `/destinations/*` pages generated with no Three.js/`@react-three` chunk in `.next/static/chunks/` (grep for `three` in the chunk manifest — should find nothing).

- [ ] **Step 3: Run the full e2e suite**

```bash
npm run test:e2e
```
Expected: all specs pass against the real static export.

- [ ] **Step 4: Re-run Lighthouse and report real numbers**

```bash
npm run lighthouse
```

Report the actual before/after performance score, LCP, and Total Blocking Time — compare against the last known baseline (score ~0.77, LCP ~3.4s, per the Task 22 follow-up). Removing the entire Three.js/`@react-three/fiber` bundle (not just deferring it) should produce a further real improvement. If the hard budget (score ≥0.85, LCP ≤2000ms) still isn't met, do not loosen `lighthouserc.json` — report the exact remaining gap and what the bootup-time/mainthread-work-breakdown audits now show as the top contributor, same honesty standard as the existing project history.

- [ ] **Step 5: Serve the static export locally and visually verify**

```bash
npx serve out -p 3000
```

Open `http://localhost:3000` and manually confirm:
- Hero is a normal-height section (not full-page scroll-jacked) — scrolling the page moves past it into the rest of the homepage content.
- Cards show images and star ratings; the active card is visibly larger.
- Clicking a card switches the active destination and background video immediately.
- Letting a video play to the end (or waiting) advances to the next card automatically, only while the hero is on-screen.
- The feature-icon row (Best Price Guarantee, etc.) is visible.
- The NavBar's "Plan your trip" button and the hero's "Explore Destinations" button both go to `/plan`.
- All 10 destinations are reachable via the card rail and via `/destinations/{slug}`.

Report the outcome (and any visual issues found) back before considering this sub-project done — per the standing instruction to check in with a real preview after a major change rather than only at the very end.

- [ ] **Step 6: Update the project memory**

This isn't a code step — after visual verification, note the outcome (Lighthouse numbers, any visual issues found and fixed) so the next session has an accurate, current record instead of relying on the pre-redesign snapshot.
