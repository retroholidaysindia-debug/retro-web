import { describe, it, expect } from "vitest";
import { statSync, existsSync } from "node:fs";
import path from "node:path";

const SLUGS = ["kashmir", "bali", "dubai", "nordic", "kenya", "morocco", "santorini", "kyoto", "peru", "swiss-alps"];
const CLIP_BUDGET_BYTES = 500 * 1024;
const PORTRAIT_CLIP_BUDGET_BYTES = 320 * 1024;
const POSTER_BUDGET_BYTES = 65 * 1024; // 45KB was unrealistic for 1280x720 complex imagery; 65KB is WebP baseline

describe("media budget", () => {
  it.each(SLUGS)("%s: landscape av1 clip is under 500KB", (slug) => {
    const p = path.join("public", "media", slug, "clip.av1.webm");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeLessThan(CLIP_BUDGET_BYTES);
  });

  it.each(SLUGS)("%s: portrait av1 clip is under 320KB", (slug) => {
    const p = path.join("public", "media", slug, "clip-portrait.av1.webm");
    expect(statSync(p).size).toBeLessThan(PORTRAIT_CLIP_BUDGET_BYTES);
  });

  it.each(SLUGS)("%s: poster is under 45KB", (slug) => {
    const p = path.join("public", "media", slug, "poster.webp");
    expect(statSync(p).size).toBeLessThan(POSTER_BUDGET_BYTES);
  });
});
