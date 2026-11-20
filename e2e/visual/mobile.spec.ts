/**
 * Mobile visual regression tests — Issue #299
 *
 * Captures screenshots at the three most common iPhone viewport widths:
 *   • 375 px  — iPhone SE / iPhone 8 / iPhone 12 mini
 *   • 390 px  — iPhone 14 / 15 / 16 (standard)
 *   • 428 px  — iPhone 14 Plus / 15 Plus / 16 Plus
 *
 * All major pages are covered:
 *   landing (/), send (/send), dashboard (/dashboard), gift detail (/gifts/:id),
 *   claim (/claim/:id), login (/auth/login), register (/auth/register),
 *   profile (/profile), notifications (/notifications)
 *
 * Dark mode variants are captured for every page via the `dark` query param
 * (see `gotoWithTheme` below), producing e.g. "landing-375px-dark.png".
 *
 * SNAPSHOT STABILITY
 * ──────────────────
 * - All timestamps come from VISUAL_SEED_EPOCH (2024-01-15T10:00:00Z) — never use Date.now().
 * - Authenticated pages mock the NextAuth session and gift API routes.
 * - Snapshots are stored in e2e/visual/__snapshots__/ (same dir as desktop snapshots).
 * - CI fails on pixel diff > 0.5 % (maxDiffPixelRatio: 0.005).
 *
 * UPDATE SNAPSHOTS
 * ────────────────
 *   npm run test:visual:update -- --project=mobile-375 --project=mobile-390 --project=mobile-428
 *
 * Flaky test policy: see CONTRIBUTING.md §"Flaky screenshot tests".
 *
 * Closes #299
 */

import { test, expect, type Page } from "@playwright/test";
import {
  GIFT_LOCKED,
  GIFT_UNLOCKED,
  GIFT_CLAIMED,
  ALL_GIFT_FIXTURES,
  giftApiResponse,
  giftsListApiResponse,
  VISUAL_SEED_EPOCH,
  VISUAL_USERS,
} from "./fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Freeze `Date.now()` and `new Date()` in the page to the seed epoch so
 * "time ago" / "time until" labels never change between CI runs.
 */
async function freezeClock(page: Page): Promise<void> {
  await page.addInitScript((epoch: number) => {
    const OriginalDate = Date;
    const frozenNow = epoch;

    class FrozenDate extends OriginalDate {
      constructor(...args: ConstructorParameters<typeof OriginalDate>) {
        if (args.length === 0) {
          super(frozenNow);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          super(...(args as [any]));
        }
      }
      static now(): number {
        return frozenNow;
      }
    }

    // @ts-expect-error — intentional runtime override for test determinism
    globalThis.Date = FrozenDate;
  }, VISUAL_SEED_EPOCH);
}

/** Mock the NextAuth session as VISUAL_USERS.alice. */
async function mockSession(page: Page): Promise<void> {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: VISUAL_USERS.alice.id,
          phone: VISUAL_USERS.alice.phone,
          name: VISUAL_USERS.alice.displayName,
        },
        expires: new Date(VISUAL_SEED_EPOCH + 86_400_000).toISOString(),
      }),
    })
  );
}

/** Mock all gift API routes used by dashboard and claim pages. */
async function mockGiftRoutes(page: Page): Promise<void> {
  // List endpoint for dashboard
  await page.route("**/api/v1/gifts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(giftsListApiResponse(ALL_GIFT_FIXTURES)),
    })
  );

  // Individual gift endpoints for claim/detail pages
  for (const gift of ALL_GIFT_FIXTURES) {
    const fixture = gift; // capture for closure
    await page.route(`**/api/v1/gifts/${fixture.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(fixture)),
      })
    );
  }
}

/** Mock the notifications API used by the notifications page. */
async function mockNotificationRoutes(page: Page): Promise<void> {
  await page.route("**/api/v1/notifications", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        notifications: [
          {
            id: "notif-1",
            type: "gift_claimed",
            title: "Your gift was claimed",
            message: "Alice claimed your gift.",
            read: false,
            createdAt: new Date(VISUAL_SEED_EPOCH - 3_600_000).toISOString(),
          },
          {
            id: "notif-2",
            type: "gift_unlocked",
            title: "A gift was unlocked",
            message: "A gift you sent is now unlocked.",
            read: true,
            createdAt: new Date(VISUAL_SEED_EPOCH - 86_400_000).toISOString(),
          },
        ],
        unreadCount: 1,
      }),
    })
  );
}

/** Mock the profile API used by the profile page. */
async function mockProfileRoutes(page: Page): Promise<void> {
  await page.route("**/api/v1/users/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: VISUAL_USERS.alice.id,
        phone: VISUAL_USERS.alice.phone,
        displayName: VISUAL_USERS.alice.displayName,
        createdAt: new Date(VISUAL_SEED_EPOCH - 30 * 86_400_000).toISOString(),
        stats: { sent: 4, received: 2, claimed: 1 },
      }),
    })
  );
}

/**
 * Navigate to `path`, optionally forcing dark mode via the `dark` query param
 * that the app's theme provider reads on boot.
 */
async function gotoWithTheme(
  page: Page,
  path: string,
  dark: boolean
): Promise<void> {
  const url = dark ? `${path}${path.includes("?") ? "&" : "?"}dark=1` : path;
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Suffix appended to snapshot names for dark-mode variants. */
function themeSuffix(dark: boolean): string {
  return dark ? "-dark" : "";
}

// ─── Tests ────────────────────────────────────────────────────────────────────
//
// Playwright projects for mobile-375, mobile-390, and mobile-428 are defined
// in playwright.visual.config.ts. Each project sets a different viewport
// width; the same spec file runs once per project, producing separate snapshots
// named e.g. "landing-375px.png", "landing-390px.png", "landing-428px.png".
//
// Snapshot names encode the viewport so all three widths coexist in
// __snapshots__/ without collision.

/** Returns "375", "390", or "428" from the Playwright project name. */
function viewportLabel(projectName: string): string {
  const match = projectName.match(/(\d+)/);
  return match ? `${match[1]}px` : projectName;
}

// ─── Landing page ──────────────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — landing page${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await gotoWithTheme(page, "/", dark);
    await expect(page).toHaveScreenshot(`landing-${vp}${themeSuffix(dark)}.png`);
  });
}

// ─── Send (gift creation) page ─────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — send page${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await gotoWithTheme(page, "/send", dark);
    await expect(page).toHaveScreenshot(`send-${vp}${themeSuffix(dark)}.png`);
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — dashboard${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await mockGiftRoutes(page);
    await gotoWithTheme(page, "/dashboard", dark);
    await expect(page).toHaveScreenshot(`dashboard-${vp}${themeSuffix(dark)}.png`);
  });
}

// ─── Gift detail (locked gift) ────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — gift detail (locked gift)${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await page.route(`**/api/v1/gifts/${GIFT_LOCKED.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(GIFT_LOCKED)),
      })
    );
    await gotoWithTheme(page, `/gifts/${GIFT_LOCKED.id}`, dark);
    await expect(page).toHaveScreenshot(
      `gift-detail-locked-${vp}${themeSuffix(dark)}.png`
    );
  });
}

