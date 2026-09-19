import { test, expect } from "@playwright/test";

const SLUGS = ["kashmir", "bali", "dubai", "nordic", "kenya", "morocco", "santorini", "kyoto", "peru", "swiss-alps"];

test.describe("home page hero", () => {
  test("the hero CTA is visible and clickable, and navigates to the plan page", async ({ page }) => {
    await page.goto("/");
    const heroPanel = page.getByTestId("hero-panel");
    const cta = heroPanel.getByRole("link", { name: /explore destinations/i });
    await expect(cta).toBeVisible();
    // A real click, not just toBeVisible(): Playwright's click fails if
    // another element (e.g. the background video/poster layer) intercepts
    // the pointer event at the CTA's coordinates, so this is what actually
    // proves the hero panel stacks above the media layer.
    await cta.click();
    await expect(page).toHaveURL(/\/plan\?destination=/);
  });
});

test.describe("destination pages", () => {
  for (const slug of SLUGS) {
    test(`/destinations/${slug} renders the map and a plan CTA`, async ({ page }) => {
      await page.goto(`/destinations/${slug}`);
      await expect(page.locator("svg path[data-role='coastline']")).toBeVisible();
      // The NavBar also renders a "Plan your trip" link (href="/plan"), so matching by
      // accessible name is ambiguous on this page. Target this page's own CTA by its
      // unique href instead.
      const cta = page.locator(`a[href="/plan?destination=${slug}"]`);
      await expect(cta).toBeVisible();
    });
  }
});

test.describe("plan page", () => {
  test("shows the requested destination when a valid slug is given", async ({ page }) => {
    await page.goto("/plan?destination=bali");
    await expect(page.getByText("Bali")).toBeVisible();
    await expect(page.getByText(/phase 2/i)).toBeVisible();
  });

  test("shows a destination picker when no slug is given", async ({ page }) => {
    await page.goto("/plan");
    await expect(page.getByRole("link", { name: /kashmir/i })).toBeVisible();
  });

  test("shows a destination picker when an unknown slug is given", async ({ page }) => {
    await page.goto("/plan?destination=atlantis");
    await expect(page.getByRole("link", { name: /kashmir/i })).toBeVisible();
  });
});

test.describe("contact page", () => {
  test("renders founder, address and phone details", async ({ page }) => {
    await page.goto("/contact");
    await expect(page.getByText(/9804786498|98047 86498/)).toBeVisible();
    await expect(page.getByText(/Kolkata/)).toBeVisible();
  });

  test("the enquiry form states it does not submit to a server", async ({ page }) => {
    await page.goto("/contact");
    await expect(page.getByText(/not yet connected|opens whatsapp|via whatsapp/i)).toBeVisible();
  });
});
