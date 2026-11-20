# Staging Environment

Lumigift uses a staging environment to validate changes before they reach production users.

## How it works

- Pushes to the `develop` branch automatically trigger `.github/workflows/staging.yml`
- The workflow builds the app with **testnet** Stellar configuration and deploys a Vercel preview
- Smoke tests run against the live staging URL after deployment

## Stellar network

Staging always uses **Stellar testnet**:

| Variable                     | Value                                                      |
| ---------------------------- | ---------------------------------------------------------- |
| `STELLAR_NETWORK`            | `testnet`                                                  |
| `STELLAR_HORIZON_URL`        | `https://horizon-testnet.stellar.org`                      |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`                        |
| `USDC_ISSUER`                | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

## GitHub Secrets (staging)

All staging secrets use the `STAGING_` prefix and are stored in the **staging** GitHub
environment (`Settings → Environments → staging`).

| Secret                               | Description                                 |
| ------------------------------------ | ------------------------------------------- |
| `STAGING_NEXTAUTH_SECRET`            | NextAuth JWT signing secret                 |
| `STAGING_DATABASE_URL`               | PostgreSQL connection string for staging DB |
| `STAGING_STELLAR_ESCROW_CONTRACT_ID` | Testnet escrow contract address             |
| `STAGING_STELLAR_SERVER_SECRET_KEY`  | Testnet Stellar signing key                 |
| `STAGING_PAYSTACK_SECRET_KEY`        | Paystack test-mode secret key               |
| `STAGING_STRIPE_SECRET_KEY`          | Stripe test-mode secret key                 |
| `STAGING_STRIPE_WEBHOOK_SECRET`      | Stripe webhook signing secret (test)        |
| `STAGING_TERMII_API_KEY`             | Termii API key (test environment)           |
| `STAGING_REDIS_URL`                  | Redis connection string for staging         |
| `STAGING_CRON_SECRET`                | Bearer token for `/api/cron/unlock`         |

GitHub variables (non-secret, stored in the staging environment):

| Variable          | Example                        |
| ----------------- | ------------------------------ |
| `STAGING_APP_URL` | `https://staging.lumigift.app` |

Shared secrets (used by both staging and production):

| Secret              | Description            |
| ------------------- | ---------------------- |
| `VERCEL_TOKEN`      | Vercel API token       |
| `VERCEL_ORG_ID`     | Vercel organization ID |
| `VERCEL_PROJECT_ID` | Vercel project ID      |

## Smoke tests

After each staging deployment, Playwright runs tests tagged `@smoke` against the live URL.
To tag a test as a smoke test, add `@smoke` to its title:

```typescript
test("@smoke homepage loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Lumigift/);
});
```

## Load tests (Issue #561)

After a successful staging deploy, the load test suite in `load-tests/` runs against
the live staging URL. It is wired into `.github/workflows/staging.yml` as a step that
depends on the deploy and smoke-test jobs, so it only runs when staging is healthy.

### Scenarios

| Scenario           | What it exercises                                  |
| ------------------ | -------------------------------------------------- |
| Gift creation      | `POST` gift creation endpoint with a valid payload |
| Claim              | Claim flow for an existing test gift               |
| Dashboard listing  | Authenticated dashboard gift listing endpoint      |

### Thresholds

The run uses **50 concurrent virtual users (VUs)** and fails the CI step if any
threshold is breached:

| Metric     | Threshold   |
| ---------- | ----------- |
| p95 latency| < 500 ms    |
| Error rate | < 0.1 %     |

### Failure behaviour

If a threshold is breached the load test step exits non-zero, which fails the
staging workflow. A failed staging workflow blocks promotion: do not merge
`develop` → `main` until the load tests pass (or the regression is fixed and the
workflow is re-run).

### Artifacts

Load test results (summary report and raw metrics) are uploaded as CI artifacts on
every run, pass or fail, and are retained per the repository's default artifact
retention. Download them from the **Actions** tab of the staging workflow run.

### Required configuration

The load test job uses the staging GitHub environment and reads:

| Name                     | Type     | Description                              |
| ------------------------ | -------- | ---------------------------------------- |
| `STAGING_APP_URL`        | Variable | Base URL the load tests target           |
| `STAGING_LOAD_TEST_TOKEN` | Secret   | Auth token for authenticated scenarios   |

## Promoting to production

Once staging is validated (including passing load tests), merge `develop` → `main`.
The production deploy workflow (`.github/workflows/deploy.yml`) will trigger
automatically.

---

## Staging ↔ Production Parity Checks (Issue #294)

An automated parity check runs on every push to `develop` and on a weekly
schedule (Mondays 08:00 UTC). It is defined in
`.github/workflows/staging-parity.yml`.

### What is checked

| Check              | What it does                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Env-var key parity | Verifies every required secret/variable key from `.env.example` is present in the `staging` GitHub environment |
| PR comment         | Posts a parity report as a comment on deploy-triggering PRs                                                    |
| Weekly schedule    | Catches drift even without a deploy                                                                            |

The check compares **keys only** — secret values are never read or logged.

### What it does NOT check automatically

- **DB schema drift** between staging and production: detected by running
  migrations on both environments and comparing the output. This is a manual
  step until a migration-diffing tool is integrated.
- **Feature flag parity**: document any divergences in this file when they are
  intentional.

### When the parity check fails

1. Go to **Settings → Environments → staging** in the GitHub repository.
2. Add the missing secret or variable listed in the parity report.
3. Re-run the failed workflow from the Actions tab.

If a discrepancy is intentional (e.g. a staging-only override), document it in
the table below.

### Known intentional staging/production differences

| Variable               | Staging value        | Production value | Reason                                   |
| ---------------------- | -------------------- | ---------------- | ---------------------------------------- |
| `STELLAR_NETWORK`      | `testnet`            | `mainnet`        | Staging uses testnet to avoid real money |
| `NEXT_PUBLIC_APP_NAME` | `Lumigift (Staging)` | `Lumigift`       | Visual indicator in UI                   |
| Stellar Horizon URL    | testnet endpoint     | mainnet endpoint | Follows network                          |
