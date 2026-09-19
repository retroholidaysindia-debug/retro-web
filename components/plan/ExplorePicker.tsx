"use client";

/**
 * "I want to explore" — the alternative to the map.
 *
 * The traveller answers a few bounded questions and the catalogue is ranked
 * against them using the destination suitability scores and month-by-month
 * ratings already compiled into the core bundle. Still no free text.
 */
import { useMemo, useState } from "react";
import type { CoreBundle, TripStyle } from "@/lib/atlas/schema";
import { styleScore } from "@/lib/atlas/engine";
import { evaluatePlaceSelectability } from "@/lib/atlas/engine/bounds";

import { onAccent, selectStyle } from "./theme";

const STYLES: { value: TripStyle; label: string }[] = [
  { value: "family", label: "Family time" },
  { value: "romantic", label: "Romance" },
  { value: "honeymoon", label: "Honeymoon" },
  { value: "luxury", label: "Luxury" },
  { value: "adventure", label: "Adventure" },
  { value: "culture", label: "Culture & history" },
  { value: "budget", label: "Great value" },
  { value: "pilgrimage", label: "Pilgrimage" },
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const BUDGETS: { value: "value" | "mid" | "premium"; label: string; stars: string }[] = [
  { value: "value", label: "Keep it lean", stars: "3 star" },
  { value: "mid", label: "Comfortable", stars: "4 star" },
  { value: "premium", label: "Spare no expense", stars: "5 star and above" },
];

type Props = {
  core: CoreBundle;
  selected: string[];
  onChange: (placeIds: string[]) => void;
};

export function ExplorePicker({ core, selected, onChange }: Props) {
  const [style, setStyle] = useState<TripStyle>("culture");
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [budget, setBudget] = useState<"value" | "mid" | "premium">("mid");
  const [regionId, setRegionId] = useState<string>("any");

  const summaries = useMemo(
    () => new Map(core.placeSummaries.map((s) => [s.placeId, s])),
    [core.placeSummaries],
  );
  const countryById = useMemo(
    () => new Map(core.countries.map((c) => [c.id, c])),
    [core.countries],
  );

  const ranked = useMemo(() => {
    const cheapestHotel = new Map<string, number>();
    for (const rate of core.hotelRates) {
      if (rate.star !== "3 Star" || rate.zone !== "Outskirts") continue;
      cheapestHotel.set(rate.placeId, rate.inr);
    }
    const prices = [...cheapestHotel.values()].sort((a, b) => a - b);
    const p33 = prices[Math.floor(prices.length * 0.33)] ?? 0;
    const p66 = prices[Math.floor(prices.length * 0.66)] ?? Infinity;

    return core.places
      .filter((p) => p.hasContent)
      .filter((p) => regionId === "any" || countryById.get(p.countryId)?.regionId === regionId)
      .map((place) => {
        const summary = summaries.get(place.id);
        const fit = styleScore(summary, style);
        // The destination files score each month for weather, crowd and price;
        // a high monthly price index means an expensive time to go.
        const monthIndex = summary?.monthPrice?.[String(month)] ?? 50;
        const nightly = cheapestHotel.get(place.id) ?? p33;

        let budgetFit = 0;
        if (budget === "value") budgetFit = nightly <= p33 ? 15 : nightly <= p66 ? 5 : -10;
        else if (budget === "mid") budgetFit = nightly <= p66 ? 10 : 0;
        else budgetFit = nightly > p66 ? 12 : 4;

        // Prefer months where the destination is not at peak pricing.
        const seasonFit = (100 - monthIndex) * 0.15;

        return { place, score: fit + budgetFit + seasonFit, fit };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
  }, [core, summaries, countryById, style, month, budget, regionId]);

  const selectedSet = new Set(selected);
  const selectability = useMemo(() => evaluatePlaceSelectability(core, selected), [core, selected]);
  const toggle = (id: string) =>
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">What kind of trip?</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Trip style">
            {STYLES.map((s) => (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={s.value === style}
                onClick={() => setStyle(s.value)}
                className="rounded-full border px-4 py-1.5 text-sm"
                style={{
                  borderColor: s.value === style ? "var(--accent)" : "var(--hairline)",
                  background: s.value === style ? "var(--accent)" : "transparent",
                  color: s.value === style ? onAccent : "inherit",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Budget</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Budget">
            {BUDGETS.map((b) => (
              <button
                key={b.value}
                type="button"
                role="radio"
                aria-checked={b.value === budget}
                title={b.stars}
                onClick={() => setBudget(b.value)}
                className="rounded-full border px-4 py-1.5 text-sm"
                style={{
                  borderColor: b.value === budget ? "var(--accent)" : "var(--hairline)",
                  background: b.value === budget ? "var(--accent)" : "transparent",
                  color: b.value === budget ? onAccent : "inherit",
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">When?</span>
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="rounded-lg border p-3"
            style={selectStyle}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Anywhere in particular?</span>
          <select
            value={regionId}
            onChange={(e) => setRegionId(e.target.value)}
            className="rounded-lg border p-3"
            style={selectStyle}
          >
            <option value="any">Surprise me</option>
            {core.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <h3 className="font-display text-xl">Best matches</h3>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Ranked on how well each destination suits a {STYLES.find((s) => s.value === style)?.label.toLowerCase()} trip
          in {MONTHS[month - 1]}.
        </p>
        {selected.length > 0 && (
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Destinations greyed out below aren&apos;t realistically combinable with what you&apos;ve already picked —
            deselect a place to bring them back.
          </p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ranked.map(({ place, fit }) => {
            const on = selectedSet.has(place.id);
            const entry = selectability.get(place.id);
            const isDisabled = !on && entry?.allowed === false;
            const disabledReason = entry?.reason ?? "Not realistically combinable with your current selection";
            return (
              <button
                key={place.id}
                type="button"
                aria-pressed={on}
                aria-disabled={isDisabled}
                disabled={isDisabled}
                title={isDisabled ? disabledReason : undefined}
                onClick={() => !isDisabled && toggle(place.id)}
                className="rounded-xl border p-4 text-left transition"
                style={{
                  borderColor: on ? "var(--accent)" : "var(--hairline)",
                  background: on ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                  opacity: isDisabled ? 0.4 : 1,
                  cursor: isDisabled ? "not-allowed" : "pointer",
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{place.name}</span>
                  <span className="text-xs tabular-nums" style={{ color: "var(--accent)" }}>
                    {Math.round(fit)}
                  </span>
                </div>
                <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                  {countryById.get(place.countryId)?.name}
                </p>
                {isDisabled && (
                  <p className="mt-1 text-xs" style={{ color: "var(--accent)" }}>
                    {disabledReason}
                  </p>
                )}
              </button>
            );
          })}
        </div>
        {!ranked.length && (
          <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
            No destinations match that combination yet — try a different region.
          </p>
        )}
      </div>
    </div>
  );
}
