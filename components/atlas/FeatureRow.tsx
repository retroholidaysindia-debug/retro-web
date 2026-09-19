import type { ReactNode } from "react";

type Feature = { label: string; description: string; icon: ReactNode };

const S = { fill: "none", stroke: "var(--accent)", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const FEATURES: Feature[] = [
  {
    label: "Best Price Guarantee",
    description: "We match or beat any comparable quote",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" {...S}>
        <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    label: "24/7 Travel Support",
    description: "Real people to call, wherever you are",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" {...S}>
        <path d="M4 13a8 8 0 0116 0" />
        <rect x="3" y="13" width="4" height="6" rx="1.5" />
        <rect x="17" y="13" width="4" height="6" rx="1.5" />
        <path d="M19 19a4 4 0 01-4 3h-2" />
      </svg>
    ),
  },
  {
    label: "Flexible Bookings",
    description: "Free date changes up to 30 days out",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" {...S}>
        <rect x="4" y="5" width="16" height="16" rx="2.5" />
        <path d="M4 10h16M8 3v4M16 3v4" />
        <path d="M9 15l2 2 4-4" />
      </svg>
    ),
  },
  {
    label: "Secure Payments",
    description: "Encrypted checkout, every single time",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" {...S}>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 018 0v3" />
      </svg>
    ),
  },
];

export function FeatureRow() {
  return (
    <div className="grid grid-cols-1 gap-y-8 sm:grid-cols-2 sm:gap-x-8 lg:grid-cols-4">
      {FEATURES.map((f) => (
        <div key={f.label} className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
            style={{ background: "rgba(253,191,0,0.12)" }}
          >
            {f.icon}
          </span>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {f.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              {f.description}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
