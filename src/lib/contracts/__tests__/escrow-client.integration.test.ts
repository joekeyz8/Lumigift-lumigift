/**
 * @jest-environment node
 *
 * Contract Client Integration Tests — Issue #121
 *
 * Exercises initialize, read (getState / getStatus), claim, cancel, and
 * event indexing via EscrowClient and fetchEscrowEvents against mocked
 * Soroban RPC responses (testnet fixture shapes).
 *
 * All test fixtures are isolated — no shared mutable state between cases.
 * Network failures are surfaced with diagnosable error messages.
 *
 * Design:
 *   - Mock @stellar/stellar-sdk at the module boundary so tests run without
 *     a live Soroban node. Fixture responses mirror real testnet payloads.
 *   - Error paths verify that EscrowContractError carries the correct code.
 *   - Event-indexing tests verify that fetchEscrowEvents correctly decodes
 *     all three event types (initialized, claimed, cancelled).
 */

import {
  EscrowClient,
  EscrowClientOptions,
  EscrowStatus,
  EscrowError,
  EscrowContractError,
} from "@/lib/contracts/escrow-client";
import {
  fetchEscrowEvents,
  CURSOR_GENESIS,
  type FetchEventsResult,
} from "@/lib/contracts/escrow-events";
import {
  runTtlKeeper,
  TTL_KEEPER_LOOKAHEAD_SECONDS,
  TTL_ALERT_BUFFER_SECONDS,
  type TtlKeeperGift,
  type TtlKeeperLogger,
  type TtlKeeperMetrics,
} from "@/lib/contracts/ttl-keeper";

// ─── Stellar SDK mock ─────────────────────────────────────────────────────────
// We mock the stellar-sdk at the module level so EscrowClient never dials the
// network. Each test controls the mock return values via the helpers below.

const mockSimulateTransaction = jest.fn();
const mockGetAccount = jest.fn();
const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();
const mockGetEvents = jest.fn();
const mockGetLedgerEntries = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");

  class MockServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulateTransaction;
    sendTransaction = mockSendTransaction;
    getTransaction = mockGetTransaction;
    getEvents = mockGetEvents;
    getLedgerEntries = mockGetLedgerEntries;
  }

  class MockContract {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    call(_method: string, ..._args: unknown[]) {
      return { type: "mock-operation" };
    }
  }

  class MockTransactionBuilder {
    private ops: unknown[] = [];

    addOperation(op: unknown) {
      this.ops.push(op);
      return this;
    }

    setTimeout() {
      return this;
    }

    build() {
      return {
        toXDR: () => "AAAAAQAAAA==",
        toEnvelope: () => ({ toXDR: () => Buffer.from("mock-xdr") }),
      };
    }
  }

  const mockAssembleTransaction = jest.fn((_tx: unknown, _sim: unknown) => ({
    build: () => ({ toXDR: () => "ASSEMBLED_XDR==" }),
  }));

  return {
    ...actual,
    Contract: MockContract,
    TransactionBuilder: Object.assign(MockTransactionBuilder, {
      fromXDR: jest.fn(() => ({ toXDR: () => "SIGNED_XDR==" })),
    }),
    rpc: {
      ...actual.rpc,
      Server: MockServer,
      assembleTransaction: mockAssembleTransaction,
      Api: {
        ...actual.rpc?.Api,
        isSimulationError: jest.fn(
          (sim: unknown) => (sim as { error?: string }).error !== undefined
        ),
        GetTransactionStatus: {
          NOT_FOUND: "NOT_FOUND",
          FAILED: "FAILED",
          SUCCESS: "SUCCESS",
        },
      },
    },
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const TESTNET_OPTIONS: EscrowClientOptions = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  sourcePublicKey: "GCPS5PCGMBLWHIM7EOJ6VMUNBAZUUCZEGNZ6C7MFRM6VGBR6HLCTRIWO",
};

