import { readFileSync } from "node:fs";
import path from "node:path";
import { PackageImagesConfigSchema, type PackageImagesConfig } from "@/content/schema";

const CONTENT_PATH = path.join(process.cwd(), "content", "package-images.json");

let cache: PackageImagesConfig | null = null;

function loadConfig(): PackageImagesConfig {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(CONTENT_PATH, "utf-8"));
  const result = PackageImagesConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid package image content in content/package-images.json: ${result.error.message}`);
  }
  cache = result.data;
  return cache;
}

// Small deterministic string hash (not cryptographic) — same approach used
// elsewhere in this codebase (lib/trips.ts) for seeding placeholder content.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// Returns the image gallery for a package. Packages listed under
// `overrides` (key = "{destinationSlug}/{packageSlug}") get that exact list;
// everything else deterministically rotates through `defaultImages` so
// every package still shows a distinct-looking gallery, not identical photos,
// even before real package photography is uploaded.
export function getPackageImages(destinationSlug: string, packageSlug: string): string[] {
  const config = loadConfig();
  const key = `${destinationSlug}/${packageSlug}`;
  const override = config.overrides[key];
  if (override) return override;

  const pool = config.defaultImages;
  const count = Math.min(3, pool.length);
  const seed = hash(key);
  const picked: string[] = [];
  const usedIndexes = new Set<number>();
  for (let i = 0; picked.length < count && i < pool.length; i++) {
    const idx = (seed + i * 7) % pool.length;
    if (usedIndexes.has(idx)) continue;
    usedIndexes.add(idx);
    picked.push(pool[idx]);
  }
  return picked;
}
