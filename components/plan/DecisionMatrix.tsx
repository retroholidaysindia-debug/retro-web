"use client";

/**
 * The decision matrix.
 *
 * Every control is a bounded choice — buttons, selects and steppers. There is
 * no free-text input anywhere, which is a hard requirement: the engine can only
 * price options it has data for.
 */
import { useEffect, useMemo, useState } from "react";
import type { CoreBundle, HotelStar, TravellerType, TripStyle } from "@/lib/atlas/schema";
import type { QuoteRequest } from "@/lib/atlas/engine/types";
import { STYLE_FOR_TRAVELLER } from "@/lib/atlas/engine";
import { computeNightsBounds, hotelStarForStyle, isHotelStarAvailable } from "@/lib/atlas/engine/bounds";
import { onAccent, selectStyle } from "./theme";

/** Pace nudged by trip style — pilgrimage itineraries plan gentler days by default. */
const PACE_FOR_STYLE: Partial<Record<TripStyle, QuoteRequest["pace"]>> = {
  pilgrimage: "relaxed",
};

const HOTEL_STARS: { value: HotelStar; label: string }[] = [
  { value: "3 Star", label: "3 Star" },
  { value: "4 Star", label: "4 Star" },
  { value: "5 Star", label: "5 Star" },
  { value: "Luxury 5 Star", label: "Luxury 5" },
];

const TRAVELLER_TYPES: { value: TravellerType; label: string; hint: string }[] = [
  { value: "family", label: "Family", hint: "Adults with children" },
  { value: "couple", label: "Couple", hint: "Two travelling together" },
  { value: "friends", label: "Friends", hint: "A group travelling together" },
  { value: "stags", label: "Stags", hint: "Stag or hen party" },
  { value: "business", label: "Business", hint: "Work travel with leisure time" },
  { value: "pilgrimage", label: "Pilgrimage", hint: "Faith-led itinerary, gentler pace" },
  { value: "solo", label: "Solo", hint: "Travelling alone" },
];

const TRIP_STYLES: { value: TripStyle; label: string }[] = [
  { value: "family", label: "Family" },
  { value: "romantic", label: "Romantic" },
  { value: "honeymoon", label: "Honeymoon" },
  { value: "luxury", label: "Luxury" },
  { value: "adventure", label: "Adventure" },
  { value: "culture", label: "Culture" },
  { value: "budget", label: "Budget" },
  { value: "pilgrimage", label: "Pilgrimage" },
];

const NATIONALITIES: { value: string; label: string }[] = [
  { value: "IND", label: "India" }, { value: "USA", label: "United States" },
  { value: "GBR", label: "United Kingdom" }, { value: "ARE", label: "UAE" },
  { value: "CAN", label: "Canada" }, { value: "AUS", label: "Australia" },
  { value: "SGP", label: "Singapore" }, { value: "DEU", label: "Germany" },
  { value: "FRA", label: "France" }, { value: "NLD", label: "Netherlands" },
  { value: "CHE", label: "Switzerland" }, { value: "ZAF", label: "South Africa" },
  { value: "MYS", label: "Malaysia" }, { value: "NPL", label: "Nepal" },
  { value: "LKA", label: "Sri Lanka" }, { value: "BGD", label: "Bangladesh" },
  { value: "QAT", label: "Qatar" }, { value: "SAU", label: "Saudi Arabia" },
  { value: "KWT", label: "Kuwait" }, { value: "OMN", label: "Oman" },
];

const DEPARTURE_CITIES: { value: string; label: string }[] = [
  { value: "DEL", label: "Delhi" }, { value: "BOM", label: "Mumbai" },
  { value: "MAA", label: "Chennai" }, { value: "BLR", label: "Bengaluru" },
  { value: "HYD", label: "Hyderabad" }, { value: "CCU", label: "Kolkata" },
  { value: "COK", label: "Kochi" }, { value: "AMD", label: "Ahmedabad" },
  { value: "PNQ", label: "Pune" }, { value: "GOI", label: "Goa" },
];

