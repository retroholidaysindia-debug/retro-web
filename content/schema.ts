import { z } from "zod";

// A package offer — what the traveller buys.
export const OfferSchema = z.object({
  days: z.number().int().positive().optional(),
  // The published "from" price, per person. Despite the legacy `_usd` name
  // this is INR — see scripts/etl/sync-content.ts, which writes it from the
  // master catalogue's `priceFromInr`.
  price_from_usd: z.number().positive().optional(),
  // Whether that price already covers airfare. The master catalogue publishes
  // land-only prices with the flight quoted on top, so this is false
  // throughout today; kept explicit so a page never implies an all-in figure
  // it cannot honour. Optional for backwards compatibility with hand-authored
  // files that predate the flag — treat a missing value as "flight extra".
  price_includes_flight: z.boolean().optional(),
  summary: z.string().optional(),
  highlights: z.array(z.string()).optional(),
});

// A named group of places within a destination (e.g. "North India").
// Markers reference groups by id. Clicking a marker shows the group offer.
export const GroupSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  // The real, sellable package this group represents (e.g. "Europe at a
  // Glance") — distinct from `name`, which is often just the country/state
  // cluster label used for card/filter-chip text. packageSlug is what
  // package detail pages and package-image lookups key off of.
  packageName: z.string().min(1),
  packageSlug: z.string().regex(/^[a-z0-9-]+$/),
  // Every place this package covers (from the source dataset's own
  // per-country places list) — independent of which places actually get a
  // map marker, since some destinations cap markers-per-group for map
  // legibility/size (see scripts/build-maps).
  places: z.array(z.string().min(1)).min(1),
  tagline: z.string().optional(),
  offer: OfferSchema.optional(),
});

// A single pin on the map.
export const MarkerSchema = z.object({
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  type: z.enum(["city", "poi"]),
  subtype: z.string().optional(),
  image: z.string().optional(),
  // When set, the click/hover offer comes from the matching group, not this marker.
  group: z.number().int().positive().optional(),
  // Per-place offer (used only when marker has no group).
  offer: OfferSchema.optional(),
});

// Describes what geographic shape to draw on the map.
// - country: one or more whole countries (ISO-3166-1 alpha-3)
// - state:   one or more admin1 regions inside a single country
// - region:  a group of countries shown together (e.g. Nordic)
// - city:    city-scale area (future use — not yet implemented in map builder)
export const MapAreaSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("country"),
    countries: z.array(z.string().length(3)).min(1),
    pov_country: z.string().length(3).optional(),
  }),
  z.object({
    type: z.literal("state"),
    country: z.string().length(3),
    admin1_names: z.array(z.string()).min(1),
    show_context: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("region"),
    countries: z.array(z.string().length(3)).min(2),
  }),
  z.object({
    type: z.literal("city"),
    country: z.string().length(3),
    city: z.string(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radius_km: z.number().positive().optional(),
  }),
]);

export const DestinationSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  region: z.string().min(1),
  tagline: z.string().min(1).max(80),
  headline: z.string().min(1).max(120),
  rating: z.number().min(0).max(5),
  palette: z.object({
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    deep: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }),
  media: z.object({
    clip: z.string().min(1),
    poster: z.string().min(1),
  }),
  // Named trip groups — markers reference these by id.
  groups: z.array(GroupSchema).optional(),
  // When present, drives what geographic shape the map shows.
  map_area: MapAreaSchema.optional(),
  map: z.object({
    countries: z.array(z.string().length(3)).min(1),
    povCountry: z.string().length(3).optional(),
    highlight: z.object({
      admin1: z.array(z.string()).optional(),
    }).optional(),
    markers: z.array(MarkerSchema).min(1),
  }),
});

export type Offer = z.infer<typeof OfferSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type MapArea = z.infer<typeof MapAreaSchema>;
export type Destination = z.infer<typeof DestinationSchema>;

// ---------------------------------------------------------------------------
// Hero card catalogue (content/hero-cards.json) — every possible country/state
// card the landing-page hero can show for each region. At runtime exactly one
// card per region is picked at random (see lib/hero-cards.ts); this schema
// just validates the full catalogue of possibilities.
// ---------------------------------------------------------------------------

export const HeroCardOptionSchema = z.object({
  country: z.string().min(1),
  placeSlug: z.string().regex(/^[a-z0-9-]+$/),
  packageSlug: z.string().regex(/^[a-z0-9-]+$/),
  headline: z.string().min(1),
  tagline: z.string().min(1),
  buttonLabel: z.string().min(1),
  media: z.object({
    clip: z.string().min(1),
    poster: z.string().min(1),
  }),
});

export const HeroCardRegionSchema = z.object({
  region: z.string().min(1),
  destinationSlug: z.string().regex(/^[a-z0-9-]+$/),
  destinationName: z.string().min(1),
  rating: z.number().min(0).max(5),
  palette: z.object({
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    deep: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }),
  cards: z.array(HeroCardOptionSchema).min(1),
});

export const HeroCardsFileSchema = z.object({
  regions: z.array(HeroCardRegionSchema).min(1),
});

export type HeroCardOption = z.infer<typeof HeroCardOptionSchema>;
export type HeroCardRegion = z.infer<typeof HeroCardRegionSchema>;

// ---------------------------------------------------------------------------
// Package image gallery config (content/package-images.json) — maps each
// package (keyed "{destinationSlug}/{packageSlug}") to a gallery of image
// URLs. Packages without an explicit entry fall back to a deterministic
// rotation of `defaultImages` (see lib/package-images.ts) so every package
// page still gets a gallery even before real photography exists.
// ---------------------------------------------------------------------------

export const PackageImagesConfigSchema = z.object({
  defaultImages: z.array(z.string().min(1)).min(1),
  overrides: z.record(z.string(), z.array(z.string().min(1)).min(1)),
});

export type PackageImagesConfig = z.infer<typeof PackageImagesConfigSchema>;
