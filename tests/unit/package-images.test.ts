import { describe, it, expect } from "vitest";
import { getPackageImages } from "@/lib/package-images";

describe("package-images", () => {
  it("returns the exact override list for a package that has one", () => {
    const images = getPackageImages("europe", "europe-at-a-glance");
    expect(images).toEqual([
      "/packages/placeholders/placeholder-7.webp",
      "/packages/placeholders/placeholder-2.webp",
      "/packages/placeholders/placeholder-6.webp",
    ]);
  });

  it("falls back to a deterministic rotation of the default pool for packages with no override", () => {
    const images = getPackageImages("india", "kerala");
    expect(images.length).toBeGreaterThan(0);
    for (const src of images) {
      expect(src).toMatch(/^\/packages\/placeholders\/placeholder-\d+\.webp$/);
    }
    // Deterministic: calling again for the same package returns the same images.
    expect(getPackageImages("india", "kerala")).toEqual(images);
  });

  it("gives different packages a different (not always identical) image set", () => {
    const a = getPackageImages("india", "kerala");
    const b = getPackageImages("india", "goa");
    expect(a).not.toEqual(b);
  });
});
