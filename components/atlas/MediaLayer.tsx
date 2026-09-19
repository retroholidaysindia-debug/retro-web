// components/atlas/MediaLayer.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { HeroCard } from "@/lib/hero-card-picker";
import { usePrefersReducedMotion } from "@/lib/reduced-motion";

type Props = {
  cards: HeroCard[];
  activeIndex: number;
  inView: boolean;
  onVideoEnded: () => void;
};

const CROSSFADE_MS = 700;

// A country card's own destination + place slug is unique across the whole
// catalogue (a destination can have many cards, but only one per place).
function cardKey(card: HeroCard): string {
  return `${card.destinationSlug}-${card.placeSlug}`;
}

export function MediaLayer({ cards, activeIndex, inView, onVideoEnded }: Props) {
  const [erroredKeys, setErroredKeys] = useState<Set<string>>(new Set());
  const [transitionFromIndex, setTransitionFromIndex] = useState<number | null>(null);
  const prevIndexRef = useRef(activeIndex);
  const reducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // When activeIndex changes, briefly keep the outgoing card's video mounted
  // alongside the incoming one so the CSS opacity transition has something to
  // crossfade between, then drop it once the transition ends.
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

  function markErrored(key: string) {
    // flushSync: see components/atlas/MediaLayer.tsx history — keeps the
    // poster fallback committed synchronously within the same event-dispatch
    // call stack as the video's error event (React 19 batching otherwise
    // defers it a tick).
    flushSync(() => {
      setErroredKeys((prev) => new Set(prev).add(key));
    });
  }

  const videoKeys = new Set<string>();
  if (!reducedMotion) {
    videoKeys.add(cardKey(cards[activeIndex]));
    if (transitionFromIndex !== null) videoKeys.add(cardKey(cards[transitionFromIndex]));
  }

  return (
    <div className="absolute inset-0" aria-hidden="true">
      {cards.map((card, i) => {
        const key = cardKey(card);
        const isVideo = videoKeys.has(key) && !erroredKeys.has(key);
        const layerOpacity = i === activeIndex ? 1 : 0;
        const isActive = i === activeIndex;

        return (
          <div
            key={key}
            className="absolute inset-0 transition-opacity"
            style={{ opacity: layerOpacity, zIndex: isActive ? 1 : 0, transitionDuration: `${CROSSFADE_MS}ms` }}
          >
            {isVideo ? (
              <video
                data-testid={`media-video-${key}`}
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
                poster={`/media/${card.media.poster}/poster.webp`}
                onError={() => markErrored(key)}
                onEnded={isActive ? onVideoEnded : undefined}
                className="h-full w-full object-cover"
              >
                <source src={`/media/${card.media.clip}/clip.av1.webm`} type='video/webm; codecs="av01.0.05M.08"' />
                <source src={`/media/${card.media.clip}/clip.vp9.webm`} type="video/webm" />
                <source src={`/media/${card.media.clip}/clip.mp4`} type="video/mp4" />
              </video>
            ) : (
              <img
                data-testid={`media-poster-${key}`}
                src={`/media/${card.media.poster}/poster.webp`}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
