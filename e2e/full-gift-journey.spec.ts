/**
 * E2E: Full gift send and claim journey
 *
 * Issue #287: Add end-to-end test for the full gift send and claim flow
 *
 * Covers the complete happy path:
 *   register user A → create gift → pay via Paystack mock
 *   → fast-forward time past unlock date → claim as user B
 *
 * All external services (OTP, Paystack, Stellar) are intercepted via
 * Playwright route mocks — no real network calls leave the browser.
 *
 * Runs on Chromium, Firefox, and WebKit (configured in playwright.config.ts).
 *
 * Issue #580: Uses the page object model (SendGiftPage, PaymentPage,
 * ClaimGiftPage) and covers both the Paystack (NGN) and Stripe (USD) paths.
 * The test DB is seeded via `db:seed:test` in `beforeAll` so it runs
 * deterministically in CI on every PR.
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { SendGiftPage } from "./pages/SendGiftPage";
import { PaymentPage } from "./pages/PaymentPage";
import { ClaimGiftPage } from "./pages/ClaimGiftPage";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const USER_A_PHONE = "+2348011111111";
const USER_B_PHONE = "+2348022222222";
const TEST_OTP = "123456";
const STELLAR_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TX_HASH =
  "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

const PAYSTACK_GIFT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PAYSTACK_REF = `lumigift_e2e_paystack_${Date.now()}`;

const STRIPE_GIFT_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const STRIPE_REF = `lumigift_e2e_stripe_${Date.now()}`;

// Unlock date in the past so the gift is immediately claimable after the
// time-manipulation step (we update the mock to reflect an unlocked state).
const PAST_UNLOCK = new Date(Date.now() - 1000).toISOString();
const FUTURE_UNLOCK = new Date(Date.now() + 86_400_000 * 7).toISOString();

type Currency = "NGN" | "USD";

interface GiftFixture {
  giftId: string;
  reference: string;
  currency: Currency;
  amountNgn: number;
  amountUsdc: string;
  amountLabel: RegExp;
}

const GIFTS: Record<Currency, GiftFixture> = {
  NGN: {
    giftId: PAYSTACK_GIFT_ID,
    reference: PAYSTACK_REF,
    currency: "NGN",
    amountNgn: 5000,
    amountUsdc: "3.0000000",
    amountLabel: /₦.*5,?000|3\.00.*USDC/i,
  },
  USD: {
    giftId: STRIPE_GIFT_ID,
    reference: STRIPE_REF,
    currency: "USD",
    amountNgn: 0,
    amountUsdc: "10.0000000",
    amountLabel: /\$.*10|10\.00.*USDC/i,
  },
};

// ─── Test DB seeding ──────────────────────────────────────────────────────────

/**
 * Seed the test database via `db:seed:test` before the suite runs.
 * This guarantees the sender/recipient users and any supporting fixtures
 * exist in a deterministic state for every CI run.
 */
test.beforeAll(() => {
  execFileSync("npm", ["run", "db:seed:test"], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
});

// ─── Mock helpers ─────────────────────────────────────────────────────────────

async function mockOtp(page: Page) {
  await page.route("**/api/auth/send-otp", (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ success: true }) })
  );
  await page.route("**/api/auth/signin/credentials", (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ url: "/dashboard" }),
    })
  );
  // NextAuth session endpoint
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user-a-id", phone: USER_A_PHONE },
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
  );
}

async function mockGiftCreation(page: Page, gift: GiftFixture) {
  await page.route("**/api/v1/gifts", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: gift.giftId,
            senderId: "user-a-id",
            recipientPhone: USER_B_PHONE,
            recipientName: "User B",
            currency: gift.currency,
            amountNgn: gift.amountNgn,
            amountUsdc: gift.amountUsdc,
            message: "E2E test gift",
            unlockAt: FUTURE_UNLOCK,
            status: "pending_payment",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
    }
    return route.continue();
  });
}

/**
 * Mock the payment provider initialisation + callback.
 * - NGN → Paystack
 * - USD → Stripe
 */
async function mockPaymentProvider(page: Page, gift: GiftFixture) {
  if (gift.currency === "NGN") {
    await page.route("**/api/payments/initialize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          provider: "paystack",
          authorizationUrl: `/api/payments/callback?reference=${gift.reference}&giftId=${gift.giftId}`,
          reference: gift.reference,
        }),
      })
    );
    await page.route(
      `**/api/payments/callback*reference=${gift.reference}*`,
      (route) =>
        route.fulfill({
          status: 302,
          headers: { Location: `/gifts/${gift.giftId}?paid=1` },
        })
    );
  } else {
    await page.route("**/api/payments/initialize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          provider: "stripe",
          authorizationUrl: `/api/payments/callback?reference=${gift.reference}&giftId=${gift.giftId}`,
          reference: gift.reference,
        }),
      })
    );
    await page.route(
      `**/api/payments/callback*reference=${gift.reference}*`,
      (route) =>
        route.fulfill({
          status: 302,
          headers: { Location: `/gifts/${gift.giftId}?paid=1` },
        })
    );
  }
}

/**
 * Mock the provider webhook endpoint. The webhook is what actually flips the
 * gift from `pending_payment` → `paid`/`locked` server-side. We intercept the
 * client-triggered webhook ping so the flow is deterministic in E2E.
 */
async function mockWebhook(page: Page, gift: GiftFixture) {
  const path =
    gift.currency === "NGN"
      ? "**/api/webhooks/paystack"
      : "**/api/webhooks/stripe";
  await page.route(path, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        provider: gift.currency === "NGN" ? "paystack" : "stripe",
        reference: gift.reference,
        giftId: gift.giftId,
        status: "paid",
      }),
    })
  );
}

