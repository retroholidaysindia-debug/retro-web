# `Pricing_Rules.xlsx` — Developer Reference

## What this file is
The **pricing engine** for the platform — the source of truth for rates, markups, and the quotation formula. The JSON files answer *"what places exist and how do you travel between them"*; this workbook answers *"what does a trip cost, and what's the final price quoted to the customer."*

It is a **rules-and-rates reference to implement in code, not a live quoting system.** It is **destination-centric**: each destination's rates live inside its own sheet — there are no shared global rate tables.

## Structure — 217 sheets

### A. Config sheets (3) — the cross-cutting logic to implement
- **`Pricing_Engine_Inputs`** — the **input contract**. The parameters a quote requires (adults, children, infants, nights, rooms, hotel category/zone/meal plan, flight class/legs/trip-type, transfer count, …) with defaults and data types. This is the shape of the pricing function's arguments.
- **`Quotation_Calculation`** — the **algorithm**. Twelve cost lines (hotel, flight, airport transfers, local transport, sightseeing, guide, meals, rail/ferry, visa, insurance, city/tourism tax, other) → Direct Cost → Contingency → Cost Before Markup → Agent Markup → Tax/VAT → Payment/FX Fee → **FINAL QUOTATION**. Implement this sequence.
- **`Markup_Tax_Rules`** — the **commercial levers**: base agent markup 15%, premium/luxury 20%, low-season promo 10%; per-service markups (hotel 12%, flight 8%, transport 12%, activity 15%); VAT blank (enter per market); payment gateway 2%; FX buffer 2%.

Plus **`INDEX1`** — a sheet map, accurate to the current file (lists exactly the sheets present).

### B. Destination sheets (213) — one per place, self-contained
Named to match the place names in the JSON dataset (Cairo, Petra, Leh, Ha Long Bay, …). Each has a header block then rate rows:
- **Header** — Destination, Region, Currency, local FX, Default Zone.
- **Hotel** — rate per star tier (3 / 4 / 5 / Luxury 5 Star) × zone (Central / Outskirts), per Room/Night.
- **Transport** — airport↔hotel transfers, sightseeing transfer, full-day vehicle, extra hour.
- **Meals** — lunch, dinner, snack, welcome drink, per person.
- **Activities** — per-attraction ticket/guide cost, each with a structured ID (e.g. `CAIRO_A_GIZA_PYRAMIDS`, `PETRA_A_AL_KHAZNEH`).
- Every rate stated twice: **Baseline USD** and **Local Currency INR**.

## How it joins the rest of the system
By **place-name string**, the same key used throughout the dataset:
```
JSON master place  ⇄  destination sheet name  ⇄  transport route endpoint
```
A place should appear in the master dataset, have a transport route, and have a pricing sheet.

## Data flow a developer implements
```
Pricing_Engine_Inputs (user's trip params)
   + destination sheet (unit rates for that place)
   → Quotation_Calculation (sum the 12 cost lines)
   → Markup_Tax_Rules (apply markup, tax, fees)
   → FINAL QUOTATION
```

## Caveats
1. **Rates are placeholders** — every row is tagged "Replace with contracted rate." This is the structure to populate with real supplier pricing, not live rates.
2. **No global rate tables** — hotel/meal/transport/activity rates exist *only* per destination sheet. Read per-destination; there is no central Hotel_Rates lookup (earlier drafts had one; it was intentionally removed).
3. **Currency labelling needs confirmation** — sheets carry both "Baseline USD" and "Local Currency INR" (INR ≈ USD × ~94.5, internally consistent), while header FX rows read "→Local FX = 1.0." Confirm the true base currency before wiring FX conversion.
4. **Two sheet layouts** (compact 8-column vs wide 26-column) — parse by header label, never by fixed column index.
5. **Spelling drift matches the JSON files** (`Smarkand`, `Edinburg`, `Hungery`, `Seol`, `Nauwaraeliya`, `Dharmshala`) — the place-name join fails on these unless names are normalized on both sides.
6. **`Quotation_Calculation` subtotals currently read 0** — a formula template awaiting populated inputs, not a worked example.
7. **Provisional overall** — like the JSON layer, no figure here is verified against real suppliers yet; treat as a working scaffold pending a real rate-loading pass.