const MOCK_SENDER = "GCPS5PCGMBLWHIM7EOJ6VMUNBAZUUCZEGNZ6C7MFRM6VGBR6HLCTRIWO";
const MOCK_RECIPIENT = "GCWTNXKAXWFTMGXQ4DVYDENGDPAMZIHGDBQS7HHTJCV2CJLJFI72CCJU";
const MOCK_TOKEN = "GBBKB5NGRG5YZBPPZ4ST7DENVAN7OC3YNKPIUQJRQDFMJHOJ2HIWLK7H";
const MOCK_AMOUNT = BigInt(10_000_000); // 1 USDC in stroops
const MOCK_UNLOCK_TIME = BigInt(Math.floor(Date.now() / 1000) + 86400);

// A minimal scVal-like object whose vec() returns a 4-element state tuple.
// Mirrors the shape returned by the Soroban RPC for get_state.
function makeStateScVal() {
  const { Address, nativeToScVal } = jest.requireActual("@stellar/stellar-sdk");
  return {
    vec: () => [
      Address.fromString(MOCK_RECIPIENT).toScVal(),
      nativeToScVal(MOCK_AMOUNT, { type: "i128" }),
      nativeToScVal(MOCK_UNLOCK_TIME, { type: "u64" }),
      nativeToScVal(false, { type: "bool" }),
    ],
  };
}

// A scVal for get_status returning EscrowStatus.Locked (u32 = 0).
function makeStatusScVal(status: 0 | 1 | 2 | 3) {
  const { nativeToScVal } = jest.requireActual("@stellar/stellar-sdk");
  return nativeToScVal(status, { type: "u32" });
}

// A successful simulation response fixture.
function makeSimSuccess(retval: unknown) {
  return {
    result: { retval },
    transactionData: {},
    minResourceFee: "100",
  };
}

