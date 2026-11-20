/**
 * Lightweight observability metrics for cron jobs and webhooks.
 *
 * Emits structured JSON log lines (via the pino logger) that can be
 * ingested by any log aggregation service (Logtail, Datadog, CloudWatch).
 * Errors are also captured in Sentry with a metric-tagged scope.
 *
 * Design constraints:
 *   - No PII or secrets are ever logged. Fields such as phone numbers,
 *     payment references, and gift amounts are intentionally excluded.
 *   - All values are numeric counters, durations (ms), or safe status
 *     strings so dashboards can be built on top without scrubbing.
 *
 * Usage:
 *   const timer = startTimer();
 *   try {
 *     const result = await doWork();
 *     recordCronSuccess("cron/unlock", timer(), { processed: result });
 *   } catch (err) {
 *     recordCronFailure("cron/unlock", timer(), err);
 *   }
 */

import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";

// ── SLO definitions ───────────────────────────────────────────────────────────

/**
 * Service Level Objectives surfaced on the SLO dashboards and used by the
 * error-budget burn-rate alerts. Keep these in sync with
 * docs/ops/slo-dashboards.md.
 */
export const SLO = {
  /** Availability: proportion of successful requests. */
  availability: { target: 0.999, window: "30d" },
  /** Latency: p95 request duration must stay at or below this (ms). */
  latencyP95Ms: { target: 500, window: "30d" },
  /** Payment success rate: successful payments / attempted payments. */
  paymentSuccessRate: { target: 0.995, window: "30d" },
} as const;

/** Burn-rate threshold that triggers the error-budget alert. */
export const SLO_BURN_RATE_ALERT_THRESHOLD = 2;
/** Window over which the burn rate is evaluated for alerting. */
export const SLO_BURN_RATE_ALERT_WINDOW = "1h";

// ── Timer ─────────────────────────────────────────────────────────────────────

/**
 * Returns a function that, when called, returns the elapsed time in milliseconds
 * since startTimer() was invoked.
 */
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}

// ── Cron metrics ─────────────────────────────────────────────────────────────

/**
 * Records a successful cron run.
 *
 * @param job       - Identifier for the cron job, e.g. "cron/unlock".
 * @param durationMs - Elapsed time in milliseconds.
 * @param data       - Safe numeric or string counters (no PII).
 */
export function recordCronSuccess(
  job: string,
  durationMs: number,
  data?: Record<string, number | string>
): void {
  logger.info({ metric: "cron.run", job, status: "success", durationMs, ...data }, "[cron] run ok");
}

/**
 * Records a failed cron run. The error message is captured but the full
 * stack is kept server-side only via Sentry; nothing sensitive reaches logs.
 *
 * @param job        - Identifier for the cron job.
 * @param durationMs - Elapsed time in milliseconds before the failure.
 * @param err        - The thrown error.
 */
export function recordCronFailure(job: string, durationMs: number, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  logger.error(
    { metric: "cron.run", job, status: "error", durationMs, reason },
    "[cron] run failed"
  );

  Sentry.withScope((scope) => {
    scope.setTag("metric", "cron.run");
    scope.setTag("job", job);
    scope.setExtra("durationMs", durationMs);
    Sentry.captureException(err);
  });
}

/**
 * Records a failed cron job to a Redis dead-letter queue so it can be
 * retried manually. Best-effort: if Redis is unavailable the dead-letter is
 * skipped (the failure is still reported to Sentry via recordCronFailure).
 *
 * @param job         - Identifier for the cron job, e.g. "cron/unlock".
 * @param durationMs  - Elapsed time in milliseconds before the failure.
 * @param err         - The thrown error.
 * @param recordCount - Number of records processed before the failure, if known.
 */
export async function recordDeadLetter(
  job: string,
  durationMs: number,
  err: unknown,
  recordCount?: number
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  const payload = {
    job,
    status: "dead-lettered",
    durationMs,
    reason,
    failedAt: new Date().toISOString(),
    ...(recordCount !== undefined ? { recordCount } : {}),
  };

  try {
    const redis = await getRedisClient();
    await redis.set(`cron:dead-letter:${job}`, JSON.stringify(payload), {
      EX: 7 * 24 * 60 * 60,
    });
  } catch {
    // Redis unavailable — dead-letter is best-effort.
  }

  logger.error(
    {
      metric: "cron.dead_letter",
      job,
      status: "dead-lettered",
      durationMs,
      reason,
      ...(recordCount !== undefined ? { recordCount } : {}),
    },
    "[cron] dead-lettered"
  );
}

// ── SLO metrics ───────────────────────────────────────────────────────────────

