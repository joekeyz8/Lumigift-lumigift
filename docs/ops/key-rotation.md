# Stellar Server Key Rotation Procedure

**Applies to:** `STELLAR_SERVER_SECRET_KEY` — the server-side Stellar signing key used to authorize all escrow transactions.

## Overview

The server signing key is a long-lived secret. If it is compromised, an attacker could sign unauthorized USDC transfers from the escrow account. This document describes how to rotate the key safely with zero downtime and a full audit trail.

## Prerequisites

- Access to the production secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault, Vercel environment variables).
- Stellar CLI or the Stellar Laboratory to generate a new keypair.
- Access to the Stellar escrow account to update signers.
- On-call engineer available during the rotation window.

## Key Storage Requirements

In production the key **must** be stored in a secrets manager, not only in environment variables:

| Environment | Storage                                                                |
| ----------- | ---------------------------------------------------------------------- |
| Local dev   | `.env.local` (never committed)                                         |
| Staging     | Vercel environment variables (encrypted at rest)                       |
| Production  | AWS Secrets Manager or HashiCorp Vault; injected as env var at runtime |

Never store the raw secret key in source code, CI logs, or unencrypted config files.

## Rotation Procedure

### Step 1 — Generate a New Keypair

```bash
# Using Stellar CLI
stellar keys generate new-server-key --network mainnet

# Or using the Stellar SDK (Node.js)
node -e "
const { Keypair } = require('@stellar/stellar-sdk');
const kp = Keypair.random();
console.log('Public:', kp.publicKey());
console.log('Secret:', kp.secret());
"
```

Record the new public key (`G…`) and secret key (`S…`). Store the secret immediately in your secrets manager — do not leave it in terminal history.

### Step 2 — Fund the New Account (if needed)

The new key must correspond to a funded Stellar account before it can sign transactions.

```bash
# Testnet only — use Friendbot
curl "https://friendbot.stellar.org?addr=<NEW_PUBLIC_KEY>"

# Mainnet — transfer minimum XLM reserve from existing account
```

### Step 3 — Add the New Key as a Signer on the Escrow Account

While the old key is still active, add the new key as an additional signer with the same weight. This allows both keys to sign during the transition window.

```bash
stellar tx new set-options \
  --source-account <ESCROW_ACCOUNT_PUBLIC_KEY> \
  --signer-key <NEW_PUBLIC_KEY> \
  --signer-weight 1 \
  --network mainnet \
  --sign-with-key <OLD_SECRET_KEY>
```

### Step 4 — Update the Secret in the Secrets Manager

Update `STELLAR_SERVER_SECRET_KEY` to the new secret key value in your secrets manager. Do **not** remove the old key yet.

```bash
# AWS Secrets Manager example
aws secretsmanager update-secret \
  --secret-id lumigift/production/stellar-server-secret-key \
  --secret-string '{"STELLAR_SERVER_SECRET_KEY":"<NEW_SECRET_KEY>"}'
```

### Step 5 — Deploy and Verify

1. Trigger a new deployment so the application picks up the new key.
2. Verify the app is signing transactions with the new key:
   - Check `/api/health?deep=1` returns `200 ok`.
   - Perform a test transaction on staging before production.
   - Monitor application logs for signing errors.

### Step 6 — Remove the Old Key as a Signer

Once the new deployment is confirmed healthy (allow at least 15 minutes), remove the old key from the escrow account's signer list.

```bash
stellar tx new set-options \
  --source-account <ESCROW_ACCOUNT_PUBLIC_KEY> \
  --signer-key <OLD_PUBLIC_KEY> \
  --signer-weight 0 \
  --network mainnet \
  --sign-with-key <NEW_SECRET_KEY>
```

Setting signer weight to `0` removes the signer.

### Step 7 — Record the Audit Log Entry

After successful rotation, record the event in the audit log (see below). This is required for compliance.

### Step 8 — Revoke the Old Key

Securely delete the old secret key from all locations:

- Remove from secrets manager (or mark as deprecated/inactive).
- Clear from any local `.env` files.
- Rotate any backups that contained the old key.

## Zero-Downtime Guarantee

The procedure above ensures zero downtime because:

1. The new key is added as a co-signer **before** the old key is removed.
2. The application is redeployed with the new key while both keys are valid.
3. The old key is only removed after the new deployment is confirmed healthy.

## Effect on Existing Transactions

Transactions already submitted to the Stellar network are immutable — they are not affected by key rotation. Only future transactions require the new key.

## Audit Log

Every key rotation must be recorded. Append an entry to `docs/ops/key-rotation-log.md`:

```markdown
## Rotation — YYYY-MM-DD

- Rotated by: [engineer name]
- Reason: [scheduled / suspected compromise / other]
- Old public key: G…
- New public key: G…
- Deployment: [deployment ID or commit SHA]
- Verified healthy: [yes/no]
- Old key removed from signers: [yes/no, timestamp]
```

The application also emits a structured log entry at rotation time (see `src/lib/stellar.ts` audit log hook).

## Emergency Rotation (Key Compromise)

If the key is suspected to be compromised, follow the same steps but with urgency:

