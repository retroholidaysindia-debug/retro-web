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
