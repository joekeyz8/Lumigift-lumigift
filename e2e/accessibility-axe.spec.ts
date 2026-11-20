/**
 * e2e: Full-page accessibility audit using @axe-core/playwright
 *
 * Issue #293 — Accessibility audit to CI with axe-core
 *
 * This file runs axe-core against every public-facing route in the app to
 * catch accessibility regressions that component-level jest-axe tests cannot
 * catch (e.g. focus-management, dynamic content, iframe issues).
 *
 * CI GATE: Any page that produces a critical or serious axe violation will
 * fail this test. Violations listed in KNOWN_EXCEPTIONS are exempted and
 * must be documented in docs/accessibility/known-violations.md.
 *
 * AUDIT METHODOLOGY (see docs/accessibility/known-violations.md → "Audit
 * Methodology"): this spec is the automated half of the WCAG 2.1 AA audit
 * required by issue #577. It runs axe-core with the tag set
 * ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] against every public route.
 * The manual-testing half, severity ratings, remediation owners and target
 * dates live in the same document. When a violation is fixed, remove its id
 * from KNOWN_EXCEPTIONS and mark the corresponding row in
 * known-violations.md as fixed with the linked PR.
 *
 * The "axe-core — full violation report" test below writes the complete
 * results.violations array (including moderate/minor) to
 * test-results/axe-violations.json so the audit table in
 * known-violations.md can be populated and kept current.
 *
 * Routes covered:
 *   /             – Landing page
 *   /auth/login   – Login (phone OTP)
 *   /auth/register – Registration
 *   /help         – Help / FAQ
 *   /send         – Create gift form
 *   /dashboard    – User dashboard (authenticated)
 *   /notifications – Notification centre (authenticated)
 *   /claim        – Gift claim landing
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";

// ─── Known acceptable violations ─────────────────────────────────────────────
// Each entry MUST have a corresponding entry in
// docs/accessibility/known-violations.md.

// Keep this list in sync with the "Open violations" table in
// docs/accessibility/known-violations.md. Removing an entry here without
// fixing the underlying issue will fail CI; fixing the issue without
// removing the entry leaves a stale exemption.

const KNOWN_EXCEPTIONS: string[] = [
  // GiftCard: <button> nested inside <article role="button">
  // Tracked: docs/accessibility/known-violations.md
  "nested-interactive",
];

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Run axe on the current page and assert no unexcepted critical/serious
 * violations. Prints a structured summary if the test fails.
 */
async function assertNoViolations(page: import("@playwright/test").Page, route: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking = results.violations.filter(
    (v) => (v.impact === "critical" || v.impact === "serious") && !KNOWN_EXCEPTIONS.includes(v.id)
  );

  if (blocking.length > 0) {
    const summary = blocking
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.description}\n` +
          v.nodes
            .slice(0, 2)
            .map((n) => `    → ${n.html}`)
            .join("\n")
      )
      .join("\n\n");

    throw new Error(
      `[${route}] axe found ${blocking.length} critical/serious violation(s):\n${summary}\n\n` +
        `Add rule IDs to KNOWN_EXCEPTIONS if pre-existing, with a docs/accessibility/known-violations.md entry.`
    );
  }

  // Attach full results as an annotation for the HTML report
  test.info().annotations.push({
    type: "axe-violations",
    description: `${route}: ${results.violations.length} total violation(s), ${blocking.length} blocking`,
  });
}

// ─── Full violation report (audit artifact) ───────────────────────────────────

/**
 * Collect the complete axe results (all impacts, not just blocking) for a
 * route and append them to the audit artifact consumed when updating
 * docs/accessibility/known-violations.md.
 */
async function collectViolations(
  page: import("@playwright/test").Page,
  route: string,
  sink: Array<Record<string, unknown>>
) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  for (const v of results.violations) {
    sink.push({
      route,
      id: v.id,
      impact: v.impact ?? "unknown",
      description: v.description,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.map((n) => ({ html: n.html, target: n.target })),
    });
  }
}

// ─── Unauthenticated public routes ────────────────────────────────────────────

test.describe("axe-core — public routes", () => {
  test("/ (landing page) has no blocking violations", async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await page.goto("/");
    await assertNoViolations(page, "/");
  });

  test("/auth/login has no blocking violations", async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await page.goto("/auth/login");
    // Wait for interactive elements to be ready
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/auth/login");
  });

  test("/auth/register has no blocking violations", async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await page.goto("/auth/register");
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/auth/register");
  });

  test("/help has no blocking violations", async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await page.goto("/help");
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/help");
  });

  test("/claim has no blocking violations", async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );
    await page.goto("/claim");
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/claim");
  });
});

// ─── Authenticated routes ─────────────────────────────────────────────────────

test.describe("axe-core — authenticated routes", () => {
  const SESSION_MOCK = {
    user: {
      id: "test-user-axe",
      phone: "+2348099000001",
      name: "Axe Test User",
    },
    expires: "9999-12-31T23:59:59.000Z",
  };

  test.beforeEach(async ({ page }) => {
    // Inject a valid session so authenticated pages render
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_MOCK),
      })
    );

    // Stub API calls so pages load without a real backend
    await page.route("**/api/v1/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );
  });

  test("/send has no blocking violations", async ({ page }) => {
    await page.goto("/send");
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/send");
  });

  test("/dashboard has no blocking violations", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/dashboard");
  });

  test("/notifications has no blocking violations", async ({ page }) => {
    await page.goto("/notifications");
    await page.waitForLoadState("domcontentloaded");
    await assertNoViolations(page, "/notifications");
  });
});

// ─── Audit artifact ───────────────────────────────────────────────────────────

test.describe("axe-core — full violation report", () => {
  const SESSION_MOCK = {
    user: {
      id: "test-user-axe",
      phone: "+2348099000001",
      name: "Axe Test User",
    },
    expires: "9999-12-31T23:59:59.000Z",
  };

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_MOCK),
      })
    );
    await page.route("**/api/v1/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );
  });

  test("writes full axe violations to test-results/axe-violations.json", async ({ page }) => {
    const routes = [
      "/",
      "/auth/login",
      "/auth/register",
      "/help",
      "/claim",
      "/send",
      "/dashboard",
      "/notifications",
    ];

    const sink: Array<Record<string, unknown>> = [];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("domcontentloaded");
      await collectViolations(page, route, sink);
    }

    const outDir = path.join(process.cwd(), "test-results");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "axe-violations.json");
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          knownExceptions: KNOWN_EXCEPTIONS,
          violations: sink,
        },
        null,
        2
      )
    );

    test.info().annotations.push({
      type: "axe-audit-artifact",
      description: `Wrote ${sink.length} violation record(s) to ${outFile}`,
    });
  });
});
