import { Pool, type PoolConfig } from "pg";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { serverConfig } from "@/server/config";

/**
 * Credentials resolved from AWS Secrets Manager (issue #556).
 * The secret JSON is expected to contain the standard RDS rotation fields:
 *   { username, password, host, port, dbname }
 * `host`/`port`/`dbname` are optional and fall back to config so the same
 * secret shape works for both primary and replica endpoints (issue #560).
 */
interface DbCredentials {
  username: string;
  password: string;
  host?: string;
  port?: number;
  dbname?: string;
}

let secretsClient: SecretsManagerClient | undefined;

function getSecretsClient(): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({
      region: serverConfig.database.secretsManagerRegion,
    });
  }
  return secretsClient;
}

/**
 * Fetches the current DB credentials from Secrets Manager. When no secret ARN
 * is configured (local dev, tests) this returns undefined so callers fall back
 * to the static DATABASE_URL connection string.
 */
async function fetchCredentials(): Promise<DbCredentials | undefined> {
  const secretId = serverConfig.database.secretsManagerSecretArn;
  if (!secretId) return undefined;

  const res = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  if (!res.SecretString) {
    throw new Error("[db] Secrets Manager returned no SecretString");
  }
  return JSON.parse(res.SecretString) as DbCredentials;
}

/**
 * Builds a pg connection string from resolved credentials, parameterised by
 * the configured primary/replica endpoint so failover (issue #560) only needs
 * a config change rather than a code change.
 */
function buildConnectionString(
  creds: DbCredentials | undefined,
  endpoint: string | undefined,
  fallback: string
): string {
  if (!creds) return fallback;
  const host = endpoint ?? creds.host;
  if (!host) return fallback;
  const port = creds.port ?? 5432;
  const dbname = creds.dbname ?? "postgres";
  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);
  return `postgres://${user}:${pass}@${host}:${port}/${dbname}`;
}

function poolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    min: serverConfig.database.poolMin,
    max: serverConfig.database.poolMax,
    idleTimeoutMillis: serverConfig.database.idleTimeoutMs,
    connectionTimeoutMillis: serverConfig.database.connectionTimeoutMs,
  };
}

function attachPoolListeners(target: Pool, label: string) {
  target.on("connect", () => {
    // Fires for each new physical connection added to the pool
  });
  target.on("error", (err) => {
    console.error(`[db] Unexpected ${label} pool error:`, err.message);
  });
}

/**
 * Active pools. These are reassigned atomically during a blue-green swap so
 * that importers always see the current pool. Consumers must reference the
 * exported `pool`/`readPool` bindings rather than caching them at module load.
 */
let activePool: Pool;
let activeReadPool: Pool;

/**
 * Creates a fresh pool for the given connection string and verifies it can
 * serve queries before it is promoted to active.
 */
async function createHealthyPool(
  connectionString: string,
  label: string
): Promise<Pool> {
  const candidate = new Pool(poolConfig(connectionString));
  attachPoolListeners(candidate, label);
  try {
    await candidate.query("SELECT 1");
  } catch (err) {
    await candidate.end().catch(() => undefined);
    throw err;
  }
  return candidate;
}

/**
 * Blue-green swap: build a new pool with the latest credentials, health-check
 * it, atomically swap the exported reference, then drain the old pool once its
 * in-flight queries complete. This keeps rotation downtime-free (issue #556).
 */
async function swapPool(
  current: Pool,
  connectionString: string,
  label: string
): Promise<Pool> {
  const next = await createHealthyPool(connectionString, label);
  // Atomic reference swap — new queries use `next` immediately.
  const previous = current;
  if (label === "primary") {
    activePool = next;
  } else {
    activeReadPool = next;
  }
  // Drain the old pool after in-flight queries finish.
  previous.end().catch((err) => {
    console.error(`[db] Error draining old ${label} pool:`, err.message);
  });
  return next;
}

