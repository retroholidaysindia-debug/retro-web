-- Atlas backend — D1 schema.
--
-- Deliberately narrow. The catalogue, the rate card and the quotation engine
-- all stay compiled into static assets and run in the browser: that is what
-- keeps re-pricing instant and hosting inside the free tier, and a database
-- round trip would make it slower and more expensive for no gain.
--
-- What D1 holds is the thing a static site genuinely cannot: state that
-- outlives the page. Trip enquiries, and quotes a traveller asked us to keep.
--
-- Apply with, from `workers/api`:
--   npx wrangler d1 migrations apply atlas --remote

-- A quote the traveller asked us to keep, so it can be reopened from a link or
-- picked up by an agent.
--
-- `request` is the QuoteRequest that produced it and is the authoritative
-- record: replaying it through the engine reproduces the quotation exactly,
-- because the engine is pure. `total_inr` and `per_person_inr` are stored
-- alongside only so a list can be shown without replaying every quote, and
-- `dataset_version` records which compiled dataset produced them — a later
-- rebuild may legitimately price the same request differently.
CREATE TABLE IF NOT EXISTS quote (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  -- JSON: the full QuoteRequest.
  request         TEXT NOT NULL,
  -- Denormalised for listing without parsing the request JSON.
  place_ids       TEXT NOT NULL,
  nights          INTEGER NOT NULL,
  start_date      TEXT NOT NULL,
  total_inr       REAL NOT NULL,
  per_person_inr  REAL NOT NULL,
  -- `generatedAt` of the core bundle the totals came from.
  dataset_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_created ON quote (created_at DESC);

CREATE TABLE IF NOT EXISTS enquiry (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  destination   TEXT,
  travel_window TEXT,
  travellers    TEXT,
  notes         TEXT,
  -- Where the enquiry came from: `contact-form`, `quote`, …
  source        TEXT NOT NULL DEFAULT 'contact-form',
  -- Set when the enquiry was raised from a saved quote.
  quote_id      TEXT REFERENCES quote(id),
  -- Operational state for whoever works the leads.
  status        TEXT NOT NULL DEFAULT 'new',
  -- Coarse metadata for spam triage. No IP address is stored.
  country       TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_enquiry_created ON enquiry (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiry_status ON enquiry (status);
