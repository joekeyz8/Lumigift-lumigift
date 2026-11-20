/**
 * chaos-tests/chaos-postgres.test.ts
 *
 * Chaos tests for Postgres failures.
 *
 * Verifies that the app returns structured error responses (not 500 crashes)
 * when the database becomes unavailable mid-request.
 *
 * Test scenarios:
 *   1. Postgres killed → API returns 503 (not unhandled 500 crash)
 *   2. Postgres times out → API returns structured error
 *   3. Postgres restored → requests succeed
 *   4. Health endpoint reports Postgres as degraded (not crashed)
 *
 * Prerequisites:
 *   docker compose -f chaos-tests/docker-compose.chaos.yml up -d
 *
 * Run:
 *   npx ts-node chaos-tests/run-chaos-suite.ts
 *   # or directly:
 *   CHAOS_MODE=1 npx jest chaos-tests/chaos-postgres.test.ts --runInBand --forceExit
 *
 * Issue #297
 */

import {
  waitForToxiproxy,
  ensureProxy,
  setProxyEnabled,
  addTimeoutToxic,
  addLatencyToxic,
  restoreProxy,
  PROXY_NAMES,
  PROXY_CONFIG,
} from "./toxiproxy-setup";
import { Pool } from "pg";
import http from "http";

const CHAOS_MODE = process.env.CHAOS_MODE === "1";

const APP_URL = process.env.CHAOS_APP_URL ?? "http://localhost:3000";
const PG_PROXY_URL = "postgresql://lumigift:lumigift@localhost:5434/lumigift_chaos";

/** Minimal HTTP request helpers */
async function httpRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const url = new URL(path, APP_URL);
    const options = {
      hostname: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
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
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** Wait for Postgres to accept connections via the proxy. */
async function waitForPgProxy(maxMs = 15_000): Promise<void> {
  const pool = new Pool({ connectionString: PG_PROXY_URL });
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  await pool.end().catch(() => {});
  throw new Error("Postgres proxy not reachable after timeout");
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!CHAOS_MODE) return;

  console.log("\n🔴 Chaos test setup: Postgres failure scenarios");
  await waitForToxiproxy();
  await ensureProxy(
    PROXY_NAMES.postgres,
    PROXY_CONFIG.postgres.listen,
    PROXY_CONFIG.postgres.upstream
  );
  await waitForPgProxy();
  console.log("  Postgres proxy ready\n");
}, 60_000);

afterEach(async () => {
  if (!CHAOS_MODE) return;
  await restoreProxy(PROXY_NAMES.postgres);
  await new Promise((r) => setTimeout(r, 500));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Chaos: Postgres failure", () => {
  const itChaos = CHAOS_MODE ? it : it.skip;

  /** Assert a response body leaks no stack traces, connection strings or secrets. */
  function expectNoSensitiveData(data: unknown): void {
    const serialized = JSON.stringify(data ?? "");
    // Stack traces / internal file paths
    expect(serialized).not.toMatch(
      /at Object\.|at Function\.|at async |\.ts:\d+:\d+|\.js:\d+:\d+|node_modules/
    );
    // Connection strings / credentials
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/password|passwd|secret|api[_-]?key/i);
    // Raw driver error internals
    expect(serialized).not.toMatch(/ECONNREFUSED|ETIMEDOUT|EPIPE/);
  }

  itChaos(
    "API returns 503 (not unhandled 500) when Postgres is killed",
    async () => {
      // Kill the Postgres proxy
      await setProxyEnabled(PROXY_NAMES.postgres, false);

      // Attempt a read endpoint (gifts list or health) — any DB-touching route
      const response = await httpRequest("GET", "/api/v1/gifts");

      // DB-touching endpoints must degrade gracefully with 503, never 500
      expect(response.status).toBe(503);

      const data = response.data as Record<string, unknown>;
      expect(data.success).toBe(false);
      expectNoSensitiveData(data);
    },
    15_000
  );

  itChaos(
    "API returns structured error when Postgres times out",
    async () => {
      // Inject a 3-second timeout (most DB queries should timeout before this)
      await addTimeoutToxic(PROXY_NAMES.postgres, 3000);

      const response = await httpRequest("GET", "/api/v1/gifts");

      // Timeout must surface as 503, not 500
      expect(response.status).toBe(503);
      const data = response.data as Record<string, unknown>;

      // Body must be valid JSON with an error field
      expect(typeof data).toBe("object");
      expect(data.success).toBe(false);
      expectNoSensitiveData(data);
    },
    15_000
  );

  itChaos(
    "API returns structured error during Postgres high latency",
    async () => {
      // Simulate high latency (5s) — exceeds most request timeouts
      await addLatencyToxic(PROXY_NAMES.postgres, 5000, 500);

      const response = await httpRequest("GET", "/api/health");

      // Should not hang forever or crash — must return a response
      expect(response.status).toBeGreaterThanOrEqual(200);
    },
    20_000
  );

  itChaos(
    "Connection pool reconnects and requests succeed after Toxiproxy is restored",
    async () => {
      // Kill the proxy
      await setProxyEnabled(PROXY_NAMES.postgres, false);

      const failedResponse = await httpRequest("GET", "/api/v1/gifts");
      // Should fail gracefully with 503
      expect(failedResponse.status).toBe(503);
      expectNoSensitiveData(failedResponse.data);

      // Restore the proxy
      await restoreProxy(PROXY_NAMES.postgres);
      await waitForPgProxy();

      // The app's connection pool must reconnect — retry briefly to allow
      // stale/broken pooled connections to be evicted and replaced.
      const deadline = Date.now() + 10_000;
      let okResponse = await httpRequest("GET", "/api/v1/gifts");
      while (okResponse.status !== 200 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        okResponse = await httpRequest("GET", "/api/v1/gifts");
      }

      expect(okResponse.status).toBe(200);

      // Health endpoint should also report healthy again
      const healthResponse = await httpRequest("GET", "/api/health");
      expect(healthResponse.status).toBe(200);
    },
    30_000
  );

  itChaos(
    "Health endpoint reports Postgres as degraded (not a 500 crash)",
    async () => {
      await setProxyEnabled(PROXY_NAMES.postgres, false);

      const response = await httpRequest("GET", "/api/health");

      const data = response.data as Record<string, unknown>;

      // Health must not crash with 500 / no body — degrade to 503
      expect(response.status).not.toBe(500);
      expect([200, 503]).toContain(response.status);
      expectNoSensitiveData(data);

      // If structured health response, Postgres should be degraded / down
      if (data.checks && typeof data.checks === "object") {
        const checks = data.checks as Record<string, unknown>;
        if (checks.database || checks.postgres || checks.db) {
          const dbStatus = checks.database ?? checks.postgres ?? checks.db;
          expect(["degraded", "down", "error", false]).toContain(dbStatus);
        }
      }
    },
    15_000
  );
});
