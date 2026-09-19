import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "data", "natural-earth");

const SOURCES = {
  "admin0.geojson":
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson",
  "admin0-ind.geojson":
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries_ind.geojson",
  "admin1.geojson":
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson",
};

async function fetchOne(filename: string, url: string) {
  const dest = path.join(OUT_DIR, filename);
  if (existsSync(dest)) {
    console.log(`skip (exists): ${filename}`);
    return;
  }
  console.log(`fetching ${filename} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  writeFileSync(dest, body);
  console.log(`wrote ${filename} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [filename, url] of Object.entries(SOURCES)) {
    await fetchOne(filename, url);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
