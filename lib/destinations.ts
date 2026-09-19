import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DestinationSchema, type Destination } from "@/content/schema";

const CONTENT_DIR = path.join(process.cwd(), "content", "destinations");

let cache: Destination[] | null = null;

export function loadDestinations(): Destination[] {
  if (cache) return cache;
  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".json"));
  cache = files.map((file) => {
    const raw = JSON.parse(readFileSync(path.join(CONTENT_DIR, file), "utf-8"));
    const result = DestinationSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid destination content in ${file}: ${result.error.message}`);
    }
    return result.data;
  });
  return cache;
}

export function loadDestination(slug: string): Destination | undefined {
  return loadDestinations().find((d) => d.slug === slug);
}
