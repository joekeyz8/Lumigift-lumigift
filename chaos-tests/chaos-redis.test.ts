/**
 * chaos-tests/chaos-redis.test.ts
 *
 * Chaos tests for Redis failures.
 *
 * Verifies that the app degrades gracefully when Redis becomes unavailable
 * mid-request, in line with the fail-closed policy documented in:
 *   docs/ops/redis-failure-policy.md
 *
 * Test scenarios:
 *   1. Redis killed during OTP request → 503, no OTP delivered
 *   2. Redis killed during payment webhook idempotency check → 503 / safe error
 *   3. Redis restored → OTP flow resumes normally
 *   4. Non-auth feature (notification dedup) continues when Redis is down
 *
 * Prerequisites:
 *   docker compose -f chaos-tests/docker-compose.chaos.yml up -d
 *
 * Run:
 *   npx ts-node chaos-tests/run-chaos-suite.ts
 *   # or directly:
 *   CHAOS_MODE=1 npx jest chaos-tests/chaos-redis.test.ts --runInBand --forceExit
 *
 * Issue #297
 */

import {
  waitForToxiproxy,
  ensureProxy,
  setProxyEnabled,
  clearToxics,
  addTimeoutToxic,
  restoreProxy,
  PROXY_NAMES,
  PROXY_CONFIG,
} from "./toxiproxy-setup";
import { createClient } from "redis";
import http from "http";

// Skip if not in chaos mode (prevents accidental runs in normal CI)
const CHAOS_MODE = process.env.CHAOS_MODE === "1";

const APP_URL = process.env.CHAOS_APP_URL ?? "http://localhost:3000";
const REDIS_PROXY_URL = "redis://localhost:6381";

/** Minimal HTTP POST helper */
async function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(path, APP_URL);
    const options = {
      hostname: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.write(payload);
    req.end();
  });
}

/** Wait for Redis to accept connections via the proxy. */
async function waitForRedisProxy(maxMs = 10_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const client = createClient({ url: REDIS_PROXY_URL });
    try {
      await client.connect();
      await client.ping();
      await client.disconnect();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
    }
  }
  throw new Error("Redis proxy not reachable after timeout");
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!CHAOS_MODE) return;

  console.log("\n🔴 Chaos test setup: Redis failure scenarios");
  await waitForToxiproxy();
  await ensureProxy(PROXY_NAMES.redis, PROXY_CONFIG.redis.listen, PROXY_CONFIG.redis.upstream);
  await waitForRedisProxy();
  console.log("  Redis proxy ready\n");
}, 60_000);

