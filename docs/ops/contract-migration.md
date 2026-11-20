# Stellar Testnet → Mainnet Migration

This runbook walks through migrating the application's Stellar configuration from testnet to mainnet. Follow the steps in order. Do not skip the preconditions or verification steps.

> **Owner:** Stellar integration engineer
> **Reviewer sign-off required before execution** (see bottom of document).

---

## 0. Preconditions

- [ ] All changes have been merged to the release branch and CI is green.
- [ ] A maintenance window has been scheduled and announced to stakeholders.
- [ ] You have access to the production secret manager / deployment environment.
- [ ] You have a funded mainnet deployer keypair (with enough XLM for contract deployment fees).
- [ ] You have the mainnet USDC issuer address confirmed from an authoritative source (Circle).
- [ ] You have a current backup of `.contract-ids.json` and the production env file.
- [ ] You have read the rollback section (Section 8) and know how to trigger it.

---

## 1. Record the current (testnet) state

Capture the current values so rollback is possible.

- [ ] Copy the current `.contract-ids.json` to a safe location (e.g. `.contract-ids.testnet.bak.json`).
- [ ] Record the current env values:
  - [ ] `STELLAR_NETWORK`
  - [ ] `STELLAR_HORIZON_URL`
  - [ ] `STELLAR_NETWORK_PASSPHRASE`
  - [ ] `STELLAR_RPC_URL`
  - [ ] `USDC_ISSUER`
  - [ ] Exchange-rate feed configuration (see Section 6)
- [ ] Note the currently deployed testnet contract ID(s).

---

## 2. Update Stellar environment variables

Set the following in the production environment (secret manager / deployment config). Use the values below as the mainnet targets.

- [ ] `STELLAR_NETWORK=mainnet` (or `public`, matching the value your config loader expects — confirm against `src/config`).
- [ ] `STELLAR_HORIZON_URL=https://horizon.stellar.org`
- [ ] `STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`
- [ ] `STELLAR_RPC_URL=https://soroban-rpc.mainnet.stellar.gateway.fm` (or your approved mainnet RPC provider).
- [ ] `USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (mainnet USDC issuer — verify before use).

> ⚠️ The network passphrase must match the network exactly. A mismatch will cause signature verification failures.

- [ ] Double-check every value against the mainnet reference before proceeding.

---

## 3. Deploy the mainnet contract

- [ ] Confirm the deployer keypair is configured and funded on mainnet.
- [ ] Run the deployment script with the mainnet confirmation flag:

  ```bash
  npx ts-node scripts/deploy-contract.ts --confirm-mainnet
  ```

- [ ] Capture the deployed contract ID from the script output.
- [ ] Confirm the deployment transaction succeeded on a mainnet explorer (e.g. Stellar Expert).

---

## 4. Update `.contract-ids.json`

- [ ] Open `.contract-ids.json`.
- [ ] Update the mainnet entry with the contract ID captured in Section 3.
- [ ] Leave the testnet entry intact (do not delete it).
- [ ] Validate the JSON is well-formed:

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('.contract-ids.json','utf8')); console.log('ok')"
  ```

- [ ] Commit the change through the normal review process.

---

## 5. Deploy the application with the new configuration

- [ ] Deploy the application so it picks up the updated env vars and `.contract-ids.json`.
- [ ] Confirm the deployment completed without errors.

---

## 6. Switch the exchange-rate feed

- [ ] Update the exchange-rate feed configuration to point at the mainnet source (per the provider's mainnet endpoint / asset identifiers).
- [ ] Confirm the feed is reading mainnet USDC (`USDC_ISSUER` from Section 2).
- [ ] Restart or reload the rate-feed worker if required.

---

## 7. Verification

- [ ] Application health checks pass.
- [ ] Logs show the app connected to `horizon.stellar.org` (mainnet), not testnet.
- [ ] A read-only contract call against the mainnet contract ID succeeds.
- [ ] Exchange-rate values are populated and plausible (non-zero, correct asset).
- [ ] Perform a small end-to-end smoke transaction on mainnet and confirm it settles.
- [ ] Confirm no testnet endpoints or passphrases remain in the running configuration.

---

## 8. Rollback procedure

Trigger rollback if any verification step in Section 7 fails and cannot be resolved quickly.

- [ ] Restore the previous env values recorded in Section 1:
  - [ ] `STELLAR_NETWORK`
  - [ ] `STELLAR_HORIZON_URL`
  - [ ] `STELLAR_NETWORK_PASSPHRASE`
  - [ ] `STELLAR_RPC_URL`
  - [ ] `USDC_ISSUER`
- [ ] Restore `.contract-ids.json` from the backup taken in Section 1.
- [ ] Revert the exchange-rate feed configuration to the previous (testnet) source.
- [ ] Redeploy the application with the restored configuration.
- [ ] Re-run the verification steps in Section 7 against testnet to confirm the system is healthy.
- [ ] Notify stakeholders of the rollback and open an incident/ticket to investigate.

> Note: the mainnet contract deployment (Section 3) does not need to be undone for rollback; simply stop pointing the app at it.

---

## 9. Post-migration

- [ ] Update the launch readiness backlog (H-9) to mark this item complete.
- [ ] Archive the recorded testnet state and deployment logs with the release record.
- [ ] Schedule a follow-up to remove stale testnet configuration once mainnet is stable.

---

## Reviewer sign-off

This procedure must be reviewed by the engineer who built the Stellar integration before execution.

- [ ] Reviewed by (Stellar integration engineer): ______________________  Date: __________
- [ ] Executed by: ______________________  Date: __________
- [ ] Rollback verified by: ______________________  Date: __________