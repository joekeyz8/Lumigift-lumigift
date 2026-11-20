# ADR-0011: Redis Cache Strategy

## Status

Accepted

## Date

2024-01-01

## Context

The application runs on serverless infrastructure where each request may be handled by a different, short-lived instance. This creates two distinct needs:

1. **Shared caching** — Expensive read queries (e.g. public listings, aggregate statistics) should not hit the database on every request. Because instances are ephemeral and not guaranteed to be reused, an in-process cache cannot provide consistent, shared state across the fleet.
2. **Ephemeral shared state** — Some flows require short-lived state that must be visible across instances, such as WebAuthn challenge values (which must be verified on a subsequent request that may land on a different instance) and export payloads (which are generated once and then downloaded).

A single, shared, low-latency store is needed to satisfy both needs. Redis is a natural fit: it is fast, supports TTL-based expiry natively, and is widely supported by managed hosting providers.

This ADR builds on the general caching approach described in [ADR-0007: Caching Strategy](./0007-caching-strategy.md), and focuses specifically on how Redis is used and integrated.

## Decision

We will use a single Redis instance as the shared cache and ephemeral state store, integrated as follows:

### Redis client singleton

- A single Redis client is created and reused as a module-level singleton in `src/lib/redis.ts`. This avoids opening a new connection per request, which would be costly in a serverless environment.
- The client is instrumented with **failure metrics**: connection errors and command failures are counted/recorded so that Redis problems are observable rather than silent.

### Cached JSON responses

- A `cachedJsonResponse` helper in `src/lib/cache.ts` wraps read endpoints. It:
  - Computes a cache key for the request.
  - Returns the cached JSON payload on a hit, or invokes the underlying handler on a miss and stores the result with a **TTL**.
  - Sets appropriate **`Cache-Control` headers** on the response so downstream caches and clients behave correctly.

### Cacheability by endpoint type

- **Public endpoints** (data that is the same for all users) are cacheable and use the shared Redis cache with a TTL.
- **User-specific endpoints** (data scoped to the authenticated user) are marked `private` / `no-store` and are **not** stored in the shared cache, to avoid leaking one user's data to another.

### Ephemeral state beyond response caching

Redis is also used for short-lived, cross-instance state:

- **WebAuthn challenges** — The challenge issued during registration/authentication is stored in Redis with a short TTL and consumed on verification, ensuring it is available regardless of which instance handles the follow-up request.
- **Export payloads** — Generated export data is stored temporarily in Redis with a TTL so it can be downloaded without regenerating it, and without requiring sticky sessions.

## Consequences

### Positive

- **Reduced latency** — Cached responses are served from Redis instead of recomputing expensive queries.
- **Reduced database load** — Public, cacheable reads no longer hit the database on every request.
- **Correct cross-instance behaviour** — WebAuthn challenges and export payloads work reliably across ephemeral serverless instances.
- **Observability** — Failure metrics make Redis issues visible before they become user-facing outages.

### Negative

- **Cache invalidation complexity** — Deciding when to invalidate or expire cached entries adds complexity; stale data is possible within the TTL window.
- **Operational dependency** — Redis becomes part of the critical path for cached reads and ephemeral flows.
- **Graceful degradation required** — On a Redis outage, the system must fall back to computing results directly (cache miss behaviour) rather than failing requests. This degrades performance but preserves correctness.

## Alternatives Considered

- **In-memory cache** — Simple and dependency-free, but ineffective on serverless infrastructure: instances are ephemeral and not shared, so cache hit rates would be low and ephemeral state (WebAuthn challenges, exports) could not be reliably retrieved on a subsequent request.
- **CDN-only caching** — Good for fully public, static-ish responses, but cannot store user-scoped ephemeral state, cannot serve as a general-purpose key/value store for challenges and exports, and offers no fine-grained TTL control for application data.
- **No cache** — Simplest to reason about, but would increase latency and database load significantly and would not solve the cross-instance ephemeral state problem at all.

## References

- `src/lib/redis.ts` — Redis client singleton and failure metrics
- `src/lib/cache.ts` — `cachedJsonResponse` helper and cache key/TTL logic
- [ADR-0007: Caching Strategy](./0007-caching-strategy.md)