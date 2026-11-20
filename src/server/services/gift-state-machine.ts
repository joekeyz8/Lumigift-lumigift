import type { GiftStatus } from "@/types";

/**
 * Gift state machine.
 *
 * The allowed transitions between {@link GiftStatus} values are visualised in
 * the state diagram at `docs/architecture/gift-state-machine.md` (Mermaid).
 * That document also lists the invalid transitions and their error codes.
 *
 * Invalid transitions are rejected by {@link assertValidTransition}, which
 * throws an `Error`; at the API boundary this surfaces as the
 * `GIFT_INVALID_STATE` error code with HTTP status `409 Conflict`.
 *
 * @see docs/architecture/gift-state-machine.md
 */

// Valid transitions: from → Set<to>
// Each status only allows specific forward (and cancel) transitions to prevent
// invalid state changes such as re-funding a claimed gift.
const TRANSITIONS: Record<GiftStatus, Set<GiftStatus>> = {
  pending_payment: new Set<GiftStatus>(["funded", "cancelled"]),
  funded: new Set<GiftStatus>(["locked", "cancelled"]),
  locked: new Set<GiftStatus>(["unlocked", "cancelled"]),
  unlocked: new Set<GiftStatus>(["claimed", "cancelled", "expired_pending_refund"]),
  claimed: new Set<GiftStatus>(),
  cancelled: new Set<GiftStatus>(),
  // legacy / edge statuses
  draft: new Set<GiftStatus>(["pending_payment", "cancelled"]),
  // late claims are still allowed during the expiry grace period
  expired_pending_refund: new Set<GiftStatus>(["claimed", "expired"]),
  expired: new Set<GiftStatus>(),
};

/**
 * Returns `true` if transitioning a gift from `current` to `next` is a valid
 * state-machine transition.
 *
 * @param current - The gift's current {@link GiftStatus}.
 * @param next - The desired target {@link GiftStatus}.
 * @returns `true` if the transition is allowed, `false` otherwise.
 * @see docs/architecture/gift-state-machine.md for the full state diagram.
 */
export function isValidTransition(current: GiftStatus, next: GiftStatus): boolean {
  return TRANSITIONS[current]?.has(next) ?? false;
}

/**
 * Asserts that transitioning from `current` to `next` is valid.
 * Throws a descriptive error if the transition is not permitted, preventing
 * callers from accidentally corrupting gift state.
 *
 * @param current - The gift's current {@link GiftStatus}.
 * @param next - The desired target {@link GiftStatus}.
 * @throws `Error` with a human-readable message if the transition is invalid.
 *   At the API boundary this is reported as `GIFT_INVALID_STATE` (HTTP 409).
 * @see docs/architecture/gift-state-machine.md for the full state diagram.
 */
export function assertValidTransition(current: GiftStatus, next: GiftStatus): void {
  if (!isValidTransition(current, next)) {
    throw new Error(`Invalid gift status transition: "${current}" → "${next}"`);
  }
}
