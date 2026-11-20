/**
 * k6 load test — Gift Claim endpoint
 * Endpoint: POST /api/v1/gifts/:id/claim
 *
 * Scenario: 50 concurrent virtual users claiming gifts simultaneously.
 *
 * Load profile: 50 concurrent virtual users, 5-minute ramp-up,
 * sustained for 10 minutes, then ramp-down.
 *
 * Thresholds (performance regression gates):
 *   - p95 response time < 500 ms
 *   - error rate < 0.1%
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 GIFT_IDS=id1,id2,... STELLAR_KEY=G... k6 run load-tests/gift-claim.k6.js
 *
 * Results are exported to JSON (--summary-export / handleSummary) for
 * comparison against the baseline in CI.
 *
 * GIFT_IDS should be a comma-separated list of pre-seeded gift IDs with status "unlocked".
 * STELLAR_KEY is the recipient's Stellar public key used for all claim requests.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ─── Custom metrics ───────────────────────────────────────────────────────────
const errorRate = new Rate("gift_claim_errors");
const claimDuration = new Trend("gift_claim_duration", true);

// ─── Options ──────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    gift_claim: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5m", target: 50 }, // ramp up to 50 VUs over 5 minutes
        { duration: "10m", target: 50 }, // sustain 50 VUs for 10 minutes
        { duration: "1m", target: 0 }, // ramp down
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // p95 latency under 500 ms
    gift_claim_duration: ["p(95)<500"],
    // error rate under 0.1%
    gift_claim_errors: ["rate<0.001"],
    http_req_failed: ["rate<0.001"],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const STELLAR_KEY =
  __ENV.STELLAR_KEY || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Pre-seeded gift IDs — each VU picks one round-robin
const GIFT_IDS = (__ENV.GIFT_IDS || "").split(",").filter(Boolean);

// ─── Default function ─────────────────────────────────────────────────────────
export default function () {
  if (GIFT_IDS.length === 0) {
    console.error("No GIFT_IDS provided. Set GIFT_IDS=id1,id2,... env var.");
    return;
  }

  // Round-robin gift selection across VUs
  const giftId = GIFT_IDS[__VU % GIFT_IDS.length];

  const payload = JSON.stringify({
    giftId,
    recipientStellarKey: STELLAR_KEY,
  });

  const params = {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /api/v1/gifts/:id/claim" },
  };

  const res = http.post(
    `${BASE_URL}/api/v1/gifts/${giftId}/claim`,
    payload,
    params
  );

  claimDuration.add(res.timings.duration);

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "response has txHash": (r) => {
      try {
        return JSON.parse(r.body).data?.txHash !== undefined;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);

  sleep(0.2); // 200 ms think time
}

// ─── Summary export (for CI baseline comparison) ──────────────────────────────
export function handleSummary(data) {
  const out = __ENV.RESULTS_FILE || "load-tests/results/gift-claim-summary.json";
  return {
    [out]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}

import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";
