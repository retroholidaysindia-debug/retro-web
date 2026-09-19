import { execSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import sources from "./media-sources.json";

const OUT_ROOT = path.join(process.cwd(), "public", "media");
const RAW_DIR = path.join(process.cwd(), "data", "raw-footage");

function sh(cmd: string) {
  execSync(cmd, { stdio: "inherit" });
}

async function downloadRaw(slug: string, url: string): Promise<string> {
  mkdirSync(RAW_DIR, { recursive: true });
  const dest = path.join(RAW_DIR, `${slug}.mp4`);
  if (existsSync(dest)) return dest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${slug} footage: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

function encodeRenditions(slug: string, rawPath: string) {
  const outDir = path.join(OUT_ROOT, slug);
  mkdirSync(outDir, { recursive: true });

  // Cut a seamless 7s loop starting 1s in (avoids common intro camera-shake).
  const trim = "-ss 1 -t 7";

  // Landscape renditions (targeted CRF per-destination for budget compliance)
  // Kashmir/Kenya/Santorini/Peru need extreme compression due to complexity; Dubai moderate; Bali/Nordic minimal
  let av1CrfLandscape: number, vp9CrfLandscape: number, av1CrfPortrait: number, vp9CrfPortrait: number;
  if (slug === "kashmir" || slug === "kenya" || slug === "santorini" || slug === "peru") {
    av1CrfLandscape = 62;
    vp9CrfLandscape = 54;
    av1CrfPortrait = 62;
    vp9CrfPortrait = 54;
  } else if (slug === "dubai") {
    av1CrfLandscape = 56;
    vp9CrfLandscape = 50;
    av1CrfPortrait = 58;
    vp9CrfPortrait = 52;
  } else {
    // bali, nordic
    av1CrfLandscape = 54;
    vp9CrfLandscape = 48;
    av1CrfPortrait = 56;
    vp9CrfPortrait = 50;
  }

  sh(`ffmpeg -y -i "${rawPath}" ${trim} -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" -an -c:v libsvtav1 -crf ${av1CrfLandscape} -b:v 0 -cpu-used 6 "${outDir}/clip.av1.webm"`);
  sh(`ffmpeg -y -i "${rawPath}" ${trim} -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" -an -c:v libvpx-vp9 -crf ${vp9CrfLandscape} -b:v 0 "${outDir}/clip.vp9.webm"`);
  sh(`ffmpeg -y -i "${rawPath}" ${trim} -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" -an -c:v libx264 -crf 36 -preset slow -movflags +faststart "${outDir}/clip.mp4"`);

  // Portrait renditions (spec §5.2.1: 720x1280, <=320KB)
  sh(`ffmpeg -y -i "${rawPath}" ${trim} -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" -an -c:v libsvtav1 -crf ${av1CrfPortrait} -b:v 0 -cpu-used 6 "${outDir}/clip-portrait.av1.webm"`);
  sh(`ffmpeg -y -i "${rawPath}" ${trim} -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" -an -c:v libvpx-vp9 -crf ${vp9CrfPortrait} -b:v 0 "${outDir}/clip-portrait.vp9.webm"`);
  sh(`ffmpeg -y -i "${rawPath}" ${trim} -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" -an -c:v libx264 -crf 38 -preset slow -movflags +faststart "${outDir}/clip-portrait.mp4"`);

  // Posters: first frame of the trimmed range, as WebP (aggressively compressed for budget)
  // ffmpeg's libwebp encoder is not available in this build, so render a PNG
  // frame and convert with the standalone cwebp CLI.
  sh(`ffmpeg -y -i "${rawPath}" -ss 1 -vframes 1 -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" "${outDir}/poster.png"`);
  sh(`cwebp -q 25 "${outDir}/poster.png" -o "${outDir}/poster.webp"`);
  sh(`rm "${outDir}/poster.png"`);
  sh(`ffmpeg -y -i "${rawPath}" -ss 1 -vframes 1 -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" "${outDir}/poster-portrait.png"`);
  sh(`cwebp -q 25 "${outDir}/poster-portrait.png" -o "${outDir}/poster-portrait.webp"`);
  sh(`rm "${outDir}/poster-portrait.png"`);
}

async function main() {
  for (const [slug, { url }] of Object.entries(sources as Record<string, { url: string }>)) {
    if (!url || url.startsWith("PASTE_")) {
      throw new Error(`scripts/media-sources.json: no URL set for "${slug}" — pick a clip from Pexels first.`);
    }
    console.log(`--- ${slug} ---`);
    const raw = await downloadRaw(slug, url);
    encodeRenditions(slug, raw);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