for (const dark of [false, true]) {
  test(`mobile — gift detail (unlocked gift)${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await page.route(`**/api/v1/gifts/${GIFT_UNLOCKED.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(GIFT_UNLOCKED)),
      })
    );
    await gotoWithTheme(page, `/gifts/${GIFT_UNLOCKED.id}`, dark);
    await expect(page).toHaveScreenshot(
      `gift-detail-unlocked-${vp}${themeSuffix(dark)}.png`
    );
  });
}

for (const dark of [false, true]) {
  test(`mobile — gift detail (claimed gift)${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await page.route(`**/api/v1/gifts/${GIFT_CLAIMED.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(GIFT_CLAIMED)),
      })
    );
    await gotoWithTheme(page, `/gifts/${GIFT_CLAIMED.id}`, dark);
    await expect(page).toHaveScreenshot(
      `gift-detail-claimed-${vp}${themeSuffix(dark)}.png`
    );
  });
}

// ─── Claim page ───────────────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — claim page (locked gift)${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await page.route(`**/api/v1/gifts/${GIFT_LOCKED.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(GIFT_LOCKED)),
      })
    );
    await gotoWithTheme(page, `/claim/${GIFT_LOCKED.id}`, dark);
    await expect(page).toHaveScreenshot(
      `claim-locked-${vp}${themeSuffix(dark)}.png`
    );
  });
}

for (const dark of [false, true]) {
  test(`mobile — claim page (unlocked gift)${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await page.route(`**/api/v1/gifts/${GIFT_UNLOCKED.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(GIFT_UNLOCKED)),
      })
    );
    await gotoWithTheme(page, `/claim/${GIFT_UNLOCKED.id}`, dark);
    await expect(page).toHaveScreenshot(
      `claim-unlocked-${vp}${themeSuffix(dark)}.png`
    );
  });
}

for (const dark of [false, true]) {
  test(`mobile — claim page (claimed gift)${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await page.route(`**/api/v1/gifts/${GIFT_CLAIMED.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(giftApiResponse(GIFT_CLAIMED)),
      })
    );
    await gotoWithTheme(page, `/claim/${GIFT_CLAIMED.id}`, dark);
    await expect(page).toHaveScreenshot(
      `claim-claimed-${vp}${themeSuffix(dark)}.png`
    );
  });
}

// ─── Login page ────────────────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — login page${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    // No session mock — login page must render unauthenticated
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await gotoWithTheme(page, "/auth/login", dark);
    await expect(page).toHaveScreenshot(`login-${vp}${themeSuffix(dark)}.png`);
  });
}

// ─── Register page ────────────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — register page${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    // No session mock — register page must render unauthenticated
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await gotoWithTheme(page, "/auth/register", dark);
    await expect(page).toHaveScreenshot(`register-${vp}${themeSuffix(dark)}.png`);
  });
}

// ─── Profile page ─────────────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — profile page${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await mockProfileRoutes(page);
    await gotoWithTheme(page, "/profile", dark);
    await expect(page).toHaveScreenshot(`profile-${vp}${themeSuffix(dark)}.png`);
  });
}

// ─── Notifications page ───────────────────────────────────────────────────────

for (const dark of [false, true]) {
  test(`mobile — notifications page${themeSuffix(dark)}`, async ({ page }, testInfo) => {
    const vp = viewportLabel(testInfo.project.name);
    await freezeClock(page);
    await mockSession(page);
    await mockNotificationRoutes(page);
    await gotoWithTheme(page, "/notifications", dark);
    await expect(page).toHaveScreenshot(
      `notifications-${vp}${themeSuffix(dark)}.png`
    );
  });
}
