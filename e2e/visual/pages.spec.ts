import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Visual regression tests for all major page routes.
 *
 * These tests capture full-page screenshots for the primary application
 * routes in both light and dark color schemes. Snapshots are stored in
 * `e2e/visual/__snapshots__/` and are committed to the repository so that
 * CSS regressions are caught before they reach users.
 *
 * Determinism strategy:
 *  - The clock is frozen via `page.clock` so any date/time rendering is stable.
 *  - API routes are mocked with fixtures so data is identical on every run.
 *  - The session is mocked so authenticated pages render without a real backend.
 *  - Animations and transitions are disabled via injected CSS.
 */

const FROZEN_TIME = new Date('2024-01-15T12:00:00.000Z');

const GIFT_ID = 'gift_visual_001';

const fixtures = {
  user: {
    id: 'user_visual_001',
    email: 'visual@example.com',
    name: 'Visual Tester',
    avatarUrl: null,
    createdAt: '2023-06-01T00:00:00.000Z',
  },
  gift: {
    id: GIFT_ID,
    title: 'A Visual Gift',
    description: 'A deterministic gift used for visual regression testing.',
    amount: '50.00',
    currency: 'XLM',
    status: 'active',
    senderId: 'user_visual_001',
    recipientId: 'user_visual_002',
    createdAt: '2024-01-10T00:00:00.000Z',
    expiresAt: '2024-02-10T00:00:00.000Z',
  },
  gifts: [
    {
      id: GIFT_ID,
      title: 'A Visual Gift',
      amount: '50.00',
      currency: 'XLM',
      status: 'active',
      createdAt: '2024-01-10T00:00:00.000Z',
    },
    {
      id: 'gift_visual_002',
      title: 'Another Visual Gift',
      amount: '25.00',
      currency: 'XLM',
      status: 'claimed',
      createdAt: '2024-01-05T00:00:00.000Z',
    },
  ],
  notifications: [
    {
      id: 'notif_visual_001',
      type: 'gift_received',
      message: 'You received a gift!',
      read: false,
      createdAt: '2024-01-14T00:00:00.000Z',
    },
    {
      id: 'notif_visual_002',
      type: 'gift_claimed',
      message: 'Your gift was claimed.',
      read: true,
      createdAt: '2024-01-12T00:00:00.000Z',
    },
  ],
};

/**
 * Disable animations/transitions and hide the caret so screenshots are stable.
 */
async function stabilizePage(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  });
}

/**
 * Mock the session so authenticated routes render deterministically.
 */
async function mockSession(page: Page): Promise<void> {
  await page.addInitScript((user) => {
    window.localStorage.setItem('session', JSON.stringify({ user, token: 'visual-token' }));
    window.localStorage.setItem('theme', 'light');
  }, fixtures.user);
}

/**
 * Mock all API routes used by the application with fixture data.
 */
async function mockApiRoutes(page: Page): Promise<void> {
  const json = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

  await page.route('**/api/auth/session', (route) => json(route, { user: fixtures.user }));
  await page.route('**/api/auth/login', (route) => json(route, { user: fixtures.user, token: 'visual-token' }));
  await page.route('**/api/auth/register', (route) => json(route, { user: fixtures.user, token: 'visual-token' }));
  await page.route('**/api/user/profile', (route) => json(route, fixtures.user));
  await page.route('**/api/gifts', (route) => json(route, { gifts: fixtures.gifts }));
  await page.route(`**/api/gifts/${GIFT_ID}`, (route) => json(route, fixtures.gift));
  await page.route('**/api/notifications', (route) => json(route, { notifications: fixtures.notifications }));
  await page.route('**/api/claim/**', (route) => json(route, { status: 'ok' }));

  // Catch-all for any other API calls so nothing hits a real backend.
  await page.route('**/api/**', (route) => json(route, {}));
}

/**
 * Common setup applied before every visual test.
 */
async function prepare(page: Page): Promise<void> {
  await page.clock.setFixedTime(FROZEN_TIME);
  await mockSession(page);
  await mockApiRoutes(page);
}

const routes: Array<{ name: string; path: string }> = [
  { name: 'landing', path: '/' },
  { name: 'send', path: '/send' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'gift-detail', path: `/gifts/${GIFT_ID}` },
  { name: 'claim', path: `/claim?code=visual-code-001` },
  { name: 'login', path: '/auth/login' },
  { name: 'register', path: '/auth/register' },
  { name: 'profile', path: '/profile' },
  { name: 'notifications', path: '/notifications' },
];

const colorSchemes: Array<'light' | 'dark'> = ['light', 'dark'];

for (const route of routes) {
  for (const scheme of colorSchemes) {
    test(`${route.name} page (${scheme})`, async ({ page }) => {
      await prepare(page);
      await page.emulateMedia({ colorScheme: scheme });

      await page.goto(route.path, { waitUntil: 'networkidle' });
      await stabilizePage(page);

      // Wait for the main content to be present before capturing.
      await expect(page.locator('body')).toBeVisible();

      await expect(page).toHaveScreenshot(`${route.name}-${scheme}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.02,
      });
    });
  }
}