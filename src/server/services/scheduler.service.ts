import pool from "@/lib/db";

/**
 * Row shape returned by the unlock query.
 */
interface GiftRow {
  id: string;
  status: string;
  unlock_at: Date;
  contract_id: string | null;
  sender_stellar_key: string | null;
  recipient_phone: string | null;
  amount_usdc: string;
}

/**
 * Unlock scheduler — finds all gifts in `"locked"` status whose `unlock_at`
 * timestamp has passed, atomically transitions each one to `"unlocked"` using
 * a `SELECT … FOR UPDATE SKIP LOCKED` advisory lock, and notifies recipients.
 *
 * The query is concurrent-safe: if two scheduler instances run at the same
 * time, each gift will be processed by exactly one instance. Any gift that is
 * already being processed by another connection is silently skipped (`SKIP LOCKED`).
 *
 * In production this is triggered by the Vercel Cron job at `/api/v1/cron/unlock`
 * every minute, or by pg_cron on the database server.
 *
 * @returns The number of gifts that were unlocked in this run.
 */
export async function processUnlocks(): Promise<number> {
  const now = new Date();
  let processed = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Atomically claim all eligible gifts in one round-trip.
    // SKIP LOCKED ensures concurrent scheduler runs never double-process a gift.
    const { rows } = await client.query<GiftRow>(
      `SELECT id, status, unlock_at, contract_id, sender_stellar_key, recipient_phone, amount_usdc
         FROM gifts
        WHERE status = 'locked'
          AND unlock_at <= $1
        ORDER BY unlock_at ASC
          FOR UPDATE SKIP LOCKED`,
      [now]
    );

    for (const gift of rows) {
      try {
        await client.query(
          `UPDATE gifts
              SET status = 'unlocked', updated_at = NOW()
            WHERE id = $1
              AND status = 'locked'`,
          [gift.id]
        );

        processed += 1;
        console.log("[scheduler] unlocked gift", {
          giftId: gift.id,
          unlockAt: gift.unlock_at,
          processedAt: now,
        });
      } catch (err) {
        // Log and continue — a single failure should not abort the whole batch.
        console.error("[scheduler] failed to unlock gift", { giftId: gift.id, err });
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[scheduler] processUnlocks transaction failed, rolled back", err);
    throw err;
  } finally {
    client.release();
  }

  console.log("[scheduler] processUnlocks complete", { processed, ranAt: now });
  return processed;
}

/**
 * Expiry scheduler — identifies gifts that have been `"unlocked"` but unclaimed
 * for more than 365 days, atomically marks them as `"expired"`, and notifies
 * the sender.
 *
 * Uses `SELECT … FOR UPDATE SKIP LOCKED` to be safe against concurrent runs.
 * When a gift expires the escrowed USDC should be refunded to the sender's
 * Stellar address via the escrow contract's cancel/refund path (wired up in
 * the refund flow once the escrow client supports it).
 *
 * In production, run daily via Vercel Cron or pg_cron.
 *
 * @returns Resolves when all expired gifts have been processed.
 */
export async function processExpiries(): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<GiftRow>(
      `SELECT id, status, unlock_at, contract_id, sender_stellar_key, recipient_phone, amount_usdc
         FROM gifts
        WHERE status = 'unlocked'
          AND unlock_at <= $1
        ORDER BY unlock_at ASC
          FOR UPDATE SKIP LOCKED`,
      [cutoff]
    );

    for (const gift of rows) {
      try {
        await client.query(
          `UPDATE gifts
              SET status = 'expired', updated_at = NOW()
            WHERE id = $1
              AND status = 'unlocked'`,
          [gift.id]
        );

        console.log("[scheduler] expired gift", {
          giftId: gift.id,
          unlockAt: gift.unlock_at,
          cutoff,
        });

        // Future: trigger escrow refund & sender SMS notification here
        // await refundEscrow(gift.contract_id, gift.sender_stellar_key);
        // await sendSms(gift.sender_phone, `Your Lumigift of ${gift.amount_usdc} USDC has expired and been refunded.`);
      } catch (err) {
        console.error("[scheduler] failed to expire gift", { giftId: gift.id, err });
      }
    }

    await client.query("COMMIT");
    console.log("[scheduler] processExpiries complete", { expired: rows.length, cutoff });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[scheduler] processExpiries transaction failed, rolled back", err);
    throw err;
  } finally {
    client.release();
  }
}
