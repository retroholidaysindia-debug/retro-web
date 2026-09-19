/**
 * Renders the compiled model as SQLite DDL + seed data.
 *
 * The app itself reads the JSON bundles — this exists so the same relational
 * model can be loaded into Cloudflare D1 unchanged when the agency wants an
 * admin UI or server-side quoting, without redesigning anything.
 */
import type {
  CoreBundle,
  DestinationBundle,
  DestinationGuidance,
  Route,
  VisaRule,
} from "../../lib/atlas/schema";

const DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE region      (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
CREATE TABLE country     (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
                          region_id TEXT NOT NULL REFERENCES region(id),
                          iso3 TEXT, is_cluster INTEGER NOT NULL DEFAULT 0);
CREATE TABLE subregion   (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                          region_id TEXT NOT NULL REFERENCES region(id));
CREATE TABLE state       (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
                          country_id TEXT NOT NULL REFERENCES country(id),
                          subregion_id TEXT REFERENCES subregion(id));
CREATE TABLE place       (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
                          country_id TEXT NOT NULL REFERENCES country(id),
                          state_id TEXT REFERENCES state(id),
                          has_rates INTEGER NOT NULL DEFAULT 0,
                          has_content INTEGER NOT NULL DEFAULT 0,
                          -- Resolved from map marker, primary airport or geocoder.
                          -- Null when no source could locate the place.
                          lat REAL, lon REAL);
CREATE TABLE place_alias (alias TEXT NOT NULL, place_id TEXT NOT NULL REFERENCES place(id),
                          source TEXT NOT NULL, how TEXT NOT NULL,
                          PRIMARY KEY (alias, source));

CREATE TABLE package     (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
                          region_id TEXT NOT NULL REFERENCES region(id),
                          nights INTEGER NOT NULL, days INTEGER NOT NULL,
                          price_from_inr REAL NOT NULL,
                          flexible_duration INTEGER NOT NULL DEFAULT 0,
                          description TEXT, highlights TEXT);
-- A package may span several countries ("European Delights").
CREATE TABLE package_country (package_id TEXT NOT NULL REFERENCES package(id),
                          country_id TEXT NOT NULL REFERENCES country(id),
                          PRIMARY KEY (package_id, country_id));
CREATE TABLE package_state (package_id TEXT NOT NULL REFERENCES package(id),
                          state_id TEXT NOT NULL REFERENCES state(id),
                          PRIMARY KEY (package_id, state_id));
CREATE TABLE package_place (package_id TEXT NOT NULL REFERENCES package(id),
                          place_id TEXT NOT NULL REFERENCES place(id),
                          position INTEGER NOT NULL,
                          PRIMARY KEY (package_id, place_id));

CREATE TABLE destination (place_id TEXT PRIMARY KEY REFERENCES place(id),
                          destination_code TEXT, short_description TEXT, agent_summary TEXT,
                          currency TEXT, timezone TEXT,
                          min_nights INTEGER, ideal_nights INTEGER, max_nights INTEGER,
                          overall_cost_level TEXT);
CREATE TABLE suitability_score (place_id TEXT NOT NULL REFERENCES place(id),
                          category TEXT NOT NULL, score REAL NOT NULL,
                          PRIMARY KEY (place_id, category));
CREATE TABLE destination_tag (place_id TEXT NOT NULL REFERENCES place(id),
                          kind TEXT NOT NULL, tag TEXT NOT NULL,
                          PRIMARY KEY (place_id, kind, tag));
CREATE TABLE monthly_score (place_id TEXT NOT NULL REFERENCES place(id),
                          month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
                          weather REAL, crowd REAL, price REAL, overall REAL, recommendation TEXT,
                          PRIMARY KEY (place_id, month));
CREATE TABLE area        (id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES place(id),
                          name TEXT NOT NULL, price_level TEXT, transport_convenience REAL,
                          zone TEXT NOT NULL);
CREATE TABLE attraction  (id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES place(id),
                          name TEXT NOT NULL, priority REAL NOT NULL);
CREATE TABLE activity    (id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES place(id),
                          code TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE purpose_activity (place_id TEXT NOT NULL REFERENCES place(id),
                          purpose TEXT NOT NULL, description TEXT NOT NULL);
CREATE TABLE cluster     (id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES place(id),
                          name TEXT NOT NULL, recommended_duration TEXT,
                          duration_hours REAL NOT NULL, walking_intensity TEXT);
CREATE TABLE cluster_attraction (cluster_id TEXT NOT NULL REFERENCES cluster(id),
                          name TEXT NOT NULL, position INTEGER NOT NULL,
                          PRIMARY KEY (cluster_id, position));

-- The 21 destination-file sections no structured table claims: airport
-- transfer logic, the per-audience travel guidance, the worked itinerary
-- patterns, the agent insights and the destination's own decision rules.
-- Captured whole, keyed by the section and the audience it is written for.
CREATE TABLE destination_guidance (
                          place_id TEXT NOT NULL REFERENCES place(id),
                          section INTEGER NOT NULL,
                          topic TEXT NOT NULL,
                          section_title TEXT NOT NULL,
                          heading TEXT,
                          audience TEXT,
                          body TEXT NOT NULL,
                          position INTEGER NOT NULL,
                          PRIMARY KEY (place_id, position));
CREATE TABLE destination_guidance_bullet (
                          place_id TEXT NOT NULL REFERENCES place(id),
                          position INTEGER NOT NULL,
                          bullet_index INTEGER NOT NULL,
                          text TEXT NOT NULL,
                          PRIMARY KEY (place_id, position, bullet_index));
CREATE INDEX idx_guidance_audience ON destination_guidance (audience);
CREATE INDEX idx_guidance_topic ON destination_guidance (topic);

-- Section 33 parsed into an evaluable form. One row per rule, with its
-- conditions and any executable effect in child tables.
CREATE TABLE decision_rule (
                          id TEXT PRIMARY KEY,
                          place_id TEXT NOT NULL REFERENCES place(id),
                          action TEXT NOT NULL,
                          reason TEXT);
CREATE TABLE decision_rule_condition (
                          rule_id TEXT NOT NULL REFERENCES decision_rule(id),
                          position INTEGER NOT NULL,
                          variable TEXT NOT NULL,
                          operator TEXT NOT NULL,
                          value TEXT NOT NULL,
                          number REAL,
                          unit TEXT,
                          -- How this condition joins the previous one.
                          joiner TEXT,
                          PRIMARY KEY (rule_id, position));
CREATE TABLE decision_rule_effect (
                          rule_id TEXT NOT NULL REFERENCES decision_rule(id),
                          position INTEGER NOT NULL,
                          kind TEXT NOT NULL,
                          token TEXT NOT NULL,
                          PRIMARY KEY (rule_id, position, token));
CREATE INDEX idx_rule_place ON decision_rule (place_id);
CREATE INDEX idx_rule_condition_var ON decision_rule_condition (variable);

CREATE TABLE hotel_rate  (place_id TEXT NOT NULL REFERENCES place(id),
                          star TEXT NOT NULL, zone TEXT NOT NULL, meal_plan TEXT NOT NULL,
                          inr REAL NOT NULL, baseline REAL, baseline_currency TEXT,
                          source TEXT NOT NULL,
                          PRIMARY KEY (place_id, star, zone, meal_plan));
CREATE TABLE transfer_rate (place_id TEXT NOT NULL REFERENCES place(id),
                          service TEXT NOT NULL, inr REAL NOT NULL,
                          baseline REAL, baseline_currency TEXT, source TEXT NOT NULL,
                          PRIMARY KEY (place_id, service));
CREATE TABLE meal_rate   (place_id TEXT NOT NULL REFERENCES place(id),
                          meal TEXT NOT NULL, inr REAL NOT NULL,
                          baseline REAL, baseline_currency TEXT, source TEXT NOT NULL,
                          PRIMARY KEY (place_id, meal));
CREATE TABLE activity_rate (place_id TEXT NOT NULL REFERENCES place(id),
                          code TEXT NOT NULL, unit TEXT, inr REAL NOT NULL,
                          baseline REAL, baseline_currency TEXT, source TEXT NOT NULL,
                          PRIMARY KEY (place_id, code));
CREATE TABLE markup_rule (level TEXT NOT NULL, rule TEXT NOT NULL, unit TEXT,
                          value REAL NOT NULL, notes TEXT,
                          PRIMARY KEY (level, rule));

CREATE TABLE route       (id TEXT PRIMARY KEY, scope TEXT NOT NULL, country_context TEXT,
                          origin_place_id TEXT, dest_place_id TEXT,
                          origin_country_id TEXT, dest_country_id TEXT,
                          onsite_mode TEXT, route_type TEXT);
CREATE TABLE route_option (route_id TEXT NOT NULL REFERENCES route(id),
                          mode TEXT NOT NULL, enabled INTEGER NOT NULL,
                          price_low REAL, price_high REAL, currency TEXT,
                          duration_minutes REAL, terminal_from TEXT, terminal_to TEXT,
                          unavailable_reason TEXT,
                          PRIMARY KEY (route_id, mode));

CREATE TABLE flight_band (id TEXT PRIMARY KEY, origin_city TEXT NOT NULL,
                          dest_country_id TEXT NOT NULL REFERENCES country(id),
                          carrier TEXT NOT NULL, cabin TEXT NOT NULL, trip_type TEXT NOT NULL,
                          price_low REAL NOT NULL, price_high REAL NOT NULL,
                          currency TEXT NOT NULL, duration_minutes REAL, source TEXT NOT NULL);
CREATE TABLE visa_rule   (nationality TEXT NOT NULL,
                          dest_country_id TEXT NOT NULL REFERENCES country(id),
                          requirement TEXT NOT NULL, fee_inr REAL NOT NULL,
                          processing_days INTEGER, source TEXT NOT NULL,
                          PRIMARY KEY (nationality, dest_country_id));
CREATE TABLE insurance_rate (zone TEXT PRIMARY KEY, per_person_per_day_inr REAL NOT NULL,
                          source TEXT NOT NULL);
CREATE TABLE city_tax    (place_id TEXT PRIMARY KEY REFERENCES place(id),
                          per_person_per_night_inr REAL NOT NULL, source TEXT NOT NULL);

CREATE INDEX idx_place_country      ON place(country_id);
CREATE INDEX idx_package_country    ON package_country(country_id);
CREATE INDEX idx_hotel_place        ON hotel_rate(place_id);
CREATE INDEX idx_activity_rate_place ON activity_rate(place_id);
CREATE INDEX idx_route_origin       ON route(origin_place_id);
CREATE INDEX idx_route_dest         ON route(dest_place_id);
CREATE INDEX idx_cluster_place      ON cluster(place_id);
CREATE INDEX idx_visa_nationality   ON visa_rule(nationality);
`.trim();

function lit(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insert(table: string, columns: string[], rows: unknown[][]): string {
  if (!rows.length) return "";
  const lines: string[] = [];
  // Chunked so a single statement never gets unwieldy for D1's importer.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    lines.push(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n` +
        chunk.map((r) => `  (${r.map(lit).join(", ")})`).join(",\n") +
        ";",
    );
  }
  return lines.join("\n");
}

