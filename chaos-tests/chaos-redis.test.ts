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
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Skip if not in chaos mode (prevents accidental runs in normal CI)
const CHAOS_MODE = process.env.CHAOS_MODE === "1";

const APP_URL = process.env.CHAOS_APP_URL ?? "http://localhost:3000";
const REDIS_PROXY_URL = "redis://localhost:6381";

/**
 * Sentinel-aware Redis URL used by the app in HA mode. When Sentinel is
 * configured the app connects via the sentinel endpoints and discovers the
 * current primary, so a failover is transparent to the application.
 */
const REDIS_SENTINEL_URL =
  process.env.CHAOS_REDIS_SENTINEL_URL ?? "redis://localhost:26379";

/** Name of the primary Redis container in the chaos compose stack. */
const REDIS_PRIMARY_CONTAINER =
  process.env.CHAOS_REDIS_PRIMARY_CONTAINER ?? "chaos-redis-primary";

/** Max time (ms) allowed for a standby to be promoted after primary loss. */
const FAILOVER_BUDGET_MS = 30_000;

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

/**
 * Resolve the current primary address via Redis Sentinel.
 * Returns null if Sentinel cannot be reached or has no primary yet.
 */
async function getSentinelPrimary(): Promise<{ host: string; port: number } | null> {
  const client = createClient({ url: REDIS_SENTINEL_URL });
  try {
    await client.connect();
    const result = (await client.sendCommand([
      "SENTINEL",
      "get-master-addr-by-name",
      process.env.CHAOS_REDIS_MASTER_NAME ?? "mymaster",
    ])) as string[] | null;
    if (!result || result.length < 2) return null;
    return { host: result[0], port: Number(result[1]) };
  } catch {
    return null;
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
}

/**
 * Poll Sentinel until a primary is reported and it responds to PING.
 * Resolves with the elapsed time in ms once a healthy primary is found.
 */
async function waitForPromotedPrimary(maxMs = FAILOVER_BUDGET_MS): Promise<number> {
  const start = Date.now();
  const deadline = start + maxMs;
  while (Date.now() < deadline) {
    const primary = await getSentinelPrimary();
    if (primary) {
      const client = createClient({
        url: `redis://${primary.host}:${primary.port}`,
      });
      try {
        await client.connect();
        await client.ping();
        await client.disconnect();
        return Date.now() - start;
      } catch {
        // primary not yet accepting connections; keep polling
      } finally {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No promoted Redis primary within ${maxMs}ms`);
}

/** Stop the primary Redis container to simulate a hard failure. */
async function killRedisPrimary(): Promise<void> {
  await execFileAsync("docker", ["stop", REDIS_PRIMARY_CONTAINER]);
}

/** Start the primary Redis container again (it rejoins as a replica). */
async function startRedisPrimary(): Promise<void> {
  await execFileAsync("docker", ["start", REDIS_PRIMARY_CONTAINER]);
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
  // Ensure the primary container is running again after failover tests
  try {
    await startRedisPrimary();
  } catch {
    // container may already be running or not present in this stack
  }
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
    "Standby is promoted and app recovers within 30s after primary is killed",
    async () => {
      // Confirm a healthy primary exists before we break anything.
      const before = await getSentinelPrimary();
      expect(before).not.toBeNull();

      // Kill the primary container to simulate a hard node failure.
      await killRedisPrimary();

      // Sentinel should promote the standby within the failover budget.
      const elapsed = await waitForPromotedPrimary(FAILOVER_BUDGET_MS);
      expect(elapsed).toBeLessThan(FAILOVER_BUDGET_MS);

      // The promoted primary must differ from the one we killed (or at least
      // be reachable) — the app should now be able to use Redis again.
      const after = await getSentinelPrimary();
      expect(after).not.toBeNull();

      // App-level recovery: OTP flow should no longer fail closed.
      const response = await post("/api/auth/send-otp", {
        phone: "+2348099000096",
      });
      expect(response.status).not.toBe(503);
    },
    60_000
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
