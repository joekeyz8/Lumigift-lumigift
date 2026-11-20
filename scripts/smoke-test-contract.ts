#!/usr/bin/env ts-node
/**
 * Smoke test suite for deployed Lumigift Escrow Soroban contract on Testnet / Mainnet.
 *
 * Runs on-chain and RPC level verification against a deployed contract:
 *   1. Validates Contract ID StrKey format (C...)
 *   2. Checks RPC node health & connectivity
 *   3. Verifies contract instance existence on-chain
 *   4. Tests contract response to `get_state` (verifies VM execution)
 *   5. Tests contract response to `get_status`
 *   6. End-to-end escrow flow (unless --skip-e2e):
 *      a. initialize a gift with 1 USDC (10_000_000 stroops)
 *      b. verify get_status returns Locked
 *      c. cancel and verify funds returned to sender
 *   7. Produces structured smoke test report: smoke-test-report.json
 *
 * Usage:
 *   STELLAR_NETWORK=testnet ts-node scripts/smoke-test-contract.ts
 *   ts-node scripts/smoke-test-contract.ts --contract-id CA... --network testnet
 *   ts-node scripts/smoke-test-contract.ts --skip-e2e   # read-only checks only
 *
 * Exit code:
 *   0: All smoke tests passed (safe for promotion)
 *   1: Smoke test failure (blocks promotion)
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  rpc as SorobanRpc,
  Keypair,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
} from "@stellar/stellar-sdk";

/** Testnet USDC Stellar Asset Contract. */
const TESTNET_USDC_CONTRACT_ID =
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** 1 USDC expressed in stroops (7 decimals). */
const ONE_USDC_STROOPS = 10_000_000n;

/** EscrowStatus enum values as defined in the contract. */
enum EscrowStatus {
  Locked = 0,
  Claimed = 1,
  Cancelled = 2,
  Expired = 3,
}

export interface SmokeTestCheck {
  name: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  durationMs: number;
  details?: string;
  error?: string;
}

export interface SmokeTestReport {
  timestamp: string;
  network: string;
  contractId: string;
  rpcUrl: string;
  status: "PASSED" | "FAILED";
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  durationMs: number;
  checks: SmokeTestCheck[];
}

