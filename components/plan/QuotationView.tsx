"use client";

/**
 * The quotation view: line-item pricing, the day-by-day itinerary and the
 * levers a traveller can pull. Structural land-package costs are shown as
 * locked; everything else can be dropped or added, and the price recomputes.
 */
import { useMemo, useState } from "react";
import type { Quotation, QuoteRequest } from "@/lib/atlas/engine/types";
import type { TransportMode } from "@/lib/atlas/schema";
import { formatDuration, formatInr } from "@/lib/atlas/engine/text";
import policy from "@/content/quote-policy.json";

/** The hard ceiling on sightseeing in any one day; shown so the traveller can
 *  see why an outing will not fit rather than just finding that it does not. */
const maxSightseeingHours = policy.dayPlanning.maxSightseeingHoursPerDay;

/**
 * Contingency and agent margin are never shown as their own line — they are
 * folded straight into the categories below, at these fixed shares, so the
 * traveller only ever sees what a category costs, not how the agency arrived
 * at it. Weights are re-scaled across whichever of these categories are
 * actually present in a given quote.
 */
const MARKUP_ALLOCATION = policy.markup.contingencyMarginAllocation as Record<string, number>;

/** Structural components kept visible even when they price to zero, so an
 *  absent cost (e.g. no tourist tax on this route) reads as "included, none
 *  due" rather than looking like the line was dropped. */
const ALWAYS_VISIBLE_COMPONENTS = ["city-tax"];

const COMPONENT_LABEL: Record<string, string> = {
  hotel: "Accommodation",
  flight: "Flights",
  "airport-transfer": "Airport transfers",
  "local-transport": "Sightseeing transport",
  "intercity-transport": "Intercity transport",
  sightseeing: "Sightseeing & entrances",
  meals: "Meals",
  visa: "Visa support",
  insurance: "Travel insurance",
  "city-tax": "City & tourism tax",
};

/**
 * The optional side of the quote: everything a traveller can actually take out
 * or put back. Anything absent from this map is structural (the land package
 * the agency's policy says is always included) and is tagged "Included".
 *
 * `requestKey` is set only where the whole component is a single yes/no on the
 * request, which is what lets those rows carry their own add/remove control
 * and still appear — priced at zero — when they are switched off. The rest are
 * optional in the sense that they can be tuned elsewhere in this page, so they
 * say where rather than offering a toggle that would be a lie.
 */
const OPTIONAL_COMPONENTS: Record<
  string,
  { note: string; requestKey?: "includeFlight" | "includeVisa" | "includeInsurance" }
> = {
  flight: {
    requestKey: "includeFlight",
    note: "Return airfare from your departure city. Drop it to price the land package on its own.",
  },
  visa: {
    requestKey: "includeVisa",
    note: "Visa fees and handling. Drop it if you would rather apply yourself.",
  },
  insurance: {
    requestKey: "includeInsurance",
    note: "Priced from a typical daily rate pending the agency's own provider figures.",
  },
  sightseeing: {
    note: "Entry tickets for the outings below — deselect any of them in the day-by-day plan to drop it.",
  },
  meals: {
    note: "Set by the meal plan you chose; breakfast always comes with the room.",
  },
};

type Props = {
  quote: Quotation;
  request: QuoteRequest;
  onChange: (next: QuoteRequest) => void;
  onBack: () => void;
};

