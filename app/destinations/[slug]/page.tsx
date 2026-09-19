import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDestination, loadDestinations } from "@/lib/destinations";
import { getPackagesForDestination } from "@/lib/packages";
import { getPackageImages } from "@/lib/package-images";
import { NavBar } from "@/components/ui/NavBar";
import { Footer } from "@/components/ui/Footer";
import { DestinationMapSection } from "@/components/destinations/DestinationMapSection";
import { PackagesRow } from "@/components/destinations/PackagesRow";

export function generateStaticParams() {
  return loadDestinations().map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const dest = loadDestination(slug);
  if (!dest) return {};
  return {
    title: `${dest.name} — Retro Holidays`,
    description: dest.tagline,
    openGraph: { images: [`/media/${dest.media.poster}/poster.webp`] },
  };
}

export default async function DestinationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const dest = loadDestination(slug);
  if (!dest) notFound();

  const packages = getPackagesForDestination(dest).map((pkg) => ({
    ...pkg,
    coverImage: getPackageImages(dest.slug, pkg.packageSlug)[0],
  }));

  return (
    <>
      <NavBar />

      {/* Hero */}
      <section
        className="relative flex h-[78vh] min-h-[560px] items-end p-6 md:p-12"
        style={{ background: dest.palette.deep }}
      >
        <img
          src={`/media/${dest.media.poster}/poster.webp`}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="scrim-hero pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative max-w-2xl">
          <Link
            href="/destinations"
            className="mb-6 inline-flex items-center gap-2 text-sm transition-colors hover:text-[var(--text)]"
            style={{ color: "var(--muted)" }}
          >
            <span aria-hidden="true">←</span> All destinations
          </Link>
          <p
            className="mb-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em]"
            style={{ color: "var(--accent)" }}
          >
            <span className="inline-block h-px w-8" style={{ background: "var(--accent)" }} />
            {dest.region}
          </p>
          <h1
            className="font-display text-6xl leading-[0.98] md:text-7xl"
            style={{ textShadow: "0 2px 30px rgba(0,0,0,0.55)" }}
          >
            {dest.name}
          </h1>
          <p
            className="mt-4 max-w-md text-lg"
            style={{ color: "rgba(242,247,246,0.86)", textShadow: "0 1px 12px rgba(0,0,0,0.6)" }}
          >
            {dest.tagline}
          </p>
        </div>
      </section>

      {/* Packages available in this region */}
      <section className="px-6 pt-16 pb-4 md:px-12" style={{ background: "var(--deep)" }}>
        <div className="mb-6 max-w-2xl">
          <h2 className="font-display text-3xl md:text-4xl">Packages in {dest.name}</h2>
          <p className="mt-3 text-base leading-relaxed" style={{ color: "var(--muted)" }}>
            {packages.length} hand-built {packages.length === 1 ? "package" : "packages"} across {dest.name} —
            pick one to see the full itinerary, highlights and price.
          </p>
        </div>

        <PackagesRow destinationSlug={dest.slug} packages={packages} />
      </section>

      {/* Full-width interactive map */}
      <section className="px-6 pt-4 pb-16 md:px-12" style={{ background: "var(--deep)" }}>
        <div className="mb-6 max-w-2xl">
          <h2 className="font-display text-3xl md:text-4xl">Where we go in {dest.name}</h2>
          <p className="mt-3 text-base leading-relaxed" style={{ color: "var(--muted)" }}>
            {dest.tagline} We travel to {dest.map.markers.length} places across {dest.name} — each chosen for what it offers, not how often it appears in a travel guide. Some are well-known; several are not. Hover a place to preview it, click to see the package it belongs to.
          </p>
        </div>
        <DestinationMapSection
          destinationSlug={dest.slug}
          mapSvg={getMapSvgSync(dest.slug)}
          groups={dest.groups ?? []}
          markers={dest.map.markers}
        />
      </section>

      <Footer />
    </>
  );
}

function getMapSvgSync(slug: string): string {
  return readFileSync(path.join(process.cwd(), "public", "maps", `${slug}.svg`), "utf-8");
}

