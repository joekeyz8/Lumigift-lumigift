# Redis Failure Policy

Redis is required for security-sensitive state. Redis errors must never trigger an in-memory or permissive fallback for authentication, OTP verification, or rate limiting.

## High Availability Topology

Production Redis runs as a replicated deployment with automatic failover. Either of the following is acceptable:

- **Redis Sentinel**: one primary, at least one replica, and a quorum of at least three Sentinel processes (an odd number) monitoring the deployment. Sentinels agree on failure detection and promote a replica.
- **ElastiCache for Redis (cluster mode disabled) with Multi-AZ automatic failover**: the managed equivalent, where AWS promotes the standby replica.

The application connects through the `redis` client configured with Sentinel support (`redis.sentinel.Sentinel` / `SentinelConnectionPool`) or the managed primary endpoint, so it never hardcodes a single instance address. Replicas are read-only; all writes go to the current primary.

## Automatic Failover Behavior

- Sentinels (or the managed service) detect an unresponsive primary via `down-after-milliseconds` and reach quorum.
- A replica is promoted to primary and the remaining replicas are reconfigured to follow it. Target promotion time is **within 30 seconds**; this is the SLO validated in staging.
- During the failover window, writes fail with connection errors. Per the table above, security-sensitive operations fail closed (HTTP 503) rather than falling back; clients may retry after the new primary is elected.

## How the Application Discovers the New Primary

- With Sentinel, the client's `SentinelConnectionPool` asks the Sentinels for the current primary address on each new connection and re-resolves after a `MasterNotFoundError`/connection failure, so it reconnects to the promoted replica automatically.
- With ElastiCache, the client reconnects to the primary endpoint, which DNS re-points to the promoted node; the client retries with backoff.
- The client records failover-related connection errors in the existing low-cardinality failure counters (`metrics.redis`) so operators can see the outage and recovery.

## Verifying Failover in Staging

1. Confirm the current primary: `redis-cli -h <sentinel> -p 26379 SENTINEL get-master-addr-by-name <master-name>` (or check the ElastiCache primary endpoint).
2. Kill the primary: stop the process/instance (e.g. `redis-cli -h <primary> SHUTDOWN NOSAVE`, or terminate the instance in the console).
3. Watch promotion: poll the Sentinel command above (or the console events) and confirm a new primary address is reported **within 30 seconds**.
4. Confirm the application reconnects: exercise a Redis-backed path (e.g. an OTP rate-limit check or `/api/health`) and verify `checks.redis` returns to healthy and `metrics.redis` failure counters stop increasing.
5. Record the observed promotion time and any 503s during the window.

This procedure is automated by the Redis failure chaos test scenario (see `docs/ops/chaos-tests.md`), which kills the primary, asserts promotion within 30s, and asserts the application reconnects and resumes serving.

| Operation                                           | Policy when Redis is unavailable                                                                                                                                                                                              | Reason                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| OTP rate-limit checks                               | Fail closed with HTTP 503; do not send an OTP                                                                                                                                                                                 | A local fallback would reset across instances and allow limit bypasses.                                                  |
| OTP persistence and verification                    | Fail closed; do not deliver an OTP that cannot be verified, and never accept a code without Redis verification                                                                                                                | OTP state and attempt counts are security controls.                                                                      |
| Payment webhook idempotency and keyed gift requests | Fail closed if the initial Redis lookup fails. A failure while storing the result after a side effect returns an error and may cause a retry; the side effect must also be idempotent. Gift idempotency keys remain optional. | Redis cannot make a remote payment or database side effect atomic.                                                       |
| Event-indexer cursor reads/writes                   | Fail closed and return a failed cron run; do not advance an in-memory cursor                                                                                                                                                  | A retry can replay events idempotently; skipping persisted progress can lose events.                                     |
| Non-OTP notification delivery                       | Continue delivery if Redis deduplication fails; log the outage and accept possible duplicate delivery                                                                                                                         | Delivery is best-effort and does not authorize or mutate gift state. OTP dispatch still fails closed at OTP persistence. |
| Health checks                                       | Continue checking other dependencies and report Redis as degraded                                                                                                                                                             | One failed dependency should not hide the state of the others.                                                           |

The Redis client records low-cardinality failure counters by operation and the time of the most recent failure. `/api/health` exposes these counters under `metrics.redis`; the existing `checks.redis` field remains the current dependency status. The client logs Redis errors without command arguments or credentials.

No security-sensitive operation may fail open. A future best-effort feature may continue without Redis only when its caller has an independent source of truth and explicitly documents that fallback.
