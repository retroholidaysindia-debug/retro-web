import { test, expect } from "@playwright/test";

test.describe("degradation paths", () => {
  test("reduced motion: page is usable and shows static poster imagery, no video autoplay", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("video")).toHaveCount(0);
    await expect(page.getByRole("list")).toBeVisible();
    await context.close();
  });

  test("video ended: auto-advances to the next card while the hero is in view", async ({ page }) => {
    await page.goto("/");
    const cardRail = page.getByRole("list");
    await cardRail.getByRole("link", { name: /kashmir/i }).click();
    await expect(cardRail.getByRole("link", { name: /kashmir/i })).toHaveAttribute("aria-current", "true");
    await page.locator('[data-testid="media-video-kashmir"]').evaluate((el) => {
      (el as HTMLVideoElement).dispatchEvent(new Event("ended"));
    });
    await expect(cardRail.getByRole("link", { name: /kashmir/i })).not.toHaveAttribute("aria-current", "true");
  });

  test("video error: destination falls back to poster and CTA still works", async ({ page }) => {
    await page.route("**/media/kashmir/clip*", (route) => route.abort());
    await page.goto("/");
    // `loadDestinations()` orders destinations by filesystem readdir order
    // (deliberately unspecified per Task 3's own test, which sorts before
    // comparing), not by slug name — so kashmir is not guaranteed to be the
    // initially active/scrolled-to destination. Select it explicitly via the
    // card rail so the error path below is actually exercised regardless of
    // content ordering.
    await page.getByRole("list").getByRole("link", { name: /kashmir/i }).click();
    // MediaLayer renders a poster <img> for every non-active destination
    // unconditionally, so `media-poster-kashmir` being present/visible proves
    // nothing on its own — it would render identically whether or not the
    // aborted route was ever hit. Assert the video genuinely failed over:
    // kashmir is now active, its poster must be visible AND its video must
    // be absent (not just invisible — MediaLayer swaps the element out on
    // error rather than hiding it).
    await expect(page.getByTestId("media-poster-kashmir")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("media-video-kashmir")).toHaveCount(0);
    // The NavBar also renders a "Plan your trip" link (href="/plan"), so matching by
    // accessible name + `.first()` is fragile (it depends on DOM order, not intent).
    // Target this page's own CTA by its unique href instead.
    const cta = page.locator('a[href="/plan?destination=kashmir"]');
    await expect(cta).toBeVisible();
  });
});
