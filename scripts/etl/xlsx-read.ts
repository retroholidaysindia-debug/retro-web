/**
 * Minimal dependency-free XLSX (OOXML SpreadsheetML) reader.
 *
 * Only supports what the pricing workbook actually uses: shared strings, inline
 * strings and numeric cells on plain worksheets. Formatting, formulas, dates and
 * styles are ignored — the ETL only ever reads raw values.
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export type Cell = string | null;
export type Row = Cell[];

const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function readZip(buf: Buffer): Map<string, Buffer> {
  // Locate the End Of Central Directory record by scanning backwards; the
  // trailing comment is variable-length so the offset is not fixed.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file: no EOCD record");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== SIG_CENTRAL_DIR) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    // The local file header repeats name/extra with its own lengths.
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(s: string): string {
  return s
    .replace(/&(?:lt|gt|quot|apos);/g, (m) => ENTITIES[m])
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** "BC" -> 54 (zero-based column index). */
export function columnToIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export class Workbook {
  private constructor(
    private readonly files: Map<string, Buffer>,
    private readonly shared: string[],
    /** Sheet names in workbook order. */
    readonly sheetNames: string[],
    private readonly sheetPath: Map<string, string>,
  ) {}

  static open(file: string): Workbook {
    const files = readZip(readFileSync(file));
    const text = (name: string) => files.get(name)?.toString("utf8") ?? "";

    const shared: string[] = [];
    for (const si of text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // A shared string may be split across several <t> runs.
      const runs = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
      shared.push(runs.join(""));
    }

    const rels = new Map<string, string>();
    for (const r of text("xl/_rels/workbook.xml.rels").matchAll(
      /<Relationship[^>]*\bId="([^"]*)"[^>]*\bTarget="([^"]*)"/g,
    )) {
      rels.set(r[1], r[2].replace(/^\/?xl\//, ""));
    }

    const sheetNames: string[] = [];
    const sheetPath = new Map<string, string>();
    for (const s of text("xl/workbook.xml").matchAll(
      /<sheet[^>]*\bname="([^"]*)"[^>]*\br:id="(rId\d+)"/g,
    )) {
      const name = decodeXml(s[1]);
      sheetNames.push(name);
      sheetPath.set(name, "xl/" + rels.get(s[2]));
    }

    return new Workbook(files, shared, sheetNames, sheetPath);
  }

  /**
   * Returns the sheet as an array of rows positioned by their `r` attribute, so
   * blank rows are preserved. Missing cells are `null`.
   */
  sheet(name: string): Row[] {
    const path = this.sheetPath.get(name);
    if (!path) throw new Error(`No such sheet: ${name}`);
    const xml = this.files.get(path)?.toString("utf8") ?? "";

    const rows: Row[] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowIndex = Number(/\br="(\d+)"/.exec(rm[1])?.[1] ?? rows.length + 1) - 1;
      const cells: Row = [];

      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const body = cm[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        if (!ref) continue;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];

        let value: Cell;
        if (type === "inlineStr") {
          value = decodeXml(/<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? "");
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (v == null) value = null;
          else if (type === "s") value = this.shared[Number(v)] ?? null;
          else value = decodeXml(v);
        }
        cells[columnToIndex(ref)] = value;
      }

      rows[rowIndex] = cells;
    }

    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    return rows;
  }
}

/** Trimmed string at `i`, or "" — cells are frequently absent rather than blank. */
export function cell(row: Row | undefined, i: number): string {
  return (row?.[i] ?? "").toString().trim();
}

/** Numeric value at `i`, or null when absent/non-numeric. */
export function num(row: Row | undefined, i: number): number | null {
  const v = parseFloat(cell(row, i));
  return Number.isFinite(v) ? v : null;
}
