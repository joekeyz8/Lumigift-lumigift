# Contributing to Lumigift

Thank you for your interest in contributing! Lumigift is an open-source project built on the Stellar blockchain, and we welcome contributions of all kinds.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Onboarding Video Walkthrough](#onboarding-video-walkthrough)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Docker Development Setup](#docker-development-setup)
- [Running Tests](#running-tests)
- [Architecture Overview](#architecture-overview)
- [Development Workflow](#development-workflow)
- [Common Pitfalls](#common-pitfalls)
- [Commit Convention](#commit-convention)
- [Pull Request Process](#pull-request-process)
- [Branch Protection Rules](#branch-protection-rules)
- [Smart Contract Contributions](#smart-contract-contributions)
- [Reporting Bugs](#reporting-bugs)

---

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

---

## Onboarding Video Walkthrough

> 🎬 **New to Lumigift?** Watch the contributor onboarding video before diving into the text below.

A screen-recorded walkthrough is available to help first-time contributors get up and running quickly. The video covers the full path from cloning the repo to opening your first PR:

| Step | What is covered |
| ---- | --------------- |
| 1    | Fork & clone the repository |
| 2    | Docker environment setup    |
| 3    | Running the test suite      |
| 4    | Creating and submitting a PR |

**Watch the walkthrough:**

- 🎥 **YouTube:** _[Lumigift Contributor Onboarding Walkthrough](https://www.youtube.com/watch?v=PLACEHOLDER)_ *(link will be updated once the video is published)*
- 🎥 **Loom (mirror):** _[Lumigift Contributor Onboarding — Loom](https://www.loom.com/share/PLACEHOLDER)_ *(link will be updated once the video is published)*

> **Accessibility:** The video will include closed captions and a full transcript. The transcript is available at [`docs/contributor-onboarding-transcript.md`](docs/contributor-onboarding-transcript.md) for anyone who prefers reading or cannot access the video.

> **Keeping it current:** The video and transcript are reviewed and re-recorded whenever the setup steps change significantly (e.g. Node.js major version bumps, Docker Compose config changes). If you notice the video is out of date, please open an issue or PR.

---

## Getting Started

### Prerequisites

| Tool        | Version                                       |
| ----------- | --------------------------------------------- |
| Node.js     | ≥ 20                                          |
| npm         | ≥ 10                                          |
| Rust        | stable (for contract work)                    |
| Stellar CLI | latest                                        |
| gitleaks    | ≥ 8 (required for pre-commit secret scanning) |

Install gitleaks before your first commit:

```bash
# macOS
brew install gitleaks

# Linux (replace VERSION with latest from https://github.com/gitleaks/gitleaks/releases)
VERSION=v8.30.1
curl -sSL "https://github.com/gitleaks/gitleaks/releases/download/${VERSION}/gitleaks_${VERSION#v}_linux_x64.tar.gz" \
  | tar -xz -C /usr/local/bin gitleaks

# Windows (via Chocolatey)
choco install gitleaks
```

### Setup

```bash
# 1. Fork the repository on GitHub, then clone your fork
git clone https://github.com/<your-username>/lumigift.git
cd lumigift

# 2. Add the upstream remote so you can stay in sync
git remote add upstream https://github.com/lumigift/lumigift.git

# 3. Install dependencies
npm install

# 4. Copy environment variables
cp .env.example .env.local
# Fill in the required values (see Environment Variables below)

# 5. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

All local configuration lives in `.env.local` (git-ignored). Copy `.env.example` and fill in the values below. Never commit real secrets — the pre-commit hook will block them.

| Variable | Purpose | Local default / notes |
| -------- | ------- | --------------------- |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Stellar network to target | `testnet` |
| `STELLAR_HORIZON_URL` | Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `STELLAR_SOROBAN_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `ESCROW_CONTRACT_ID` | Deployed escrow contract ID | Deploy your own to testnet (see below) |
| `PAYSTACK_SECRET_KEY` | Paystack API secret | Use your **test** key (`sk_test_...`) |
| `PAYSTACK_PUBLIC_KEY` | Paystack public key | Use your **test** key (`pk_test_...`) |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `DATABASE_URL` | Postgres connection string | Provided by Docker Compose |

> `.env.example` is the source of truth. If you add a new variable, document it there and in this table.

---

## Docker Development Setup

The fastest way to get a fully working environment (app + Postgres + Redis) is Docker Compose:

```bash
# Build and start all services in the background
docker compose up --build -d

# Tail logs for the app
docker compose logs -f app

# Stop everything
docker compose down
```

This starts:

- **app** — Next.js dev server on [http://localhost:3000](http://localhost:3000)
- **postgres** — on `localhost:5432`
- **redis** — on `localhost:6379`

If you prefer running the app on your host (for faster HMR), start only the backing services:

```bash
docker compose up -d postgres redis
npm run dev
```

---

## Running Tests

Run the full suite before opening a PR:

```bash
npm run lint          # ESLint
npm run type-check    # TypeScript check
npm test              # Jest unit tests
npm run contract:build  # Build Soroban WASM
npm run contract:test   # Run Rust contract tests
```

CI runs the same commands (see `.github/workflows/ci.yml`). A PR cannot be merged until all of them pass.

---

## Architecture Overview

Lumigift is a Next.js application backed by a Soroban smart contract on Stellar. The full diagram and component responsibilities are documented in [`docs/architecture.md`](docs/architecture.md).

At a high level:

| Component | Responsibility |
| --------- | -------------- |
| `src/app/` | Next.js App Router — pages and API routes. Thin layer: validates input, delegates to services. |
| `src/server/services/` | Core domain logic (gift creation, claiming, scheduling). Server-only. |
| `src/server/middleware/` | Auth and rate limiting for API routes. |
| `src/lib/` | Third-party integrations — Stellar, Paystack, SMS. |
| `src/components/` | React UI components. |
| `contracts/escrow/` | Soroban escrow contract (Rust) that holds funds until claim conditions are met. |

---

## Development Workflow

```bash
npm run dev          # Start Next.js dev server
npm run lint         # ESLint
npm run type-check   # TypeScript check
npm run format       # Prettier
npm test             # Jest unit tests
npm run contract:build  # Build Soroban WASM
npm run contract:test   # Run Rust contract tests
```

### Secret scanning

The pre-commit hook runs [gitleaks](https://github.com/gitleaks/gitleaks) on staged files before every commit. If it finds a potential secret, the commit is blocked and the match is shown (value redacted).

**If you get a false positive** (e.g. a test fixture or placeholder value), add an allowlist entry to `.gitleaks.toml` and commit that change first:

```toml
[[rules.allowlist]]
description = "Explain why this is not a real secret"
paths = ["path/to/file"]
regexes = ["the-matching-pattern"]
```

Never disable the hook entirely or use `--no-verify` to bypass it. If you believe the detection is wrong, open an issue or update the allowlist instead.

**To run the scan manually** against all staged changes:

```bash
gitleaks protect --staged --config=.gitleaks.toml --redact
```

**To scan the full repo history:**

```bash
gitleaks detect --config=.gitleaks.toml --redact
```

---

## Common Pitfalls

### Stellar Testnet

- **Unfunded accounts fail silently.** A new testnet account must be funded via [Friendbot](https://laboratory.stellar.org/#account-creator) before it can submit transactions.
- **Testnet resets.** Stellar periodically resets testnet, wiping accounts and contracts. If your `ESCROW_CONTRACT_ID` suddenly stops working, redeploy the contract and update `.env.local`.
- **Wrong network.** Double-check `NEXT_PUBLIC_STELLAR_NETWORK=testnet` and that your Horizon/Soroban URLs point at testnet, not mainnet.

### Paystack Sandbox

- **Use test keys only.** Keys must start with `sk_test_` / `pk_test_`. Live keys will hit real money — never put them in `.env.local`.
- **Webhooks need a public URL.** Paystack cannot reach `localhost`. Use a tunnel (e.g. `ngrok http 3000`) and set the webhook URL in your Paystack dashboard.
- **Test cards.** Use Paystack's [documented test cards](https://paystack.com/docs/payments/test-payments/) — real cards will be declined in test mode.

### Local Redis

- **Connection refused.** If you see `ECONNREFUSED 127.0.0.1:6379`, Redis isn't running. Start it with `docker compose up -d redis` or `redis-server`.
- **Stale keys between runs.** Rate-limit and OTP keys persist across restarts. Flush with `docker compose exec redis redis-cli FLUSHALL` when testing auth flows.
- **Port conflicts.** If you already run Redis locally, either stop it or change the published port in `docker-compose.yml` and update `REDIS_URL`.

---

## Project Structure

```
src/
├── app/            # Next.js App Router (pages + API routes)
├── server/         # Server-only business logic
│   ├── services/   # Core domain logic
│   ├── middleware/ # Auth, rate limiting
│   └── config/     # Server config
├── components/     # React UI components
├── lib/            # Third-party integrations (Stellar, Paystack, SMS)
├── types/          # TypeScript types and Zod schemas
└── styles/         # Vanilla CSS design system
contracts/
└── escrow/         # Soroban smart contract (Rust)
```

---

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) to enable automated changelog generation:

```
<type>(<scope>): <short description>

Types: feat | fix | docs | style | refactor | perf | test | chore | ci | revert
```

Examples:

- `feat(gift): add media upload to gift creation`
- `fix(contract): prevent double-claim race condition`
- `docs: update contributing guide`

### Commit Types and Changelog Mapping

| Type       | Description                         | Appears in Changelog |
| ---------- | ----------------------------------- | -------------------- |
| `feat`     | New feature                         | ✅ Added             |
| `fix`      | Bug fix                             | ✅ Fixed             |
| `docs`     | Documentation only                  | ❌                   |
| `style`    | Code style (formatting, whitespace) | ❌                   |
| `refactor` | Code refactoring                    | ❌                   |
| `perf`     | Performance improvement             | ✅ Changed           |
| `test`     | Adding or updating tests            | ❌                   |
| `chore`    | Maintenance tasks                   | ❌                   |
| `ci`       | CI/CD changes                       | ❌                   |
| `revert`   | Revert previous commit              | ✅ Fixed             |

**Breaking changes:** Add `BREAKING CHANGE:` in the commit body or append `!` after the type:

```
feat(api)!: remove deprecated v1 endpoints

BREAKING CHANGE: The /api/v1/legacy endpoints have been removed. Use /api/v2 instead.
```

---

## Changelog Updates

We maintain [CHANGELOG.md](CHANGELOG.md) following the [Keep a Changelog](https://keepachangelog.com/) format.

### When to Update the Changelog

- **Automated:** Changelog entries are generated from conventional commit messages during release
- **Manual:** For complex features or breaking changes, add detailed context to the `[Unreleased]` section

### Changelog Sections

Changes are grouped under these categories:

- **Added** — New features (`feat` commits)
- **Changed** — Changes to existing functionality (`perf`, major `refactor`)
- **Deprecated** — Features marked for removal
- **Removed** — Deleted features (breaking changes)
- **Fixed** — Bug fixes (`fix` commits)
- **Security** — Security improvements or vulnerability fixes

### Release Process

1. All changes accumulate in the `[Unreleased]` section
2. On release, the maintainer:
   - Renames `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`
   - Creates a new empty `[Unreleased]` section
   - Updates comparison links at the bottom
   - Tags the release in Git

### Example Entry

```markdown
## [1.2.0] - 2024-12-20

### Added

- Gift scheduling for future delivery dates (#45)
- Email notifications for gift events (#52)

### Fixed

- Race condition in concurrent gift claims (#48)
- Incorrect timezone handling in unlock scheduler (#51)

### Security

- Implement rate limiting on OTP endpoints (#50)
```

---

## Pull Request Process

1. Sync your fork and create a branch from `develop`:
   ```bash
   git fetch upstream
   git checkout -b feat/your-feature upstream/develop
   ```
2. Make your changes with tests where applicable
3. Ensure all checks pass locally: `npm run lint && npm run type-check && npm test`
4. Push to your fork and open a PR against `develop` (not `main`)
5. Fill in the PR template — describe the change, link the issue, and note any manual testing
6. Request a review — PRs require at least one approval (two for security-sensitive contract changes)
7. Address review feedback by pushing new commits; keep the branch up to date with `develop`

---

## Branch Protection Rules

Both `main` and `develop` are protected branches. The rules below are enforced via GitHub repository settings and cannot be bypassed by any contributor, including maintainers.

### `main`

| Rule                              | Setting                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Required approving reviews        | 1                                                                         |
| Dismiss stale reviews on new push | ✅                                                                        |
| Require status checks to pass     | `lint-and-type-check`, `test`, `build`, `contract-test`, `contract-build` |
| Require branches to be up to date | ✅                                                                        |
| Direct pushes                     | ❌ Disabled                                                               |
| Force pushes                      | ❌ Disabled                                                               |
| Branch deletion                   | ❌ Disabled                                                               |

### `develop`

| Rule                              | Setting                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Required approving reviews        | —                                                                         |
| Require status checks to pass     | `lint-and-type-check`, `test`, `build`, `contract-test`, `contract-build` |
| Require branches to be up to date | ✅                                                                        |
| Direct pushes                     | ❌ Disabled                                                               |
| Force pushes                      | ❌ Disabled                                                               |
| Branch deletion                   | ✅ Allowed                                                                |

### Why these rules?

- **No direct pushes** — all changes must go through a PR so CI runs and history stays clean.
- **Required CI checks** — a PR cannot be merged until every workflow job in `ci.yml` passes.
- **1 approval on `main`** — production code gets a second pair of eyes before it ships.
- **Force-push disabled** — prevents rewriting shared history and breaking other contributors' local branches.
- **Deletion disabled on `main`** — the production branch cannot be accidentally removed.

---

## Smart Contract Contributions

The Soroban escrow contract lives in `contracts/escrow/`. Before making changes:

1. Read the [Soroban documentation](https://developers.stellar.org/docs/build/smart-contracts)
2. Write tests in `contracts/escrow/src/lib.rs`
3. Run `npm run contract:test` to verify
4. Document any new public functions with Rust doc comments

Security-sensitive contract changes require two approvals.

---

## Reporting Bugs

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md). For security vulnerabilities, please email **security@lumigift.com** instead of opening a public issue.
