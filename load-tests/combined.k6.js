/**
 * k6 combined load test — Gift Creation + Claim (full flow)
 *
 * Runs three scenarios in parallel:
 *   - 100 VUs creating gifts for 30 s
 *   - 50 VUs claiming pre-seeded gifts for 30 s
 *   - 50 VUs listing the dashboard for 30 s
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 AUTH_TOKEN=<jwt> GIFT_IDS=id1,id2 STELLAR_KEY=G... \
 *     k6 run load-tests/combined.k6.js --out json=load-tests/results/run-$(date +%s).json
 *
 * Staging CI gate (issue #561): set CI=true to enforce p95 < 500ms and
 * error rate < 0.1% at 50 concurrent users. k6 exits non-zero when any
 * threshold is breached, failing the CI job.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ─── Custom metrics ───────────────────────────────────────────────────────────
const creationErrors = new Rate("gift_creation_errors");
const claimErrors = new Rate("gift_claim_errors");
const creationDuration = new Trend("gift_creation_duration", true);
const claimDuration = new Trend("gift_claim_duration", true);
const dashboardErrors = new Rate("dashboard_listing_errors");
const dashboardDuration = new Trend("dashboard_listing_duration", true);

// ─── Threshold config ─────────────────────────────────────────────────────────
// CI (staging gate): p95 < 500ms, error rate < 0.1% at 50 concurrent users.
// Local runs keep the looser defaults; override via env vars.
const IS_CI = __ENV.CI === "true";
const P95_MS = Number(__ENV.P95_MS || (IS_CI ? 500 : 2000));
const ERROR_RATE = Number(__ENV.ERROR_RATE || (IS_CI ? 0.001 : 0.01));
const VUS = Number(__ENV.VUS || (IS_CI ? 50 : 100));
const CLAIM_VUS = Number(__ENV.CLAIM_VUS || (IS_CI ? 50 : 50));
const DASHBOARD_VUS = Number(__ENV.DASHBOARD_VUS || (IS_CI ? 50 : 50));
const DURATION = __ENV.DURATION || "30s";

// ─── Options ──────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    gift_creation: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      exec: "createGift",
    },
    gift_claim: {
      executor: "constant-vus",
      vus: CLAIM_VUS,
      duration: DURATION,
      exec: "claimGift",
    },
    dashboard_listing: {
      executor: "constant-vus",
      vus: DASHBOARD_VUS,
      duration: DURATION,
      exec: "listDashboard",
    },
  },
  thresholds: {
    gift_creation_duration: [`p(95)<${P95_MS}`],
    gift_claim_duration: [`p(95)<${P95_MS}`],
    dashboard_listing_duration: [`p(95)<${P95_MS}`],
    gift_creation_errors: [`rate<${ERROR_RATE}`],
    gift_claim_errors: [`rate<${ERROR_RATE}`],
    dashboard_listing_errors: [`rate<${ERROR_RATE}`],
    http_req_failed: [`rate<${ERROR_RATE}`],
  },
};

// ─── Shared config ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const STELLAR_KEY =
  __ENV.STELLAR_KEY || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const GIFT_IDS = (__ENV.GIFT_IDS || "").split(",").filter(Boolean);

function randomPhone() {
  const suffix = Math.floor(10000000 + Math.random() * 90000000);
  return `+23480${suffix}`;
}

function futureDate(daysAhead = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString();
}

// ─── Scenario: create gift ────────────────────────────────────────────────────
export function createGift() {
  const payload = JSON.stringify({
    recipientPhone: randomPhone(),
    recipientName: "Load Test User",
    amountNgn: 1000,
    unlockAt: futureDate(),
    paymentProvider: "paystack",
  });

  const res = http.post(`${BASE_URL}/api/v1/gifts`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    tags: { name: "POST /api/v1/gifts" },
  });

  creationDuration.add(res.timings.duration);
  const ok = check(res, { "gift created (201)": (r) => r.status === 201 });
  creationErrors.add(!ok);
  sleep(0.1);
}

// ─── Scenario: claim gift ─────────────────────────────────────────────────────
export function claimGift() {
  if (GIFT_IDS.length === 0) return;

  const giftId = GIFT_IDS[__VU % GIFT_IDS.length];
  const payload = JSON.stringify({ giftId, recipientStellarKey: STELLAR_KEY });

  const res = http.post(`${BASE_URL}/api/v1/gifts/${giftId}/claim`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /api/v1/gifts/:id/claim" },
  });

  claimDuration.add(res.timings.duration);
  const ok = check(res, { "gift claimed (200)": (r) => r.status === 200 });
  claimErrors.add(!ok);
  sleep(0.2);
}

// ─── Scenario: dashboard listing ──────────────────────────────────────────────
export function listDashboard() {
  const res = http.get(`${BASE_URL}/api/v1/gifts`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    tags: { name: "GET /api/v1/gifts" },
  });

  dashboardDuration.add(res.timings.duration);
  const ok = check(res, { "dashboard listed (200)": (r) => r.status === 200 });
  dashboardErrors.add(!ok);
  sleep(0.2);
}