/**
 * Records the outcome of an HTTP request for availability SLOs.
 *
 * Emits a structured log line with `metric: "slo.request"` and a numeric
 * `success` flag (1/0) so dashboards can compute the availability ratio and
 * error-budget burn rate. No request bodies, headers, or PII are logged.
 *
 * @param route      - Normalised route label, e.g. "POST /api/gifts".
 * @param statusCode - HTTP status code returned to the client.
 * @param durationMs - Total request duration in milliseconds.
 */
export function recordRequestOutcome(
  route: string,
  statusCode: number,
  durationMs: number
): void {
  const success = statusCode >= 200 && statusCode < 500 ? 1 : 0;
  logger.info(
    { metric: "slo.request", route, statusCode, durationMs, success },
    "[slo] request"
  );
}

/**
 * Records a payment attempt outcome for the payment success-rate SLO.
 *
 * @param provider   - Payment provider identifier, e.g. "paystack".
 * @param success    - Whether the payment ultimately succeeded.
 * @param durationMs - Time from initiation to terminal state, if known.
 */
export function recordPaymentOutcome(
  provider: string,
  success: boolean,
  durationMs?: number
): void {
  logger.info(
    {
      metric: "slo.payment",
      provider,
      success: success ? 1 : 0,
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    "[slo] payment outcome"
  );
}

// ── Cron heartbeat ────────────────────────────────────────────────────────────

/**
 * Pings the external cron monitor (Healthchecks.io or equivalent) to confirm
 * a cron run *completed* successfully. Call this only after the job's work
 * has finished — never on invocation — so missed or partial runs are detected.
 *
 * Best-effort: failures to ping are logged but never thrown, so monitoring
 * outages cannot break the cron itself.
 *
 * @param job - Identifier for the cron job, e.g. "cron/unlock".
 */
export async function pingCronHeartbeat(job: string): Promise<void> {
  const baseUrl = process.env.HEALTHCHECKS_PING_URL;
  if (!baseUrl) {
    logger.warn({ metric: "cron.heartbeat", job, status: "skipped" }, "[cron] heartbeat not configured");
    return;
  }

  // Map job identifiers to their Healthchecks.io check slugs.
  const slug = job.replace(/^cron\//, "").replace(/\//g, "-");
  const url = `${baseUrl.replace(/\/$/, "")}/${slug}`;

  try {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) {
      logger.warn(
        { metric: "cron.heartbeat", job, status: "failed", httpStatus: res.status },
        "[cron] heartbeat ping failed"
      );
    }
  } catch (err) {
    logger.warn(
      {
        metric: "cron.heartbeat",
        job,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      },
      "[cron] heartbeat ping error"
    );
  }
}

// ── Webhook metrics ───────────────────────────────────────────────────────────

/**
 * Records a successfully processed webhook event.
 *
 * @param provider   - Payment provider identifier, e.g. "paystack" or "stripe".
 * @param eventType  - The webhook event type string (safe to log, not PII).
 * @param durationMs - Processing time in milliseconds.
 * @param status     - Outcome of the business logic, e.g. "locked" or "ignored".
 */
export function recordWebhookSuccess(
  provider: string,
  eventType: string,
  durationMs: number,
  status: string
): void {
  logger.info(
    { metric: "webhook.event", provider, eventType, status, durationMs },
    "[webhook] processed ok"
  );
}

/**
 * Records a failed or rejected webhook event.
 *
 * @param provider   - Payment provider identifier.
 * @param eventType  - The webhook event type string (or "unknown" if unparseable).
 * @param durationMs - Processing time before the failure.
 * @param reason     - Short failure reason label (no raw error messages with secrets).
 * @param err        - The underlying error, forwarded to Sentry only.
 */
export function recordWebhookFailure(
  provider: string,
  eventType: string,
  durationMs: number,
  reason: string,
  err?: unknown
): void {
  logger.error(
    { metric: "webhook.event", provider, eventType, status: "error", durationMs, reason },
    "[webhook] processing failed"
  );

  if (err) {
    Sentry.withScope((scope) => {
      scope.setTag("metric", "webhook.event");
      scope.setTag("provider", provider);
      scope.setTag("eventType", eventType);
      scope.setExtra("durationMs", durationMs);
      scope.setExtra("reason", reason);
      Sentry.captureException(err);
    });
  }
}

/**
 * Records a status transition for a gift (e.g. pending_payment → locked).
 * The gift ID is included so events are correlatable in logs, but no
 * personal data (phone, name, amount) is recorded here.
 *
 * @param giftId    - The gift's UUID.
 * @param fromStatus - Previous status.
 * @param toStatus   - New status.
 * @param trigger    - What caused the transition, e.g. "webhook:paystack".
 */
export function recordStatusTransition(
  giftId: string,
  fromStatus: string,
  toStatus: string,
  trigger: string
): void {
  logger.info(
    { metric: "gift.status_transition", giftId, fromStatus, toStatus, trigger },
    "[gift] status changed"
  );
}
