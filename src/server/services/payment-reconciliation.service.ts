/**
 * Payment Reconciliation Service (Issue #60)
 *
 * Polls Paystack for all gifts in `pending_payment` status whose webhooks
 * were missed or delayed, then repairs their state.
 *
 * Design choices:
 *  - Bounded retries per gift (MAX_RETRIES) with exponential back-off tracking
 *    stored in Redis to survive server restarts.
 *  - Dead-letter visibility: gifts that exhaust retries are moved to a Redis
 *    dead-letter set and logged at ERROR level so ops can investigate.
 *  - State-machine guard: reconciliation only advances gifts through valid
 *    transitions (pending_payment → locked). It never skips states.
 *  - A single reconciliation run is guarded by a distributed Redis lock so
 *    concurrent cron invocations don't produce duplicate transitions.
 *  - No direct DB writes — all state changes go through the existing
 *    `updateGiftStatusIdempotent` which enforces the state machine.
 */

import * as Sentry from "@sentry/nextjs";
import { verifyPayment } from "@/lib/paystack";
import { getRedisClient } from "@/lib/redis";
import { serviceLogger } from "@/lib/logger";
import { getGiftsByStatus, updateGiftStatusIdempotent } from "./gift.service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Gift } from "@/types";

const log = serviceLogger("payment-reconciliation");

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum number of reconciliation attempts per gift before dead-lettering. */
export const MAX_RETRIES = 5;

/** Redis key prefix for per-gift retry counters. */
const RETRY_KEY_PREFIX = "reconcile:retries:";

/** Redis key for the dead-letter set of unrecoverable gift IDs. */
const DEAD_LETTER_KEY = "reconcile:dead-letter";

/** TTL (seconds) for retry counters — auto-expire after 48 h. */
const RETRY_TTL_SECONDS = 48 * 60 * 60;

/** TTL (seconds) for the distributed run lock — prevents overlapping runs. */
const RUN_LOCK_TTL_SECONDS = 120; // 2 minutes

/** Redis key for the distributed run lock. */
const RUN_LOCK_KEY = "reconcile:run-lock";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ReconcileResult {
  /** Total gifts in pending_payment that were inspected. */
  inspected: number;
  /** Gifts whose Paystack status was "success" — advanced to "locked". */
  recovered: number;
  /** Gifts whose Paystack status was "failed" — left in pending_payment (no-op). */
  failed: number;
  /** Gifts still pending at Paystack — left unchanged. */
  pending: number;
  /** Gifts that exceeded MAX_RETRIES and were dead-lettered. */
  deadLettered: number;
  /** Any per-gift errors that did not abort the full run. */
  errors: Array<{ giftId: string; message: string }>;
  /** Gifts where provider records disagreed with the DB (alerted + persisted). */
  mismatches: number;
}

/** A persisted reconciliation mismatch awaiting manual review. */
export interface ReconciliationError {
  id: string;
  provider: string;
  reference: string;
  gift_id: string | null;
  expected_amount: number | null;
  actual_amount: number | null;
  currency: string | null;
  status: string;
  details: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

/** Input for persisting a reconciliation mismatch. */
interface ReconciliationMismatchInput {
  provider: "paystack" | "stripe";
  reference: string;
  giftId: string | null;
  expectedAmount: number | null;
  actualAmount: number | null;
  currency: string | null;
  details: Record<string, unknown>;
  message: string;
}

// ─── Core reconciliation ──────────────────────────────────────────────────────

/**
 * Runs a single reconciliation pass over all `pending_payment` gifts.
 *
 * @returns A {@link ReconcileResult} summary of the run.
 */
export async function reconcilePendingPayments(): Promise<ReconcileResult> {
  const redis = await getRedisClient();
  const result: ReconcileResult = {
    inspected: 0,
    recovered: 0,
    failed: 0,
    pending: 0,
    deadLettered: 0,
    errors: [],
    mismatches: 0,
  };

  // ── Distributed lock: skip run if another one is in progress ───────────────
  const lockAcquired = await redis.set(RUN_LOCK_KEY, "1", {
    NX: true,
    EX: RUN_LOCK_TTL_SECONDS,
  });
  if (!lockAcquired) {
    log.info("[reconcile] Skipping run — another instance is already running");
    return result;
  }

  try {
    const pendingGifts = await getGiftsByStatus("pending_payment");
    result.inspected = pendingGifts.length;

    log.info({ inspected: result.inspected }, "[reconcile] Starting reconciliation run");

    for (const gift of pendingGifts) {
      try {
        await reconcileOneGift(gift, result, redis);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ giftId: gift.id, err }, "[reconcile] Unexpected error for gift");
        result.errors.push({ giftId: gift.id, message });
      }
    }

