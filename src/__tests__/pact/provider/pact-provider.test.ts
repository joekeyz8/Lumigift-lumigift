/**
 * Pact provider verification — LumigiftAPI
 *
 * Issue #291: Add API contract tests with Pact.io
 * Issue #583: Extend contract testing to all API routes
 *
 * Run after consumer tests have generated pact files in /pacts.
 * Verifies that the real API satisfies all consumer contracts.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 npx jest src/__tests__/pact/provider
 *
 * Publishing verification results to the Pact broker:
 *   PACT_BROKER_BASE_URL=https://your-broker.example.com \
 *   PACT_BROKER_TOKEN=xxxx \
 *   GITHUB_SHA=$(git rev-parse HEAD) \
 *   npx jest src/__tests__/pact/provider
 */

import fs from "fs";
import path from "path";
import { Verifier } from "@pact-foundation/pact";

const PACT_DIR = path.resolve(process.cwd(), "pacts");

/**
 * Collect every pact file in the pacts directory so that all consumer
 * contracts (gifts, auth, payments, notifications, wishlists, occasions,
 * referrals, support cases, ...) are verified — not just a single pact.
 */
function collectPactFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectPactFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    })
    .sort();
}

describe("Pact provider verification (LumigiftAPI)", () => {
  const pactFiles = collectPactFiles(PACT_DIR);

  it("has at least one consumer contract to verify", () => {
    expect(pactFiles.length).toBeGreaterThan(0);
  });

  it("satisfies all consumer contracts", async () => {
    const brokerBaseUrl = process.env.PACT_BROKER_BASE_URL;
    const brokerToken = process.env.PACT_BROKER_TOKEN;
    const providerVersion = process.env.GITHUB_SHA || "local";

    const opts: Record<string, unknown> = {
      provider: "LumigiftAPI",
      providerBaseUrl: process.env.BASE_URL || "http://localhost:3000",
      pactUrls: pactFiles,
      publishVerificationResult:
        process.env.CI === "true" && Boolean(brokerBaseUrl),
      providerVersion,
      logLevel: "warn" as const,
    };

    if (brokerBaseUrl) {
      opts.pactBrokerUrl = brokerBaseUrl;
      if (brokerToken) {
        opts.pactBrokerToken = brokerToken;
      }
    }

    // Throws if any consumer contract is broken, failing CI.
    await new Verifier(opts).verifyProvider();
  }, 60_000);
});