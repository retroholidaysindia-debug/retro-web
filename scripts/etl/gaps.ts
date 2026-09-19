import { Workbook, cell } from "./xlsx-read";

/**
 * Prints the review workbook to the terminal, so the gaps can be read without
 * opening Excel.
 *
 *   npx tsx scripts/etl/gaps.ts
 */
const wb = Workbook.open("data/atlas/Atlas_Rate_Review.xlsx");

function rule(title: string) {
  console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
}

rule("CONTENTS");
for (const r of wb.sheet("READ ME").slice(1)) {
  console.log(`  ${cell(r, 0).padEnd(18)} ${cell(r, 1).padEnd(24)} ${cell(r, 2)}`);
}

rule("SECTION 1 — OUR ESTIMATES");
{
  const rows = wb.sheet("Our Estimates").slice(1);
  const byTable = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const table = cell(r, 0);
    const basis = cell(r, 5).replace(/x[\d.]+ cost-level/, "scaled by cost level");
    const inner = byTable.get(table) ?? new Map<string, number>();
    inner.set(basis, (inner.get(basis) ?? 0) + 1);
    byTable.set(table, inner);
  }
  console.log(`\n  Inferred rates — ${rows.length} values\n`);
  for (const [table, inner] of byTable) {
    const total = [...inner.values()].reduce((a, b) => a + b, 0);
    console.log(`    ${table} — ${total}`);
    for (const [basis, n] of [...inner.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${String(n).padStart(5)}  ${basis}`);
    }
  }

  const fares = wb.sheet("Flight Fares (derived)").slice(1);
  const derived = fares.filter((r) => cell(r, 5) === "great-circle distance").length;
  console.log(`\n  Flight fares — ${fares.length} routes`);
  console.log(`        ${String(derived).padStart(5)}  derived from real great-circle distance`);
  console.log(`        ${String(fares.length - derived).padStart(5)}  regional fallback (no airport resolved)`);
  console.log("\n    sample:");
  for (const r of fares
    .filter((x) => cell(x, 2) === "DEL" && cell(x, 5) === "great-circle distance")
    .slice(0, 6)) {
    console.log(
      `      DEL -> ${cell(r, 0).padEnd(16)} ${String(cell(r, 3)).padStart(6)} km   ` +
        `mid return INR ${Number(cell(r, 4)).toLocaleString("en-IN")}`,
    );
  }

  const visa = wb.sheet("Visa Requirements").slice(1);
  console.log(`\n  Visa — ${visa.length} countries; requirement is real, fee is estimated`);
}

rule("SECTION 2 — MISSING DATA (what you need to provide)");
for (const r of wb.sheet("Missing Data").slice(1)) {
  console.log(`\n  ${cell(r, 0)}   [${cell(r, 1)}]`);
  console.log(`     file    : ${cell(r, 2)}`);
  console.log(`     section : ${cell(r, 3)}`);
  console.log(`     scope   : ${cell(r, 4)}`);
  console.log(`     shape   : ${cell(r, 5)}`);
  console.log(`     why     : ${cell(r, 6)}`);
}

rule("MISSING FILES — grouped");
{
  const rows = wb.sheet("Missing Files").slice(1);
  const byKind = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const kind = cell(r, 0);
    const region = cell(r, 2) || "(unknown)";
    const inner = byKind.get(kind) ?? new Map<string, number>();
    inner.set(region, (inner.get(region) ?? 0) + 1);
    byKind.set(kind, inner);
  }
  for (const [kind, inner] of byKind) {
    const total = [...inner.values()].reduce((a, b) => a + b, 0);
    console.log(`\n  ${kind} — ${total} required`);
    for (const [region, n] of [...inner.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(n).padStart(4)}  ${region}`);
    }
  }
}