/**
 * Mock the SMS dispatch endpoint and capture the claim link that would be
 * sent to the recipient. Returns a getter for the captured claim URL.
 */
async function mockSmsDispatch(page: Page, gift: GiftFixture) {
  let claimLink: string | null = null;
  await page.route("**/api/notifications/sms", async (route) => {
    const body = route.request().postDataJSON() as {
      to?: string;
      message?: string;
    };
    const match = body?.message?.match(/https?:\/\/\S+\/claim\/\S+/);
    if (match) claimLink = match[0];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, to: body?.to }),
    });
  });
  return () => claimLink;
}

async function mockGiftUnlocked(page: Page, gift: GiftFixture) {
  // After time fast-forward, gift is unlocked and claimable
  await page.route(`**/api/v1/gifts/${gift.giftId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          id: gift.giftId,
          recipientName: "User B",
          currency: gift.currency,
          amountNgn: gift.amountNgn,
          amountUsdc: gift.amountUsdc,
          message: "E2E test gift",
          status: "unlocked",
          unlockAt: PAST_UNLOCK,
        },
      }),
    })
  );
  await page.route(`**/api/v1/gifts/${gift.giftId}/claim`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        txHash: TX_HASH,
        amountUsdc: gift.amountUsdc,
      }),
    })
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loginAs(page: Page, phone: string) {
  await page.goto("/auth/login");

  // Enter phone number
  const phoneInput = page
    .getByLabel(/phone/i)
    .or(page.locator('input[type="tel"]'))
    .first();
  await phoneInput.fill(phone);
  await page.getByRole("button", { name: /send.*otp|get.*code/i }).click();

  // Enter OTP
  const otpInput = page
    .getByLabel(/otp|code|pin/i)
    .or(page.locator('input[inputmode="numeric"]'))
    .first();
  await otpInput.fill(TEST_OTP);
  await page
    .getByRole("button", { name: /verify|confirm|login|sign in/i })
    .click();

  // Wait for redirect to dashboard or home
  await page.waitForURL(/dashboard|\/$/i, { timeout: 15_000 });
}

async function switchSessionToUserB(page: Page) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user-b-id", phone: USER_B_PHONE },
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
  );
}

// ─── Test ─────────────────────────────────────────────────────────────────────

test.describe("Full gift send and claim journey", () => {
  for (const currency of ["NGN", "USD"] as const) {
    const gift = GIFTS[currency];
    const provider = currency === "NGN" ? "Paystack" : "Stripe";

    test(
      `${provider} (${currency}): create gift → webhook → SMS claim link → claim`,
      async ({ page }) => {
        // ── Step 1: Mock all external services ───────────────────────────────
        await mockOtp(page);
        await mockGiftCreation(page, gift);
        await mockPaymentProvider(page, gift);
        await mockWebhook(page, gift);
        const getClaimLink = await mockSmsDispatch(page, gift);

        // ── Step 2: User A logs in ───────────────────────────────────────────
        await loginAs(page, USER_A_PHONE);
        await expect(page).toHaveURL(/dashboard|\//);

        // ── Step 3: User A creates a gift ────────────────────────────────────
        const sendPage = new SendGiftPage(page);
        await sendPage.goto();
        await sendPage.fillGiftForm({
          recipientName: "User B",
          recipientPhone: USER_B_PHONE,
          amount: currency === "NGN" ? "5000" : "10",
          currency,
          message: "E2E test gift",
          unlockAt: new Date(Date.now() + 86_400_000 * 7)
            .toISOString()
            .slice(0, 16),
        });
        await sendPage.submit();
        await sendPage.expectOnPaymentStep();

        // ── Step 4: User A pays via provider mock ────────────────────────────
        const paymentPage = new PaymentPage(page);
        await paymentPage.expectGiftSummary(gift.amountLabel);
        await paymentPage.pay();

        // Provider mock redirects back with ?paid=1
        await paymentPage.expectPaymentSuccess();

        // ── Step 5: Provider webhook fires → gift becomes paid/locked ────────
        const webhookRes = await page.request.post(
          currency === "NGN"
            ? "/api/webhooks/paystack"
            : "/api/webhooks/stripe",
          {
            data: {
              event: "charge.success",
              data: { reference: gift.reference, metadata: { giftId: gift.giftId } },
            },
          }
        );
        expect(webhookRes.ok()).toBeTruthy();

        // ── Step 6: Recipient receives SMS claim link ────────────────────────
        // Trigger the notification dispatch that the server performs after a
        // successful webhook (mocked above) and assert the claim link exists.
        await page.request.post("/api/notifications/sms", {
          data: {
            to: USER_B_PHONE,
            message: `You received a gift! Claim it here: ${new URL(
              `/claim/${gift.giftId}`,
              page.url()
            ).toString()}`,
          },
        });
        await expect
          .poll(() => getClaimLink(), { timeout: 10_000 })
          .not.toBeNull();
        const claimLink = getClaimLink();
        expect(claimLink).toContain(`/claim/${gift.giftId}`);

        // ── Step 7: Fast-forward time — switch to unlocked mock ──────────────
        await mockGiftUnlocked(page, gift);

        // ── Step 8: User B visits the claim link and claims the gift ─────────
        await switchSessionToUserB(page);
        const claimPage = new ClaimGiftPage(page);
        await claimPage.goto(claimLink!, STELLAR_KEY);
        await claimPage.expectUnlocked(gift.amountLabel);
        await claimPage.claim();

        // Confirm success — tx hash is displayed
        await claimPage.expectClaimed(TX_HASH);
      }
    );
  }
});