const CHILD_AGES = Array.from({ length: 18 }, (_, i) => i);

type Props = {
  core: CoreBundle;
  value: QuoteRequest;
  /**
   * Accepts an updater as well as a plain request. Several fields are derived
   * from others (style from traveller, hotel and length from style), so more
   * than one effect can need to patch the request in the same commit. Spreading
   * a captured `value` in each would let the last writer silently undo the
   * rest; composing from the live request cannot.
   */
  onChange: (next: QuoteRequest | ((current: QuoteRequest) => QuoteRequest)) => void;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="text-sm font-medium">{label}</span>
        {hint && (
          <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ChipGroup<T extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className="rounded-full border px-4 py-1.5 text-sm transition"
          style={{
            borderColor: o.value === value ? "var(--accent)" : "var(--hairline)",
            background: o.value === value ? "var(--accent)" : "transparent",
            color: o.value === value ? onAccent : "inherit",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({
  label, value, min, max, onChange,
}: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="h-9 w-9 rounded-full border text-lg disabled:opacity-30"
        style={{ borderColor: "var(--hairline)" }}
      >
        −
      </button>
      <span className="min-w-8 text-center tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="h-9 w-9 rounded-full border text-lg disabled:opacity-30"
        style={{ borderColor: "var(--hairline)" }}
      >
        +
      </button>
    </div>
  );
}

export function DecisionMatrix({ core, value, onChange }: Props) {
  const set = <K extends keyof QuoteRequest>(key: K, v: QuoteRequest[K]) =>
    onChange((r) => ({ ...r, [key]: v }));

  // Trip style follows the traveller type unless the traveller overrides it.
  useEffect(() => {
    onChange((r) => {
      const suggested = STYLE_FOR_TRAVELLER[r.travellerType];
      return suggested && r.tripStyle !== suggested ? { ...r, tripStyle: suggested } : r;
    });
    // Intentionally keyed only on traveller type: re-running on tripStyle would
    // undo a deliberate override.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.travellerType]);

  // Children only make sense for a "family" trip — every other traveller type
  // travels without kids in this taxonomy, so clear any stale ages rather than
  // silently pricing a couple's trip as if children were coming.
  useEffect(() => {
    onChange((r) =>
      r.travellerType !== "family" && r.childAges.length > 0 ? { ...r, childAges: [] } : r,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.travellerType]);

  // Hotel category and pace are suggested from trip style, exactly like trip
  // style is suggested from traveller type — a starting point, not a lock.
  // Tracking whether the current value was our own suggestion (rather than a
  // deliberate pick) lets the traveller override it without it snapping back
  // the next time they nudge some other field.
  const [autoHotelStar, setAutoHotelStar] = useState(true);
  const [autoPace, setAutoPace] = useState(true);

  // Everything that follows from who is travelling and how, applied as one
  // patch composed from the live request. Kept together deliberately: these
  // all fire on the same change, and as separate effects each spreading its
  // own captured snapshot they used to overwrite each other — which is how a
  // trip could leave the luxury style still holding a Luxury 5 Star hotel that
  // was no longer even on offer.
  useEffect(() => {
    onChange((r) => {
      const patch: Partial<QuoteRequest> = {};

      // A category the style does not permit is a rule, not a preference, so
      // it is corrected even when the traveller chose it by hand.
      if (!isHotelStarAvailable(r.tripStyle, r.hotelStar)) {
        patch.hotelStar = hotelStarForStyle(r.tripStyle);
      } else if (autoHotelStar) {
        const suggested = hotelStarForStyle(r.tripStyle);
        if (r.hotelStar !== suggested) patch.hotelStar = suggested;
      }

      if (autoPace) {
        const suggested = PACE_FOR_STYLE[r.tripStyle] ?? "balanced";
        if (r.pace !== suggested) patch.pace = suggested;
      }

      // Who is travelling changes how long the same destinations take, so the
      // suggested length moves with it rather than leaving a family and a stag
      // party both sitting on whatever number happened to be there before.
      if (r.placeIds.length) {
        const { recommended } = computeNightsBounds(core, r.placeIds, {
          travellerType: r.travellerType,
          tripStyle: r.tripStyle,
        });
        if (r.nights !== recommended) patch.nights = recommended;
      }

      return Object.keys(patch).length ? { ...r, ...patch } : r;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.travellerType, value.tripStyle, autoHotelStar, autoPace, core]);

  // Low-cost carriers never sell a business cabin (the engine's own fare
  // generation skips that combination), so downgrade rather than offer a
  // choice that would silently fall back to something else.
  useEffect(() => {
    onChange((r) =>
      r.carrier === "LCC" && r.cabin === "Business" ? { ...r, cabin: "Economy" } : r,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.carrier]);

  const selectedPlaces = useMemo(
    () => core.places.filter((p) => value.placeIds.includes(p.id)),
    [core.places, value.placeIds],
  );

  const isFamily = value.travellerType === "family";
  // Who is travelling, and how, changes how long the same destinations take —
  // a family lingers, a stag party does not. Recomputed as those change so the
  // slider re-sizes live rather than only on the destinations.
  const nightsBounds = useMemo(
    () =>
      computeNightsBounds(core, value.placeIds, {
        travellerType: value.travellerType,
        tripStyle: value.tripStyle,
      }),
    [core, value.placeIds, value.travellerType, value.tripStyle],
  );
  const minNights = nightsBounds.min || 1;
  // Clamped into the *whole* realistic range, not just the floor — otherwise
  // the slider's visible thumb position and the "NN / DD" text beside it can
  // disagree when the request's stored nights sits above a tight max.
  const displayNights = Math.min(Math.max(minNights, value.nights), Math.max(nightsBounds.max, minNights));

  // Adding a destination, or switching to a profile with a tighter window, can
  // leave the stored length outside the new range. Display already clamps, but
  // the *request* is what gets priced, so write the clamped value back —
  // otherwise the quote silently bills a length the slider never showed.
  useEffect(() => {
    onChange((r) => {
      if (!r.placeIds.length) return r;
      const clamped = Math.min(Math.max(r.nights, nightsBounds.min), nightsBounds.max);
      return clamped === r.nights ? r : { ...r, nights: clamped };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightsBounds.min, nightsBounds.max]);

  const removePlace = (placeId: string) => {
    set("placeIds", value.placeIds.filter((id) => id !== placeId));
  };
  const cabinOptions = (
    [
      { value: "Economy" as const, label: "Economy" },
      { value: "Premium Economy" as const, label: "Premium economy" },
      { value: "Business" as const, label: "Business" },
    ]
  ).filter((o) => o.value !== "Business" || value.carrier !== "LCC");

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <Field label="Who is travelling?">
        <ChipGroup
          ariaLabel="Traveller type"
          options={TRAVELLER_TYPES}
          value={value.travellerType}
          onChange={(v) => set("travellerType", v)}
        />
      </Field>

      <Field label="Trip style" hint="Preselected from who is travelling — change it if you like">
        <ChipGroup
          ariaLabel="Trip style"
          options={TRIP_STYLES}
          value={value.tripStyle}
          onChange={(v) => set("tripStyle", v)}
        />
      </Field>

      <Field label="Adults" hint="12 years and over">
        <Stepper label="adults" value={value.adults} min={1} max={40} onChange={(v) => set("adults", v)} />
      </Field>

      <Field label="Children" hint={isFamily ? "We need each child's age" : "Only travelling with a family adds children"}>
        {isFamily ? (
          <div className="flex flex-col gap-3">
            <Stepper
              label="children"
              value={value.childAges.length}
              min={0}
              max={10}
              onChange={(count) => {
                const next = [...value.childAges];
                while (next.length < count) next.push(8);
                next.length = count;
                set("childAges", next);
              }}
            />
            {value.childAges.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {value.childAges.map((age, i) => (
                  <label key={i} className="flex items-center gap-1 text-xs">
                    <span style={{ color: "var(--muted)" }}>Child {i + 1}</span>
                    <select
                      aria-label={`Age of child ${i + 1}`}
                      value={age}
                      onChange={(e) => {
                        const next = [...value.childAges];
                        next[i] = Number(e.target.value);
                        set("childAges", next);
                      }}
                      className="rounded-lg border px-2 py-1"
                      style={selectStyle}
                    >
                      {CHILD_AGES.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            —
          </p>
        )}
      </Field>


      <Field label="Departure date">
        <input
          type="date"
          value={value.startDate}
          onChange={(e) => set("startDate", e.target.value)}
          className="rounded-lg border p-3"
          style={selectStyle}
        />
      </Field>

      <Field
        label="Your destinations"
        hint={selectedPlaces.length ? "Deselect a place if you've changed your mind" : undefined}
      >
        {selectedPlaces.length ? (
          <div className="flex flex-wrap gap-2">
            {selectedPlaces.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => removePlace(p.id)}
                className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition hover:opacity-80"
                style={{ borderColor: "var(--hairline)" }}
                aria-label={`Remove ${p.name}`}
              >
                {p.name}
                <span aria-hidden style={{ color: "var(--muted)" }}>×</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No destinations selected.
          </p>
        )}
      </Field>

      <Field
        label="Nights"
        hint={`${nightsBounds.min}-${nightsBounds.max} realistic for ${selectedPlaces.length} destination(s) · ${nightsBounds.recommended} recommended`}
      >
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={nightsBounds.min || 1}
            max={Math.max(nightsBounds.max, nightsBounds.min, 1)}
            value={displayNights}
            onChange={(e) => set("nights", Number(e.target.value))}
            className="flex-1"
            aria-label="Number of nights"
          />
          <span className="tabular-nums" aria-live="polite">
            {displayNights}N / {displayNights + 1}D
          </span>
        </div>
        {nightsBounds.profileNote && (
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {nightsBounds.profileNote}
          </p>
        )}
      </Field>

      <Field label="Departing from">
        <select
          value={value.departureCity}
          onChange={(e) => set("departureCity", e.target.value)}
          className="rounded-lg border p-3"
          style={selectStyle}
          aria-label="Departure city"
        >
          {DEPARTURE_CITIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label} ({c.value})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Passport / nationality" hint="Determines visa requirement and fee">
        <select
          value={value.nationality}
          onChange={(e) => set("nationality", e.target.value)}
          className="rounded-lg border p-3"
          style={selectStyle}
          aria-label="Nationality"
        >
          {NATIONALITIES.map((n) => (
            <option key={n.value} value={n.value}>
              {n.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Hotel category"
        hint={
          value.tripStyle === "luxury"
            ? "Set by your trip style — Luxury 5 is only offered on a luxury trip"
            : autoHotelStar
              ? "Set by your trip style — pick another if you prefer"
              : undefined
        }
      >
        <ChipGroup
          ariaLabel="Hotel category"
          // Luxury 5 Star is not merely un-suggested off a luxury trip, it is
          // not offered at all — it carries the higher agent markup and should
          // never be reachable from a budget or pilgrimage itinerary.
          options={HOTEL_STARS.filter((o) => isHotelStarAvailable(value.tripStyle, o.value))}
          value={value.hotelStar}
          onChange={(v) => {
            setAutoHotelStar(false);
            set("hotelStar", v);
          }}
        />
      </Field>

      <Field label="Hotel location">
        <ChipGroup
          ariaLabel="Hotel location"
          options={[
            { value: "Central" as const, label: "City centre" },
            { value: "Outskirts" as const, label: "Outskirts" },
          ]}
          value={value.hotelZone}
          onChange={(v) => set("hotelZone", v)}
        />
      </Field>

      <Field label="Flight preference">
        <ChipGroup
          ariaLabel="Carrier type"
          options={[
            { value: "LCC" as const, label: "Low-cost carrier" },
            { value: "FSC" as const, label: "Full-service carrier" },
          ]}
          value={value.carrier}
          onChange={(v) => set("carrier", v)}
        />
      </Field>

      <Field
        label="Cabin"
        hint={value.carrier === "LCC" ? "Low-cost carriers don't offer a business cabin" : undefined}
      >
        <ChipGroup
          ariaLabel="Cabin"
          options={cabinOptions}
          value={value.cabin}
          onChange={(v) => set("cabin", v)}
        />
      </Field>

      <Field label="Meals" hint="Breakfast is always included with the room">
        <ChipGroup
          ariaLabel="Meal plan"
          options={[
            { value: "breakfast" as const, label: "Breakfast only" },
            { value: "half-board" as const, label: "Half board" },
            { value: "full-board" as const, label: "Full board" },
          ]}
          value={value.mealPlan}
          onChange={(v) => set("mealPlan", v)}
        />
      </Field>

      <Field label="Dietary preference">
        <ChipGroup
          ariaLabel="Dietary preference"
          options={[
            { value: "no-preference" as const, label: "No preference" },
            { value: "veg" as const, label: "Vegetarian" },
            { value: "non-veg" as const, label: "Non-vegetarian" },
            { value: "vegan" as const, label: "Vegan" },
            { value: "jain" as const, label: "Jain" },
            { value: "halal" as const, label: "Halal" },
          ]}
          value={value.food}
          onChange={(v) => set("food", v)}
        />
      </Field>

      <Field
        label="Pace"
        hint={
          autoPace && value.tripStyle === "pilgrimage"
            ? "Suggested gentler pace for a pilgrimage trip — everyone gets at least 10 hours of rest a day"
            : "Everyone gets at least 10 hours of rest a day"
        }
      >
        <ChipGroup
          ariaLabel="Pace"
          options={[
            { value: "relaxed" as const, label: "Relaxed" },
            { value: "balanced" as const, label: "Balanced" },
            { value: "packed" as const, label: "Packed" },
          ]}
          value={value.pace}
          onChange={(v) => {
            setAutoPace(false);
            set("pace", v);
          }}
        />
      </Field>

      <Field
        label="Getting between destinations"
        hint={
          value.transportPreference === "cheapest"
            ? "Cheapest fare, even if the journey is long — expect overnight buses and slow trains"
            : value.transportPreference === "fastest"
              ? "Shortest journey, even if it costs more — expect flights on the longer hops"
              : "A sensible balance of fare and journey time"
        }
      >
        <ChipGroup
          ariaLabel="Transport preference"
          options={[
            { value: "cheapest" as const, label: "Cheapest" },
            { value: "balanced" as const, label: "Balanced" },
            { value: "fastest" as const, label: "Fastest" },
          ]}
          value={value.transportPreference}
          onChange={(v) => onChange({ ...value, transportPreference: v, legModes: {} })}
        />
      </Field>

      <Field label="Include in the quote">
        <div className="flex flex-col gap-2 text-sm">
          {(
            [
              ["includeFlight", "Return flights"],
              ["includeVisa", "Visa support"],
              ["includeInsurance", "Travel insurance"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(e) => set(key, e.target.checked)}
              />
              {label}
            </label>
          ))}
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Airport, sightseeing and intercity transfers are part of the land package and are
            always included. Travel insurance is priced from a typical daily rate pending the
            agency&apos;s own provider figures — untick it and the quote will clearly show it as
            excluded.
          </p>
        </div>
      </Field>
    </div>
  );
}