/**
 * Re-resolves credentials from Secrets Manager and performs a blue-green pool
 * swap. Safe to call from a rotation event or a periodic poll; concurrent calls
 * are serialised so only one swap runs at a time.
 */
let refreshInFlight: Promise<void> | undefined;

export function refreshCredentials(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const creds = await fetchCredentials();
      const primaryUrl = buildConnectionString(
        creds,
        serverConfig.database.primaryEndpoint,
        serverConfig.database.url
      );
      await swapPool(activePool, primaryUrl, "primary");

      if (serverConfig.database.readReplicaUrl) {
        const replicaUrl = buildConnectionString(
          creds,
          serverConfig.database.readReplicaEndpoint,
          serverConfig.database.readReplicaUrl
        );
        await swapPool(activeReadPool, replicaUrl, "read replica");
      }
    } finally {
      refreshInFlight = undefined;
    }
  })();
  return refreshInFlight;
}

// Bootstrap the pools synchronously with the static connection string so the
// module is usable immediately; refreshCredentials() upgrades to Secrets
// Manager credentials once resolved.
activePool = new Pool(poolConfig(serverConfig.database.url));
attachPoolListeners(activePool, "primary");

activeReadPool = serverConfig.database.readReplicaUrl
  ? new Pool(poolConfig(serverConfig.database.readReplicaUrl))
  : activePool;
if (activeReadPool !== activePool) {
  attachPoolListeners(activeReadPool, "read replica");
}

/**
 * The active primary pool. Always read through this binding (do not cache it)
 * so that a blue-green swap is observed by callers.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const value = Reflect.get(activePool, prop, activePool);
    return typeof value === "function" ? value.bind(activePool) : value;
  },
});

/**
 * Read-only pool for GET endpoints (dashboard, gift lookup). Connects to the
 * replica endpoint when configured; otherwise it is the primary pool, so local
 * dev and single-instance deployments need no extra configuration. Never use it
 * for writes or for reads that must see a just-committed write.
 */
export const readPool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const value = Reflect.get(activeReadPool, prop, activeReadPool);
    return typeof value === "function" ? value.bind(activeReadPool) : value;
  },
});

/**
 * Returns a snapshot of the current connection pool metrics.
 * Suitable for inclusion in health-check responses.
 *
 * Fields:
 *   total       — total physical connections (idle + active)
 *   idle        — connections sitting in the pool waiting for work
 *   waiting     — client.connect() calls queued waiting for a free slot
 *   min         — configured pool minimum
 *   max         — configured pool maximum
 *   idleTimeout — idle timeout in ms
 *   connectionTimeout — connection acquisition timeout in ms
 */
export interface PoolMetrics {
  total: number;
  idle: number;
  waiting: number;
  min: number;
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export function getPoolMetrics(): PoolMetrics {
  return {
    total: activePool.totalCount,
    idle: activePool.idleCount,
    waiting: activePool.waitingCount,
    min: serverConfig.database.poolMin,
    max: serverConfig.database.poolMax,
    idleTimeoutMs: serverConfig.database.idleTimeoutMs,
    connectionTimeoutMs: serverConfig.database.connectionTimeoutMs,
  };
}

/**
 * Logs the current connection pool configuration and live metrics to stdout.
 * Useful for verifying pool settings on application startup.
 */
export function logPoolMetrics() {
  const m = getPoolMetrics();
  console.log(
    `[db] Pool ready — min: ${m.min}, max: ${m.max}, ` +
      `idleTimeout: ${m.idleTimeoutMs}ms, connectionTimeout: ${m.connectionTimeoutMs}ms | ` +
      `live: total=${m.total}, idle=${m.idle}, waiting=${m.waiting}`
  );
}

/**
 * Gracefully drains and closes all connections in the pool.
 * Should be called during application shutdown to avoid connection leaks.
 *
 * @returns Resolves when all connections have been closed.
 */
export async function closePool() {
  await activePool.end();
  if (activeReadPool !== activePool) await activeReadPool.end();
  console.log("[db] Pool closed.");
}

export default pool;
