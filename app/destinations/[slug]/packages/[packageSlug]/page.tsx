import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDestination, loadDestinations } from "@/lib/destinations";
import { getPackage, getPackagesForDestination } from "@/lib/packages";
import { getPackageImages } from "@/lib/package-images";
import { formatPrice } from "@/lib/trips";
import { NavBar } from "@/components/ui/NavBar";
import { Footer } from "@/components/ui/Footer";
import { Button } from "@/components/ui/Button";

export function generateStaticParams() {
  return loadDestinations().flatMap((d) =>
    getPackagesForDestination(d).map((p) => ({ slug: d.slug, packageSlug: p.packageSlug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; packageSlug: string }>;
}): Promise<Metadata> {
  const { slug, packageSlug } = await params;
  const dest = loadDestination(slug);
  const pkg = dest && getPackage(dest, packageSlug);
  if (!dest || !pkg) return {};
  return {
    title: `${pkg.packageName} — ${dest.name} — Retro Holidays`,
    description: pkg.offer?.summary ?? pkg.tagline,
    openGraph: { images: getPackageImages(dest.slug, pkg.packageSlug) },
  };
}

export default async function PackagePage({
  params,
}: {
  params: Promise<{ slug: string; packageSlug: string }>;
}) {
  const { slug, packageSlug } = await params;
  const dest = loadDestination(slug);
  const pkg = dest && getPackage(dest, packageSlug);
  if (!dest || !pkg) notFound();

  const images = getPackageImages(dest.slug, pkg.packageSlug);
  const [heroImage, ...galleryImages] = images;
  const offer = pkg.offer;

  return (
    <>
      <NavBar />

      {/* Hero */}
      <section
        className="relative flex h-[62vh] min-h-[440px] items-end p-6 md:p-12"
        style={{ background: dest.palette.deep }}
      >
        <img src={heroImage} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="scrim-hero pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative max-w-2xl">
          <Link
            href={`/destinations/${dest.slug}`}
            className="mb-6 inline-flex items-center gap-2 text-sm transition-colors hover:text-[var(--text)]"
            style={{ color: "var(--muted)" }}
          >
            <span aria-hidden="true">←</span> Back to {dest.name}
          </Link>
          <p
            className="mb-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em]"
            style={{ color: "var(--accent)" }}
          >
            <span className="inline-block h-px w-8" style={{ background: "var(--accent)" }} />
            {dest.region} · {pkg.name}
          </p>
          <h1
            className="font-display text-5xl leading-[1.0] md:text-6xl"
            style={{ textShadow: "0 2px 30px rgba(0,0,0,0.55)" }}
          >
            {pkg.packageName}
          </h1>
          {pkg.tagline && (
            <p
              className="mt-4 max-w-md text-lg"
              style={{ color: "rgba(242,247,246,0.86)", textShadow: "0 1px 12px rgba(0,0,0,0.6)" }}
            >
              {pkg.tagline}
            </p>
          )}
        </div>
      </section>

      <section className="px-6 py-16 md:px-12" style={{ background: "var(--deep)" }}>
        <div className="grid gap-12 lg:grid-cols-[1fr_20rem] lg:items-start">
          <div>
            <h2 className="font-display text-3xl">About this package</h2>
            <p className="mt-4 max-w-2xl text-lg" style={{ color: "var(--muted)" }}>
              {offer?.summary ?? pkg.tagline}
            </p>

            {offer?.highlights && offer.highlights.length > 0 && (
              <>
                <h3 className="mt-10 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text)" }}>
                  Package highlights
                </h3>
                <ul className="mt-4 flex max-w-2xl flex-col gap-3">
                  {offer.highlights.map((h) => (
                    <li key={h} className="flex gap-3" style={{ color: "var(--muted)" }}>
                      <span aria-hidden="true" style={{ color: "var(--accent)" }}>
                        ✦
                      </span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="mt-10 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text)" }}>
              Places covered
            </h3>
            <div className="mt-4 flex max-w-2xl flex-wrap gap-2">
              {pkg.places.map((place) => (
                <span
                  key={place}
                  className="rounded-full border px-3 py-1 text-sm"
                  style={{ borderColor: "var(--hairline)", color: "var(--muted)" }}
                >
                  {place}
                </span>
              ))}
            </div>

            {galleryImages.length > 0 && (
              <>
                <h3 className="mt-10 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text)" }}>
                  Gallery
                </h3>
                <div className="mt-4 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
                  {galleryImages.map((src, i) => (
                    <div key={src + i} className="aspect-square overflow-hidden rounded-xl">
                      <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Price + quote card */}
          <aside
            className="rounded-2xl border p-6"
            style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Duration
              </span>
              <span className="font-medium" style={{ color: "var(--text)" }}>
                {offer?.days ? `${offer.days} days` : "Flexible"}
              </span>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                From
              </span>
              <span className="font-display text-3xl" style={{ color: "var(--accent)" }}>
                {formatPrice(offer?.price_from_usd ?? 0)}
              </span>
            </div>
            <p className="mt-1 text-right text-xs" style={{ color: "var(--muted)" }}>
              {offer?.price_includes_flight
                ? "per person, indicative, flights included"
                : "per person, indicative — land package only, flights extra"}
            </p>
            <div className="mt-6">
              <Button href={`/plan?destination=${dest.slug}&package=${pkg.packageSlug}`}>
                Request a quote
                <span aria-hidden="true">→</span>
              </Button>
            </div>
            <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
              Every trip is shaped by hand — this is a starting point, not a fixed package.
            </p>
          </aside>
        </div>
      </section>

      <Footer />
    </>
  );
}
