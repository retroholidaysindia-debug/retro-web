/**
 * Parses `Pricing_Rules.xlsx` into the rate tables.
 *
 * The workbook holds one sheet per destination plus four meta sheets. Column
 * layout is *not* consistent across sheets — seven header variants exist, some
 * omit the Subcategory column, and the baseline currency is USD on most sheets
 * but EUR on the European ones. Everything is therefore located by header text
 * rather than by fixed column index.
 */
import { Workbook, cell, num, type Row } from "./xlsx-read";
import { Matcher, normalise } from "./normalise";
import type {
  Activity,
  ActivityRate,
  HotelRate,
  HotelStar,
  HotelZone,
  MarkupRule,
  MealRate,
  MealType,
  Place,
  TransferRate,
  TransferService,
} from "../../lib/atlas/schema";

export const META_SHEETS = new Set([
  "Markup_Tax_Rules",
  "Pricing_Engine_Inputs",
  "Quotation_Calculation",
  "INDEX1",
]);

const STARS: Record<string, HotelStar> = {
  "3 star": "3 Star",
  "4 star": "4 Star",
  "5 star": "5 Star",
  "luxury 5 star": "Luxury 5 Star",
};

const SERVICES: Record<string, TransferService> = {
  "airport hotel": "Airport→Hotel",
  "hotel airport": "Hotel→Airport",
  "hotel sightseeing": "Hotel→Sightseeing",
  "full day vehicle": "Full Day Vehicle",
  "extra hour": "Extra Hour",
  "airport cruise": "Airport→Cruise",
  "cruise airport": "Cruise→Airport",
  "cruise sightseeing": "Cruise→Sightseeing",
};

const MEALS: Record<string, MealType> = {
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  "welcome drink": "Welcome Drink",
};

type ColumnMap = {
  parameter: number;
  subcategory: number;
  zone: number;
  unit: number;
  baseline: number;
  baselineCurrency: string;
  inr: number;
};

/** Locates the columns of a "main" rate block from its header row. */
function mapMainHeader(row: Row): ColumnMap | null {
  const idx = (label: string) =>
    row.findIndex((c) => normalise(c ?? "") === normalise(label));

  const inr = row.findIndex((c) => /local currency/i.test(c ?? ""));
  const baseline = row.findIndex((c) => /^baseline/i.test((c ?? "").trim()));
  if (inr < 0 || baseline < 0) return null;

  const currency = /baseline\s+(\w+)/i.exec(cell(row, baseline))?.[1]?.toUpperCase() ?? "USD";

  return {
    parameter: idx("Parameter"),
    subcategory: idx("Subcategory"),
    zone: idx("Zone/Duration"),
    unit: idx("Unit"),
    baseline,
    baselineCurrency: currency,
    inr,
  };
}

/** Locates the columns of the activities block. */
function mapActivityHeader(row: Row): { code: number; unit: number; baseline: number; baselineCurrency: string; inr: number } | null {
  const code = row.findIndex((c) => /activities_id/i.test(c ?? ""));
  const inr = row.findIndex((c) => /local currency/i.test(c ?? ""));
  const baseline = row.findIndex((c) => /^baseline/i.test((c ?? "").trim()));
  if (code < 0 || inr < 0) return null;
  const currency = /baseline\s+(\w+)/i.exec(cell(row, baseline))?.[1]?.toUpperCase() ?? "USD";
  return { code, unit: row.findIndex((c) => normalise(c ?? "") === "unit"), baseline, baselineCurrency: currency, inr };
}

export type PricingParse = {
  hotelRates: HotelRate[];
  transferRates: TransferRate[];
  mealRates: MealRate[];
  activities: Activity[];
  activityRates: ActivityRate[];
  markupRules: MarkupRule[];
  /** Sheets that matched no place in the master catalogue. */
  orphanSheets: string[];
  /** Places that got at least one rate row. */
  pricedPlaceIds: Set<string>;
};

/** "CAIRO_A_GIZA_PYRAMIDS" -> "Giza Pyramids" */
function activityLabel(code: string): string {
  const tail = code.replace(/^[A-Z0-9]+_A_/i, "").replace(/_/g, " ");
  return tail
    .toLowerCase()
    .split(/(\s+|\/)/)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join("")
    .trim();
}