// A simulation error fixture — mirrors Soroban error strings.
function makeSimError(contractErrorCode: number) {
  return {
    error: `Error(Contract, #${contractErrorCode})`,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

function makeClient(): EscrowClient {
  return new EscrowClient(TESTNET_OPTIONS);
}

function stubAccount() {
  mockGetAccount.mockResolvedValue({
    accountId: () => TESTNET_OPTIONS.sourcePublicKey,
    sequenceNumber: () => "100",
    incrementSequenceNumber: jest.fn(),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EscrowClient — Issue #121", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubAccount();
  });

  // ── buildInitialize ────────────────────────────────────────────────────────

  describe("buildInitialize", () => {
    it("returns a signed XDR string on success", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimSuccess(null));
      const client = makeClient();

      const xdr = await client.buildInitialize(
        MOCK_SENDER,
        MOCK_RECIPIENT,
        MOCK_TOKEN,
        MOCK_AMOUNT,
        MOCK_UNLOCK_TIME
      );

      expect(typeof xdr).toBe("string");
      expect(xdr.length).toBeGreaterThan(0);
    });

    it("throws EscrowContractError(AlreadyInitialized) when contract returns #1", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.AlreadyInitialized));
      const client = makeClient();

      await expect(
        client.buildInitialize(
          MOCK_SENDER,
          MOCK_RECIPIENT,
          MOCK_TOKEN,
          MOCK_AMOUNT,
          MOCK_UNLOCK_TIME
        )
      ).rejects.toThrow(EscrowContractError);

      try {
        await client.buildInitialize(
          MOCK_SENDER,
          MOCK_RECIPIENT,
          MOCK_TOKEN,
          MOCK_AMOUNT,
          MOCK_UNLOCK_TIME
        );
      } catch (err) {
        expect(err).toBeInstanceOf(EscrowContractError);
        expect((err as EscrowContractError).code).toBe(EscrowError.AlreadyInitialized);
      }
    });

    it("throws EscrowContractError(InvalidToken) when token is not USDC", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.InvalidToken));
      const client = makeClient();
      // Use a valid G-address for the wrong token (contract validates token on-chain, not here)
      const WRONG_TOKEN = "GBBKB5NGRG5YZBPPZ4ST7DENVAN7OC3YNKPIUQJRQDFMJHOJ2HIWLK7H";

      await expect(
        client.buildInitialize(
          MOCK_SENDER,
          MOCK_RECIPIENT,
          WRONG_TOKEN,
          MOCK_AMOUNT,
          MOCK_UNLOCK_TIME
        )
      ).rejects.toMatchObject({ code: EscrowError.InvalidToken });
    });

    it("throws EscrowContractError(InvalidAmount) for zero amount", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.InvalidAmount));
      const client = makeClient();

      await expect(
        client.buildInitialize(MOCK_SENDER, MOCK_RECIPIENT, MOCK_TOKEN, 0n, MOCK_UNLOCK_TIME)
      ).rejects.toMatchObject({ code: EscrowError.InvalidAmount });
    });

    it("is diagnosable when the RPC network request fails", async () => {
      mockGetAccount.mockRejectedValue(new Error("ECONNREFUSED: soroban-testnet.stellar.org:443"));
      const client = makeClient();

      await expect(
        client.buildInitialize(
          MOCK_SENDER,
          MOCK_RECIPIENT,
          MOCK_TOKEN,
          MOCK_AMOUNT,
          MOCK_UNLOCK_TIME
        )
      ).rejects.toThrow("ECONNREFUSED");
    });
  });

  // ── getState ──────────────────────────────────────────────────────────────

  describe("getState", () => {
    it("decodes the escrow state from a successful simulation", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimSuccess(makeStateScVal()));
      const client = makeClient();

      const state = await client.getState();

      expect(state.recipient).toBe(MOCK_RECIPIENT);
      expect(state.amount).toBe(MOCK_AMOUNT);
      expect(state.unlockTime).toBe(MOCK_UNLOCK_TIME);
      expect(state.claimed).toBe(false);
    });

    it("throws EscrowContractError(NotInitialized) when escrow not yet set up", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.NotInitialized));
      const client = makeClient();

      await expect(client.getState()).rejects.toMatchObject({
        code: EscrowError.NotInitialized,
      });
    });

    it("throws when simulation returns no value", async () => {
      mockSimulateTransaction.mockResolvedValue({ result: undefined });
      const client = makeClient();

      await expect(client.getState()).rejects.toThrow("get_state simulation returned no value");
    });
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it.each([
      [0, EscrowStatus.Locked, "Locked"],
      [1, EscrowStatus.Unlocked, "Unlocked"],
      [2, EscrowStatus.Claimed, "Claimed"],
      [3, EscrowStatus.Cancelled, "Cancelled"],
    ] as const)("decodes status %i as EscrowStatus.%s", async (raw, expected) => {
      mockSimulateTransaction.mockResolvedValue(makeSimSuccess(makeStatusScVal(raw)));
      const state = await makeClient().getStatus();
      expect(state).toBe(expected);
    });

    it("throws EscrowContractError(StillLocked) when contract blocks claim", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.StillLocked));
      await expect(makeClient().getStatus()).rejects.toMatchObject({
        code: EscrowError.StillLocked,
      });
    });
  });

  // ── buildClaim ────────────────────────────────────────────────────────────

  describe("buildClaim", () => {
    it("returns XDR string on success", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimSuccess(null));
      const xdr = await makeClient().buildClaim();
      expect(typeof xdr).toBe("string");
    });

    it("throws EscrowContractError(AlreadyClaimed) on double-claim attempt", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.AlreadyClaimed));
      await expect(makeClient().buildClaim()).rejects.toMatchObject({
        code: EscrowError.AlreadyClaimed,
      });
    });

    it("throws EscrowContractError(StillLocked) before unlock time", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError(EscrowError.StillLocked));
      await expect(makeClient().buildClaim()).rejects.toMatchObject({
        code: EscrowError.StillLocked,
      });
    });
  });

  // ── submitTransaction ─────────────────────────────────────────────────────

  describe("submitTransaction", () => {
    const MOCK_HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    it("returns tx hash on successful submission", async () => {
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: MOCK_HASH });
      mockGetTransaction.mockResolvedValue({ status: "SUCCESS" });

      const hash = await makeClient().submitTransaction("SIGNED_XDR==");
      expect(hash).toBe(MOCK_HASH);
    });

    it("throws when submission returns ERROR status", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR", errorResult: "txBAD_SEQ" });
      await expect(makeClient().submitTransaction("BAD_XDR==")).rejects.toThrow(
        "Transaction submission failed"
      );
    });

    it("throws when transaction finalization fails", async () => {
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: MOCK_HASH });
      mockGetTransaction.mockResolvedValue({ status: "FAILED" });

      await expect(makeClient().submitTransaction("SIGNED_XDR==")).rejects.toThrow(
        `Transaction failed: ${MOCK_HASH}`
      );
    });

    it("is diagnosable: surfaces RPC network errors with original message", async () => {
      mockSendTransaction.mockRejectedValue(new Error("Network timeout after 30s"));

      await expect(makeClient().submitTransaction("SIGNED_XDR==")).rejects.toThrow(
        "Network timeout after 30s"
      );
    });
  });
});

