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
