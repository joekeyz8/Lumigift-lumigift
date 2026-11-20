# Environment Variable Reference

Complete reference for every environment variable Lumigift reads at runtime.  
Variables are validated on startup by a Zod schema in `src/server/config/env.ts` — the server will refuse to start if a required variable is missing or malformed.

> **Security note:** Never commit real credentials to version control.  
> Copy `.env.example` to `.env.local` (git-ignored) and fill in your own values.  
> Generate random secrets with: `openssl rand -base64 32`

---

## Table of Contents

1. [Application](#1-application)
2. [Authentication](#2-authentication)
3. [CSRF Protection](#3-csrf-protection)
4. [Database](#4-database)
5. [Stellar / Soroban Blockchain](#5-stellar--soroban-blockchain)
6. [USDC Asset](#6-usdc-asset)
7. [Payments — Paystack (NGN)](#7-payments--paystack-ngn)
8. [Payments — Stripe (International)](#8-payments--stripe-international)
9. [SMS / OTP](#9-sms--otp)
10. [Cron / Scheduler](#10-cron--scheduler)
11. [Redis](#11-redis)
12. [Exchange Rate Cache](#12-exchange-rate-cache)
13. [Gift Amount Limits](#13-gift-amount-limits)
14. [Cloudinary (Media Uploads)](#14-cloudinary-media-uploads)
15. [Error Monitoring — Sentry](#15-error-monitoring--sentry)
16. [WebAuthn / Passkeys](#16-webauthn--passkeys)
17. [Referral Programme](#17-referral-programme)
18. [Business Accounts](#18-business-accounts)
19. [Secrets Validation (`secrets:validate`)](#19-secrets-validation-secretsvalidate)
20. [Variable Quick-Reference Table](#20-variable-quick-reference-table)
21. [Keeping This Document In Sync](#21-keeping-this-document-in-sync)

---

## Conventions

- **Required** — the Zod schema in `src/server/config/env.ts` has no default and no `.optional()`; startup fails if the variable is missing.
- **Sensitive** — marked with 🔒. These values must never be committed, logged, or exposed to the browser. Use placeholder values only in examples.
- **Scope** — `Server` means the value is only read in server code; `Server + Client` means it is prefixed `NEXT_PUBLIC_` and inlined into the browser bundle.

---

## 1. Application

These variables configure the app's public identity and base URL.

### `NEXT_PUBLIC_APP_URL`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server + Client (prefixed `NEXT_PUBLIC_`) |
| **Format** | Full URL with protocol — no trailing slash |
| **Example** | `http://localhost:3000` |

Base URL where the app is hosted. Used for redirect URLs, webhook callback registration, and email links.

- Local dev: `http://localhost:3000`
- Production: `https://lumigift.com`

### `NEXT_PUBLIC_APP_NAME`

| | |
|---|---|
| **Required** | No (default: `"Lumigift"`) |
| **Scope** | Server + Client |
| **Format** | Plain text string |
| **Example** | `Lumigift` |

Display name shown in the UI, notification messages, and SMS templates.

---

## 2. Authentication

Lumigift uses [NextAuth.js](https://next-auth.js.org/) with a phone OTP credential provider.  
Sessions are stored in signed JWT cookies.

### `NEXTAUTH_URL`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Full URL — must match `NEXT_PUBLIC_APP_URL` |
| **Example** | `http://localhost:3000` |

Canonical URL used by NextAuth for callback URL construction and session validation.  
Must match the origin the browser is actually using.

### `NEXTAUTH_SECRET`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | Random string, minimum 32 characters |
| **Example** | *(not shown — generate your own)* |
| **Generate** | `openssl rand -base64 32` |

Secret used to sign and encrypt JWT session tokens and session cookies.  
Changing this value invalidates all existing sessions.

### `NEXTAUTH_SECRET_PREVIOUS`

| | |
|---|---|
| **Required** | No |
| **Scope** | Server only |
| **Format** | Same as `NEXTAUTH_SECRET` |
| **Example** | *(not shown)* |

Previous secret key used during key rotation.  
Set this to the old `NEXTAUTH_SECRET` when rotating so existing sessions remain valid during the grace period.  
Remove this variable after `NEXTAUTH_ROTATION_GRACE_HOURS` has elapsed.  
See `docs/ops/key-rotation.md` for the full rotation procedure.

### `NEXTAUTH_ROTATION_GRACE_HOURS`

| | |
|---|---|
| **Required** | No (default: `24`) |
| **Scope** | Server only |
| **Format** | Integer (hours) |
| **Example** | `24` |

Number of hours that tokens signed with `NEXTAUTH_SECRET_PREVIOUS` remain valid after rotation.

---

## 3. CSRF Protection

### `CSRF_SECRET`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | Hex string, minimum 32 characters |
| **Example** | *(not shown — generate your own)* |
| **Generate** | `openssl rand -hex 32` |

Secret used to sign double-submit CSRF tokens (`src/lib/csrf.ts`).  
All state-mutating API routes (`POST`, `PUT`, `DELETE`) validate a CSRF token in the `x-csrf-token` header, which the browser obtains from `GET /api/v1/csrf`.

---

## 4. Database

Lumigift uses PostgreSQL via the `pg` driver.

### `DATABASE_URL`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — contains credentials |
| **Format** | `postgresql://username:password@host:port/database` |
| **Example** | `postgresql://lumigift:lumigift@localhost:5432/lumigift` |

Full PostgreSQL connection string.  
Production deployments should use a managed database URL (Vercel Postgres, Supabase, AWS RDS) stored in the deployment environment, never in a committed file.

### `READ_REPLICA_DATABASE_URL`

|              |                                                                 |
| ------------ | --------------------------------------------------------------- |
| **Required** | No (falls back to `DATABASE_URL`)                               |
| **Scope**    | Server only — contains credentials                              |
| **Format**   | `postgresql://username:password@host:port/database`             |
| **Example**  | `postgresql://lumigift:lumigift@replica.internal:5432/lumigift` |

Connection string for the PostgreSQL read replica. Read-only GET endpoints
(dashboard gift lists, recipient gift lookup, notifications, transaction
history) use it via `readPool` from `@/lib/db`; all writes, and reads that must
see a just-committed write, use the primary. Pool sizing (`DB_POOL_*`) applies
to both pools. In production it is provisioned by Terraform
(`aws_db_instance.postgres_replica`) and stored in Secrets Manager. See
[the read replica runbook](runbooks/read-replica.md) for lag alerting and failover.

### `DB_POOL_MIN`

| | |
|---|---|
| **Required** | No (default: `2`) |
| **Scope** | Server only |
| **Format** | Positive integer |
| **Example** | `2` |

Minimum number of idle connections maintained in the connection pool.

### `DB_POOL_MAX`

| | |
|---|---|
| **Required** | No (default: `10`) |
| **Scope** | Server only |
| **Format** | Positive integer |
| **Example** | `10` |

Maximum number of concurrent connections in the pool. Keep below the database plan's connection limit.

### `DB_IDLE_TIMEOUT_MS`

| | |
|---|---|
| **Required** | No (default: `10000`) |
| **Scope** | Server only |
| **Format** | Integer (milliseconds) |
| **Example** | `10000` |

Time in milliseconds before an idle connection is closed and removed from the pool.

### `DB_CONNECTION_TIMEOUT_MS`

| | |
|---|---|
| **Required** | No (default: `5000`) |
| **Scope** | Server only |
| **Format** | Integer (milliseconds) |
| **Example** | `5000` |

Maximum time to wait when acquiring a connection from the pool before throwing an error.

---

## 5. Stellar / Soroban Blockchain

These variables configure the app's connection to the Stellar network and the Soroban escrow smart contract.

### `STELLAR_NETWORK`

| | |
|---|---|
| **Required** | No (default: `"testnet"`) |
| **Scope** | Server only |
| **Format** | `"testnet"` or `"mainnet"` |
| **Example** | `testnet` |

Which Stellar network to connect to. Use `testnet` for all local and staging environments.

### `STELLAR_HORIZON_URL`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Full HTTPS URL |
| **Testnet** | `https://horizon-testnet.stellar.org` |
| **Mainnet** | `https://horizon.stellar.org` |

Stellar Horizon API endpoint used for account queries, transaction submission, and event streaming.

### `STELLAR_NETWORK_PASSPHRASE`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Exact network passphrase string |
| **Testnet** | `Test SDF Network ; September 2015` |
| **Mainnet** | `Public Global Stellar Network ; September 2015` |

Network passphrase included in transaction envelopes for replay protection.  
Must match the network specified in `STELLAR_NETWORK`.

### `STELLAR_ESCROW_CONTRACT_ID`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Soroban contract address starting with `C` |
| **Example** | `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM` |

Address of the deployed Soroban escrow contract (`contracts/escrow`).  
Obtain by running `npm run contract:deploy` and copying the printed contract ID.

### `STELLAR_SERVER_SECRET_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — critical secret, never expose |
| **Format** | Stellar secret key starting with `S`, 56 characters |
| **Example** | *(not shown — generate your own)* |
| **Generate** | `stellar keys generate --global lumigift-dev --network testnet` |

Server-side Stellar secret key used to sign contract deployment and escrow funding transactions.  
In production, store in AWS Secrets Manager or HashiCorp Vault — never in a config file.  
See `docs/ops/key-rotation.md` for the key rotation procedure.

### `STELLAR_RPC_URL`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Full HTTPS URL |
| **Testnet** | `https://soroban-testnet.stellar.org` |
| **Mainnet** | `https://soroban-rpc.stellar.org` |

Soroban RPC endpoint used for smart contract invocations and event indexing.

### `STELLAR_SERVER_PUBLIC_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Stellar public key starting with `G`, 56 characters |
| **Example** | `GABC...XYZ` |
| **Derive** | `stellar keys address lumigift-dev` |

Public key corresponding to `STELLAR_SERVER_SECRET_KEY`.  
Used for RPC simulations and to verify that transactions are signed by the expected authority.

---

## 6. USDC Asset

### `USDC_ISSUER`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Stellar public key (`G…`) |
| **Testnet** | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| **Mainnet** | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |

Stellar account that issues the USDC tokens used in escrow.  
This is Circle's official USDC issuer for each network — do not change it.

### `USDC_ASSET_CODE`

| | |
|---|---|
| **Required** | No (default: `"USDC"`) |
| **Scope** | Server only |
| **Format** | String, max 12 characters |
| **Example** | `USDC` |

Asset code for the stablecoin. Should always be `USDC`.

---

## 7. Payments — Paystack (NGN)

Paystack handles Nigerian Naira (NGN) on-ramp payments.

### `PAYSTACK_SECRET_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | `sk_test_…` (sandbox) or `sk_live_…` (production) |
| **Obtain** | [Paystack Dashboard → Settings → API Keys](https://dashboard.paystack.com/#/settings/developers) |

Secret key for server-side Paystack API calls (charge initialization, refunds, verification).  
Use the **test key** in development and staging environments.

### `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server + Client |
| **Format** | `pk_test_…` (sandbox) or `pk_live_…` (production) |
| **Obtain** | Same Paystack dashboard page |

Public key used to initialize the Paystack Popup on the frontend.  
Safe to expose to the browser.

---

## 8. Payments — Stripe (International)

Stripe handles international card payments.

### `STRIPE_SECRET_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | `sk_test_…` (sandbox) or `sk_live_…` (production) |
| **Obtain** | [Stripe Dashboard → Developers → API Keys](https://dashboard.stripe.com/apikeys) |

Secret key for server-side Stripe API calls (payment intents, refunds).

### `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server + Client |
| **Format** | `pk_test_…` (sandbox) or `pk_live_…` (production) |
| **Obtain** | Same Stripe dashboard page |

Publishable key for initializing Stripe Elements in the browser.

### `STRIPE_WEBHOOK_SECRET`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | `whsec_…` |
| **Obtain** | [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks) |

Signing secret used to verify `stripe-signature` headers on incoming webhook events.  
The webhook endpoint is `POST /api/v1/payments/stripe/webhook`.  
Register `{NEXT_PUBLIC_APP_URL}/api/v1/payments/stripe/webhook` as the endpoint URL in the Stripe dashboard and set this to the secret it provides.

---

## 9. SMS / OTP

Lumigift sends one-time passwords via Termii SMS.

### `TERMII_API_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | Alphanumeric string |
| **Obtain** | [Termii Dashboard → API Settings](https://accounts.termii.com/#/api-settings) |

API key for the Termii messaging service.  
Free trial keys are available for development.

### `TERMII_SENDER_ID`

| | |
|---|---|
| **Required** | No (default: `"Lumigift"`) |
| **Scope** | Server only |
| **Format** | Alphanumeric, max 11 characters |
| **Example** | `Lumigift` |

Sender name shown on OTP SMS messages. Must be registered and approved in the Termii dashboard.

---

## 10. Cron / Scheduler

Internal cron endpoints (`/api/v1/cron/*`) are authenticated with a static bearer token to prevent unauthorized triggering.

### `METRICS_TOKEN`

|              |                                   |
| ------------ | --------------------------------- |
| **Required** | No (endpoint disabled when unset) |
| **Scope**    | Server only — secret              |
| **Format**   | Random string, 32+ characters     |
| **Example**  | `openssl rand -hex 32`            |

Bearer token Prometheus sends to scrape `GET /api/metrics` (gift funnel
counters and histograms). When unset, the endpoint returns 401 for every
request. The Grafana dashboard and alert rules live in `infra/monitoring/`.

### `CRON_SECRET`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | Random string, minimum 32 characters |
| **Example** | *(not shown — generate your own)* |
| **Generate** | `openssl rand -base64 32` |

Static secret included in cron job requests as `Authorization: Bearer <CRON_SECRET>`.  
Configure this value in Vercel's cron settings or your external scheduler.  
See `openapi.yaml` for the `cronBearer` security scheme definition.

---

## 11. Redis

Redis is used for session caching, OTP storage, and job queuing.

### `REDIS_URL`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | `redis://[username:password@]host:port[/database]` |
| **Example** | `redis://localhost:6379` |

Connection URL for the Redis instance.  
Local dev: start Redis with `docker compose up -d`.  
Production: use a managed Redis (Upstash, Redis Cloud, AWS ElastiCache).

---

## 12. Exchange Rate Cache

The exchange rate service caches the NGN/USDC rate in Redis to avoid hitting Stellar Horizon on every request.
See [`docs/ops/exchange-rate-caching.md`](ops/exchange-rate-caching.md) for full documentation including the
fetch → cache → serve flow, staleness behaviour, and the operator runbook for manually refreshing stale rates.

### `EXCHANGE_RATE_CACHE_TTL`

| | |
|---|---|
| **Required** | No (default: `60`) |
| **Scope** | Server only |
| **Format** | Positive integer (seconds) |
| **Example** | `60` |

Redis TTL in seconds for the cached NGN/USDC exchange rate. When the cached entry expires the service
fetches a fresh rate from the Stellar Horizon order book and repopulates the cache.

- **Lower value** (e.g. `10`) — more frequent Horizon fetches; useful in volatile rate environments.
- **Higher value** (e.g. `300`) — fewer Horizon fetches; acceptable when rate stability is high.
- **`0`** — disables caching (not recommended in production; will hit Horizon on every request).

> **Implementation note:** As of the current release `CACHE_TTL_SEC` is a compile-time constant (`60`).
> To make this variable effective, wire it into the service:
> `const CACHE_TTL_SEC = Number(process.env.EXCHANGE_RATE_CACHE_TTL ?? 60);`

---

## 13. Gift Amount Limits

These variables enforce AML (anti-money laundering) and regulatory limits on gift amounts.  
All values are in Nigerian Naira (NGN) with no decimal component.

### `GIFT_MIN_AMOUNT_NGN`

| | |
|---|---|
| **Required** | No (default: `500`) |
| **Scope** | Server only |
| **Format** | Positive integer (NGN) |
| **Example** | `500` |

Minimum allowed gift amount. Prevents micro-transaction abuse.

### `GIFT_MAX_AMOUNT_NGN`

| | |
|---|---|
| **Required** | No (default: `500000`) |
| **Scope** | Server only |
| **Format** | Positive integer (NGN) |
| **Example** | `500000` |

Maximum allowed gift amount per single transaction.

### `GIFT_DAILY_LIMIT_NGN`

| | |
|---|---|
| **Required** | No (default: `1000000`) |
| **Scope** | Server only |
| **Format** | Positive integer (NGN) |
| **Example** | `1000000` |

Maximum total gift amount a single user may send in a rolling 24-hour window.  
Exceeding this limit returns error code `GIFT_DAILY_LIMIT` (HTTP 429).

---

## 14. Cloudinary (Media Uploads)

Gift cards can include an image or short video uploaded to Cloudinary.

### `CLOUDINARY_CLOUD_NAME`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | String (your Cloudinary cloud name) |
| **Obtain** | [Cloudinary Console → Dashboard → Account Details](https://console.cloudinary.com/console) |

Your Cloudinary cloud identifier.

### `CLOUDINARY_API_KEY`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only |
| **Format** | Numeric string |
| **Obtain** | Same Cloudinary Console page |

API key for authenticating server-side upload requests.

### `CLOUDINARY_API_SECRET`

| | |
|---|---|
| **Required** | Yes |
| **Scope** | Server only — never expose to client |
| **Format** | Alphanumeric string |
| **Obtain** | Same Cloudinary Console page |

API secret used to sign upload parameters. Never include in client-side code or API responses.

---

## 15. Error Monitoring — Sentry

### `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`

| | |
|---|---|
| **Required** | No (monitoring disabled if unset) |
| **Scope** | `SENTRY_DSN` — server only; `NEXT_PUBLIC_SENTRY_DSN` — client + server |
| **Format** | Sentry DSN URL |
| **Obtain** | [sentry.io → Project Settings → Client Keys (DSN)](https://sentry.io) |

Data Source Name for sending error reports to Sentry.  
Both variables should be set to the same DSN value.

### `SENTRY_ORG`

| | |
|---|---|
| **Required** | No (only needed for CI source-map uploads) |
| **Scope** | CI/CD build environment only |
| **Format** | Sentry organization slug |
| **Obtain** | Sentry → Organization Settings → General → Organization Slug |

### `SENTRY_PROJECT`

| | |
|---|---|
| **Required** | No (only needed for CI source-map uploads) |
| **Scope** | CI/CD build environment only |
| **Format** | Sentry project slug |
| **Obtain** | Sentry → Project Settings → General → Project Slug |

### `SENTRY_AUTH_TOKEN`

| | |
|---|---|
| **Required** | No (only needed for CI source-map uploads) |
| **Scope** | CI/CD build environment only — never expose at runtime |
| **Format** | Sentry auth token string |
| **Obtain** | Sentry → User Settings → Auth Tokens |

Used by the Sentry webpack plugin during `next build` to upload source maps.  
Store as a CI secret (e.g., GitHub Actions secret) — never in `.env.local`.

---

## 16. WebAuthn / Passkeys

Passkey (WebAuthn) registration and login. The relying party ID and origin must match the domain the browser sees, otherwise the browser rejects the ceremony.

### `WEBAUTHN_RP_ID`

| | |
|---|---|
| **Required** | No (default: hostname derived from `NEXT_PUBLIC_APP_URL`) |
| **Scope** | Server only |
| **Format** | Bare hostname — no scheme, no port, no path |
| **Example** | `lumigift.com` |
| **Sensitive** | No |

Relying Party ID used when generating and verifying WebAuthn challenges. Must be the registrable domain of the origin (or a parent of it). For local development use `localhost`.

### `WEBAUTHN_RP_NAME`

| | |
|---|---|
| **Required** | No (default: `NEXT_PUBLIC_APP_NAME`) |
| **Scope** | Server only |
| **Format** | Plain text string |
| **Example** | `Lumigift` |
| **Sensitive** | No |

Human-readable name shown by the browser/OS in the passkey prompt.

### `WEBAUTHN_ORIGIN`

| | |
|---|---|
| **Required** | No (default: `NEXT_PUBLIC_APP_URL`) |
| **Scope** | Server only |
| **Format** | Full origin with scheme — no trailing slash |
| **Example** | `https://lumigift.com` |
| **Sensitive** | No |

Expected origin of WebAuthn ceremonies. Must exactly match the origin the browser reports (including `http://localhost:3000` in dev).

### `WEBAUTHN_CHALLENGE_TTL_SEC`

| | |
|---|---|
| **Required** | No (default: `300`) |
| **Scope** | Server only |
| **Format** | Positive integer (seconds) |
| **Example** | `300` |
| **Sensitive** | No |

How long a generated WebAuthn challenge remains valid before it must be re-requested.

---

## 17. Referral Programme

Referral codes and reward crediting.

### `REFERRAL_CODE_LENGTH`

| | |
|---|---|
| **Required** | No (default: `8`) |
| **Scope** | Server only |
| **Format** | Positive integer |
| **Example** | `8` |
| **Sensitive** | No |

Length of generated referral codes. Keep short enough to type, long enough to avoid collisions.

### `REFERRAL_REWARD_NGN`

| | |
|---|---|
| **Required** | No (default: `500`) |
| **Scope** | Server only |
| **Format** | Positive integer (NGN) |
| **Example** | `500` |
| **Sensitive** | No |

Reward credited to the referrer when a referred user completes their first qualifying gift.

### `REFERRAL_MAX_REWARDS_PER_USER`

| | |
|---|---|
| **Required** | No (default: `50`) |
| **Scope** | Server only |
| **Format** | Positive integer |
| **Example** | `50` |
| **Sensitive** | No |

Cap on the number of referral rewards a single user can earn, to limit abuse.

### `REFERRAL_ENABLED`

| | |
|---|---|
| **Required** | No (default: `true`) |
| **Scope** | Server only |
| **Format** | `"true"` or `"false"` |
| **Example** | `true` |
| **Sensitive** | No |

Feature flag to enable or disable the referral programme without a deploy.

---

## 18. Business Accounts

Organisation/business accounts, team members, and invoicing.

### `BUSINESS_ACCOUNTS_ENABLED`

| | |
|---|---|
| **Required** | No (default: `false`) |
| **Scope** | Server only |
| **Format** | `"true"` or `"false"` |
| **Example** | `false` |
| **Sensitive** | No |

Feature flag gating business-account creation and the business dashboard.

### `BUSINESS_MAX_TEAM_MEMBERS`

| | |
|---|---|
| **Required** | No (default: `10`) |
| **Scope** | Server only |
| **Format** | Positive integer |
| **Example** | `10` |
| **Sensitive** | No |

Maximum number of team members that can be invited to a single business account.

### `BUSINESS_INVOICE_PREFIX`

| | |
|---|---|
| **Required** | No (default: `"INV"`) |
| **Scope** | Server only |
| **Format** | Uppercase alphanumeric string |
| **Example** | `INV` |
| **Sensitive** | No |

Prefix used when generating business invoice numbers.

### `BUSINESS_WEBHOOK_SECRET`

| | |
|---|---|
| **Required** | No (endpoint disabled when unset) |
| **Scope** | Server only — sensitive 🔒 |
| **Format** | Random string, minimum 32 characters |
| **Example** | *(not shown — generate your own)* |
| **Generate** | `openssl rand -base64 32` |
| **Sensitive** | Yes 🔒 |

Signing secret used to verify outbound business-account webhook deliveries. Never commit a real value.

---

## 19. Secrets Validation (`secrets:validate`)

`npm run secrets:validate` runs `scripts/validate-production-secrets.ts`. It is intended to be run in CI and immediately before a production deploy to catch missing, placeholder, or wrong-environment secrets.

### What it checks

- **Presence** — every variable marked required in `src/server/config/env.ts` must be set (non-empty).
- **Placeholder detection** — values matching known placeholders are rejected, e.g. `changeme`, `your-secret-here`, `xxx`, `TODO`, `sk_test_…` in production, and the literal values shipped in `.env.example`.
- **Minimum length / format** — secrets must meet the schema's minimum length (e.g. 32 chars for `NEXTAUTH_SECRET`, `CSRF_SECRET`, `CRON_SECRET`) and format checks (Stellar keys start with `S`/`G`, Paystack/Stripe key prefixes).
- **Mainnet live-key requirements** — when `STELLAR_NETWORK=mainnet`, the script additionally requires live (non-test) payment keys: `PAYSTACK_SECRET_KEY` must start with `sk_live_`, `STRIPE_SECRET_KEY` must start with `sk_live_`, and `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` must start with `pk_live_`. Test keys on mainnet are treated as failures.
- **Cross-field consistency** — `NEXTAUTH_URL` must match `NEXT_PUBLIC_APP_URL`; `STELLAR_NETWORK_PASSPHRASE` must match `STELLAR_NETWORK`; `WEBAUTHN_ORIGIN` must match `NEXT_PUBLIC_APP_URL`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All checks passed. |
| `1` | One or more checks failed — the offending variable names are printed (values are never printed). |

### Usage

```bash
# Validate the current environment (reads .env.local / process env)
npm run secrets:validate

# In CI, provide secrets via environment variables, not a committed file
NEXTAUTH_SECRET="$NEXTAUTH_SECRET" npm run secrets:validate
```

> The script never prints secret values — only variable names and the reason for failure.

---

## 20. Variable Quick-Reference Table

| Variable | Required | Scope | Default |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | ✅ | Server + Client | — |
| `NEXT_PUBLIC_APP_NAME` | No | Server + Client | `Lumigift` |
| `NEXTAUTH_URL` | ✅ | Server | — |
| `NEXTAUTH_SECRET` | ✅ | Server | — |
| `NEXTAUTH_SECRET_PREVIOUS` | No | Server | — |
| `NEXTAUTH_ROTATION_GRACE_HOURS` | No | Server | `24` |
| `CSRF_SECRET` | ✅ | Server | — |
| `DATABASE_URL` | ✅ | Server | — |
| `READ_REPLICA_DATABASE_URL` | No | Server | `DATABASE_URL` |
| `DB_POOL_MIN` | No | Server | `2` |
| `DB_POOL_MAX` | No | Server | `10` |
| `DB_IDLE_TIMEOUT_MS` | No | Server | `10000` |
| `DB_CONNECTION_TIMEOUT_MS` | No | Server | `5000` |
| `STELLAR_NETWORK` | No | Server | `testnet` |
| `STELLAR_HORIZON_URL` | ✅ | Server | — |
| `STELLAR_NETWORK_PASSPHRASE` | ✅ | Server | — |
| `STELLAR_ESCROW_CONTRACT_ID` | ✅ | Server | — |
| `STELLAR_SERVER_SECRET_KEY` | ✅ | Server | — |
| `STELLAR_RPC_URL` | ✅ | Server | — |
| `STELLAR_SERVER_PUBLIC_KEY` | ✅ | Server | — |
| `USDC_ISSUER` | ✅ | Server | — |
| `USDC_ASSET_CODE` | No | Server | `USDC` |
| `PAYSTACK_SECRET_KEY` | ✅ | Server | — |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | ✅ | Server + Client | — |
| `STRIPE_SECRET_KEY` | ✅ | Server | — |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | ✅ | Server + Client | — |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Server | — |
| `TERMII_API_KEY` | ✅ | Server | — |
| `TERMII_SENDER_ID` | No | Server | `Lumigift` |
| `CRON_SECRET` | ✅ | Server | — |
| `METRICS_TOKEN` | No | Server | — |
| `REDIS_URL` | ✅ | Server | — |
| `EXCHANGE_RATE_CACHE_TTL` | No | Server | `60` |
| `GIFT_MIN_AMOUNT_NGN` | No | Server | `500` |
| `GIFT_MAX_AMOUNT_NGN` | No | Server | `500000` |
| `GIFT_DAILY_LIMIT_NGN` | No | Server | `1000000` |
| `CLOUDINARY_CLOUD_NAME` | ✅ | Server | — |
| `CLOUDINARY_API_KEY` | ✅ | Server | — |
| `CLOUDINARY_API_SECRET` | ✅ | Server | — |
| `SENTRY_DSN` | No | Server | — |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Server + Client | — |
| `SENTRY_ORG` | No | CI only | — |
| `SENTRY_PROJECT` | No | CI only | — |
| `SENTRY_AUTH_TOKEN` | No | CI only | — |
| `WEBAUTHN_RP_ID` | No | Server | derived from `NEXT_PUBLIC_APP_URL` |
| `WEBAUTHN_RP_NAME` | No | Server | `NEXT_PUBLIC_APP_NAME` |
| `WEBAUTHN_ORIGIN` | No | Server | `NEXT_PUBLIC_APP_URL` |
| `WEBAUTHN_CHALLENGE_TTL_SEC` | No | Server | `300` |
| `REFERRAL_CODE_LENGTH` | No | Server | `8` |
| `REFERRAL_REWARD_NGN` | No | Server | `500` |
| `REFERRAL_MAX_REWARDS_PER_USER` | No | Server | `50` |
| `REFERRAL_ENABLED` | No | Server | `true` |
| `BUSINESS_ACCOUNTS_ENABLED` | No | Server | `false` |
| `BUSINESS_MAX_TEAM_MEMBERS` | No | Server | `10` |
| `BUSINESS_INVOICE_PREFIX` | No | Server | `INV` |
| `BUSINESS_WEBHOOK_SECRET` 🔒 | No | Server | — |

Variables marked 🔒 are sensitive — never commit real values.

---

## 21. Keeping This Document In Sync

This document must stay in lockstep with `serverConfig` in `src/server/config/index.ts` and the Zod schema in `src/server/config/env.ts`.

**Review checklist** (run whenever a variable is added, renamed, or removed):

- [ ] Every key in `src/server/config/env.ts` has a section in this document with name, description, required/optional, example value, and a sensitive marker where applicable.
- [ ] Every key exposed on `serverConfig` (`src/server/config/index.ts`) is documented — including derived/defaulted values.
- [ ] The [Quick-Reference Table](#20-variable-quick-reference-table) lists every variable with its required status and default.
- [ ] `.env.example` contains a matching entry (with a placeholder, never a real value) for every variable.
- [ ] New sensitive variables are marked 🔒 and added to the `secrets:validate` checks if they need format/length validation.
- [ ] The Table of Contents is updated if a new section was added.

A quick way to diff the schema against this doc:

```bash
# List variable names declared in the Zod schema
grep -oE '^\s+[A-Z0-9_]+:' src/server/config/env.ts | tr -d ' :' | sort -u
```

---

## Related Documents

- `.env.example` — annotated template for all variables
- `.env.local.example` — Docker Compose local dev template
- `docs/ops/key-rotation.md` — rotating `NEXTAUTH_SECRET` and `STELLAR_SERVER_SECRET_KEY`
- `docs/local-dev-setup.md` — step-by-step local setup guide
- `docs/troubleshooting.md` — diagnosing startup failures and misconfigured variables
- `src/server/config/env.ts` — Zod validation schema (source of truth for all defaults and formats)
- `src/server/config/index.ts` — `serverConfig` object (source of truth for what the app actually reads)
- `scripts/validate-production-secrets.ts` — `secrets:validate` implementation
