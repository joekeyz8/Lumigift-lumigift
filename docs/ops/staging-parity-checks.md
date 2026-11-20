# Staging Parity Checks

The `staging-parity.yml` workflow runs on a schedule and on demand to verify that the staging environment stays in sync with production. It performs two independent checks and alerts on-call when either fails. **Parity failures never block staging deploys** — they only notify.

## What Is Compared

### 1. Environment Variable Key Parity

Every key defined in `.env.example` must be present in the staging environment.

- The workflow parses `.env.example` and extracts the set of variable **keys** (names only — values are never compared or logged).
- It then reads the keys currently configured in staging (via the staging secrets/config store) and computes the difference.
- **Pass:** every key in `.env.example` exists in staging.
- **Fail:** one or more keys from `.env.example` are missing in staging. The alert lists the missing key names.

> Note: Extra keys present in staging but absent from `.env.example` are reported as a warning, not a failure.

### 2. Database Schema Parity

The workflow compares the **migration state** of the staging database against production.

- It reads the applied migration history (e.g. the migrations table / migration tool state) from both staging and production.
- It compares the ordered set of applied migrations.
- **Pass:** staging and production have the same applied migration set (staging may be ahead only if the difference is explicitly allowlisted).
- **Fail:** staging is missing migrations that production has applied, or the migration histories diverge. The alert lists the diverging migration identifiers.

Schema parity checks the migration state only; it does not diff raw column types or indexes.

## How Alerts Are Sent

When either check fails, the workflow sends a notification to:

- **Slack** — posted to the on-call / ops channel.
- **Email** — sent to the on-call rotation address.

The alert includes which check failed, the specific missing env var keys or diverging migrations, and a link to the failing workflow run. Alerts are sent on failure only; successful runs are silent.

## Failures Do Not Block Deploys

These checks are **advisory**. A parity failure:

- does **not** block or gate the staging deploy pipeline;
- does **not** fail the deploy job;
- **does** notify on-call so the drift can be corrected.

The goal is early visibility into configuration and schema drift, not deploy enforcement.

## Resolving Parity Failures

### Missing environment variables

1. Open the alert and note the listed missing keys.
2. Add the missing keys to the staging environment's config/secrets store with appropriate staging values.
3. Re-run the `staging-parity.yml` workflow to confirm the check passes.

### Schema / migration drift

1. Open the alert and note the diverging migrations.
2. If staging is **behind** production, apply the missing migrations to staging through the normal migration process.
3. If histories have **diverged** (e.g. a migration was applied out of order or rolled back), investigate the cause before reconciling — do not blindly re-run migrations.
4. Re-run the `staging-parity.yml` workflow to confirm the check passes.

If a divergence is intentional and temporary, add the migration to the allowlist referenced by the workflow and document the reason in the PR that introduces the allowlist entry.