# Local Development Setup Guide

This guide walks you through setting up Lumigift on your local machine from scratch.

---

## Prerequisites

| Tool                    | Minimum version | Install                                                                                           |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------- | --- |
| Node.js                 | 20              | [nodejs.org](https://nodejs.org)                                                                  |
| npm                     | 10              | bundled with Node.js                                                                              |
| Git                     | any             | [git-scm.com](https://git-scm.com)                                                                |
| Docker & Docker Compose | any             | [docs.docker.com](https://docs.docker.com/get-docker/)                                            |
| Rust + Cargo            | stable          | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs                                        | sh` |
| Stellar CLI             | latest          | see [Stellar CLI docs](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) |

> **Windows users:** all commands below assume **WSL 2** (Ubuntu 22.04 recommended).  
> Install WSL: `wsl --install` in an elevated PowerShell, then reopen a WSL terminal.  
> See [Section 10 — Windows / WSL2 setup](#10-windows--wsl2-setup) for the full Windows walkthrough, including Docker Desktop integration, the Rust toolchain, and common WSL2 issues.

---

## 1. Clone and install dependencies

```bash
git clone https://github.com/joekeyz8/Lumigift-lumigift.git
cd Lumigift-lumigift
npm install
```

---

## 2. Start backing services (Redis + PostgreSQL)

The project ships a `docker-compose.yml` for Redis. Add PostgreSQL alongside it:

```bash
# Start Redis (already in docker-compose.yml)
docker compose up -d

# Start PostgreSQL separately (or add it to docker-compose.yml)
docker run -d \
  --name lumigift-postgres \
  -e POSTGRES_USER=lumigift \
  -e POSTGRES_PASSWORD=lumigift \
  -e POSTGRES_DB=lumigift \
  -p 5432:5432 \
  postgres:16-alpine
```

Verify both are running:

```bash
docker ps          # should show redis and postgres containers
redis-cli ping     # → PONG
psql postgresql://lumigift:lumigift@localhost:5432/lumigift -c '\l'
```

---

## 3. Configure environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in the values described in the sections below.

### 3a. Core app

```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<run: openssl rand -base64 32>
```

### 3b. Database

```env
DATABASE_URL=postgresql://lumigift:lumigift@localhost:5432/lumigift
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_IDLE_TIMEOUT_MS=10000
DB_CONNECTION_TIMEOUT_MS=5000
```

### 3c. Redis

```env
REDIS_URL=redis://localhost:6379
```

### 3d. Stellar testnet account

See [Section 4](#4-create-a-stellar-testnet-account) for how to obtain these values.

```env
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SERVER_SECRET_KEY=<your testnet secret key>
STELLAR_ESCROW_CONTRACT_ID=<deployed contract id — see Section 6>
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
USDC_ASSET_CODE=USDC
```

### 3e. Paystack sandbox

See [Section 5](#5-set-up-paystack-sandbox) for how to obtain these values.

```env
PAYSTACK_SECRET_KEY=sk_test_<your_key>
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_<your_key>
```

### 3f. SMS (Termii)

Sign up at [termii.com](https://termii.com) and grab a free trial API key.

```env
TERMII_API_KEY=<your_termii_api_key>
TERMII_SENDER_ID=Lumigift
```

### 3g. Cron secret

```env
CRON_SECRET=<run: openssl rand -base64 32>
```

### 3h. Cloudinary (optional — only needed for gift media uploads)

```env
CLOUDINARY_CLOUD_NAME=<your_cloud_name>
CLOUDINARY_API_KEY=<your_api_key>
CLOUDINARY_API_SECRET=<your_api_secret>
```

---

## 4. Create a Stellar testnet account

This section walks through every step needed to get a funded testnet account with both XLM and USDC — required for the blockchain integration to work locally.

### 4a. Generate a keypair

```bash
# Install Stellar CLI if you haven't already (skip if already installed)
cargo install --locked stellar-cli --features opt

# Generate a new named keypair and store it in the local key store
stellar keys generate --global lumigift-dev --network testnet

# Print the public key (G…)
stellar keys address lumigift-dev

# Print the secret key (S…) — copy this into STELLAR_SERVER_SECRET_KEY
stellar keys show lumigift-dev
```

> **Keep the secret key safe.** Never commit it to version control. Store it only in `.env.local`, which is git-ignored.

### 4b. Fund with testnet XLM via Friendbot

Friendbot is a free faucet that sends 10 000 XLM to any new testnet account.

**Option A — Stellar CLI (recommended):**

```bash
stellar keys fund lumigift-dev --network testnet
```

**Option B — HTTP request (useful in CI or scripts):**

```bash
curl "https://friendbot.stellar.org/?addr=$(stellar keys address lumigift-dev)"
```

**Option C — Browser:**

Open the URL below, replacing `<YOUR_PUBLIC_KEY>` with the `G…` address printed above:

```
https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>
```

Verify the account is funded:

```bash
stellar account show lumigift-dev --network testnet
# Look for "native" balance ≥ 10 000 XLM
```

### 4c. Add a USDC trustline

Before your account can hold USDC, it must explicitly trust the testnet USDC asset issued by Circle's testnet issuer (`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`).

```bash
stellar tx new change-trust \
  --source-account lumigift-dev \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet \
  --sign \
  --submit
```

Verify the trustline was created:

```bash
stellar account show lumigift-dev --network testnet
# Look for a "USDC" entry under balances (balance will be 0 until funded)
```

### 4d. Get testnet USDC from the testnet issuer

The testnet USDC issuer accepts payment requests directly — sending any amount of XLM to the issuer account with the memo `USDC` causes it to send USDC back to your account.

**Option A — Stellar CLI:**

```bash
# Send 1 XLM to the issuer; it will return USDC to your account
stellar tx new payment \
  --source-account lumigift-dev \
  --destination GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --asset native \
  --amount 1 \
  --network testnet \
  --sign \
  --submit
```

**Option B — Stellar Laboratory (browser UI):**

1. Open [Stellar Laboratory — Transaction Builder](https://laboratory.stellar.org/#txbuilder?network=test).
2. Set **Source Account** to your public key.
3. Add a **Payment** operation:
   - Destination: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
   - Asset: `native` (XLM)
   - Amount: `1`
4. Sign and submit the transaction.

Verify USDC arrived:

```bash
stellar account show lumigift-dev --network testnet
# "USDC" balance should now be > 0
```

### Summary of values to copy into `.env.local`

| Variable                    | Where to get it                                                    |
| --------------------------- | ------------------------------------------------------------------ |
| `STELLAR_SERVER_SECRET_KEY` | `stellar keys show lumigift-dev`                                   |
| `USDC_ISSUER`               | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (fixed) |

---

## 5. Set up Paystack sandbox

1. Sign up at [paystack.com](https://paystack.com) (free).
2. In the dashboard, switch to **Test mode** (toggle in the top-right).
3. Go to **Settings → API Keys & Webhooks**.
4. Copy the **Test Secret Key** (`sk_test_…`) → `PAYSTACK_SECRET_KEY`.
5. Copy the **Test Public Key** (`pk_test_…`) → `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`.

**Test card numbers** (use these in the checkout flow):

| Card number         | CVV | Expiry | Result                   |
| ------------------- | --- | ------ | ------------------------ |
| 4084 0840 8408 4081 | 408 | 01/99  | Success                  |
| 4084 0840 8408 4081 | 408 | 01/99  | Declined (use wrong CVV) |

---

## 6. Run database migrations

```bash
# Apply all migrations in order
for f in migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done
```

---

## 7. Build and deploy the escrow contract (optional for frontend work)

```bash
# Add the wasm32 target if you haven't already
rustup target add wasm32-unknown-unknown

# Build the contract WASM
npm run contract:build

# Run Rust unit tests
npm run contract:test

# Deploy to testnet and copy the printed contract ID into STELLAR_ESCROW_CONTRACT_ID
STELLAR_NETWORK=testnet npm run contract:deploy
```

---

## 8. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## 9. Run the test suite

```bash
npm test                  # unit tests (Jest)
npm run test:coverage     # with coverage report
npm run contract:test     # Rust / Soroban tests
```

---

## Troubleshooting

### `ECONNREFUSED` connecting to Redis

Redis is not running. Start it:

```bash
docker compose up -d
```

### `ECONNREFUSED` connecting to PostgreSQL

The Postgres container is not running:

```bash
docker start lumigift-postgres
# or re-run the docker run command from Section 2
```

### `Error: connect ECONNREFUSED 127.0.0.1:5432` in tests

Tests that hit the DB need a running Postgres. Alternatively, mock `@/lib/db` in your test file:

```ts
jest.mock("@/lib/db", () => ({ query: jest.fn() }));
```

### Stellar `op_no_trust` error

Your server account does not have a USDC trustline. Re-run the `change-trust` command in [Section 4](#4-create-a-stellar-testnet-account).

### Stellar `tx_insufficient_balance`

Your testnet account is out of XLM. Re-fund it:

```bash
stellar keys fund lumigift-dev --network testnet
```

### `Invalid OTP` in local testing

OTPs are sent via Termii SMS. In local dev you can read the OTP directly from Redis:

```bash
redis-cli get "otp:+2348012345678"
```

### `next: command not found` after `npm install`

Run `npm install` again, or use `npx next dev` instead of `npm run dev`.

### Port 3000 already in use

```bash
# Find and kill the process using port 3000
lsof -ti:3000 | xargs kill -9
```

### WSL-specific: Docker Desktop not running

Make sure Docker Desktop is running on Windows and WSL integration is enabled:  
**Docker Desktop → Settings → Resources → WSL Integration → enable your distro**.

See [Section 10 — Windows / WSL2 setup](#10-windows--wsl2-setup) for more WSL2-specific troubleshooting.

---

## 10. Windows / WSL2 setup

This section is for contributors running Windows 10 (21H2+) or Windows 11. All development happens **inside WSL 2** — do not run the project from a PowerShell or CMD prompt.

> **Tested configuration:** Windows 11 23H2, WSL 2, Ubuntu 22.04 LTS, Docker Desktop 4.x with WSL 2 backend.  
> If you test this guide on a different combination, please update this note (and mention it in your PR) so the record stays current.

### 10a. Install WSL 2 and Ubuntu 22.04

1. Open **PowerShell as Administrator** and run:

   ```powershell
   wsl --install -d Ubuntu-22.04
   ```

   This enables the Virtual Machine Platform and WSL features, installs the WSL 2 kernel, sets WSL 2 as the default version, and installs Ubuntu 22.04.

2. Reboot if prompted, then launch **Ubuntu 22.04** from the Start menu and create your Linux username and password.

3. Confirm you are on WSL **2** (not 1):

   ```powershell
   wsl --list --verbose
   # NAME            STATE    VERSION
   # Ubuntu-22.04    Running  2
   ```

   If the version shows `1`, convert it:

   ```powershell
   wsl --set-version Ubuntu-22.04 2
   ```

4. Inside the Ubuntu terminal, update the base packages:

   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y build-essential pkg-config libssl-dev curl git
   ```

### 10b. Docker Desktop WSL 2 integration

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/) and, during setup, keep **Use WSL 2 instead of Hyper-V** enabled.
2. Open **Docker Desktop → Settings → General** and confirm **Use the WSL 2 based engine** is checked.
3. Go to **Settings → Resources → WSL Integration**:
   - Enable **Enable integration with my default WSL distro**.
   - Toggle on **Ubuntu-22.04** under *Enable integration with additional distros*.
4. Click **Apply & Restart**.

Verify Docker works from inside WSL 2 (not PowerShell):

```bash
docker version          # Client and Server sections should both appear
docker compose version  # Docker Compose v2
docker run --rm hello-world
```

> If `docker` is not found inside WSL, the integration toggle is off or Docker Desktop is not running. Start Docker Desktop on Windows first, then reopen your WSL terminal.

### 10c. Install the Rust toolchain in WSL 2

Install Rust with `rustup` **inside WSL 2** — do not use a Windows Rust installation, as the contract build runs in Linux.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Confirm the toolchain
rustc --version
cargo --version

# Add the Soroban contract target
rustup target add wasm32-unknown-unknown
rustup target list --installed   # should include wasm32-unknown-unknown
```

Add the Cargo bin directory to your shell profile so new terminals pick it up:

```bash
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc
```

Then install the Stellar CLI (see [Section 4a](#4a-generate-a-keypair)):

```bash
cargo install --locked stellar-cli --features opt
```

### 10d. Verify PostgreSQL and Redis via Docker Compose on Windows

From your project directory inside WSL 2, start the backing services exactly as in [Section 2](#2-start-backing-services-redis--postgresql):

```bash
docker compose up -d
```

Verify the containers are running:

```bash
docker ps
# should list the redis container and the lumigift-postgres container
```

Verify Redis responds:

```bash
docker exec -it $(docker ps -qf "ancestor=redis") redis-cli ping
# → PONG
```

Verify PostgreSQL accepts connections:

```bash
psql postgresql://lumigift:lumigift@localhost:5432/lumigift -c '\l'
# or, if psql is not installed in WSL:
docker exec -it lumigift-postgres psql -U lumigift -d lumigift -c '\l'
```

If both checks pass, continue with [Section 3](#3-configure-environment-variables).

### 10e. Common WSL2 issues

#### CRLF line endings break scripts

Windows tools may convert files to CRLF, which causes `bad interpreter: /bin/bash^M` errors or failing shell scripts.

```bash
# Inside WSL 2, in the repo
git config core.autocrlf input
git config core.eol lf
```

Also add a `.gitattributes` at the repo root to normalise line endings for everyone:

```gitattributes
* text=auto eol=lf
*.sh text eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
```

If files are already corrupted, re-checkout them:

```bash
git rm --cached -r . && git reset --hard
```

#### File permissions and performance (`/mnt/c` vs `~/projects`)

Do **not** clone the repo under `/mnt/c/...` (e.g. `C:\Users\you\...`). Cross-filesystem access is slow, and Windows does not preserve Linux permission bits, which breaks `npm install`, `cargo`, and executable scripts.

Clone into the Linux filesystem instead:

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/joekeyz8/Lumigift-lumigift.git
cd Lumigift-lumigift
```

If you must access the files from Windows Explorer, use `\\wsl$\Ubuntu-22.04\home\<user>\projects\Lumigift-lumigift`.

If permissions are already wrong, reset them:

```bash
chmod -R u+rwX ~/projects/Lumigift-lumigift
```

#### Port forwarding and `localhost`

WSL 2 normally forwards `localhost` automatically, so `http://localhost:3000` in a Windows browser reaches the dev server running in WSL 2. If it does not:

1. Confirm the server is listening inside WSL 2:

   ```bash
   ss -tlnp | grep 3000
   ```

2. Restart WSL so the localhost relay is re-established:

   ```powershell
   wsl --shutdown
   ```

   Then reopen Ubuntu and start the dev server again.

3. Check Windows Firewall. If you use a custom firewall profile, allow the WSL virtual adapter:

   ```powershell
   New-NetFirewallRule -DisplayName "WSL2" -Direction Inbound -InterfaceAlias "vEthernet (WSL)" -Action Allow
   ```

4. If you need to reach the server from another device on your LAN, bind Next.js to all interfaces (`npm run dev -- -H 0.0.0.0`) and forward the port from Windows:

   ```powershell
   netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=(wsl hostname -I).Trim()
   ```

   Remove the rule later with `netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0`.

#### Docker Desktop integration stops working after a Windows update

Restart Docker Desktop, then run `wsl --shutdown` in PowerShell and reopen Ubuntu. If the problem persists, re-check **Settings → Resources → WSL Integration** and re-apply.

---

## Useful commands reference

```bash
npm run dev              # start Next.js dev server
npm run build            # production build
npm run lint             # ESLint
npm run type-check       # TypeScript type check
npm run format           # Prettier
npm test                 # Jest unit tests
npm run contract:build   # build Soroban WASM
npm run contract:test    # Rust tests
npm run contract:deploy  # deploy to testnet
docker compose up -d     # start Redis
docker compose down      # stop Redis
```

Windows / WSL2 helpers:

```powershell
wsl --list --verbose     # list distros and their WSL version
wsl --shutdown           # restart the WSL 2 VM (fixes localhost forwarding)
```

```bash
docker exec -it $(docker ps -qf "ancestor=redis") redis-cli ping   # verify Redis from WSL 2
rustup target list --installed                                     # confirm wasm32-unknown-unknown
```
