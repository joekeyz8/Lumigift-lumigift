import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for visual regression (snapshot) tests.
 *
 * Desktop:
 *   npm run test:visual
 *   npm run test:visual:update
 *
 * Mobile:
 *   npx playwright test --config playwright.visual.config.ts --project mobile-375
 *   npx playwright test --config playwright.visual.config.ts --project mobile-390
 *   npx playwright test --config playwright.visual.config.ts --project mobile-428
 *
 * Update all mobile baselines at once:
 *   npm run test:visual:update -- --project=mobile-375 --project=mobile-390 --project=mobile-428
 *
 * Pixel-diff threshold: 0.5% (maxDiffPixelRatio: 0.005).
 * CI fails if any snapshot exceeds this threshold.
 *
 * Flaky tests: quarantine per CONTRIBUTING.md §"Flaky screenshot tests".
 * New or updated snapshots in e2e/visual/__snapshots__/ require PR review
 * (enforced via CODEOWNERS).
 *
 * Closes #107, #299
 */
export default defineConfig({
  testDir: "./e2e/visual",
  snapshotDir: "./e2e/visual/__snapshots__",
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    toHaveScreenshot: {
      // CI requires strict 0.5% tolerance to catch real layout regressions
      // while avoiding false positives from sub-pixel anti-aliasing.
      maxDiffPixelRatio: 0.005,
    },
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "off",
  },
  projects: [
    // ── Desktop ──────────────────────────────────────────────────────────────
    // Covers all major page routes (landing, send, dashboard, gift detail,
    // claim, login, register, profile, notifications) in light mode.
    {
      name: "chromium",
      testMatch: /(components|pages)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Desktop dark mode ────────────────────────────────────────────────────
    // Same page routes rendered with prefers-color-scheme: dark so CSS
    // regressions in dark theme are caught before merge.
    {
      name: "chromium-dark",
      testMatch: /(components|pages)\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        colorScheme: "dark",
      },
    },

    // ── Mobile viewports (Issue #299) ─────────────────────────────────────────
    // Three most common iPhone widths: SE/8/12mini, 14/15/16, 14+/15+/16+.
    // The mobile.spec.ts test file reads the project name to derive the
    // viewport label appended to every snapshot filename.
    {
      name: "mobile-375",
      testMatch: /(mobile|pages)\.spec\.ts/,
      use: {
        ...devices["iPhone SE"],
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-390",
      testMatch: /(mobile|pages)\.spec\.ts/,
      use: {
        ...devices["iPhone 14"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-428",
      testMatch: /(mobile|pages)\.spec\.ts/,
      use: {
        ...devices["iPhone 14 Plus"],
        viewport: { width: 428, height: 926 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },

    // ── Mobile dark mode ─────────────────────────────────────────────────────
    // Mobile viewport with dark color scheme for the major page routes.
    {
      name: "mobile-390-dark",
      testMatch: /(mobile|pages)\.spec\.ts/,
      use: {
        ...devices["iPhone 14"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        colorScheme: "dark",
      },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