export function parsePricing(
  file: string,
  places: Place[],
  overrides: Record<string, string> = {},
): PricingParse {
  const wb = Workbook.open(file);
  const matcher = new Matcher(
    places.map((p) => ({ name: p.name, value: p })),
    overrides,
  );

  const out: PricingParse = {
    hotelRates: [],
    transferRates: [],
    mealRates: [],
    activities: [],
    activityRates: [],
    markupRules: [],
    orphanSheets: [],
    pricedPlaceIds: new Set(),
  };

  // --- Markup_Tax_Rules -------------------------------------------------
  for (const row of wb.sheet("Markup_Tax_Rules").slice(1)) {
    const level = cell(row, 0);
    if (!level) continue;
    const value = num(row, 3);
    if (value == null) continue;
    out.markupRules.push({
      level: level as MarkupRule["level"],
      rule: cell(row, 1),
      unit: cell(row, 2),
      value,
      notes: cell(row, 4) || null,
    });
  }

  // --- destination sheets ------------------------------------------------
  for (const sheetName of wb.sheetNames) {
    if (META_SHEETS.has(sheetName)) continue;

    const hit = matcher.match(sheetName);
    if (!hit) {
      out.orphanSheets.push(sheetName);
      continue;
    }
    const placeId = hit.value.id;

    let main: ColumnMap | null = null;
    let act: ReturnType<typeof mapActivityHeader> = null;
    const seenCodes = new Set<string>();

    for (const row of wb.sheet(sheetName)) {
      const category = cell(row, 0);
      if (!category) continue;

      // A header row switches which block we're in.
      if (normalise(category) === "category") {
        const a = mapActivityHeader(row);
        if (a) {
          act = a;
          main = null;
        } else {
          main = mapMainHeader(row);
          act = null;
        }
        continue;
      }

      if (category === "Activities" && act) {
        const code = cell(row, act.code);
        const inr = num(row, act.inr);
        if (!code || inr == null || seenCodes.has(code)) continue;
        seenCodes.add(code);

        out.activities.push({
          id: `${placeId}:${normalise(code).replace(/\s+/g, "-")}`,
          placeId,
          code,
          name: activityLabel(code),
        });
        out.activityRates.push({
          placeId,
          code,
          unit: cell(row, act.unit) || "Person",
          inr,
          baseline: num(row, act.baseline),
          baselineCurrency: act.baselineCurrency,
          source: "workbook",
        });
        out.pricedPlaceIds.add(placeId);
        continue;
      }

      if (!main) continue;
      const inr = num(row, main.inr);
      if (inr == null) continue;

      const parameter = main.parameter >= 0 ? cell(row, main.parameter) : "";
      const baseline = num(row, main.baseline);
      const common = { placeId, inr, baseline, baselineCurrency: main.baselineCurrency, source: "workbook" as const };

      if (category === "Hotel" || category === "Cruise") {
        const star = STARS[normalise(parameter)];
        if (!star) continue;
        // Zone lives in Zone/Duration normally, but slides into Subcategory on
        // the sheets that omit a Subcategory column.
        const zoneText = [main.zone, main.subcategory]
          .filter((i) => i >= 0)
          .map((i) => cell(row, i))
          .find((v) => /central|outskirts/i.test(v));
        const zone: HotelZone = /outskirts/i.test(zoneText ?? "") ? "Outskirts" : "Central";
        out.hotelRates.push({ ...common, star, zone, mealPlan: "Breakfast", unit: "Room/Night" });
        out.pricedPlaceIds.add(placeId);
        continue;
      }

      if (category === "Transport") {
        const service = SERVICES[normalise(parameter)];
        if (!service) continue;
        out.transferRates.push({ ...common, service, unit: "Vehicle" });
        out.pricedPlaceIds.add(placeId);
        continue;
      }

      if (category === "Meals") {
        const meal = MEALS[normalise(parameter)];
        if (!meal) continue;
        out.mealRates.push({ ...common, meal, unit: "Person" });
        out.pricedPlaceIds.add(placeId);
      }
    }
  }

  return out;
}
