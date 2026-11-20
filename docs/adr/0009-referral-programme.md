# ADR-0009: Referral Programme Design

- **Status:** Accepted
- **Date:** 2024-01-01
- **Deciders:** Engineering, Product
- **Related:** `src/server/services/referral.service.ts`, `migrations/0009_referral_programme.sql`

## Context

User acquisition is a primary growth lever for the platform. Organic sign-ups alone have not been sufficient to reach our growth targets, and paid acquisition channels carry a high cost per acquired user. We want a mechanism that:

- Incentivises existing users to invite new users.
- Rewards both the inviter and the invitee so that the invitee has a reason to complete their first meaningful action (a gift payment).
- Keeps the reward tied to real economic activity rather than mere sign-up, to avoid rewarding low-quality or fraudulent accounts.
- Remains simple to reason about and to account for.

A referral programme introduces new concerns: code generation and uniqueness, reward accounting, and fraud. This ADR records the design choices made to address them.

## Decision

We will implement a referral programme with the following characteristics:

### Unique 8-character codes

- Each user is assigned a unique referral code of 8 characters, generated from an unambiguous alphabet (avoiding visually confusable characters such as `0`/`O` and `1`/`I`).
- Codes are persisted with a uniqueness constraint enforced at the database level. Generation retries on collision.
- A new user may optionally supply a referral code at sign-up. The association between inviter and invitee is recorded once and is immutable.

### ₦500 credit to both parties after the first gift payment

- The reward is **not** granted at sign-up. It is granted only after the invited user completes their **first gift payment**.
- On that qualifying event, both the inviter and the invitee receive a **₦500 credit**.
- This ties the reward to genuine economic activity and reduces the incentive to create throwaway accounts.

### Credit applied as a discount, not withdrawable

- Referral credit is a **platform credit**, applied as a discount against future gift payments.
- Credit is **not** withdrawable as cash and cannot be transferred to another user.
- Credit balances are tracked in the ledger and consumed before other payment methods at checkout.

### Fraud detection via device/IP/name signals

- Referral relationships are evaluated against fraud signals including:
  - **Device fingerprint** — inviter and invitee sharing a device is a strong signal of self-referral.
  - **IP address** — matching or closely related IPs at sign-up and at the qualifying payment.
  - **Name similarity** — near-identical names between inviter and invitee.
- When signals cross configured thresholds, the reward is withheld pending review, and the referral is flagged.
- Fraud checks run at both the sign-up (association) stage and the reward-granting stage.

The implementation lives in `src/server/services/referral.service.ts`, and the schema (codes, referral associations, credit ledger entries, and fraud flags) is defined in `migrations/0009_referral_programme.sql`.

## Consequences

### Positive

- **Incentivised growth:** Rewarding both parties creates a strong, self-reinforcing acquisition loop.
- **Quality-aligned rewards:** Tying the reward to the first gift payment aligns incentives with real usage and reduces sign-up farming.
- **Contained cost:** Non-withdrawable credit keeps reward value within the platform and defers/offsets cash outflow.
- **Auditable:** Ledger-based credit tracking makes balances and redemptions traceable.

### Negative

- **Fraud surface:** Any referral programme attracts abuse (self-referral, sybil accounts, collusion). Mitigation via device/IP/name signals is heuristic and will produce both false positives (legitimate rewards withheld) and false negatives (some fraud slipping through).
- **Accounting complexity:** Credit is a liability that must be tracked, reconciled, and expired/handled per policy. It complicates revenue recognition and reporting compared with pure cash flows.
- **Operational overhead:** Fraud review queues, manual adjudication of flagged referrals, and customer support for withheld rewards add ongoing cost.
- **Edge cases:** Refunds, chargebacks, or reversals of the qualifying payment require reversing the granted credit, which adds state-machine complexity.

## Alternatives Considered

### Cash payouts to inviter and invitee

Pay out the reward as withdrawable cash or bank transfer.

- **Rejected:** Higher fraud incentive (directly monetisable), greater accounting and compliance burden (payout rails, KYC, tax reporting), and immediate cash outflow. Non-withdrawable credit keeps value on-platform and is simpler to administer.

### Tiered / escalating rewards

Reward more for higher referral volumes (e.g., milestone bonuses, multi-level rewards).

- **Rejected (for now):** Increases complexity and the attractiveness of gaming the system. A flat reward is easier to reason about, audit, and defend against fraud. Tiering can be revisited once baseline fraud controls are proven.

### No referral programme

Rely solely on organic and paid acquisition.

- **Rejected:** Leaves a cost-effective growth channel unused and forgoes the trust signal that peer referrals provide. Paid acquisition cost per user remains high.

## References

- Implementation: `src/server/services/referral.service.ts`
- Schema/migration: `migrations/0009_referral_programme.sql`
- Related ADRs: ADR-0000 (template), ADR index in `docs/adr/README.md`