export function QuotationView({ quote, request, onChange, onBack }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<string, typeof quote.lineItems>();
    for (const item of quote.lineItems) {
      const list = map.get(item.component);
      if (list) list.push(item);
      else map.set(item.component, [item]);
    }
    const rows = [...map.entries()].sort(
      (a, b) =>
        b[1].reduce((s, i) => s + i.totalInr, 0) - a[1].reduce((s, i) => s + i.totalInr, 0),
    );
    // A component the traveller has switched off contributes no line items, so
    // it would otherwise vanish from the breakdown entirely — leaving no way to
    // tell "not charged for" from "not offered". Keep an empty row for each so
    // every optional part of the quote is visible and can be added back.
    for (const [component, meta] of Object.entries(OPTIONAL_COMPONENTS)) {
      if (!meta.requestKey || map.has(component) || request[meta.requestKey]) continue;
      rows.push([component, []]);
    }
    // Structural components can legitimately price to zero (no tourist tax on
    // this route, say) — keep the row rather than let it vanish and look like
    // it was quietly dropped.
    for (const component of ALWAYS_VISIBLE_COMPONENTS) {
      if (!map.has(component)) rows.push([component, []]);
    }
    return rows;
  }, [quote, request]);

  // Contingency + agent margin are computed by the engine but never shown on
  // their own — they are folded into the categories the policy assigns them
  // to, scaled up across only the categories actually present in this quote.
  const markupAllocation = useMemo(() => {
    const hiddenMarkup = quote.totals.contingency + quote.totals.agentMarkup;
    const baseByComponent = new Map<string, number>();
    for (const item of quote.lineItems) {
      baseByComponent.set(item.component, (baseByComponent.get(item.component) ?? 0) + item.totalInr);
    }
    const presentWeightSum = Object.entries(MARKUP_ALLOCATION).reduce(
      (sum, [component, weight]) => sum + (baseByComponent.get(component) ? weight : 0),
      0,
    );
    const map = new Map<string, number>();
    if (presentWeightSum > 0) {
      for (const [component, weight] of Object.entries(MARKUP_ALLOCATION)) {
        if (!baseByComponent.get(component)) continue;
        map.set(component, hiddenMarkup * (weight / presentWeightSum));
      }
    }
    return map;
  }, [quote]);

  // The flight fare is a same-day approximation, not a fixed price — this
  // note is one click away rather than always on screen.
  const [showFlightNote, setShowFlightNote] = useState(false);

  const excludedClusters = new Set(request.excludedClusterIds);

  // Internal notes explain how the engine reached a number; they belong in the
  // calibration report, not in front of the traveller.
  const travellerWarnings = quote.warnings.filter((w) => w.audience === "traveller");

  /** Turning a planned activity off, or back on again. */
  const toggleCluster = (clusterId: string) => {
    const turningOff = !excludedClusters.has(clusterId);
    onChange({
      ...request,
      excludedClusterIds: turningOff
        ? [...request.excludedClusterIds, clusterId]
        : request.excludedClusterIds.filter((id) => id !== clusterId),
      // Dropping something the traveller had previously asked for must also
      // release the pin, or the planner would keep forcing it back in.
      pinnedClusterIds: turningOff
        ? request.pinnedClusterIds.filter((id) => id !== clusterId)
        : request.pinnedClusterIds,
    });
  };

  /**
   * Adding a suggested outing to the itinerary.
   *
   * A suggestion is a cluster that was never excluded — it simply did not fit
   * the day budget — so toggling its exclusion would have removed it
   * altogether. It has to be *pinned* instead, which pushes it to the front
   * of the planner's queue while still respecting the daily sightseeing cap.
   */
  const addCluster = (clusterId: string) => {
    if (request.pinnedClusterIds.includes(clusterId)) return;
    onChange({
      ...request,
      pinnedClusterIds: [...request.pinnedClusterIds, clusterId],
      excludedClusterIds: request.excludedClusterIds.filter((id) => id !== clusterId),
    });
  };

  const setNights = (placeId: string, nights: number) => {
    onChange({ ...request, nightOverrides: { ...request.nightOverrides, [placeId]: nights } });
  };

  /** Transfer days that are a real intercity hop, in itinerary order. */
  const transferLegs = useMemo(
    () =>
      quote.days
        .filter((d) => d.isTransferDay && d.transfer && d.transfer.alternatives.length > 0)
        .map((d) => ({ placeId: d.placeId, leg: d.transfer! })),
    [quote.days],
  );

  const setLegMode = (placeId: string, mode: TransportMode) => {
    onChange({ ...request, legModes: { ...request.legModes, [placeId]: mode } });
  };

  return (
    <div className="flex flex-col gap-10">
      {/* ---- headline ---- */}
      <section
        className="rounded-2xl border p-6"
        style={{ borderColor: "var(--hairline)", background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}
      >
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              {quote.referencePackage
                ? `Based on ${quote.referencePackage.name}`
                : "A custom itinerary built for you"}
            </p>
            <h2 className="font-display mt-1 text-4xl">
              {quote.stays.map((s) => s.placeName).join(" · ")}
            </h2>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              {quote.days.length} days · {quote.stays.reduce((a, s) => a + s.nights, 0)} nights ·{" "}
              {quote.pax.adults} adult{quote.pax.adults !== 1 && "s"}
              {quote.pax.children > 0 && `, ${quote.pax.children} child`}
              {quote.pax.infants > 0 && `, ${quote.pax.infants} infant`} · {quote.pax.rooms} room
              {quote.pax.rooms !== 1 && "s"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Total for the group
            </p>
            <p className="font-display text-5xl tabular-nums" style={{ color: "var(--accent)" }}>
              {formatInr(quote.totals.total)}
            </p>
            <p className="text-sm tabular-nums" style={{ color: "var(--muted)" }}>
              {formatInr(quote.totals.perPerson)} per person
            </p>
          </div>
        </div>

        {travellerWarnings.length > 0 && (
          <ul className="mt-5 flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
            {travellerWarnings.map((w, i) => (
              <li key={i}>
                {w.level === "warning" ? "⚠" : "ℹ"} {w.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- adjusters ---- */}
      <section className="flex flex-col gap-4">
        <h3 className="font-display text-2xl">Adjust the trip</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Slide nights between destinations and the price follows.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {quote.stays.map((stay) => (
            <div
              key={stay.placeId}
              className="rounded-xl border p-4"
              style={{ borderColor: "var(--hairline)" }}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{stay.placeName}</span>
                <span className="text-sm tabular-nums" style={{ color: "var(--accent)" }}>
                  {stay.nights} night{stay.nights !== 1 && "s"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={14}
                value={stay.nights}
                onChange={(e) => setNights(stay.placeId, Number(e.target.value))}
                className="mt-3 w-full"
                aria-label={`Nights in ${stay.placeName}`}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ---- transport legs ---- */}
      {transferLegs.length > 0 && (
        <section className="flex flex-col gap-4">
          <h3 className="font-display text-2xl">Getting between destinations</h3>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Every leg is priced on the mode we think suits your trip. Switch any of them to trade
            fare against journey time — the total updates immediately.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Across the whole trip:
            </span>
            {(
              [
                ["cheapest", "Cheapest"],
                ["balanced", "Balanced"],
                ["fastest", "Fastest"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() =>
                  onChange({ ...request, transportPreference: key, legModes: {} })
                }
                aria-pressed={request.transportPreference === key}
                className="rounded-full border px-4 py-1.5 text-sm transition"
                style={
                  request.transportPreference === key
                    ? { borderColor: "var(--accent)", background: "var(--accent)", color: "var(--deep)" }
                    : { borderColor: "var(--hairline)" }
                }
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {transferLegs.map(({ placeId, leg }) => {
              const chosen = leg.alternatives.find((a) => a.mode === leg.mode);
              return (
                <div key={placeId} className="rounded-xl border p-4" style={{ borderColor: "var(--hairline)" }}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {leg.from} → {leg.to}
                    </span>
                    <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                      {leg.distanceKm ? `${leg.distanceKm} km` : ""}
                    </span>
                  </div>

                  {leg.alternatives.length > 1 ? (
                    <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={`Transport from ${leg.from} to ${leg.to}`}>
                      {leg.alternatives.map((alt) => {
                        const isChosen = alt.mode === leg.mode;
                        const deltaInr = chosen ? alt.priceInr - chosen.priceInr : 0;
                        const deltaMin = chosen ? alt.minutes - chosen.minutes : 0;
                        return (
                          <button
                            key={alt.mode}
                            type="button"
                            role="radio"
                            aria-checked={isChosen}
                            onClick={() => setLegMode(placeId, alt.mode)}
                            className="rounded-xl border px-3 py-2 text-left text-sm transition"
                            style={
                              isChosen
                                ? { borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 14%, transparent)" }
                                : { borderColor: "var(--hairline)" }
                            }
                          >
                            <div className="font-medium capitalize">{alt.mode.replace(/_/g, " ")}</div>
                            <div className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                              {formatInr(alt.priceInr)} pp · {formatDuration(alt.minutes)}
                            </div>
                            {!isChosen && (deltaInr !== 0 || deltaMin !== 0) && (
                              <div className="text-xs tabular-nums" style={{ color: "var(--accent)" }}>
                                {deltaInr === 0
                                  ? "same fare"
                                  : `${deltaInr > 0 ? "+" : "−"}${formatInr(Math.abs(deltaInr))}`}
                                {" · "}
                                {deltaMin === 0
                                  ? "same time"
                                  : `${deltaMin > 0 ? "+" : "−"}${formatDuration(Math.abs(deltaMin))}`}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                      <span className="capitalize">{leg.mode.replace(/_/g, " ")}</span>
                      {leg.durationMinutes != null && ` · ${formatDuration(leg.durationMinutes)}`}
                      {" — the only service on this route."}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---- itinerary ---- */}
      <section className="flex flex-col gap-4">
        <h3 className="font-display text-2xl">Day by day</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          No day is planned beyond {maxSightseeingHours} hours of sightseeing, so there is always
          time to eat, travel between sites and rest.
        </p>
        <ol className="flex flex-col gap-3">
          {quote.days.map((day) => {
            const full = day.budgetHours > 0 && day.activeHours >= day.budgetHours - 0.05;
            return (
            <li
              key={day.dayNumber}
              className="rounded-xl border p-4"
              style={{ borderColor: "var(--hairline)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  Day {day.dayNumber} · {day.placeName}
                </span>
                <span
                  className="text-xs tabular-nums"
                  style={{ color: full ? "var(--accent)" : "var(--muted)" }}
                >
                  {day.date} · {day.activeHours}h of {day.budgetHours}h
                  {full ? " · full" : ""}
                </span>
              </div>

              {day.notes.length > 0 && (
                <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                  {day.notes.join(" · ")}
                </p>
              )}

              {day.activities.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2">
                  {day.activities.map((a) => {
                    const off = a.clusterId ? excludedClusters.has(a.clusterId) : false;
                    return (
                      <li key={`${day.dayNumber}-${a.clusterId ?? a.title}`} className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={!off}
                          disabled={a.locked || !a.clusterId}
                          onChange={() => a.clusterId && toggleCluster(a.clusterId)}
                          aria-label={`Include ${a.title}`}
                        />
                        <div className="flex-1">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className={off ? "line-through opacity-50" : ""}>{a.title}</span>
                            <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                              {a.hours}h
                              {a.pricePerPersonInr > 0 && ` · ${formatInr(a.pricePerPersonInr)} pp`}
                            </span>
                          </div>
                          {a.attractions.length > 0 && (
                            <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
                              {a.attractions.slice(0, 4).join(" · ")}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
            );
          })}
        </ol>
      </section>

      {/* ---- suggestions ---- */}
      {quote.suggestions.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-display text-2xl">You could also add</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {quote.suggestions.map((s) => {
              const pinned = s.clusterId ? request.pinnedClusterIds.includes(s.clusterId) : false;
              return (
                <button
                  key={s.clusterId ?? s.title}
                  type="button"
                  onClick={() => s.clusterId && (pinned ? toggleCluster(s.clusterId) : addCluster(s.clusterId))}
                  aria-pressed={pinned}
                  className="rounded-xl border p-4 text-left transition hover:opacity-80"
                  style={
                    pinned
                      ? { borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)" }
                      : { borderColor: "var(--hairline)" }
                  }
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{s.title}</span>
                    <span className="text-xs tabular-nums" style={{ color: "var(--accent)" }}>
                      +{formatInr(s.pricePerPersonInr)} pp
                    </span>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    {s.hours}h · {s.attractions.slice(0, 3).join(" · ")}
                  </p>
                  {pinned && (
                    <p className="mt-1 text-xs" style={{ color: "var(--accent)" }}>
                      Requested — no room yet. Add a night to fit it in.
                    </p>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            A day holds at most {maxSightseeingHours} hours of sightseeing, so adding one of these
            may need an extra night in that destination.
          </p>
        </section>
      )}

      {/* ---- price breakdown ---- */}
      <section className="flex flex-col gap-4">
        <h3 className="font-display text-2xl">What you are paying for</h3>
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--hairline)" }}>
          {grouped.map(([component, items]) => {
            const optional = OPTIONAL_COMPONENTS[component];
            const requestKey = optional?.requestKey;
            const isOn = requestKey ? Boolean(request[requestKey]) : items.length > 0;
            // Structural components are locked by the pricing engine; anything
            // the traveller can drop is flagged optional so the two are never
            // confused on the bill.
            const included = !optional && items.every((i) => i.locked);
            const baseTotal = items.reduce((s, i) => s + i.totalInr, 0);
            const displayTotal = baseTotal + (markupAllocation.get(component) ?? 0);
            const isFlight = component === "flight";
            return (
              <div
                key={component}
                className="flex flex-wrap items-center justify-between gap-3 border-b p-4 last:border-b-0"
                style={{ borderColor: "var(--hairline)" }}
              >
                <span className="font-medium">
                  {COMPONENT_LABEL[component] ?? component}
                  <span
                    className="ml-2 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide"
                    style={
                      included
                        ? { background: "var(--hairline)", color: "var(--muted)" }
                        : {
                            background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                            color: "var(--accent)",
                          }
                    }
                  >
                    {included ? "Included" : "Optional"}
                  </span>
                  {optional && !isOn && (
                    <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
                      not in this quote
                    </span>
                  )}
                  {isFlight && (
                    <button
                      type="button"
                      onClick={() => setShowFlightNote((v) => !v)}
                      aria-expanded={showFlightNote}
                      className="ml-2 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide"
                      style={{ borderColor: "var(--hairline)", color: "var(--muted)" }}
                    >
                      Approximation
                    </button>
                  )}
                  {isFlight && showFlightNote && (
                    <p className="mt-1 max-w-sm text-xs font-normal normal-case" style={{ color: "var(--muted)" }}>
                      The flight price is an approximation. The actual price will be provided on
                      request confirmation.
                    </p>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  {requestKey && (
                    <button
                      type="button"
                      onClick={() => onChange({ ...request, [requestKey]: !isOn })}
                      className="rounded-full border px-3 py-1 text-xs font-medium"
                      style={{
                        borderColor: isOn ? "var(--hairline)" : "var(--accent)",
                        color: isOn ? "var(--muted)" : "var(--accent)",
                      }}
                    >
                      {isOn ? "Remove" : "Add"}
                    </button>
                  )}
                  <span className="tabular-nums">{formatInr(displayTotal)}</span>
                </span>
              </div>
            );
          })}
        </div>

        <dl className="ml-auto flex w-full max-w-sm flex-col gap-1 text-sm">
          {(
            [
              ["Direct cost", quote.totals.costBeforeMarkup + quote.totals.agentMarkup],
              ["GST", quote.totals.salesVat],
            ] as const
          ).map(([label, amount]) =>
            amount > 0 ? (
              <div key={label} className="flex justify-between">
                <dt style={{ color: "var(--muted)" }}>{label}</dt>
                <dd className="tabular-nums">{formatInr(amount)}</dd>
              </div>
            ) : null,
          )}
          <div
            className="mt-2 flex justify-between border-t pt-2 text-lg"
            style={{ borderColor: "var(--hairline)" }}
          >
            <dt>Total</dt>
            <dd className="tabular-nums" style={{ color: "var(--accent)" }}>
              {formatInr(quote.totals.total)}
            </dd>
          </div>
        </dl>
      </section>

      <button
        type="button"
        onClick={onBack}
        className="self-start rounded-full border px-6 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        Change my choices
      </button>
    </div>
  );
}
