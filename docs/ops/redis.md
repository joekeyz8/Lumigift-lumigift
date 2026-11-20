# Redis Operations

## Configuration

Redis is configured with **AOF (Append Only File)** persistence and **RDB snapshots**
to prevent data loss of OTP codes, job queues, and rate-limit state on restart.

### Persistence settings

| Setting          | Value            | Reason                                                             |
| ---------------- | ---------------- | ------------------------------------------------------------------ |
| `appendonly`     | `yes`            | Enables AOF persistence                                            |
| `appendfsync`    | `everysec`       | Flushes to disk every second — balances durability and performance |
| `appendfilename` | `appendonly.aof` | AOF file name                                                      |
| `dir`            | `/data`          | Persistent volume mount point                                      |
| `save 3600 1`    | RDB snapshot     | Write RDB if ≥1 key changed in 1 hour                              |
| `save 300 100`   | RDB snapshot     | Write RDB if ≥100 keys changed in 5 minutes                        |
| `save 60 10000`  | RDB snapshot     | Write RDB if ≥10 000 keys changed in 1 minute                      |

### Why both AOF and RDB?

AOF provides near-real-time durability (at most 1 second of data loss); RDB provides
compact recovery snapshots. Using both gives a fast startup path from RDB and
fine-grained recovery from AOF.

## Replication

### Local / development

`docker-compose.yml` defines a `redis-replica` service that automatically follows
the primary (`redis`) using `--replicaof redis 6379`. It is exposed on port **6380**.

```bash
# Start both primary and replica
docker compose up -d redis redis-replica

# Verify replication is running
docker compose exec redis-replica redis-cli info replication
# Expected: role:slave, master_link_status:up
```

### Production

Production **must not** run a single Redis instance. Use one of the following
high-availability topologies:

| Provider    | Option                                   |
| ----------- | ---------------------------------------- |
| AWS         | ElastiCache Multi-AZ with auto-failover  |
| GCP         | Memorystore with read replica            |
| Upstash     | Multi-region replication                 |
| Self-hosted | Redis Sentinel (≥3 sentinels, ≥1 replica) |

#### Application connection modes

The application uses the `redis` client, which supports Sentinel and Cluster
topologies natively. The mode is selected by environment variables:

| Env var               | Format                                | Purpose                                                       |
| --------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `REDIS_URL`           | `redis://host:6379`                   | Single-node / primary endpoint (dev, or managed failover)     |
| `REDIS_SENTINELS`     | `host1:26379,host2:26379,host3:26379` | Comma-separated Sentinel endpoints (enables Sentinel mode)    |
| `REDIS_SENTINEL_NAME` | `mymaster`                            | Sentinel master set name (required with `REDIS_SENTINELS`)    |
| `REDIS_CLUSTER_NODES` | `host1:6379,host2:6379,host3:6379`    | Comma-separated cluster seed nodes (enables Cluster mode)     |
| `REDIS_READ_URL`      | `redis://host:6380`                   | Optional read-replica endpoint for read-only workloads        |

Resolution order: `REDIS_CLUSTER_NODES` → `REDIS_SENTINELS` → `REDIS_URL`.
In Sentinel mode the client asks the sentinels for the current primary, so
failover requires **no application restart or config change**. In Cluster mode
the client discovers the slot map from the seed nodes and follows `MOVED`
redirects automatically.

Example (Sentinel):

```bash
REDIS_SENTINELS=redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379
REDIS_SENTINEL_NAME=mymaster
```

Example (Cluster):

```bash
REDIS_CLUSTER_NODES=redis-1:6379,redis-2:6379,redis-3:6379
```

For managed providers that expose a stable primary endpoint (ElastiCache with
auto-failover, Upstash), set `REDIS_URL` to that endpoint and leave the
Sentinel/Cluster variables unset.

## Running locally

```bash
docker compose up -d redis redis-replica
```

Primary: `redis://localhost:6379`  
Replica: `redis://localhost:6380`

## Failover testing procedure

Use this procedure to test that failover works before it happens in production.
**Target: standby promoted and application traffic recovered within 30 seconds.**

An automated chaos test covers this scenario — see
`tests/chaos/test_redis_failure.py` (and the `chaos-redis` CI job). The manual
steps below mirror what the chaos test does and can be used for ad-hoc
verification in staging.

### 1. Verify replication is healthy

```bash
docker compose exec redis redis-cli info replication
# Expect: connected_slaves:1
docker compose exec redis-replica redis-cli info replication
# Expect: role:slave, master_link_status:up
```

### 2. Simulate primary failure

```bash
# Kill the primary container
docker compose stop redis

# Verify the replica is still responding
docker compose exec redis-replica redis-cli ping
# Expected: PONG
```

### 3. Promote replica to primary (manual, for self-hosted Redis)

With Sentinel configured, promotion is automatic — the sentinels elect a new
primary and the application client reconnects to it. Measure the time from the
kill to the first successful write:

```bash
# Start the timer, kill the primary, then poll until writes succeed
date +%s
docker compose stop redis
until docker compose exec redis-sentinel-1 redis-cli -p 26379 \
  sentinel get-master-addr-by-name mymaster | grep -q redis-replica; do sleep 0.5; done
date +%s   # elapsed must be <= 30s
```

Without Sentinel (plain replica), promote manually:

```bash
docker compose exec redis-replica redis-cli replicaof no one
# Verify it is now primary
docker compose exec redis-replica redis-cli info replication
# Expect: role:master
```

Then update `REDIS_URL` to point to the promoted replica endpoint (not required
in Sentinel/Cluster mode).

### 4. Restart original primary as a new replica (optional)

```bash
docker compose start redis
docker compose exec redis redis-cli replicaof redis-replica 6379
```

### 5. Restore original topology

```bash
docker compose exec redis redis-cli replicaof no one
docker compose exec redis-replica redis-cli replicaof redis 6379
```

> **Note**: Managed providers (ElastiCache, Upstash) handle promotion automatically.
> You only need to update `REDIS_URL` if the primary endpoint changes.
>
> **Acceptance**: failover in staging must complete within **30 seconds**. If the
> chaos test exceeds this budget, treat it as a release blocker and review
> `sentinel down-after-milliseconds` / `failover-timeout` settings.

## Recovery procedure

If Redis data is lost or corrupted:

1. **Stop the application** to prevent new jobs from being enqueued.

2. **Check AOF file integrity:**

   ```bash
   docker compose exec redis redis-check-aof /data/appendonly.aof
   ```

   If corrupted, repair it:

   ```bash
   docker compose exec redis redis-check-aof --fix /data/appendonly.aof
   ```

3. **Restart Redis** — it will replay the AOF log automatically:

   ```bash
   docker compose restart redis
   ```

4. **Verify queued jobs** are restored, then restart the application.

5. **For total data loss** (no AOF file): queued unlock jobs must be reconstructed
   from the PostgreSQL `gifts` table. Query for gifts with `status = 'locked'` and
   `unlock_at > NOW()` and re-enqueue them manually.

## Monitoring

Check persistence and replication health in one command:

```bash
docker compose exec redis redis-cli info all | grep -E \
  "aof_enabled|aof_last_bgrewrite_status|rdb_last_bgsave_status|connected_slaves|master_link_status"
```

Expected output:

```
aof_enabled:1
aof_last_bgrewrite_status:ok
rdb_last_bgsave_status:ok
connected_slaves:1            # (primary only)
master_link_status:up         # (replica only)
```
