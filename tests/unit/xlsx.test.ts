import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Workbook, cell, columnToIndex, num } from "@/scripts/etl/xlsx-read";
import { writeWorkbook } from "@/scripts/etl/xlsx-write";

describe("columnToIndex", () => {
  it("maps spreadsheet column letters to zero-based indices", () => {
    expect(columnToIndex("A1")).toBe(0);
    expect(columnToIndex("Z9")).toBe(25);
    expect(columnToIndex("AA1")).toBe(26);
    expect(columnToIndex("BC12")).toBe(54);
  });
});

describe("xlsx round trip", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atlas-xlsx-"));
  const file = path.join(dir, "test.xlsx");

  it("writes a workbook the reader can parse back", () => {
    writeWorkbook(file, [
      {
        name: "Rates",
        header: ["Place", "Rate", "Notes"],
        rows: [
          ["Cairo", 9071.09, "contracted"],
          ["Kuala Lumpur", 4200, null],
          ["Ampersand & <angles>", 1, 'quote " apostrophe \''],
        ],
      },
      { name: "Second", header: ["Only"], rows: [["x"]] },
    ]);

    const wb = Workbook.open(file);
    expect(wb.sheetNames).toEqual(["Rates", "Second"]);

    const rows = wb.sheet("Rates");
    expect(cell(rows[0], 0)).toBe("Place");
    expect(cell(rows[1], 0)).toBe("Cairo");
    expect(num(rows[1], 1)).toBeCloseTo(9071.09, 2);
    // Empty cells are omitted rather than written as blanks.
    expect(cell(rows[2], 2)).toBe("");
    expect(cell(rows[3], 0)).toBe("Ampersand & <angles>");
    expect(cell(rows[3], 2)).toBe('quote " apostrophe \'');
  });

  it("sanitises sheet names Excel would reject", () => {
    const f2 = path.join(dir, "names.xlsx");
    writeWorkbook(f2, [
      { name: "Bad/Name:With*Chars?And[Brackets]AndVeryLongIndeed", header: ["A"], rows: [["1"]] },
    ]);
    const wb = Workbook.open(f2);
    expect(wb.sheetNames[0]).toHaveLength(31);
    expect(wb.sheetNames[0]).not.toMatch(/[:\\/?*[\]]/);
  });

  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("reading the real pricing workbook", () => {
  const wb = Workbook.open("input_files/Pricing_Rules.xlsx");

  it("finds every sheet", () => {
    expect(wb.sheetNames.length).toBe(217);
    expect(wb.sheetNames).toContain("Markup_Tax_Rules");
    expect(wb.sheetNames).toContain("Cairo");
  });

  it("reads the markup rules", () => {
    const rows = wb.sheet("Markup_Tax_Rules");
    expect(cell(rows[0], 0)).toBe("Level");
    const base = rows.find((r) => cell(r, 1) === "Base Agent Markup");
    expect(num(base, 3)).toBe(0.15);
  });
});
