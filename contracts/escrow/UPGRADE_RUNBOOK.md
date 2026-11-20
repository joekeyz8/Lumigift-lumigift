# Escrow Contract Upgrade Runbook

This runbook describes the operational process for upgrading the escrow contract, with a focus on **mainnet** upgrades. It covers the authority model, the multi-sig/time-lock requirement, the approval flow, how to invoke the `upgrade` function, how to verify the `Upgraded` event, rollback procedures, and the end-to-end (E2E) testnet upgrade test that runs in CI.

> **Audience:** Contract admins, release managers, and security reviewers.
> **Scope:** `contracts/escrow` — the escrow Soroban contract and its upgrade authority.

---

## 1. Authority Model

The escrow contract has a single privileged role: the **admin**.

- The admin is stored in contract storage and is the only address authorized to call the `upgrade` function.
- `upgrade` **requires admin authorization** (`admin.require_auth()`). Any call from a non-admin address must fail with an authorization error.
- On a successful upgrade, the contract **emits an `Upgraded` event** containing the new WASM hash (and, where applicable, the admin address and ledger sequence). This event is the canonical on-chain record that an upgrade occurred and is used by monitoring and by the verification steps below.
- Admin authority tests exist (see issue #81 referenced in the source). This runbook complements those tests with the operational process.

### Network-specific authority requirements

| Network | Authority requirement |
| --- | --- |
| Local / dev | Single admin key is acceptable. |
| Testnet | Single admin key is acceptable, but upgrades must go through the CI E2E test (see §7). |
| **Mainnet** | **Multi-sig and time-lock are mandatory.** The admin address on mainnet **must be a multi-sig account** (e.g., a Stellar multi-sig account with a threshold requiring approval from multiple key holders). A **time-lock** must be enforced between proposal and execution. A single key must never be able to upgrade the mainnet contract. |

> **Hard requirement:** Mainnet upgrades require **both** a multi-sig admin **and** a time-lock. Neither alone is sufficient.

---

## 2. Prerequisites

Before starting any upgrade:

1. **Release artifact.** A built, reproducible WASM artifact for the escrow contract, with its SHA-256 hash recorded and published.
2. **Version tag.** A signed git tag for the release (e.g., `escrow-vX.Y.Z`).
3. **Audit / review sign-off.** Security review completed for any change touching funds, authorization, or storage layout.
4. **Migration review.** Confirm whether the upgrade changes storage layout. If so, a migration plan and rollback plan are required (see §6).
5. **Admin identity confirmed.** Confirm the admin address currently stored in the contract matches the expected multi-sig account (mainnet) or test key (testnet).

---

## 3. Mainnet Multi-sig & Time-lock Configuration

### 3.1 Multi-sig admin

- The contract admin on mainnet **must** be a multi-sig account.
- Recommended configuration: a threshold that requires approval from a majority of key holders (e.g., 3-of-5), with key holders in separate security domains.
- Verify the admin is a multi-sig account before proposing any upgrade. A single-key admin on mainnet is a **blocking** misconfiguration and must be corrected before proceeding.

### 3.2 Time-lock

- A time-lock must elapse between **proposal** and **execution** of a mainnet upgrade.
- The time-lock window gives stakeholders time to review the proposed WASM hash and react before the upgrade executes.
- The time-lock is enforced operationally by the multi-sig proposal/approval workflow: the upgrade transaction is proposed, the required approvals are collected, and execution is only permitted after the time-lock window has passed.
- Record the proposal timestamp and the earliest permitted execution time in the upgrade ticket.

---

## 4. Approval Flow (Mainnet)

1. **Propose.** The release manager prepares the upgrade transaction (targeting the new WASM hash) and submits it as a proposal to the multi-sig admin account. Record the proposal ID, the new WASM hash, and the proposal timestamp.
2. **Review.** Security reviewers and key holders independently verify:
   - The WASM hash matches the published release artifact.
   - The release tag and audit sign-off are present.
   - The migration/rollback plan is documented.
3. **Approve.** Key holders sign the proposal until the multi-sig threshold is met.
4. **Wait for time-lock.** Do not execute until the time-lock window has fully elapsed.
5. **Execute.** Submit the approved upgrade transaction. The contract's `upgrade` function enforces admin authorization; the multi-sig account satisfies this requirement.
6. **Verify.** Confirm the `Upgraded` event was emitted and the stored WASM hash matches the intended release (see §5).

> **No shortcuts.** Skipping the time-lock, lowering the multi-sig threshold, or executing with a single key is a policy violation and must be treated as a security incident.

---

## 5. Invoking `upgrade` and Verifying the `Upgraded` Event

### 5.1 Invocation

The `upgrade` function:

- **Requires admin authorization.** The caller must be the stored admin (on mainnet, the multi-sig account). Non-admin callers must fail authorization.
- Accepts the new WASM hash as its argument.
- On success, **emits an `Upgraded` event** and updates the contract's WASM.

Invoke it via the Soroban CLI (or your deployment tooling), targeting the escrow contract ID and passing the new WASM hash:

```bash
soroban contract invoke \
  --id <ESCROW_CONTRACT_ID> \
  --source <ADMIN_ACCOUNT> \
  --network <NETWORK> \
  -- \
  upgrade \
  --new_wasm_hash <NEW_WASM_HASH>
```

- On mainnet, `<ADMIN_ACCOUNT>` is the multi-sig account and the invocation must be executed through the approved multi-sig transaction (see §4).
- On testnet, this is exercised automatically by the CI E2E test (see §7).

### 5.2 Verifying the `Upgraded` event

After execution, confirm the upgrade on-chain:

1. **Check the transaction succeeded** and inspect its emitted contract events.
2. **Confirm an `Upgraded` event is present**, and that its payload contains the expected new WASM hash.
3. **Confirm the contract's stored WASM hash** now equals the intended release hash.
4. **Record** the transaction hash, ledger sequence, and event payload in the upgrade ticket.

If the `Upgraded` event is missing or the WASM hash does not match, treat the upgrade as failed and follow the rollback procedure (§6).

### 5.3 Negative check (authorization)

As part of verification, confirm that a call to `upgrade` from a **non-admin** address fails with an authorization error. This validates that the admin requirement is enforced in the deployed contract.

---

## 6. Rollback Procedure

If an upgrade fails verification or causes a regression:

1. **Declare incident.** Open an incident ticket and notify key holders and stakeholders.
2. **Identify the last known-good WASM hash.** This must be recorded for every release; if it is not, halt and escalate.
3. **Propose rollback.** Submit an upgrade transaction targeting the last known-good WASM hash through the same multi-sig approval flow (§4). The time-lock applies to rollbacks as well.
4. **Approve and execute** once the threshold is met and the time-lock has elapsed.
5. **Verify** the `Upgraded` event for the rollback and confirm the stored WASM hash matches the last known-good release.
6. **Post-mortem.** Document root cause, timeline, and follow-up actions.

> **Storage-layout caution:** If the failed upgrade changed storage layout, a simple WASM rollback may not be sufficient. Follow the migration/rollback plan prepared in §2 and escalate to security reviewers.

---

## 7. E2E Testnet Upgrade Test (CI)

An end-to-end upgrade test runs against **testnet** as part of CI. It validates the full upgrade path, including admin authorization and the `Upgraded` event, before any mainnet upgrade is considered.

The E2E test:

1. Deploys the current escrow contract to testnet.
2. Uploads the new WASM and records its hash.
3. Invokes `upgrade` as the **admin** and asserts it succeeds.
4. Asserts an **`Upgraded` event** was emitted with the expected new WASM hash.
5. Asserts the contract's stored WASM hash now matches the new hash.
6. Asserts that invoking `upgrade` from a **non-admin** address fails with an authorization error.

**CI requirement:** The E2E testnet upgrade test must pass before a mainnet upgrade is approved. A failing or skipped E2E upgrade test is a **blocking** condition for mainnet.

---

## 8. Upgrade Checklist

**Pre-upgrade**
- [ ] Release artifact built, hash recorded, tag signed.
- [ ] Security review / audit sign-off complete.
- [ ] Migration and rollback plan documented (if storage layout changes).
- [ ] Admin address confirmed (mainnet: multi-sig; single-key admin is blocking).
- [ ] CI E2E testnet upgrade test passing.

**Mainnet execution**
- [ ] Upgrade proposed to multi-sig admin; proposal ID and timestamp recorded.
- [ ] Required approvals collected (threshold met).
- [ ] Time-lock window fully elapsed.
- [ ] Upgrade executed.
- [ ] `Upgraded` event verified with expected WASM hash.
- [ ] Non-admin `upgrade` call confirmed to fail authorization.
- [ ] Transaction hash, ledger, and event payload recorded in the ticket.

**Post-upgrade**
- [ ] Monitoring confirms normal operation.
- [ ] Release notes published.
- [ ] Last known-good WASM hash recorded for future rollback.