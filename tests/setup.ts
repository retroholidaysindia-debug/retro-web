import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.ts does not set `test.globals: true`, so Testing Library's
// automatic afterEach(cleanup) registration (which detects a global
// `afterEach`) never fires. Without this, DOM nodes from earlier tests in the
// same file accumulate, and any test file with multiple render() calls for
// the same component (e.g. tests/unit/media-layer.test.tsx) starts failing
// getByTestId/getByRole queries with "multiple elements found" as soon as a
// testid repeats across tests.
afterEach(() => {
  cleanup();
});

// jsdom does not implement window.matchMedia. Tests that care about a
// specific prefers-reduced-motion value stub it themselves (via
// vi.stubGlobal or vi.spyOn on usePrefersReducedMotion); this default keeps
// any component that calls the real hook from crashing with
// "window.matchMedia is not a function" in tests that don't care.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

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

// jsdom does not implement HTMLMediaElement.play(); calling it logs a "Not
// implemented" error to the console and returns undefined instead of a
// Promise. MediaLayer (components/atlas/MediaLayer.tsx) imperatively calls
// video.play() to resume the active clip when the hero scrolls into view, so
// without this stub every test that renders it either crashes (optional
// chaining aside, `.catch` on undefined throws) or pollutes test output with
// jsdom's console noise. Real browsers return a Promise here; mirror that.
if (typeof window !== "undefined" && window.HTMLMediaElement) {
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
}

// jsdom does not implement Element.scrollIntoView. CardRail
// (components/atlas/CardRail.tsx) calls it to keep the active card visible
// as the carousel auto-advances; without a stub, any test rendering it
// crashes with "el.scrollIntoView is not a function".
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// jsdom does not implement ResizeObserver. CardRail watches the card scroller
// for size changes to know when the left/right nudge arrows should be
// enabled; without this stub, rendering it crashes with
// "ResizeObserver is not defined".
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver;
}

// jsdom does not implement Element.scrollTo. CardRail calls it (on the card
// scroller, not the window) both for the arrow-button nudge and to bring the
// active card into view; without a stub, any test that triggers those code
// paths crashes with "scroller.scrollTo is not a function".
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {};
}