export function emitSchemaSql(): string {
  return `-- Atlas quotation model — generated by scripts/etl/build.ts. Do not edit.\n\n${DDL}\n`;
}

export function emitSeedSql(
  core: CoreBundle,
  destinations: DestinationBundle[],
  routes: Route[],
  visaRules: VisaRule[],
  /**
   * The complete guidance set. The destination bundles carry only the subset
   * the engine reasons with, to keep the lazily-loaded asset small — but the
   * SQL mirror is the full model, so it takes everything.
   */
  guidance: DestinationGuidance[] = [],
): string {
  const out: string[] = [
    "-- Atlas seed data — generated by scripts/etl/build.ts. Do not edit.",
    "BEGIN TRANSACTION;",
  ];
  const add = (sql: string) => {
    if (sql) out.push(sql);
  };

  add(insert("region", ["id", "name", "slug"], core.regions.map((r) => [r.id, r.name, r.slug])));
  add(
    insert(
      "country",
      ["id", "name", "slug", "region_id", "iso3", "is_cluster"],
      core.countries.map((c) => [c.id, c.name, c.slug, c.regionId, c.iso3, c.isCluster]),
    ),
  );
  add(
    insert(
      "subregion",
      ["id", "name", "region_id"],
      core.subregions.map((s) => [s.id, s.name, s.regionId]),
    ),
  );
  add(
    insert(
      "state",
      ["id", "name", "slug", "country_id", "subregion_id"],
      core.states.map((s) => [s.id, s.name, s.slug, s.countryId, s.subregionId]),
    ),
  );
  add(
    insert(
      "place",
      ["id", "name", "slug", "country_id", "state_id", "has_rates", "has_content", "lat", "lon"],
      core.places.map((p) => [
        p.id, p.name, p.slug, p.countryId, p.stateId, p.hasRates, p.hasContent, p.lat, p.lon,
      ]),
    ),
  );
  add(
    insert(
      "package",
      ["id", "name", "slug", "region_id", "nights", "days",
       "price_from_inr", "flexible_duration", "description", "highlights"],
      core.packages.map((p) => [
        p.id, p.name, p.slug, p.regionId, p.nights, p.days,
        p.priceFromInr, p.flexibleDuration, p.description, JSON.stringify(p.highlights),
      ]),
    ),
  );
  add(
    insert(
      "package_country",
      ["package_id", "country_id"],
      core.packages.flatMap((p) => p.countryIds.map((id): unknown[] => [p.id, id])),
    ),
  );
  add(
    insert(
      "package_state",
      ["package_id", "state_id"],
      core.packages.flatMap((p) => p.stateIds.map((id): unknown[] => [p.id, id])),
    ),
  );
  add(
    insert(
      "package_place",
      ["package_id", "place_id", "position"],
      core.packages.flatMap((p) => p.placeIds.map((id, i): unknown[] => [p.id, id, i])),
    ),
  );
  add(
    insert(
      "hotel_rate",
      ["place_id", "star", "zone", "meal_plan", "inr", "baseline", "baseline_currency", "source"],
      core.hotelRates.map((r) => [r.placeId, r.star, r.zone, r.mealPlan, r.inr, r.baseline, r.baselineCurrency, r.source]),
    ),
  );
  add(
    insert(
      "transfer_rate",
      ["place_id", "service", "inr", "baseline", "baseline_currency", "source"],
      core.transferRates.map((r) => [r.placeId, r.service, r.inr, r.baseline, r.baselineCurrency, r.source]),
    ),
  );
  add(
    insert(
      "meal_rate",
      ["place_id", "meal", "inr", "baseline", "baseline_currency", "source"],
      core.mealRates.map((r) => [r.placeId, r.meal, r.inr, r.baseline, r.baselineCurrency, r.source]),
    ),
  );
  add(
    insert(
      "markup_rule",
      ["level", "rule", "unit", "value", "notes"],
      core.markupRules.map((m) => [m.level, m.rule, m.unit, m.value, m.notes]),
    ),
  );
  add(
    insert(
      "flight_band",
      ["id", "origin_city", "dest_country_id", "carrier", "cabin", "trip_type",
       "price_low", "price_high", "currency", "duration_minutes", "source"],
      core.flightBands.map((b) => [
        b.id, b.originCity, b.destCountryId, b.carrier, b.cabin, b.tripType,
        b.priceLow, b.priceHigh, b.currency, b.durationMinutes, b.source,
      ]),
    ),
  );
  add(
    insert(
      "insurance_rate",
      ["zone", "per_person_per_day_inr", "source"],
      core.insuranceRates.map((i) => [i.zone, i.perPersonPerDayInr, i.source]),
    ),
  );
  add(
    insert(
      "city_tax",
      ["place_id", "per_person_per_night_inr", "source"],
      core.cityTaxes.map((c) => [c.placeId, c.perPersonPerNightInr, c.source]),
    ),
  );
  add(
    insert(
      "visa_rule",
      ["nationality", "dest_country_id", "requirement", "fee_inr", "processing_days", "source"],
      visaRules.map((v) => [v.nationality, v.destCountryId, v.requirement, v.feeInr, v.processingDays, v.source]),
    ),
  );

  // --- per-destination content ------------------------------------------
  add(
    insert(
      "destination",
      ["place_id", "destination_code", "short_description", "agent_summary", "currency",
       "timezone", "min_nights", "ideal_nights", "max_nights", "overall_cost_level"],
      destinations
        .filter((d) => d.destination)
        .map((d) => {
          const x = d.destination!;
          return [x.placeId, x.destinationCode, x.shortDescription, x.agentSummary, x.currency,
                  x.timezone, x.minNights, x.idealNights, x.maxNights, x.overallCostLevel];
        }),
    ),
  );
  add(
    insert(
      "suitability_score",
      ["place_id", "category", "score"],
      destinations.flatMap((d) => d.suitability.map((s) => [s.placeId, s.category, s.score])),
    ),
  );
  add(
    insert(
      "destination_tag",
      ["place_id", "kind", "tag"],
      [
        ...new Map(
          destinations
            .flatMap((d) => d.tags)
            .map((t): [string, unknown[]] => [`${t.placeId}|${t.kind}|${t.tag}`, [t.placeId, t.kind, t.tag]]),
        ).values(),
      ],
    ),
  );
  add(
    insert(
      "monthly_score",
      ["place_id", "month", "weather", "crowd", "price", "overall", "recommendation"],
      destinations.flatMap((d) =>
        d.months.map((m) => [m.placeId, m.month, m.weather, m.crowd, m.price, m.overall, m.recommendation]),
      ),
    ),
  );
  add(
    insert(
      "area",
      ["id", "place_id", "name", "price_level", "transport_convenience", "zone"],
      destinations.flatMap((d) =>
        d.areas.map((a) => [a.id, a.placeId, a.name, a.priceLevel, a.transportConvenience, a.zone]),
      ),
    ),
  );
  add(
    insert(
      "attraction",
      ["id", "place_id", "name", "priority"],
      destinations.flatMap((d) => d.attractions.map((a) => [a.id, a.placeId, a.name, a.priority])),
    ),
  );
  add(
    insert(
      "activity",
      ["id", "place_id", "code", "name"],
      destinations.flatMap((d) => d.activities.map((a) => [a.id, a.placeId, a.code, a.name])),
    ),
  );
  add(
    insert(
      "activity_rate",
      ["place_id", "code", "unit", "inr", "baseline", "baseline_currency", "source"],
      destinations.flatMap((d) =>
        d.activityRates.map((r) => [r.placeId, r.code, r.unit, r.inr, r.baseline, r.baselineCurrency, r.source]),
      ),
    ),
  );
  add(
    insert(
      "purpose_activity",
      ["place_id", "purpose", "description"],
      destinations.flatMap((d) => d.purposeActivities.map((p) => [p.placeId, p.purpose, p.description])),
    ),
  );
  add(
    insert(
      "cluster",
      ["id", "place_id", "name", "recommended_duration", "duration_hours", "walking_intensity"],
      destinations.flatMap((d) =>
        d.clusters.map((c) => [c.id, c.placeId, c.name, c.recommendedDuration, c.durationHours, c.walkingIntensity]),
      ),
    ),
  );
  add(
    insert(
      "cluster_attraction",
      ["cluster_id", "name", "position"],
      destinations.flatMap((d) => d.clusters.flatMap((c) => c.attractions.map((n, i) => [c.id, n, i]))),
    ),
  );
  add(
    insert(
      "destination_guidance",
      ["place_id", "section", "topic", "section_title", "heading", "audience", "body", "position"],
      guidance.map((g, i) => [
        g.placeId, g.section, g.topic, g.sectionTitle, g.heading, g.audience, g.body, i,
      ]),
    ),
  );
  add(
    insert(
      "destination_guidance_bullet",
      ["place_id", "position", "bullet_index", "text"],
      guidance.flatMap((g, i) => g.bullets.map((text, b) => [g.placeId, i, b, text])),
    ),
  );

  const rules = destinations.flatMap((d) => d.decisionRules);
  add(
    insert(
      "decision_rule",
      ["id", "place_id", "action", "reason"],
      rules.map((r) => [r.id, r.placeId, r.action, r.reason]),
    ),
  );
  add(
    insert(
      "decision_rule_condition",
      ["rule_id", "position", "variable", "operator", "value", "number", "unit", "joiner"],
      rules.flatMap((r) =>
        r.conditions.map((c, i) => [r.id, i, c.variable, c.operator, c.value, c.number, c.unit, c.joiner]),
      ),
    ),
  );
  add(
    insert(
      "decision_rule_effect",
      ["rule_id", "position", "kind", "token"],
      rules.flatMap((r) =>
        r.effects.flatMap((e, i) => e.tokens.map((token) => [r.id, i, e.kind, token])),
      ),
    ),
  );

  // --- transport ---------------------------------------------------------
  add(
    insert(
      "route",
      ["id", "scope", "country_context", "origin_place_id", "dest_place_id",
       "origin_country_id", "dest_country_id", "onsite_mode", "route_type"],
      routes.map((r) => [r.id, r.scope, r.countryContext, r.originPlaceId, r.destPlaceId,
                         r.originCountryId, r.destCountryId, r.onsiteMode, r.routeType]),
    ),
  );
  add(
    insert(
      "route_option",
      ["route_id", "mode", "enabled", "price_low", "price_high", "currency",
       "duration_minutes", "terminal_from", "terminal_to", "unavailable_reason"],
      routes.flatMap((r) =>
        r.options.map((o) => [r.id, o.mode, o.enabled, o.priceLow, o.priceHigh, o.currency,
                              o.durationMinutes, o.terminalFrom, o.terminalTo, o.unavailableReason]),
      ),
    ),
  );

  out.push("COMMIT;");
  return out.join("\n\n") + "\n";
}