// ─── fetchEscrowEvents ────────────────────────────────────────────────────────

describe("fetchEscrowEvents — Issue #121", () => {
  const CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const RPC_URL = "https://soroban-testnet.stellar.org";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Build a raw event fixture that mirrors the Soroban RPC response shape. */
  function makeRawEvent(
    eventType: "initialized" | "claimed" | "cancelled",
    id: string,
    ledger: number
  ) {
    const { Address, nativeToScVal, xdr: xdrSdk } = jest.requireActual("@stellar/stellar-sdk");

    // Topic: [Symbol(eventType)]
    const topic = [xdrSdk.ScVal.scvSymbol(eventType)];

    let dataVec: unknown[];
    if (eventType === "initialized") {
      dataVec = [
        new Address(MOCK_SENDER).toScVal(),
        new Address(MOCK_RECIPIENT).toScVal(),
        nativeToScVal(MOCK_AMOUNT, { type: "i128" }),
        nativeToScVal(MOCK_UNLOCK_TIME, { type: "u64" }),
      ];
    } else if (eventType === "claimed") {
      dataVec = [
        new Address(MOCK_RECIPIENT).toScVal(),
        nativeToScVal(MOCK_AMOUNT, { type: "i128" }),
      ];
    } else {
      dataVec = [new Address(MOCK_SENDER).toScVal(), nativeToScVal(MOCK_AMOUNT, { type: "i128" })];
    }

    const value = xdrSdk.ScVal.scvVec(dataVec as InstanceType<typeof xdrSdk.ScVal>[]);

    return {
      id,
      ledger,
      ledgerClosedAt: new Date().toISOString(),
      txHash: `txhash-${id}`,
      contractId: { toString: () => CONTRACT_ID },
      topic,
      value,
    };
  }

  it("decodes an initialized event correctly", async () => {
    const raw = makeRawEvent("initialized", "0000000001-0000000001", 100);
    mockGetEvents.mockResolvedValue({ events: [raw], cursor: "0000000001-0000000001" });

    const result: FetchEventsResult = await fetchEscrowEvents({
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
      startCursor: CURSOR_GENESIS,
    });

    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.type).toBe("initialized");
    if (ev.type === "initialized") {
      expect(ev.sender).toBe(MOCK_SENDER);
      expect(ev.recipient).toBe(MOCK_RECIPIENT);
      expect(ev.amount).toBe(MOCK_AMOUNT);
    }
    expect(result.latestCursor).toBe("0000000001-0000000001");
  });

  it("decodes a claimed event correctly", async () => {
    const raw = makeRawEvent("claimed", "0000000002-0000000001", 200);
    mockGetEvents.mockResolvedValue({ events: [raw], cursor: "0000000002-0000000001" });

    const result = await fetchEscrowEvents({
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
      startCursor: "0000000001-0000000001",
    });

    expect(result.events[0].type).toBe("claimed");
    if (result.events[0].type === "claimed") {
      expect(result.events[0].recipient).toBe(MOCK_RECIPIENT);
      expect(result.events[0].amount).toBe(MOCK_AMOUNT);
    }
  });

  it("decodes a cancelled event correctly", async () => {
    const raw = makeRawEvent("cancelled", "0000000003-0000000001", 300);
    mockGetEvents.mockResolvedValue({ events: [raw], cursor: "0000000003-0000000001" });

    const result = await fetchEscrowEvents({
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
      startCursor: "0000000002-0000000001",
    });

    expect(result.events[0].type).toBe("cancelled");
    if (result.events[0].type === "cancelled") {
      expect(result.events[0].sender).toBe(MOCK_SENDER);
    }
  });

  it("returns empty events array and preserves cursor when no events found", async () => {
    mockGetEvents.mockResolvedValue({ events: [], cursor: undefined });

    const startCursor = "0000000003-0000000001";
    const result = await fetchEscrowEvents({
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
      startCursor,
    });

    expect(result.events).toHaveLength(0);
    expect(result.latestCursor).toBe(startCursor);
  });

  it("skips unknown event types without throwing", async () => {
    const { xdr: xdrSdk } = jest.requireActual("@stellar/stellar-sdk");
    const unknownRaw = {
      id: "0000000004-0000000001",
      ledger: 400,
      ledgerClosedAt: new Date().toISOString(),
      txHash: "txhash-unknown",
      contractId: { toString: () => CONTRACT_ID },
      topic: [xdrSdk.ScVal.scvSymbol("upgraded")],
      value: xdrSdk.ScVal.scvVec([]),
    };

    mockGetEvents.mockResolvedValue({ events: [unknownRaw], cursor: undefined });

    const result = await fetchEscrowEvents({
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
      startCursor: CURSOR_GENESIS,
    });

    // "upgraded" is not in our known types — should be filtered out
    expect(result.events).toHaveLength(0);
  });

  it("is diagnosable: surfaces RPC network failures with the original error message", async () => {
    mockGetEvents.mockRejectedValue(new Error("RPC node unreachable: connection refused"));

    await expect(
      fetchEscrowEvents({
        rpcUrl: RPC_URL,
        contractId: CONTRACT_ID,
        startCursor: CURSOR_GENESIS,
      })
    ).rejects.toThrow("RPC node unreachable");
  });

  it("handles multiple events in a single page and advances cursor", async () => {
    const raws = [
      makeRawEvent("initialized", "0000000010-0000000001", 1000),
      makeRawEvent("claimed", "0000000010-0000000002", 1000),
    ];
    mockGetEvents.mockResolvedValue({ events: raws, cursor: "0000000010-0000000002" });

    const result = await fetchEscrowEvents({
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
      startCursor: CURSOR_GENESIS,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("initialized");
    expect(result.events[1].type).toBe("claimed");
    expect(result.latestCursor).toBe("0000000010-0000000002");
  });
});

// ─── TTL keeper — Issue #531 ──────────────────────────────────────────────────

const DAY_SECONDS = 86_400;

describe("EscrowClient.extendTtl — Issue #531", () => {
  const MOCK_HASH = "deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef";

  beforeEach(() => {
    jest.clearAllMocks();
    stubAccount();
  });

  /**
   * Build a getLedgerEntries fixture for a contract instance whose remaining
   * TTL (in ledgers) is `remainingLedgers`. Soroban encodes the liveUntilLedger
   * as a u32 inside the entry's `liveUntilLedgerSeq` field.
   */
  function makeInstanceEntry(remainingLedgers: number) {
    const currentLedger = 1_000_000;
    return {
      entries: [
        {
          key: { type: "contractData" },
          val: { type: "contractInstance" },
          liveUntilLedgerSeq: currentLedger + remainingLedgers,
        },
      ],
      latestLedger: currentLedger,
    };
  }

  it("builds an extend_ttl transaction with the expected threshold and new TTL", async () => {
    // Instance TTL is below the 7-day buffer → keeper must extend it.
    mockGetLedgerEntries.mockResolvedValue(makeInstanceEntry(DAY_SECONDS / 5));
    mockSimulateTransaction.mockResolvedValue(makeSimSuccess(null));

    const client = makeClient();
    const threshold = 7 * DAY_SECONDS;
    const newTtl = 30 * DAY_SECONDS;

    const xdr = await client.extendTtl(threshold, newTtl);

    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);

    // The contract call must be extend_ttl with (threshold, newTtl) args.
    const contractCall = (client as unknown as { contract: { call: jest.Mock } }).contract;
    expect(contractCall.call).toHaveBeenCalledWith("extend_ttl", threshold, newTtl);
  });

  it("extends the mocked TTL above the threshold after submission", async () => {
    const threshold = 7 * DAY_SECONDS;
    const newTtl = 30 * DAY_SECONDS;

    // Start with a TTL that has already dropped below the 7-day buffer.
    let remaining = DAY_SECONDS / 5;
    mockGetLedgerEntries.mockImplementation(async () => makeInstanceEntry(remaining));
    mockSimulateTransaction.mockResolvedValue(makeSimSuccess(null));
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: MOCK_HASH });
    mockGetTransaction.mockImplementation(async () => {
      // Simulate the on-chain effect of extend_ttl: TTL jumps to newTtl.
      remaining = newTtl;
      return { status: "SUCCESS" };
    });

    const client = makeClient();
    const before = await client.getRemainingTtl();
    expect(before).toBeLessThan(threshold);

    const xdr = await client.extendTtl(threshold, newTtl);
    await client.submitTransaction(xdr);

    const after = await client.getRemainingTtl();
    expect(after).toBeGreaterThanOrEqual(threshold);
    expect(after).toBe(newTtl);
  });

  it("is diagnosable: surfaces RPC failures during TTL lookup", async () => {
    mockGetLedgerEntries.mockRejectedValue(new Error("getLedgerEntries: node unavailable"));

    await expect(makeClient().extendTtl(7 * DAY_SECONDS, 30 * DAY_SECONDS)).rejects.toThrow(
      "getLedgerEntries"
    );
  });
});

