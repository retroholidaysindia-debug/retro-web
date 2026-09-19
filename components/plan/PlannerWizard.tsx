"use client";

/**
 * The planner flow: choose where, choose how, see the quote.
 *
 * All three steps run client-side against the compiled bundles, so the
 * quotation recomputes instantly as the traveller adjusts anything and the site
 * stays a pure static export.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { WorldMapPicker } from "./WorldMapPicker";
import { DecisionMatrix } from "./DecisionMatrix";
import { QuotationView } from "./QuotationView";
import { ExplorePicker } from "./ExplorePicker";
import { PackageBrowseRail } from "./PackageBrowseRail";
import { onAccent } from "./theme";
import { loadCore, loadDestinations, loadRoutes, loadVisaRules } from "@/lib/atlas/client";
import { generateQuotation, STYLE_FOR_TRAVELLER } from "@/lib/atlas/engine";
import type { CoreBundle, DestinationBundle, Route, VisaRule } from "@/lib/atlas/schema";
import type { Quotation, QuoteRequest } from "@/lib/atlas/engine/types";

type Step = "mode" | "where" | "options" | "quote";
type Mode = "known" | "explore";

function defaultRequest(): QuoteRequest {
  const start = new Date();
  start.setDate(start.getDate() + 45);
  return {
    placeIds: [],
    nights: 6,
    startDate: start.toISOString().slice(0, 10),
    adults: 2,
    childAges: [],
    travellerType: "couple",
    tripStyle: STYLE_FOR_TRAVELLER.couple,
    nationality: "IND",
    departureCity: "DEL",
    hotelStar: "4 Star",
    hotelZone: "Central",
    carrier: "FSC",
    cabin: "Economy",
    mealPlan: "breakfast",
    food: "no-preference",
    pace: "balanced",
    includeVisa: true,
    includeInsurance: false,
    includeFlight: false,
    // No interests stated yet: the destinations' own decision rules that turn
    // on one stay undecided rather than being guessed at.
    interests: [],
    firstTimeVisitor: true,
    transportPreference: "balanced",
    legModes: {},
    excludedActivityCodes: [],
    excludedClusterIds: [],
    addedActivityCodes: [],
    pinnedClusterIds: [],
    nightOverrides: {},
  };
}

export function PlannerWizard() {
  const [step, setStep] = useState<Step>("mode");
  const [mode, setMode] = useState<Mode>("known");
  const [request, setRequest] = useState<QuoteRequest>(defaultRequest);

  const [core, setCore] = useState<CoreBundle | null>(null);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [visaRules, setVisaRules] = useState<VisaRule[] | null>(null);
  const [bundles, setBundles] = useState<Map<string, DestinationBundle>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadCore(), loadRoutes(), loadVisaRules()])
      .then(([c, r, v]) => {
        setCore(c);
        setRoutes(r);
        setVisaRules(v);
      })
      .catch(() => setError("Could not load the destination catalogue. Please refresh."));
  }, []);

  // Fetch content only for the places actually chosen.
  useEffect(() => {
    if (!core || !request.placeIds.length) return;
    const slugs = request.placeIds
      .map((id) => core.places.find((p) => p.id === id)?.slug)
      .filter((s): s is string => Boolean(s));
    loadDestinations(slugs).then(setBundles);
  }, [core, request.placeIds]);

  const quote: Quotation | null = useMemo(() => {
    if (!core || !routes || !visaRules || !request.placeIds.length) return null;
    if (step !== "quote") return null;
    try {
      return generateQuotation(request, { core, routes, visaRules, bundles });
    } catch {
      return null;
    }
  }, [core, routes, visaRules, bundles, request, step]);

  const setPlaces = useCallback((placeIds: string[] | ((current: string[]) => string[])) => {
    // Changing the destinations invalidates any per-place night override, and
    // any transport mode the traveller had pinned to a leg that may no longer
    // exist. Resolved against the live state rather than a captured array so a
    // fast burst of map clicks can't overwrite one another.
    setRequest((r) => ({
      ...r,
      placeIds: typeof placeIds === "function" ? placeIds(r.placeIds) : placeIds,
      nightOverrides: {},
      legModes: {},
    }));
  }, []);

  if (error) {
    return (
      <GlassPanel className="p-6">
        <p>{error}</p>
      </GlassPanel>
    );
  }

  if (!core) {
    return (
      <p className="p-6" style={{ color: "var(--muted)" }}>
        Loading the atlas…
      </p>
    );
  }

  const canContinue = request.placeIds.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <Progress step={step} />

      {step === "mode" && (
        <section className="flex flex-col gap-10">
          <div className="flex flex-col gap-6">
            <h1 className="font-display text-4xl">Where shall we take you?</h1>
            <div className="grid gap-5 md:grid-cols-2">
              <ModeCard
                icon={<MapPinIcon />}
                title="I know where I want to go"
                body="Pick your destinations on the map and we will build the itinerary and the price around them."
                onClick={() => {
                  setMode("known");
                  setStep("where");
                }}
              />
              <ModeCard
                icon={<CompassIcon />}
                title="I want to explore"
                body="Tell us the kind of trip you are after and we will suggest destinations that suit it."
                onClick={() => {
                  setMode("explore");
                  setStep("where");
                }}
              />
            </div>
          </div>

          <PackageBrowseRail />
        </section>
      )}

      {step === "where" && (
        <section className="flex flex-col gap-6">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h1 className="font-display text-4xl">
              {mode === "known" ? "Choose your destinations" : "Find your trip"}
            </h1>
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              {request.placeIds.length} selected
            </span>
          </div>

          {mode === "known" ? (
            <WorldMapPicker core={core} selected={request.placeIds} onChange={setPlaces} />
          ) : (
            <ExplorePicker core={core} selected={request.placeIds} onChange={setPlaces} />
          )}

          {request.placeIds.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {request.placeIds.map((id) => {
                const place = core.places.find((p) => p.id === id);
                if (!place) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPlaces(request.placeIds.filter((x) => x !== id))}
                    className="rounded-full px-3 py-1 text-xs"
                    style={{ background: "var(--accent)", color: onAccent }}
                    aria-label={`Remove ${place.name}`}
                  >
                    {place.name} ×
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep("mode")}
              className="rounded-full border px-6 py-2"
              style={{ borderColor: "var(--hairline)" }}
            >
              Back
            </button>
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => setStep("options")}
              className="rounded-full px-6 py-2 disabled:opacity-40"
              style={{ background: "var(--accent)", color: onAccent }}
            >
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "options" && (
        <section className="flex flex-col gap-8">
          <h1 className="font-display text-4xl">Tell us about the trip</h1>
          <DecisionMatrix core={core} value={request} onChange={setRequest} />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep("where")}
              className="rounded-full border px-6 py-2"
              style={{ borderColor: "var(--hairline)" }}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep("quote")}
              className="rounded-full px-6 py-2"
              style={{ background: "var(--accent)", color: onAccent }}
            >
              Build my quotation
            </button>
          </div>
        </section>
      )}

      {step === "quote" &&
        (quote ? (
          <QuotationView
            quote={quote}
            request={request}
            onChange={setRequest}
            onBack={() => setStep("options")}
          />
        ) : (
          <p style={{ color: "var(--muted)" }}>Building your quotation…</p>
        ))}
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  const steps: [Step, string][] = [
    ["where", "Destinations"],
    ["options", "Your trip"],
    ["quote", "Quotation"],
  ];
  const activeIndex = steps.findIndex(([s]) => s === step);
  return (
    <ol className="flex flex-wrap gap-4 text-xs uppercase tracking-wide">
      {steps.map(([s, label], i) => (
        <li
          key={s}
          style={{ color: i <= activeIndex ? "var(--accent)" : "var(--muted)" }}
          aria-current={s === step ? "step" : undefined}
        >
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function ModeCard({
  icon, title, body, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex min-h-56 flex-col justify-end overflow-hidden rounded-3xl border p-8 text-left transition-all duration-300 hover:-translate-y-1"
      style={{ borderColor: "var(--hairline)", background: "var(--surface)" }}
    >
      {/* Ambient accent glow behind the icon, on hover — purely decorative,
          gives the large empty card body somewhere for the eye to land. */}
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: "color-mix(in srgb, var(--accent) 35%, transparent)" }}
        aria-hidden="true"
      />
      <div
        className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl transition-transform duration-300 group-hover:scale-105"
        style={{ background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)" }}
        aria-hidden="true"
      >
        {icon}
      </div>
      <h2 className="font-display relative text-3xl">{title}</h2>
      <p className="relative mt-2 max-w-sm text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
        {body}
      </p>
      <span
        className="relative mt-5 inline-flex w-fit items-center gap-1.5 text-sm font-medium transition-transform duration-300 group-hover:translate-x-1"
        style={{ color: "var(--accent)" }}
      >
        Get started
        <span aria-hidden="true">→</span>
      </span>
    </button>
  );
}

/** A pin dropping onto a map — "I know where I want to go". */
function MapPinIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 21s-6.5-6.19-6.5-11A6.5 6.5 0 0 1 18.5 10c0 4.81-6.5 11-6.5 11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.4" fill="currentColor" />
    </svg>
  );
}

/** A compass — "I want to explore". */
function CompassIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M15.5 8.5 13 13l-4.5 2.5L11 11l4.5-2.5Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