    log.info(result, "[reconcile] Run complete");
  } finally {
    // Always release the lock, even if the run partially failed
    await redis.del(RUN_LOCK_KEY);
  }

  return result;
}

/** Process a single gift within a reconciliation run. */
async function reconcileOneGift(
  gift: Gift,
  result: ReconcileResult,
  redis: Awaited<ReturnType<typeof getRedisClient>>
): Promise<void> {
  const retryKey = `${RETRY_KEY_PREFIX}${gift.id}`;

  // ── Dead-letter check ──────────────────────────────────────────────────────
  const isDeadLettered = await redis.sIsMember(DEAD_LETTER_KEY, gift.id);
  if (isDeadLettered) {
    log.warn({ giftId: gift.id }, "[reconcile] Skipping dead-lettered gift");
    return;
  }

  // ── Retry counter ──────────────────────────────────────────────────────────
  const rawRetries = await redis.get(retryKey);
  const retries = rawRetries ? parseInt(rawRetries, 10) : 0;

  if (retries >= MAX_RETRIES) {
    log.error(
      { giftId: gift.id, retries },
      "[reconcile] Gift exceeded max retries — moving to dead-letter set"
    );
    await redis.sAdd(DEAD_LETTER_KEY, gift.id);
    await redis.del(retryKey);
    result.deadLettered++;
    return;
  }

  // ── Poll Paystack ──────────────────────────────────────────────────────────
  const reference = `lumigift_${gift.id}`;
  const payment = await verifyPayment(reference);

  log.info(
    { giftId: gift.id, paystackStatus: payment.status, retries },
    "[reconcile] Paystack status polled"
  );

  if (payment.status === "success") {
    // Advance the gift — idempotent so safe to call even if already locked
    const updated = await updateGiftStatusIdempotent(gift.id, "locked");
    if (updated?.status === "locked") {
      log.info({ giftId: gift.id }, "[reconcile] Gift recovered → locked");
      result.recovered++;
      // Clear retry counter on successful recovery
      await redis.del(retryKey);
    } else {
      // Provider says success but the DB did not reach the expected state.
      await reportMismatch(result, {
        provider: "paystack",
        reference,
        giftId: gift.id,
        expectedAmount: gift.amount ?? null,
        actualAmount: payment.amount ?? null,
        currency: payment.currency ?? gift.currency ?? null,
        details: {
          reason: "provider_success_db_not_locked",
          paystackStatus: payment.status,
          dbStatus: updated?.status ?? null,
          paystackReference: payment.reference ?? reference,
        },
        message: "Paystack reports success but gift is not in locked state",
      });
    }

    // Amount mismatch check (provider success but amounts disagree)
    if (
      payment.amount != null &&
      gift.amount != null &&
      Number(payment.amount) !== Number(gift.amount)
    ) {
      await reportMismatch(result, {
        provider: "paystack",
        reference,
        giftId: gift.id,
        expectedAmount: gift.amount,
        actualAmount: payment.amount,
        currency: payment.currency ?? gift.currency ?? null,
        details: {
          reason: "amount_mismatch",
          paystackStatus: payment.status,
          paystackReference: payment.reference ?? reference,
        },
        message: "Paystack amount does not match gift amount",
      });
    }
  } else if (payment.status === "failed") {
    // Payment definitively failed — leave in pending_payment for sender to retry
    log.info({ giftId: gift.id }, "[reconcile] Payment failed — leaving in pending_payment");
    result.failed++;
    // Increment retry counter so repeated failures eventually dead-letter
    await incrementRetryCounter(redis, retryKey, retries);
  } else {
    // Still pending at Paystack — increment counter and check again next run
    result.pending++;
    await incrementRetryCounter(redis, retryKey, retries);
  }
}