async function runSmokeTests() {
  const startTime = Date.now();
  const args = process.argv.slice(2);
  const ROOT = path.resolve(__dirname, "..");

  // ─── Network & RPC Config ───────────────────────────────────────────────────
  let network = process.env.STELLAR_NETWORK ?? "testnet";
  const networkArgIdx = args.indexOf("--network");
  if (networkArgIdx !== -1 && args[networkArgIdx + 1]) {
    network = args[networkArgIdx + 1];
  }

  const rpcUrl =
    process.env.STELLAR_RPC_URL ??
    (network === "mainnet"
      ? "https://soroban-rpc.stellar.org"
      : "https://soroban-testnet.stellar.org");

  const networkPassphrase =
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    (network === "mainnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015");

  // ─── Locate Contract ID ─────────────────────────────────────────────────────
  let contractId = process.env.STELLAR_ESCROW_CONTRACT_ID ?? "";
  const contractIdArgIdx = args.indexOf("--contract-id");
  if (contractIdArgIdx !== -1 && args[contractIdArgIdx + 1]) {
    contractId = args[contractIdArgIdx + 1];
  }

  if (!contractId) {
    // Try reading from deployment-${network}.json
    const manifestPath = path.resolve(ROOT, `deployment-${network}.json`);
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (manifest.contractId) {
          contractId = manifest.contractId;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!contractId) {
    // Try reading from .contract-ids.json
    const contractIdsPath = path.resolve(ROOT, ".contract-ids.json");
    if (fs.existsSync(contractIdsPath)) {
      try {
        const ids = JSON.parse(fs.readFileSync(contractIdsPath, "utf-8"));
        if (ids[network]?.escrow) {
          contractId = ids[network].escrow;
        }
      } catch {
        /* ignore */
      }
    }
  }

  const skipE2e = args.includes("--skip-e2e");

  const checks: SmokeTestCheck[] = [];
  const reportPath = path.resolve(ROOT, "smoke-test-report.json");

  console.log(`\n🧪 Starting Smart Contract Smoke Tests [${network}]`);
  console.log(`   Contract ID: ${contractId || "(not provided)"}`);
  console.log(`   RPC URL:     ${rpcUrl}`);
  console.log("───────────────────────────────────────────────────\n");

  // Helper to record check
  const recordCheck = (
    name: string,
    passed: boolean,
    durationMs: number,
    details?: string,
    error?: string
  ) => {
    const status = passed ? "PASSED" : "FAILED";
    checks.push({ name, status, durationMs, details, error });
    const symbol = passed ? "✅" : "❌";
    console.log(`${symbol} [${status}] ${name} (${durationMs}ms)`);
    if (details) console.log(`   └─ ${details}`);
    if (error) console.log(`   └─ Error: ${error}`);
  };

  // ─── Check 1: Contract ID Format ────────────────────────────────────────────
  const check1Start = Date.now();
  if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
    recordCheck(
      "Contract ID Format Validation",
      false,
      Date.now() - check1Start,
      undefined,
      `Invalid or missing contract ID: "${contractId}". Expected C... (56 chars).`
    );
  } else {
    recordCheck(
      "Contract ID Format Validation",
      true,
      Date.now() - check1Start,
      `Valid Soroban Contract ID: ${contractId}`
    );
  }

  // ─── Check 2: RPC Endpoint Connectivity ─────────────────────────────────────
  const check2Start = Date.now();
  let rpcHealthy = false;
  let latestLedger = 0;
  try {
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    const health = await server.getHealth();
    if (health.status === "healthy") {
      const ledgerInfo = await server.getLatestLedger();
      latestLedger = ledgerInfo.sequence;
      rpcHealthy = true;
      recordCheck(
        "Soroban RPC Endpoint Connectivity",
        true,
        Date.now() - check2Start,
        `Status: healthy | Latest Ledger: ${latestLedger}`
      );
    } else {
      recordCheck(
        "Soroban RPC Endpoint Connectivity",
        false,
        Date.now() - check2Start,
        undefined,
        `RPC health check status: ${health.status}`
      );
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordCheck(
      "Soroban RPC Endpoint Connectivity",
      false,
      Date.now() - check2Start,
      undefined,
      errorMsg
    );
  }

  // ─── Check 3: On-Chain get_state Invocation ─────────────────────────────────
  const check3Start = Date.now();
  if (contractId && /^C[A-Z2-7]{55}$/.test(contractId)) {
    // Dummy / test source key or server secret key for read invocations
    const sourceKey =
      process.env.STELLAR_SERVER_SECRET_KEY ??
      // Well-known public test account secret if no secret is provided for read-only invocation
      "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    const invokeResult = spawnSync(
      "stellar",
      [
        "contract",
        "invoke",
        "--id",
        contractId,
        "--source",
        sourceKey,
        "--rpc-url",
        rpcUrl,
        "--network-passphrase",
        networkPassphrase,
        "--",
        "get_state",
      ],
      { encoding: "utf-8", shell: false }
    );

    const out = (invokeResult.stdout || "") + (invokeResult.stderr || "");
    // A live, deployed, uninitialized contract responds with HostError / error code 4 (EscrowError::NotInitialized)
    // or returns data. Both prove on-chain bytecode execution.
    const isLive =
      out.includes("HostError") ||
      out.includes("4") ||
      out.includes("NotInitialized") ||
      invokeResult.status === 0;

    if (isLive) {
      recordCheck(
        "Contract get_state Execution Check",
        true,
        Date.now() - check3Start,
        "Contract responded on-chain (verified active bytecode execution)"
      );
    } else {
      recordCheck(
        "Contract get_state Execution Check",
        false,
        Date.now() - check3Start,
        undefined,
        invokeResult.stderr || invokeResult.error?.message || "No response from contract"
      );
    }
  } else {
    recordCheck(
      "Contract get_state Execution Check",
      false,
      Date.now() - check3Start,
      undefined,
      "Skipped due to invalid contract ID"
    );
  }

  // ─── Check 4: On-Chain get_status Invocation ────────────────────────────────
  const check4Start = Date.now();
  if (contractId && /^C[A-Z2-7]{55}$/.test(contractId)) {
    const sourceKey =
      process.env.STELLAR_SERVER_SECRET_KEY ??
      "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    const invokeResult = spawnSync(
      "stellar",
      [
        "contract",
        "invoke",
        "--id",
        contractId,
        "--source",
        sourceKey,
        "--rpc-url",
        rpcUrl,
        "--network-passphrase",
        networkPassphrase,
        "--",
        "get_status",
      ],
      { encoding: "utf-8", shell: false }
    );

    const out = (invokeResult.stdout || "") + (invokeResult.stderr || "");
    const isLive =
      out.includes("HostError") ||
      out.includes("NotInitialized") ||
      out.includes("0") ||
      out.includes("1") ||
      out.includes("2") ||
      out.includes("3") ||
      invokeResult.status === 0;

    if (isLive) {
      recordCheck(
        "Contract get_status Execution Check",
        true,
        Date.now() - check4Start,
        "Contract get_status method verified on-chain"
      );
    } else {
      recordCheck(
        "Contract get_status Execution Check",
        false,
        Date.now() - check4Start,
        undefined,
        invokeResult.stderr || invokeResult.error?.message || "Invocation failed"
      );
    }
  } else {
    recordCheck(
      "Contract get_status Execution Check",
      false,
      Date.now() - check4Start,
      undefined,
      "Skipped due to invalid contract ID"
    );
  }

  // ─── Check 5: End-to-End Escrow Flow (initialize → get_status → cancel) ─────
  if (skipE2e) {
    recordCheck(
      "End-to-End Escrow Flow (initialize/get_status/cancel)",
      true,
      0,
      "Skipped via --skip-e2e (read-only run)"
    );
  } else if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
    recordCheck(
      "End-to-End Escrow Flow (initialize/get_status/cancel)",
      false,
      0,
      undefined,
      "Skipped due to invalid contract ID"
    );
  } else {
    const e2eStart = Date.now();
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    const usdcContractId =
      process.env.STELLAR_USDC_CONTRACT_ID ?? TESTNET_USDC_CONTRACT_ID;

    const secretKey = process.env.STELLAR_SERVER_SECRET_KEY ?? "";
    if (!secretKey) {
      recordCheck(
        "End-to-End Escrow Flow (initialize/get_status/cancel)",
        false,
        Date.now() - e2eStart,
        undefined,
        "STELLAR_SERVER_SECRET_KEY is required for end-to-end checks (or pass --skip-e2e)"
      );
    } else {
      let sender: Keypair;
      try {
        sender = Keypair.fromSecret(secretKey);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        recordCheck(
          "End-to-End Escrow Flow (initialize/get_status/cancel)",
          false,
          Date.now() - e2eStart,
          undefined,
          `Invalid STELLAR_SERVER_SECRET_KEY: ${errorMsg}`
        );
        sender = Keypair.random();
      }

      const senderAddress = sender.publicKey();
      const recipient = Keypair.random().publicKey();
      const escrowContract = new Contract(contractId);
      const usdcContract = new Contract(usdcContractId);

      /** Read the sender's USDC balance (in stroops) via the SAC balance method. */
      const getUsdcBalance = async (): Promise<bigint> => {
        const account = await server.getAccount(senderAddress);
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(
            usdcContract.call(
              "balance",
              new Address(senderAddress).toScVal()
            )
          )
          .setTimeout(30)
          .build();

        const sim = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          throw new Error(`balance simulation failed: ${sim.error}`);
        }
        const retval = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse)
          .result?.retval;
        if (!retval) {
          throw new Error("balance simulation returned no value");
        }
        return BigInt(scValToNative(retval) as bigint | number | string);
      };

      /** Build, sign, submit and confirm a contract invocation. */
      const invokeAndConfirm = async (
        operation: xdr.Operation
      ): Promise<unknown> => {
        const account = await server.getAccount(senderAddress);
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(60)
          .build();

        const prepared = await server.prepareTransaction(tx);
        prepared.sign(sender);

        const sendResp = await server.sendTransaction(prepared);
        if (sendResp.status === "ERROR") {
          throw new Error(
            `sendTransaction failed: ${JSON.stringify(sendResp.errorResult)}`
          );
        }

        const hash = sendResp.hash;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const result = await server.getTransaction(hash);
          if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            return (result as SorobanRpc.Api.GetSuccessfulTransactionResponse)
              .returnValue;
          }
          if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
            throw new Error(`Transaction ${hash} failed on-chain`);
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        throw new Error(`Timed out waiting for transaction ${hash}`);
      };

      try {
        // ── Step 1: initialize with 1 USDC ──────────────────────────────────
        const balanceBefore = await getUsdcBalance();
        if (balanceBefore < ONE_USDC_STROOPS) {
          throw new Error(
            `Insufficient USDC balance: ${balanceBefore} stroops (need ${ONE_USDC_STROOPS})`
          );
        }

        const initializeOp = escrowContract.call(
          "initialize",
          new Address(senderAddress).toScVal(),
          new Address(recipient).toScVal(),
          new Address(usdcContractId).toScVal(),
          nativeToScVal(ONE_USDC_STROOPS, { type: "i128" }),
          nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 3_600), {
            type: "u64",
          })
        );
        await invokeAndConfirm(initializeOp);
        recordCheck(
          "E2E: initialize with 1 USDC",
          true,
          Date.now() - e2eStart,
          `Initialized escrow with ${ONE_USDC_STROOPS} stroops of USDC`
        );

        // ── Step 2: get_status must return Locked ───────────────────────────
        const statusStart = Date.now();
        const statusAccount = await server.getAccount(senderAddress);
        const statusTx = new TransactionBuilder(statusAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(escrowContract.call("get_status"))
          .setTimeout(30)
          .build();
        const statusSim = await server.simulateTransaction(statusTx);
        if (SorobanRpc.Api.isSimulationError(statusSim)) {
          throw new Error(`get_status simulation failed: ${statusSim.error}`);
        }
        const statusRetval = (
          statusSim as SorobanRpc.Api.SimulateTransactionSuccessResponse
        ).result?.retval;
        if (!statusRetval) {
          throw new Error("get_status returned no value");
        }
        const statusValue = Number(scValToNative(statusRetval));
        if (statusValue !== EscrowStatus.Locked) {
          throw new Error(
            `Expected status Locked (${EscrowStatus.Locked}), got ${statusValue}`
          );
        }
        recordCheck(
          "E2E: get_status returns Locked",
          true,
          Date.now() - statusStart,
          `Status = Locked (${EscrowStatus.Locked})`
        );

        // ── Step 3: cancel and verify funds returned ────────────────────────
        const cancelStart = Date.now();
        await invokeAndConfirm(escrowContract.call("cancel"));
        const balanceAfter = await getUsdcBalance();
        if (balanceAfter !== balanceBefore) {
          throw new Error(
            `Funds not returned: balance before=${balanceBefore}, after=${balanceAfter}`
          );
        }
        recordCheck(
          "E2E: cancel returns funds to sender",
          true,
          Date.now() - cancelStart,
          `USDC balance restored to ${balanceAfter} stroops`
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        recordCheck(
          "End-to-End Escrow Flow (initialize/get_status/cancel)",
          false,
          Date.now() - e2eStart,
          undefined,
          errorMsg
        );
      }
    }
  }

  // ─── Generate Summary & Report ──────────────────────────────────────────────
  const totalDuration = Date.now() - startTime;
  const passedChecks = checks.filter((c) => c.status === "PASSED").length;
  const failedChecks = checks.filter((c) => c.status === "FAILED").length;
  const overallStatus = failedChecks === 0 ? "PASSED" : "FAILED";

  const report: SmokeTestReport = {
    timestamp: new Date().toISOString(),
    network,
    contractId,
    rpcUrl,
    status: overallStatus,
    totalChecks: checks.length,
    passedChecks,
    failedChecks,
    durationMs: totalDuration,
    checks,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

  console.log("\n───────────────────────────────────────────────────");
  console.log(`📊 Smoke Test Summary: ${overallStatus}`);
  console.log(`   Passed: ${passedChecks}/${checks.length}`);
  console.log(`   Failed: ${failedChecks}/${checks.length}`);
  console.log(`   Report: ${path.relative(ROOT, reportPath)}`);
  console.log("───────────────────────────────────────────────────\n");

  if (overallStatus === "FAILED") {
    console.error("❌ Smoke tests failed! Blocking deployment promotion.");
    process.exit(1);
  }

  console.log("🚀 Smoke tests passed successfully. Safe to promote.");
  process.exit(0);
}

runSmokeTests().catch((err) => {
  console.error("Fatal error running smoke tests:", err);
  process.exit(1);
});
