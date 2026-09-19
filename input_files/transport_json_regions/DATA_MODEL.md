# Travel Dataset — Developer Data Model

This dataset has **three layers**. Read this document top to bottom before building against them.

```
travel_agency_dataset_final.json   →  WHAT exists   (places + packages, by region/state)
<region>_transport.json  (×10)      →  HOW you travel (routes, modes, fares, terminals)
index.json                          →  MANIFEST      (which files exist + route counts)
```

The **join key across all three is the place-name string.** A place in the master must match an `origin`/`destination` string in a transport file for the two to link. There are no numeric IDs.

---

## Layer 1 — `travel_agency_dataset_final.json` (master catalogue)

### Purpose
The catalogue of destinations and pre-built packages. Answers *"what places and tours exist?"* Contains **no** transport, fares, or schedules.

### Structure
```
{
  "version": string,
  "description": string,
  "regions": [
    {
      "region":    string,            // "Africa", "South East Asia", "India", …
      "countries": [                  // for India, these are STATES (label still keyed "country")
        { "country": string,          // "Egypt", or a state like "Jharkhand"
          "places":  [ string, … ] }  // canonical place names — THE JOIN KEY
      ],
      "packages":  [ Package, … ]     // itineraries built from this region's places
    }
  ]
}
```

### Notes
- For the India region, the `country` field holds **state names** (Kerala, Goa, Jharkhand, …), not countries. Same field name, different meaning — by design.
- `places` strings are the identifiers everything else joins to. Treat them as canonical.

---

## Layer 2 — `<region>_transport.json` (transport layer, 10 files)

### Purpose
For each pair of places, which travel modes exist, rough cost, duration, and terminals. Answers *"how do you get from A to B and roughly what does it cost?"*

### Structure (identical across all 10 files)
```
{
  "transport": {
    "within_country":   { "route_count": int, "routes": [ Route, … ] },
    "between_countries": { "route_count": int, "routes": [ Route, … ] }
  }
}
```
- **within_country** routes: `origin`, `destination`, `country`.
- **between_countries** routes: `origin_country`, `destination_country` (occasionally city-level `origin`/`destination` too).

### Route object
```
{
  "origin": string, "destination": string, "country": string,
  "onsite_mode": string | null,
  "transport_options": { <mode>: ModeOption, … }
}
```
Routes are **directional** (A→B); a reverse B→A is a separate entry and may not always exist.

### ModeOption
```
// enabled
{ "enabled": true,
  "price_estimate": { "low": int, "high": int, "currency": "INR", "as_of": "YYYY-MM" },
  "duration_minutes": int | null,
  "terminals": { "from": …, "to": … }  |  { "border": … } }   // shape varies by mode

// disabled
{ "enabled": false, "price_estimate": null, "currency": null,
  "duration_minutes": null,
  "unavailable_reason": string }        // human-readable; good tooltip text
```

### Modes (normalised, all lowercase)
`bus, cruise, ferry, flight, private_vehicle, seaplane, shared_vehicle, train`
- Base set present widely: `flight, train, bus`. Road extras: `private_vehicle, shared_vehicle`.
- Sea/experience modes appear **only where relevant**: `ferry` (South Asia, East Asia, Europe, Oceania, SEA), `seaplane` (South Asia), `cruise` (Africa Nile, SEA Ha Long).
- **Enumerate modes by reading each route's `transport_options` keys — do not assume a fixed set per file.**

### `onsite_mode` — the exception concept
Some "routes" are really a **destination experience**, where the journey itself is the product (a cruise, a safari circuit, a trek). These carry an `onsite_mode` and usually have most transfer modes `false`. Render them as an activity, not a "pick your transport" choice.

Onsite modes in use, by region (live-extracted):
| Region | onsite_mode values |
|---|---|
| Africa | nile_cruise, safari, boat_tour, beach, guided_tour |
| Eurasia CIS | guided_tour |
| Russia | rail_journey, arctic_tour, guided_tour |
| South Asia | pilgrimage, safari, trekking |
| East Asia | guided_tour, overland_4x4, temple_stay, trekking |
| Europe | guided_tour |
| Middle East & Gulf | desert_resort, desert_safari, leisure, guided_tour |
| Oceania | wildlife_tour |
| South East Asia | cruise |
| India | hill_station, trekking, beach, guided_tour |

### Why `enabled:false` appears (geographic patterns)
`unavailable_reason` explains each; recurring categories:
- **Islands** — no bus/train (Andamans, Maldives, Greek isles, NZ Cook-Strait crossings): sea/air only.
- **No railway in country** — Bhutan, Oman, UAE, Jordan, Nepal, most Gulf: `train:false` broadly.
- **Not adjacent** — cross-border land modes false where no usable land border.
- **Distance impractical** — very long domestic pairs disable road (Trans-Siberian, Australia→Cairns).
- **Intra-city / attraction** — a "place" inside another city (Vatican in Rome, Kok Tobe in Almaty): all transfers false, onsite tagged.

---

## Layer 3 — `index.json` (manifest)

### Purpose
Entry point. Lists every region, its transport file, and expected route counts. Load this first; use the counts as a load-time integrity check.

### Structure
```
{
  "version": "1.1",
  "total_within_country_routes":  1344,
  "total_between_country_routes": 125,
  "regions": [
    { "region": string, "file": string,
      "within_country_routes": int, "between_country_routes": int }
  ]
}
```

### Current counts (v1.1, reconciled to actual files)
| Region | file | within | between |
|---|---|---|---|
| Africa | africa_transport.json | 47 | 10 |
| Eurasia CIS | eurasia_cis_transport.json | 25 | 12 |
| Russia | russia_transport.json | 62 | 0 |
| South Asia | south_asia_transport.json | 47 | 6 |
| East Asia | east_asia_transport.json | 86 | 15 |
| Europe | europe_transport.json | 86 | 45 |
| Middle East & Gulf | middle_east_gulf_transport.json | 61 | 6 |
| Oceania | oceania_transport.json | 31 | 3 |
| South East Asia | south_east_asia_transport.json | 107 | 28 |
| INDIA | india_transport.json | 792 | 0 |
| **Total** | | **1344** | **125** |

---

## System-wide caveats (read these)

1. **Prices are ESTIMATES, not quotes.** Every `price_estimate` is an indicative low–high band with an `as_of` month. Display as "from ~₹X"; never as a bookable fare. A `null` price means *not yet estimated* — distinct from `enabled:false` (mode unavailable).
2. **Durations are often `null`** where not confidently known. Absence ≠ instant.
3. **Counts are maintained manually.** Editing a transport file does not auto-update `index.json`. Assert `routes.length === index count` at load time; every past drift came from skipping that.
4. **Empty `between_countries` is valid** for Russia and India (0 routes, intentional after cleanup).
5. **Region casing is inconsistent** ("INDIA" vs "India"); join case-insensitively.
6. **Some places have no routes yet** — e.g. Bishkek (master, no transport routes). A place existing in the master does not guarantee transport data behind it.
7. **Non-standard source spellings** exist in place keys (`Phillipines`, `Kyrgisthan`, `Charwak` vs transport's `Charvak`, `Babal Shams`, `Europen`, `Edinburg`). Build a display-name normalisation table; do not surface raw keys, and normalise before joining master ↔ transport.
8. **All figures await live verification.** Fares, durations, and some mode flags are knowledge-based estimates, not confirmed against carriers/timetables. Treat as provisional until a verification pass is done.