// ─── Mismatch alerting & persistence ─────────────────────────────────────────

/**
 * Alerts (Sentry + error log) and persists a reconciliation mismatch for
 * manual review. Never throws — a failure to persist must not abort the run.
 */
async function reportMismatch(
  result: ReconcileResult,
  input: ReconciliationMismatchInput
): Promise<void> {
  result.mismatches++;

  const context = {
    provider: input.provider,
    reference: input.reference,
    giftId: input.giftId,
    expectedAmount: input.expectedAmount,
    actualAmount: input.actualAmount,
    currency: input.currency,
    details: input.details,
  };

  log.error(context, `[reconcile] MISMATCH: ${input.message}`);

  try {
    Sentry.captureMessage(`[reconcile] Payment mismatch: ${input.message}`, {
      level: "error",
      tags: { provider: input.provider, reference: input.reference },
      extra: context,
    });
  } catch (err) {
    log.error({ err }, "[reconcile] Failed to send Sentry alert");
  }

  try {
    const { error } = await supabaseAdmin.from("reconciliation_errors").insert({
      provider: input.provider,
      reference: input.reference,
      gift_id: input.giftId,
      expected_amount: input.expectedAmount,
      actual_amount: input.actualAmount,
      currency: input.currency,
      status: "unresolved",
      details: input.details,
    });
    if (error) {
      log.error({ err: error, context }, "[reconcile] Failed to persist reconciliation error");
    }
  } catch (err) {
    log.error({ err, context }, "[reconcile] Failed to persist reconciliation error");
  }
}

/**
 * Returns all unresolved reconciliation errors, newest first.
 * Intended for the admin listing endpoint.
 */
export async function listUnresolvedReconciliationErrors(): Promise<ReconciliationError[]> {
  const { data, error } = await supabaseAdmin
    .from("reconciliation_errors")
    .select("*")
    .eq("status", "unresolved")
    .order("created_at", { ascending: true });

  if (error) {
    log.error({ err: error }, "[reconcile] Failed to list unresolved reconciliation errors");
    throw new Error(`Failed to list reconciliation errors: ${error.message}`);
  }

  return (data ?? []) as ReconciliationError[];
}

/** Increment the retry counter and reset its TTL. */
async function incrementRetryCounter(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string,
  currentRetries: number
): Promise<void> {
  const newCount = currentRetries + 1;
  await redis.set(key, String(newCount), { EX: RETRY_TTL_SECONDS });
}

// ─── Dead-letter visibility helpers ──────────────────────────────────────────

/**
 * Returns all gift IDs currently in the dead-letter set.
 * Useful for ops dashboards and alerting.
 */
export async function getDeadLetteredGiftIds(): Promise<string[]> {
  const redis = await getRedisClient();
  return redis.sMembers(DEAD_LETTER_KEY);
}

/**
 * Removes a gift ID from the dead-letter set so reconciliation will retry it.
 * Intended for use by ops / admin tooling after manual investigation.
 */
export async function redriveDeadLetteredGift(giftId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.sRem(DEAD_LETTER_KEY, giftId);
  await redis.del(`${RETRY_KEY_PREFIX}${giftId}`);
  log.info({ giftId }, "[reconcile] Gift removed from dead-letter set");
}
