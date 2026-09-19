"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/reduced-motion";

// Shared horizontal-scroll-rail behavior: tracks whether the rail is
// scrolled to its start/end (to enable/disable arrow buttons) and exposes a
// `nudge` helper to scroll by a fixed amount. Used by every horizontally
// scrolling rail in the app (hero card rail, destination package row, …) so
// they all get working prev/next arrows on every screen size, not just
// touch/trackpad scroll.
export function useHorizontalScroll<T extends HTMLElement>() {
  const scrollerRef = useRef<T | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  const updateEdgeState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateEdgeState();
    el.addEventListener("scroll", updateEdgeState, { passive: true });
    const ro = new ResizeObserver(updateEdgeState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateEdgeState);
      ro.disconnect();
    };
  }, [updateEdgeState]);

  const nudge = useCallback(
    (dir: 1 | -1, amount = 280) => {
      const el = scrollerRef.current;
      if (!el) return;
      // Note: "auto" defers to the element's computed CSS scroll-behavior
      // (which is "smooth" here via the scroll-smooth class), so reduced
      // motion needs the explicit "instant" value to actually skip the
      // animation rather than falling back to smooth anyway.
      el.scrollBy({ left: dir * amount, behavior: prefersReducedMotion ? "instant" : "smooth" });
      // Don't rely solely on the native "scroll" event to refresh the
      // arrow-disabled state: it's fired reliably during real user scrolls,
      // but some environments don't dispatch it for programmatic scrolls
      // that resolve instantly. Updating here keeps the buttons in sync
      // immediately; the scroll listener still handles mid-animation and
      // user-driven updates on top of this.
      updateEdgeState();
    },
    [prefersReducedMotion, updateEdgeState],
  );

  return { scrollerRef, atStart, atEnd, nudge };
}