describe("runTtlKeeper — Issue #531", () => {
  const NOW = 1_700_000_000; // fixed clock (seconds)

  function makeLogger(): TtlKeeperLogger & {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  } {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  }

  function makeMetrics(): TtlKeeperMetrics & {
    increment: jest.Mock;
    gauge: jest.Mock;
  } {
    return { increment: jest.fn(), gauge: jest.fn() };
  }

  function makeGift(overrides: Partial<TtlKeeperGift> = {}): TtlKeeperGift {
    return {
      contractId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      unlockTime: NOW + 60 * DAY_SECONDS, // well beyond the 20-day lookahead
      remainingTtlSeconds: 30 * DAY_SECONDS,
      ...overrides,
    };
  }

  it("selects only gifts with unlock_time > NOW() + 20 days", async () => {
    const soon = makeGift({
      contractId: "CSOON00000000000000000000000000000000000000000000000000000000",
      unlockTime: NOW + 10 * DAY_SECONDS, // inside the 20-day window → skipped
    });
    const longLived = makeGift({
      contractId: "CLONG00000000000000000000000000000000000000000000000000000000",
      unlockTime: NOW + 60 * DAY_SECONDS,
    });

    const extendTtl = jest.fn().mockResolvedValue("XDR==");
    const submitTransaction = jest.fn().mockResolvedValue("hash");
    const logger = makeLogger();
    const metrics = makeMetrics();

    const result = await runTtlKeeper({
      now: () => NOW,
      listGifts: async () => [soon, longLived],
      extendTtl,
      submitTransaction,
      logger,
      metrics,
    });

    expect(TTL_KEEPER_LOOKAHEAD_SECONDS).toBe(20 * DAY_SECONDS);
    expect(extendTtl).toHaveBeenCalledTimes(1);
    expect(extendTtl).toHaveBeenCalledWith(
      longLived.contractId,
      expect.any(Number),
      expect.any(Number)
    );
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    expect(result.extended).toEqual([longLived.contractId]);
    expect(result.skipped).toEqual([soon.contractId]);
  });

  it("logs a success line for each extended contract", async () => {
    const gift = makeGift();
    const extendTtl = jest.fn().mockResolvedValue("XDR==");
    const submitTransaction = jest.fn().mockResolvedValue("hash");
    const logger = makeLogger();

    await runTtlKeeper({
      now: () => NOW,
      listGifts: async () => [gift],
      extendTtl,
      submitTransaction,
      logger,
      metrics: makeMetrics(),
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(gift.contractId),
      expect.objectContaining({ contractId: gift.contractId })
    );
  });

  it("logs a failure line and continues when extendTtl throws", async () => {
    const bad = makeGift({
      contractId: "CBAD000000000000000000000000000000000000000000000000000000000",
    });
    const good = makeGift({
      contractId: "CGOOD00000000000000000000000000000000000000000000000000000000",
    });

    const extendTtl = jest
      .fn()
      .mockRejectedValueOnce(new Error("simulation failed"))
      .mockResolvedValueOnce("XDR==");
    const submitTransaction = jest.fn().mockResolvedValue("hash");
    const logger = makeLogger();

    const result = await runTtlKeeper({
      now: () => NOW,
      listGifts: async () => [bad, good],
      extendTtl,
      submitTransaction,
      logger,
      metrics: makeMetrics(),
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(bad.contractId),
      expect.objectContaining({ contractId: bad.contractId })
    );
    expect(result.failed).toEqual([bad.contractId]);
    expect(result.extended).toEqual([good.contractId]);
  });

  it("emits a ttl.alert metric when remaining TTL is below the 7-day buffer", async () => {
    const atRisk = makeGift({
      contractId: "CRISK00000000000000000000000000000000000000000000000000000000",
      remainingTtlSeconds: 3 * DAY_SECONDS, // below 7-day buffer
    });
    const healthy = makeGift({
      contractId: "CHEALTHY0000000000000000000000000000000000000000000000000000",
      remainingTtlSeconds: 30 * DAY_SECONDS,
    });

    const metrics = makeMetrics();
    const logger = makeLogger();

    await runTtlKeeper({
      now: () => NOW,
      listGifts: async () => [atRisk, healthy],
      extendTtl: jest.fn().mockResolvedValue("XDR=="),
      submitTransaction: jest.fn().mockResolvedValue("hash"),
      logger,
      metrics,
    });

    expect(TTL_ALERT_BUFFER_SECONDS).toBe(7 * DAY_SECONDS);
    expect(metrics.increment).toHaveBeenCalledWith(
      "ttl.alert",
      expect.objectContaining({ contractId: atRisk.contractId })
    );
    expect(metrics.increment).not.toHaveBeenCalledWith(
      "ttl.alert",
      expect.objectContaining({ contractId: healthy.contractId })
    );
  });

  it("tracks XLM keeper cost per call and against the budget", async () => {
    const gift = makeGift();
    const metrics = makeMetrics();

    const result = await runTtlKeeper({
      now: () => NOW,
      listGifts: async () => [gift],
      extendTtl: jest.fn().mockResolvedValue("XDR=="),
      submitTransaction: jest.fn().mockResolvedValue("hash"),
      logger: makeLogger(),
      metrics,
      feePerCallXlm: 0.01,
      dailyBudgetXlm: 1,
    });

    expect(result.totalCostXlm).toBeCloseTo(0.01);
    expect(metrics.gauge).toHaveBeenCalledWith("ttl.keeper.cost_xlm", 0.01);
    expect(result.budgetExceeded).toBe(false);
  });
});
