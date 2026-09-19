import { loadHeroCardRegions } from "@/lib/hero-cards";
import { AtlasScene } from "@/components/atlas/AtlasScene";
import { FeatureRow } from "@/components/atlas/FeatureRow";
import { NavBar } from "@/components/ui/NavBar";
import { Footer } from "@/components/ui/Footer";
import { Button } from "@/components/ui/Button";

const REVIEWS = [
  {
    name: "Sarah Mitchell",
    date: "October 2024",
    stars: 5,
    text: "We did Kashmir in October. My husband had planned dozens of trips himself before — this was the first time he didn't need to. Every detail was handled, and the guide knew places we'd never have found on our own. Still talking about the night in Sonamarg.",
    initial: "S",
  },
  {
    name: "James Okafor",
    date: "August 2024",
    stars: 5,
    text: "I usually plan everything myself. They sent me exactly what I asked for, no filler, no padding. And when our flight got delayed, they sorted it before I'd even messaged them. 5 stars feels like an understatement.",
    initial: "J",
  },
  {
    name: "Elena Vasquez",
    date: "March 2025",
    stars: 5,
    text: "Nordic trip, six countries, three weeks. It should have been a logistical nightmare. The routing made sense in a way I couldn't have figured out on my own. The Aurora viewing in Tromsø was timed perfectly — absolute silence, full sky.",
    initial: "E",
  },
  {
    name: "David Chen",
    date: "November 2024",
    stars: 5,
    text: "We brought eight people to Peru — three generations of family, completely different interests. What they put together worked for all of us. That felt like a minor miracle. The Machu Picchu timing was especially thoughtful: we had the whole place to ourselves at dawn.",
    initial: "D",
  },
];

export default function HomePage() {
  const heroCardRegions = loadHeroCardRegions();
  // AtlasScene always renders each region's first card on first paint (see
  // defaultHeroCards in lib/hero-card-picker.ts), with the first region
  // active — so this poster is the deterministic LCP candidate on load.
  const defaultActivePoster = heroCardRegions[0]?.cards[0]?.media.poster;

  return (
    <>
      {defaultActivePoster && (
        <link
          rel="preload"
          as="image"
          href={`/media/${defaultActivePoster}/poster.webp`}
          fetchPriority="high"
        />
      )}
      <NavBar />
      <AtlasScene heroCardRegions={heroCardRegions} />

      {/* Trust bar — the guarantees that make booking easy */}
      <section
        className="border-t px-6 py-10 md:px-12 md:py-12"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <FeatureRow />
      </section>

      {/* "You will not remember the itinerary" section */}
      <section className="px-6 py-24 md:px-12" style={{ background: "var(--deep)" }}>
        <h2 className="font-display text-4xl md:text-5xl">You will not remember the itinerary.</h2>
        <p className="mt-4 max-w-xl text-lg" style={{ color: "var(--muted)" }}>
          Twelve years of trips people still talk about. 4.9 stars, 77 reviews, two
          founders who still answer the phone.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button href="/plan">
            Plan your trip
            <span aria-hidden="true">→</span>
          </Button>
          <Button href="/contact" variant="ghost">
            Get in touch
          </Button>
        </div>
      </section>

      {/* Google Reviews section */}
      <section className="px-6 py-20 md:px-12" style={{ background: "var(--surface)" }}>
        <div className="mb-10 flex items-end justify-between">
          <div>
            <p
              className="mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em]"
              style={{ color: "var(--accent)" }}
            >
              <span className="inline-block h-px w-8" style={{ background: "var(--accent)" }} />
              What people say
            </p>
            <h2 className="font-display text-3xl md:text-4xl">Reviews from Google</h2>
          </div>
          <p className="hidden items-center gap-2 text-sm md:flex" style={{ color: "var(--muted)" }}>
            <span className="text-base" style={{ color: "var(--accent)" }}>★★★★★</span>
            4.9 · 77 reviews
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {REVIEWS.map((r) => (
            <div
              key={r.name}
              className="flex flex-col gap-4 rounded-2xl border p-6"
              style={{ background: "var(--deep)", borderColor: "var(--hairline)" }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-semibold"
                  style={{ background: "var(--glass)", color: "var(--accent)" }}
                >
                  {r.initial}
                </div>
                <div>
                  <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                    {r.name}
                  </p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {r.date}
                  </p>
                </div>
              </div>

              <p className="text-xs leading-[1.7]" style={{ color: "var(--muted)" }}>
                {r.stars === 5 && (
                  <span className="mr-2 text-sm" style={{ color: "var(--accent)" }} aria-label="5 stars">
                    ★★★★★
                  </span>
                )}
                {r.text}
              </p>

              <div className="mt-auto flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                  Posted on Google
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <Footer />
    </>
  );
}