1. **Immediately** add the new key as a co-signer (Step 3).
2. **Immediately** remove the old key as a signer (Step 6) — do not wait for a full deployment cycle.
3. Deploy the new key to production as fast as possible.
4. Investigate the compromise: check access logs, rotate all related secrets.
5. Notify the security team and file an incident report.

## Automated Database Credential Rotation

**Applies to:** RDS database credentials (`DB_USER` / `DB_PASSWORD`) used by the application connection pool.

Database credentials are rotated automatically every **90 days** by an AWS Secrets Manager rotation Lambda. No manual steps are required for routine rotation; the drill below is run quarterly to prove the automation works.

### Architecture

| Component | Purpose |
| --------- | ------- |
| Secret `lumigift/production/rds-credentials` | Stores `{"username": "...", "password": "..."}` for the RDS instance |
| Rotation Lambda `lumigift-rds-rotation` | Implements the four-step Secrets Manager rotation interface |
| EventBridge schedule | Triggers rotation every 90 days (`rate(90 days)`) |
| Application credential provider | Fetches credentials via the Secrets Manager SDK and caches them in memory |

The application **must not** read database credentials from static environment variables in production. `DB_HOST`, `DB_PORT`, and `DB_NAME` remain plain config; `DB_USER` / `DB_PASSWORD` are resolved at runtime from Secrets Manager (see `src/lib/db-credentials.ts`).

### Rotation Lambda — Four-Step Interface

AWS Secrets Manager invokes the Lambda with a `Step` parameter. The handler must implement all four steps:

1. **`createSecret`** — Generate a new password and store it under the `AWSPENDING` staging label. Do not touch the live credential.
2. **`setSecret`** — Apply the pending password to the RDS instance (`ALTER USER ... WITH PASSWORD ...`) using the current live credential.
3. **`testSecret`** — Open a connection to RDS using the `AWSPENDING` credential and run a trivial query (`SELECT 1`). Fail the rotation if this errors.
4. **`finishSecret`** — Move the `AWSCURRENT` label to the pending version and remove `AWSPENDING`. The old version is retained for rollback until the next rotation.

If any step fails, Secrets Manager retries the rotation and the live credential is left untouched.

### Application Behavior — Blue-Green Connection Pool Swap

To guarantee zero downtime, the application never mutates the in-use pool:

1. A background refresher polls Secrets Manager (default every 5 minutes) and compares the version ID of `AWSCURRENT` with the cached one.
2. When a new version is detected, the app builds a **new** connection pool using the new credentials and runs a health probe (`SELECT 1`) against it.
3. Only after the probe succeeds is the new pool promoted to active; in-flight queries on the old pool drain naturally.
4. The old pool is closed once its connections are idle (grace period, default 30s).

If the probe fails, the new pool is discarded and the old pool keeps serving traffic — a bad rotation can never take the app down.

### Rotation Drill (run quarterly)

1. **Trigger rotation manually** (simulates the 90-day schedule):
   ```bash
   aws secretsmanager rotate-secret \
     --secret-id lumigift/production/rds-credentials \
     --rotation-lambda-arn <ROTATION_LAMBDA_ARN>
   ```
2. **Watch the rotation complete**:
   ```bash
   aws secretsmanager describe-secret \
     --secret-id lumigift/production/rds-credentials \
     --query 'VersionIdsToStages'
   ```
   Confirm the new version ID carries `AWSCURRENT` and no version carries `AWSPENDING`.
3. **Verify the application picked up the new credentials**:
   - Check application logs for `db-credentials: rotated to version <id>`.
   - Confirm the cached version ID in `/api/health?deep=1` matches the new `AWSCURRENT` version.
4. **Confirm zero downtime**:
   - Health endpoint returns `200 ok` throughout the drill (no failed probes).
   - Error rate and p95 latency on the DB dashboards stay flat during the swap.
   - No connection-refused or auth-failure errors in logs.
5. **Record the drill** in the audit log (see below).

### Rollback

If the drill or a scheduled rotation misbehaves:

1. Re-point `AWSCURRENT` to the previous version:
   ```bash
   aws secretsmanager update-secret-version-stage \
     --secret-id lumigift/production/rds-credentials \
     --version-stage AWSCURRENT \
     --move-to-version-id <PREVIOUS_VERSION_ID> \
     --remove-from-version-id <NEW_VERSION_ID>
   ```
2. The application's refresher detects the version change and swaps back to a pool built from the previous credentials.
3. If the RDS password itself was already changed, reset it to the previous value using the previous credential, then re-run the drill.
4. File an incident report if production traffic was affected.

### Audit Log

Every rotation (scheduled or drill) must be recorded. Append an entry to `docs/ops/key-rotation-log.md`:

```markdown
## DB Credential Rotation — YYYY-MM-DD

- Trigger: [scheduled / manual drill]
- Rotated by: [automation / engineer name]
- Secret: lumigift/production/rds-credentials
- Old version ID: …
- New version ID: …
- Verified new credentials in use: [yes/no]
- Zero downtime confirmed: [yes/no]
- Rollback performed: [yes/no]
```

## Related Documents

- `docs/ops/production-secret-management.md` — Complete production secret management & rotation guide
- `docs/ops/runbook.md` — General incident response
- `docs/adr/0001-blockchain-stellar-soroban.md` — Stellar architecture decisions
- `.env.example` — Environment variable reference

