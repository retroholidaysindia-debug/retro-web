import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "npm run build-maps && npm run build && npx serve out -p 3100",
    port: 3100,
    reuseExistingServer: !process.env.CI,
    // Brief specifies 120_000 here, but a cold build (no Turbopack/Next.js
    // cache, e.g. a fresh checkout or CI) was observed taking ~2.3 minutes to
    // compile alone, before typecheck/page generation/serve startup — well
    // past 120s. Raised to 300_000 (5 min) so first-ever runs don't flake;
    // warm-cache runs finish in ~30s and are unaffected.
    timeout: 300_000,
  },
  use: {
    baseURL: "http://localhost:3100",
    // NOTE: Playwright's bundled Chromium cannot be installed on this host
    // (macOS 12 / Monterey — see playwright-core's DOWNLOAD_PATHS, which has
    // no download entry for "mac12"/"mac12-arm64"; `npx playwright install
    // --with-deps chromium` fails with "Playwright does not support chromium
    // on mac12"). Falling back to the system-installed Google Chrome via the
    // "chrome" channel, which Playwright can drive without downloading its
    // own browser binary.
    channel: "chrome",
  },
});