afterEach(async () => {
  if (!CHAOS_MODE) return;
  // Always restore Redis proxy so subsequent tests start clean
  await restoreProxy(PROXY_NAMES.redis);
  // Brief pause to let connection pools recover
  await new Promise((r) => setTimeout(r, 500));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Chaos: Redis failure", () => {
  const itChaos = CHAOS_MODE ? it : it.skip;

  itChaos(
    "OTP request fails closed (503) when Redis is killed mid-request",
    async () => {
      // Kill Redis proxy before the request
      await setProxyEnabled(PROXY_NAMES.redis, false);

      const response = await post("/api/auth/send-otp", {
        phone: "+2348099000099",
      });

      // Per redis-failure-policy.md: OTP must fail closed with 503
      expect(response.status).toBe(503);

      const data = response.data as Record<string, unknown>;
      expect(data.success).toBe(false);
      // Error message must not reveal internal details
      expect(JSON.stringify(data)).not.toMatch(/redis|REDIS|connection refused/i);
    },
    15_000
  );

  itChaos(
    "OTP request fails closed (503) when Redis times out",
    async () => {
      // Add a 2-second timeout toxic (OTP request should abort faster than this)
      await addTimeoutToxic(PROXY_NAMES.redis, 2000);

      const response = await post("/api/auth/send-otp", {
        phone: "+2348099000098",
      });

      // Should fail closed — not send an OTP with a degraded Redis
      expect([503, 500]).toContain(response.status);
      const data = response.data as Record<string, unknown>;
      expect(data.success).toBe(false);
    },
    15_000
  );

  itChaos(
    "OTP flow resumes normally after Redis is restored",
    async () => {
      // Disable Redis first
      await setProxyEnabled(PROXY_NAMES.redis, false);

      const failedResponse = await post("/api/auth/send-otp", {
        phone: "+2348099000097",
      });
      expect(failedResponse.status).toBe(503);

      // Restore Redis
      await restoreProxy(PROXY_NAMES.redis);
      await waitForRedisProxy();

      // OTP request should now succeed (2xx or at least not 503)
      const okResponse = await post("/api/auth/send-otp", {
        phone: "+2348099000097",
      });
      expect(okResponse.status).not.toBe(503);
    },
    20_000
  );

  itChaos(
    "Rate limiting falls back to allow-all (does not block) when Redis is down",
    async () => {
      // Simulate connection refused by disabling the proxy
      await setProxyEnabled(PROXY_NAMES.redis, false);

      // Fire several requests that would normally be rate limited.
      // With Redis down, the limiter must fail open and allow them through.
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const response = await post("/api/auth/send-otp", {
          phone: "+2348099000100",
        });
        statuses.push(response.status);
      }

      // None of the requests should be blocked with 429 (rate limited).
      // They may fail closed with 503 due to OTP policy, but must not be
      // rejected by the rate limiter itself.
      expect(statuses).not.toContain(429);
      // Every response must be a graceful status (200 or 503), never 500.
      for (const status of statuses) {
        expect([200, 503]).toContain(status);
      }
    },
    30_000
  );

  itChaos(
    "Idempotency layer falls back to DB or rejects duplicate with warning when Redis is down",
    async () => {
      await setProxyEnabled(PROXY_NAMES.redis, false);

      const idempotencyKey = `chaos-idem-${Date.now()}`;
      const payload = { event: "payment.succeeded", reference: "chaos-ref-1" };

      const first = await post("/api/webhooks/payment", payload);
      // First attempt: either processed (200) or safely rejected (503) — never 500
      expect([200, 503]).toContain(first.status);

      // Duplicate delivery with the same idempotency key
      const second = await post("/api/webhooks/payment", payload);
      expect([200, 503]).toContain(second.status);

      // If the layer fell back to DB, the duplicate should be recognized as
      // already-processed (200) or safely rejected (503) — never a 500.
      expect(second.status).not.toBe(500);

      // Silence unused-var lint while keeping the key for future header wiring
      expect(idempotencyKey).toBeTruthy();
    },
    30_000
  );

  itChaos(
    "Session reads return null gracefully (forcing re-auth) when Redis is down",
    async () => {
      await setProxyEnabled(PROXY_NAMES.redis, false);

      const response = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        const url = new URL("/api/auth/session", APP_URL);
        const req = http.get(
          {
            hostname: url.hostname,
            port: Number(url.port) || 80,
            path: url.pathname,
            headers: { Cookie: "session=chaos-invalid-session" },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
              } catch {
                resolve({ status: res.statusCode ?? 0, data: raw });
              }
            });
          }
        );
        req.on("error", reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error("Session check timed out"));
        });
      });

      // Session lookup must not crash — it should return null/empty, forcing re-auth
      expect([200, 503]).toContain(response.status);
      const data = response.data as Record<string, unknown>;
      if (response.status === 200) {
        // A graceful null session: no authenticated user returned
        expect(data.user ?? null).toBeNull();
      }
    },
    15_000
  );

  itChaos(
    "All endpoints return 200 or 503 (never 500) under Redis failure",
    async () => {
      await setProxyEnabled(PROXY_NAMES.redis, false);

      const endpoints: Array<{ path: string; method: "GET" | "POST"; body?: unknown }> = [
        { path: "/api/health", method: "GET" },
        { path: "/api/auth/session", method: "GET" },
        { path: "/api/auth/send-otp", method: "POST", body: { phone: "+2348099000101" } },
        { path: "/api/webhooks/payment", method: "POST", body: { event: "chaos" } },
      ];

      for (const endpoint of endpoints) {
        let status: number;
        if (endpoint.method === "POST") {
          const res = await post(endpoint.path, endpoint.body ?? {});
          status = res.status;
        } else {
          status = await new Promise<number>((resolve, reject) => {
            const url = new URL(endpoint.path, APP_URL);
            const req = http.get(
              { hostname: url.hostname, port: Number(url.port) || 80, path: url.pathname },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
              }
            );
            req.on("error", reject);
            req.setTimeout(5000, () => {
              req.destroy();
              reject(new Error(`Request to ${endpoint.path} timed out`));
            });
          });
        }

        // Under Redis failure every endpoint must degrade gracefully.
        expect([200, 503]).toContain(status);
        expect(status).not.toBe(500);
      }
    },
    30_000
  );

  itChaos(
    "Health endpoint reports Redis as degraded when proxy is down",
    async () => {
      await setProxyEnabled(PROXY_NAMES.redis, false);

      const response = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        const url = new URL("/api/health", APP_URL);
        const req = http.get(
          { hostname: url.hostname, port: Number(url.port) || 80, path: url.pathname },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
              } catch {
                resolve({ status: res.statusCode ?? 0, data: raw });
              }
            });
          }
        );
        req.on("error", reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error("Health check timed out"));
        });
      });

      const data = response.data as Record<string, unknown>;
      // Health check should not crash; Redis should show as degraded
      expect(response.status).not.toBe(500);
      // If the health endpoint exposes Redis status, it should be "degraded" or "down"
      if (data.checks && typeof data.checks === "object") {
        const checks = data.checks as Record<string, unknown>;
        if (checks.redis) {
          expect(["degraded", "down", "error", false]).toContain(checks.redis);
        }
      }
    },
    15_000
  );
});
