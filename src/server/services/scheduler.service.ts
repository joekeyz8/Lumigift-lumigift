import { gifts, updateGiftStatus, isGiftUnlocked } from "./gift.service";

/**
 * Unlock scheduler — checks for gifts whose `unlockAt` has passed (inclusive: `now >= unlockAt`)
 * and transitions them from `"locked"` → `"unlocked"`, then notifies recipients.
 *
 * In production this is triggered by a Vercel Cron job or pg_cron
 * at a regular interval (e.g. every minute).
 *
 * @param now - Reference timestamp for execution (defaults to new Date()).
 * @returns The number of gifts that were unlocked in this run.
 */
export async function processUnlocks(now: Date = new Date()): Promise<number> {
  let unlockedCount = 0;
  for (const gift of gifts.values()) {
    if (gift.status === "locked" && isGiftUnlocked(gift, now)) {
      await updateGiftStatus(gift.id, "unlocked");
      unlockedCount++;
    }
  }
  return unlockedCount;
}

/**
 * Expiry scheduler — identifies gifts that have been `"unlocked"` but unclaimed
 * for more than 365 days, marks them as `"expired"`, and notifies the sender.
 *
 * When a gift expires the escrowed USDC should be refunded to the sender's
 * Stellar address via the escrow contract's cancel/refund path.
 *
 * In production, run daily via Vercel Cron or pg_cron.
 *
 * @returns Resolves when all expired gifts have been processed.
 */
export async function processExpiries(): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  // TODO: replace with DB query:
  //   SELECT * FROM gifts
  //   WHERE status = 'unlocked' AND unlock_at <= :cutoff
  console.warn(
    "[scheduler] processExpiries called — wire up DB query here. Cutoff:",
    cutoff.toISOString()
  );

  // Pseudocode for production implementation:
  //
  // const expiredGifts = await db.gift.findMany({
  //   where: { status: "unlocked", unlockAt: { lte: cutoff } },
  // });
  //
  // for (const gift of expiredGifts) {
  //   await updateGiftStatus(gift.id, "expired");
  //   // Refund USDC to sender's Stellar address
  //   if (gift.contractId && gift.senderStellarKey) {
  //     await refundEscrow(gift.contractId, gift.senderStellarKey);
  //   }
  //   // Notify sender via SMS
  //   await sendSms(gift.senderPhone, `Your Lumigift of ${gift.amountUsdc} USDC has expired and been refunded.`);
  // }
}
