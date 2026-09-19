// tests/unit/media-layer.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MediaLayer } from "@/components/atlas/MediaLayer";
import type { HeroCard } from "@/lib/hero-card-picker";

afterEach(() => {
  vi.unstubAllGlobals();
});

const card = (slug: string): HeroCard => ({
  destinationSlug: slug,
  destinationName: slug,
  region: "x",
  country: slug,
  placeSlug: "p",
  packageSlug: "p-package",
  headline: "x",
  tagline: "x",
  buttonLabel: "x",
  rating: 4.5,
  palette: { accent: "#ffffff", deep: "#000000" },
  media: { clip: slug, poster: slug },
});

const cards = [card("kashmir"), card("bali"), card("dubai"), card("nordic"), card("kenya")];
const key = (slug: string) => `${slug}-p`;

describe("MediaLayer", () => {
  it("renders a video for the active card", () => {
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    expect(screen.getByTestId(`media-video-${key("kashmir")}`)).toBeInTheDocument();
  });

  it("renders poster stills for non-active cards", () => {
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    expect(screen.getByTestId(`media-poster-${key("dubai")}`)).toBeInTheDocument();
    expect(screen.getByTestId(`media-poster-${key("nordic")}`)).toBeInTheDocument();
    expect(screen.getByTestId(`media-poster-${key("kenya")}`)).toBeInTheDocument();
  });

  it("mounts at most two video elements during the crossfade window right after activeIndex changes", () => {
    const { rerender } = render(
      <MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />
    );
    rerender(<MediaLayer cards={cards} activeIndex={1} inView={true} onVideoEnded={vi.fn()} />);
    const videos = screen.getAllByTestId(/^media-video-/);
    expect(videos.length).toBeLessThanOrEqual(2);
  });

  it("does not set the loop attribute — the video plays once, not on a loop", () => {
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const video = screen.getByTestId(`media-video-${key("kashmir")}`) as HTMLVideoElement;
    expect(video).not.toHaveAttribute("loop");
  });

  it("sets muted and playsInline on the active video element", () => {
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const video = screen.getByTestId(`media-video-${key("kashmir")}`) as HTMLVideoElement;
    expect(video).toHaveAttribute("muted");
    expect(video).toHaveAttribute("playsinline");
  });

  it("calls onVideoEnded when the active video fires its native ended event", () => {
    const onVideoEnded = vi.fn();
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={onVideoEnded} />);
    const video = screen.getByTestId(`media-video-${key("kashmir")}`) as HTMLVideoElement;
    video.dispatchEvent(new Event("ended"));
    expect(onVideoEnded).toHaveBeenCalledTimes(1);
  });

  it("falls back to the poster permanently after a video error event", () => {
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const video = screen.getByTestId(`media-video-${key("kashmir")}`) as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));
    expect(screen.getByTestId(`media-poster-${key("kashmir")}`)).toBeInTheDocument();
  });

  it("renders only posters, no video elements, when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    expect(screen.queryAllByTestId(/^media-video-/)).toHaveLength(0);
    expect(screen.getByTestId(`media-poster-${key("kashmir")}`)).toBeInTheDocument();
  });

  it("lazy-loads poster images for non-active cards", () => {
    render(<MediaLayer cards={cards} activeIndex={0} inView={true} onVideoEnded={vi.fn()} />);
    const poster = screen.getByTestId(`media-poster-${key("dubai")}`);
    expect(poster).toHaveAttribute("loading", "lazy");
  });
});
