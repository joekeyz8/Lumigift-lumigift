# Cron Job Monitoring & Missing-Call Alerts

> **Issue #101** — Configure scheduled cron invocation in production  
> Acceptance criteria: schedules run at intended cadence; missing or unauthorized calls alert operators.

---

## Cron Schedule Overview

All cron jobs are invoked by **Vercel Cron** (configured in `vercel.json`) and protected
by the `CRON_SECRET` bearer token. Each job also pings a dead-man's-switch URL so that
_silence_ (a missed invocation) is just as detectable as an explicit failure.

| Route                           | Cadence            | Purpose                                            | Healthcheck env var            | Ping URL (production)                    |
| ------------------------------- | ------------------ | -------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `GET /api/v1/cron/unlock`       | Every minute       | Unlock gifts whose `unlock_time` has passed        | `HEALTHCHECK_URL`              | `https://hc-ping.com/<unlock-uuid>`      |
| `GET /api/v1/cron/index-events` | Every 5 min        | Index Soroban escrow events, sync gift status      | `HEALTHCHECK_URL_INDEX_EVENTS` | `https://hc-ping.com/<index-events-uuid>`|
| `GET /api/v1/cron/reconcile`    | Every 6 hours      | Reconcile Paystack payments, surface dead-letters  | `HEALTHCHECK_URL_RECONCILE`    | `https://hc-ping.com/<reconcile-uuid>`   |
| `GET /api/v1/cron/expire`       | Daily at 02:00 UTC | Expire unclaimed gifts (> 365 days), refund sender | `HEALTHCHECK_URL_EXPIRE`       | `https://hc-ping.com/<expire-uuid>`      |

> **Note:** The `<...-uuid>` placeholders above are the real check UUIDs stored in the
> Vercel project env vars (production **and** staging). Retrieve the live values from
> the Vercel dashboard (Project → Settings → Environment Variables) or from the
> Healthchecks.io check detail page. Never commit the real UUIDs to the repo.
=======

---

## Authentication

Every cron route checks:

```
Authorization: Bearer <CRON_SECRET>
```

Vercel automatically injects this header when invoking cron functions — set `CRON_SECRET`
as an environment variable in the Vercel project dashboard (production **and** staging).

A missing or incorrect token returns `401 Unauthorized`. If you see 401s in cron logs,
the `CRON_SECRET` env var is not set correctly in the Vercel environment.

---

## Dead-Man's-Switch Setup (Healthchecks.io)

Each cron job pings a unique URL on success. If the ping is not received within the
expected period, Healthchecks.io (or your chosen provider) fires an alert.

### Step-by-step (Healthchecks.io)

