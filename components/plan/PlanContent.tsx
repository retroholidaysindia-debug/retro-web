"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { GlassPanel } from "@/components/ui/GlassPanel";
import type { Destination } from "@/content/schema";

type Props = { destinations: Pick<Destination, "slug" | "name">[] };

export function PlanContent({ destinations }: Props) {
  const params = useSearchParams();
  const slug = params.get("destination");
  const dest = destinations.find((d) => d.slug === slug);

  if (!dest) {
    return (
      <section className="p-6 md:p-12">
        <h1 className="font-display text-3xl">Where to?</h1>
        <p className="mt-2" style={{ color: "var(--muted)" }}>
          Pick a destination to start planning.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {destinations.map((d) => (
            <Link
              key={d.slug}
              href={`/plan?destination=${d.slug}`}
              className="rounded-full border px-5 py-2"
              style={{ borderColor: "var(--hairline)" }}
            >
              {d.name}
            </Link>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="p-6 md:p-12">
      <GlassPanel className="mb-8 p-4">
        <p className="text-sm" style={{ color: "var(--accent)" }}>
          This is a Phase 2 preview — the quotation engine isn&apos;t built yet. These
          fields don&apos;t calculate anything.
        </p>
      </GlassPanel>
      <h1 className="font-display text-4xl">Planning your trip to {dest.name}</h1>
      <div className="mt-8 grid max-w-lg gap-4">
        <label className="flex flex-col gap-1">
          <span style={{ color: "var(--muted)" }}>Travel dates</span>
          <input type="date" className="rounded-lg border bg-transparent p-3" style={{ borderColor: "var(--hairline)" }} />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "var(--muted)" }}>Travellers</span>
          <input type="number" min={1} defaultValue={2} className="rounded-lg border bg-transparent p-3" style={{ borderColor: "var(--hairline)" }} />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "var(--muted)" }}>Trip style</span>
          <select className="rounded-lg border bg-transparent p-3" style={{ borderColor: "var(--hairline)" }}>
            <option>Relaxed</option>
            <option>Adventure</option>
            <option>Luxury</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "var(--muted)" }}>Budget band</span>
          <select className="rounded-lg border bg-transparent p-3" style={{ borderColor: "var(--hairline)" }}>
            <option>Comfortable</option>
            <option>Premium</option>
            <option>No limit</option>
          </select>
        </label>
      </div>
    </section>
  );
}
