import { test, expect } from "@playwright/test";

// Destinations are now regions (curated groupings), not individual countries
// or places — content/destinations/*.json defines these slugs.
const SLUGS = [
  "africa",
  "east-asia",
  "eurasia-cis",
  "europe",
  "india",
  "middle-east",
  "oceania",
  "russia",
  "south-asia",
  "south-east-asia",
];

test.describe("home page hero", () => {
  test("the hero CTA is visible and clickable, and navigates to the destinations catalogue", async ({ page }) => {
    await page.goto("/");
    const heroPanel = page.getByTestId("hero-panel");
    const cta = heroPanel.getByRole("link", { name: /explore destinations/i });
    await expect(cta).toBeVisible();
    // A real click, not just toBeVisible(): Playwright's click fails if
    // another element (e.g. the background video/poster layer, or the card
    // rail below it) intercepts the pointer event at the CTA's coordinates,
    // so this is what actually proves the hero panel stacks above them.
    await cta.click();
    await expect(page).toHaveURL(/\/destinations$/);
  });
});

test.describe("destination pages", () => {
  for (const slug of SLUGS) {
    test(`/destinations/${slug} renders the map and its packages`, async ({ page }) => {
      await page.goto(`/destinations/${slug}`);
      await expect(page.locator("svg path[data-role='coastline']")).toBeVisible();
      // Every destination page renders a package rail linking into
      // /destinations/<slug>/packages/<packageSlug> — assert at least one.
      const firstPackage = page.locator(`a[href^="/destinations/${slug}/packages/"]`).first();
      await expect(firstPackage).toBeVisible();
    });
  }
});

test.describe("plan page", () => {
  test("shows the two planning modes and the all-packages rail", async ({ page }) => {
    await page.goto("/plan");
    await expect(page.getByRole("heading", { name: /where shall we take you/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /i know where i want to go/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /i want to explore/i })).toBeVisible();
    // PackageBrowseRail renders once the client-side catalogue loads.
    await expect(page.getByRole("list", { name: /all packages/i })).toBeVisible({ timeout: 10_000 });
  });

  test("choosing 'I know where I want to go' opens the map picker", async ({ page }) => {
    await page.goto("/plan");
    await page.getByRole("button", { name: /i know where i want to go/i }).click();
    await expect(page.getByRole("heading", { name: /choose your destinations/i })).toBeVisible();
  });
});

test.describe("contact page", () => {
  test("renders founder, address and phone details", async ({ page }) => {
    await page.goto("/contact");
    // The phone number also appears in the site-wide Footer, so scope to the
    // contact page's own content section to keep this a single match.
    const main = page.locator("main");
    await expect(main.getByText(/9804786498|98047 86498/).first()).toBeVisible();
    // "Kolkata" appears twice in the Footer (address + tagline), so match
    // the first occurrence rather than require a single unique match.
    await expect(page.getByText(/Kolkata/).first()).toBeVisible();
  });

  test("the enquiry form states it does not submit to a server", async ({ page }) => {
    await page.goto("/contact");
    await expect(page.getByText(/nothing is stored on this website/i)).toBeVisible();
  });
});
