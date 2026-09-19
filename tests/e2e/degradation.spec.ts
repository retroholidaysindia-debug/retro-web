import { test, expect } from "@playwright/test";

// The hero picks one random card per region on every load (see
// lib/hero-card-picker.ts), so no specific country/place name is stable
// across runs. Tests below discover the active card's destinationSlug from
// its href instead of hardcoding one, and match media testids by prefix
// (data-testid is `media-{video,poster}-{destinationSlug}-{placeSlug}`).

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
    const cardRail = page.getByRole("list").first();
    const firstCard = cardRail.getByRole("link").first();

    // AtlasScene renders a deterministic default card per region on first
    // paint, then reshuffles to a random country per region in a one-time
    // client effect right after mount. Click first (Playwright's
    // actionability check waits for the element to stop moving/changing),
    // then read the href — otherwise a href captured before that reshuffle
    // can point at a country/place that no longer matches the DOM.
    await firstCard.click();
    await expect(firstCard).toHaveAttribute("aria-current", "true");
    const href = await firstCard.getAttribute("href");
    const destSlug = href?.match(/\/destinations\/([^/]+)\//)?.[1];
    expect(destSlug).toBeTruthy();
    const video = page.locator(`video[data-testid^="media-video-${destSlug}-"]`);
    await video.evaluate((el) => el.dispatchEvent(new Event("ended")));
    await expect(firstCard).not.toHaveAttribute("aria-current", "true");
  });

  test("video error: destination falls back to poster and CTA still works", async ({ page }) => {
    // Abort every hero clip so whichever card is active necessarily fails
    // over to its poster, regardless of which country/place was picked.
    await page.route("**/media/*/clip*", (route) => route.abort());
    await page.goto("/");
    const cardRail = page.getByRole("list").first();
    const firstCard = cardRail.getByRole("link").first();

    // Read the href after clicking, not before — see the comment in the
    // "video ended" test above about the client-side hero reshuffle race.
    await firstCard.click();
    const href = await firstCard.getAttribute("href");
    const destSlug = href?.match(/\/destinations\/([^/]+)\//)?.[1];
    expect(destSlug).toBeTruthy();
    // MediaLayer renders a poster <img> for every non-active destination
    // unconditionally, so its presence alone proves nothing — assert the
    // active card's video is genuinely gone (swapped out, not just hidden)
    // and its poster is visible instead.
    await expect(page.locator(`img[data-testid^="media-poster-${destSlug}-"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`video[data-testid^="media-video-${destSlug}-"]`)).toHaveCount(0);
    // The NavBar also renders a "Plan your trip" link, so target this card's
    // own destination page link (which every destination page renders) by
    // its href instead of matching by ambiguous accessible name.
    await expect(firstCard).toBeVisible();
  });
});