1. Go to [https://healthchecks.io](https://healthchecks.io) → **Create Check**.
2. Create one check per cron job with the period and grace matching the schedule.
   The grace period is tuned so that a **missed run alerts within 5 minutes** for the
   unlock scheduler (the H-6 launch gate requirement):

   | Job          | Period    | Grace  | Alert fires after |
   | ------------ | --------- | ------ | ----------------- |
   | unlock       | 1 minute  | 4 min  | ~5 min of silence |
   | index-events | 5 minutes | 5 min  | ~10 min of silence|
   | reconcile    | 6 hours   | 15 min | ~6h15m of silence |
   | expire       | 24 hours  | 30 min | ~24h30m of silence|

3. Copy each check's **ping URL** and set the corresponding environment variable in Vercel:

   ```
   HEALTHCHECK_URL=https://hc-ping.com/<uuid>          # unlock (fallback for all)
   HEALTHCHECK_URL_INDEX_EVENTS=https://hc-ping.com/<uuid>
   HEALTHCHECK_URL_RECONCILE=https://hc-ping.com/<uuid>
   HEALTHCHECK_URL_EXPIRE=https://hc-ping.com/<uuid>
   ```

4. For **failure pings** (job runs but throws an error), each route also calls
   `HEALTHCHECK_URL<suffix>/fail` — Healthchecks.io treats `/fail` pings as
   immediately failed regardless of grace period.

5. **Ping on success, not on invocation.** Each cron route sends the ping only after
   the handler completes successfully (after the work is committed), so a ping confirms
   completion rather than merely confirming the route was hit. If the handler throws,
   only the `/fail` ping is sent — never the success ping.

### Alternative: BetterUptime / Cronitor

Both support the same `/fail` suffix convention. The env var names are identical —
just swap the ping URL base.

---

## Alert Rules

Configure the following alerts in your monitoring provider:

### Vercel Cron Dashboard Alerts

In the Vercel dashboard (Project → Settings → Cron Jobs):

- Enable **email notifications** for cron job failures.
- Set the notification email to `ops@lumigift.app` (or your on-call alias).

### Healthchecks.io Alerts

For each check, configure:

- **Alert channel**: Slack `#incidents` + PagerDuty/email for P0 jobs (unlock, index-events).
- **Alert contacts** (configured on every check):
  - Email: `ops@lumigift.app` (distribution list, pages on-call)
  - Slack: `#incidents` (webhook integration)
  - PagerDuty: `Lumigift On-Call` service (P0 jobs only: unlock, index-events)
- **Missed-run threshold**: the `unlock` check must alert within **5 minutes** of a
  missed run (period 1 min + grace 4 min). Verify this by pausing the check in
  Healthchecks.io and confirming the alert lands in Slack/PagerDuty within 5 minutes.
- **Alert message template**:

  ```
  🔴 Cron job MISSED: {check_name}
  Last ping: {last_ping}
  Expected every: {period}
  Runbook: https://github.com/joekeyz8/Lumigift-lumigift/blob/main/docs/ops/runbook.md#cron-job-failure
  ```

### Log-Based Alerts (Betterstack / Logtail)

Create alerts on structured log fields:

| Alert                     | Query                                       | Threshold      | Channel          |
| ------------------------- | ------------------------------------------- | -------------- | ---------------- |
| Cron unlock failure       | `message LIKE '%cron/unlock%failed%'`       | ≥ 1 in 5 min   | Slack #incidents |
| Cron expire failure       | `message LIKE '%cron/expire%failed%'`       | ≥ 1 in 1 hour  | Slack #incidents |
| Cron reconcile failure    | `message LIKE '%cron/reconcile%failed%'`    | ≥ 1 in 6 hours | Slack #incidents |
| Cron index-events failure | `message LIKE '%cron/index-events%failed%'` | ≥ 1 in 15 min  | Slack #incidents |
| Unauthorized cron calls   | `message LIKE '%cron%' AND status = 401`    | ≥ 3 in 5 min   | Slack #security  |

---

## Manual Invocation (for testing or recovery)

You can trigger any cron job manually with:

```bash
# Unlock (replace BASE_URL and CRON_SECRET with real values)
curl -X GET "https://lumigift.app/api/v1/cron/unlock" \
  -H "Authorization: Bearer $CRON_SECRET"

# Expire
curl -X GET "https://lumigift.app/api/v1/cron/expire" \
  -H "Authorization: Bearer $CRON_SECRET"

# Reconcile
curl -X GET "https://lumigift.app/api/v1/cron/reconcile" \
  -H "Authorization: Bearer $CRON_SECRET"

# Index events
curl -X GET "https://lumigift.app/api/v1/cron/index-events" \
  -H "Authorization: Bearer $CRON_SECRET"
```

A successful response looks like:

```json
{ "success": true, "data": { "processed": 3, "durationMs": 142 } }
```

A `401` response means `CRON_SECRET` is wrong or not passed.

---

## Escalation

See the [Cron Job Failure section in the runbook](./runbook.md#cron-job-failure) for
full diagnosis and resolution steps.

| Severity | Condition                                       | Owner            | Notify via                          |
| -------- | ----------------------------------------------- | ---------------- | ----------------------------------- |
| P0       | `unlock` missed for > 5 minutes                 | On-call engineer | PagerDuty + Slack `#incidents`      |
| P0       | `index-events` missed for > 15 minutes          | On-call engineer | PagerDuty + Slack `#incidents`      |
| P1       | `reconcile` missed for > 12 hours               | Engineering lead | Slack `#incidents` + email          |
| P1       | `expire` missed for > 48 hours                  | Engineering lead | Slack `#incidents` + email          |
| P2       | Any cron 401 (unauthorized invocation attempts) | Security team    | Slack `#security`                   |

**Escalation path:** Healthchecks.io alert → Slack `#incidents` + PagerDuty (P0) →
on-call engineer acknowledges within 15 minutes → if unacknowledged, PagerDuty
escalates to the engineering lead. For P1/P2, the alert posts to Slack and the
owning team triages during business hours.

---

## Dead-Letter Queue (failed-job retries)

When a cron handler throws, the failure is recorded in a Redis dead-letter key
`cron:dead-letter:<job>` (TTL: 7 days) alongside the structured `cron.dead_letter`
log metric and a Sentry capture via `recordCronFailure`. The payload contains the
job name, duration, error reason, and timestamp so on-call can diagnose and
re-trigger the job manually.

Inspect dead-letters with:

```bash
# List all dead-lettered cron jobs
redis-cli keys "cron:dead-letter:*"

# Inspect a specific job's failure payload
redis-cli get "cron:dead-letter:cron/v1/unlock"
```

Each cron route stores its dead-letter on failure:
- `cron/v1/unlock`
- `cron/v1/expire`
- `cron/v1/reconcile`
- `cron/v1/index-events`

See the [Cron Job Failure](./runbook.md#cron-job-failure) runbook section for
manual re-trigger and recovery steps.
