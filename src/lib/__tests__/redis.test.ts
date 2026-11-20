jest.mock("redis", () => ({
  createClient: jest.fn(),
  createSentinel: jest.fn(),
  createCluster: jest.fn(),
}));

jest.mock("@/server/config", () => ({
  serverConfig: { redis: { url: "redis://localhost" } },
}));

import { createClient, createSentinel } from "redis";
import { getRedisClient, getRedisMetrics, withRedis } from "../redis";

describe("Redis outage handling", () => {
  const originalSentinels = process.env.REDIS_SENTINELS;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDIS_SENTINELS;
  });

  afterAll(() => {
    if (originalSentinels === undefined) {
      delete process.env.REDIS_SENTINELS;
    } else {
      process.env.REDIS_SENTINELS = originalSentinels;
    }
  });

  it("records operation failures with a low-cardinality operation label", async () => {
    const redisClient = {
      isOpen: false,
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockResolvedValue(undefined),
      incr: jest.fn().mockRejectedValue(new Error("connection refused")),
    };
    (createClient as jest.Mock).mockReturnValue(redisClient);

    await expect(withRedis("otp_rate_limit", (client) => client.incr("key"))).rejects.toMatchObject(
      { name: "RedisUnavailableError", operation: "otp_rate_limit" }
    );

    const metrics = getRedisMetrics();
    expect(metrics.failuresByOperation.otp_rate_limit).toBeGreaterThanOrEqual(1);
    expect(metrics.lastFailureAt).not.toBeNull();
  });

  it("clears a failed initial connection so a later call can retry", async () => {
    const failedClient = {
      isOpen: false,
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockRejectedValue(new Error("connection refused")),
    };
    const connectedClient = {
      isOpen: true,
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockResolvedValue(undefined),
    };
    (createClient as jest.Mock)
      .mockReturnValueOnce(failedClient)
      .mockReturnValueOnce(connectedClient);

    await expect(getRedisClient()).rejects.toMatchObject({ name: "RedisUnavailableError" });
    await expect(getRedisClient()).resolves.toMatchObject({ isOpen: true });
  });

  it("uses the sentinel factory when REDIS_SENTINELS is configured", async () => {
    process.env.REDIS_SENTINELS = "sentinel-1:26379,sentinel-2:26379";
    const sentinelClient = {
      isOpen: true,
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockResolvedValue(undefined),
    };
    (createSentinel as jest.Mock).mockReturnValue(sentinelClient);

    await expect(getRedisClient()).resolves.toMatchObject({ isOpen: true });

    expect(createSentinel).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    const sentinelOptions = (createSentinel as jest.Mock).mock.calls[0][0];
    expect(sentinelOptions.sentinels).toEqual([
      { host: "sentinel-1", port: 26379 },
      { host: "sentinel-2", port: 26379 },
    ]);
  });

  it("falls back to createClient when REDIS_SENTINELS is not set", async () => {
    const directClient = {
      isOpen: true,
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockResolvedValue(undefined),
    };
    (createClient as jest.Mock).mockReturnValue(directClient);

    await expect(getRedisClient()).resolves.toMatchObject({ isOpen: true });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createSentinel).not.toHaveBeenCalled();
  });

  it("surfaces sentinel connection failures as RedisUnavailableError and records metrics", async () => {
    process.env.REDIS_SENTINELS = "sentinel-1:26379";
    const failedSentinelClient = {
      isOpen: false,
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockRejectedValue(new Error("sentinel unreachable")),
    };
    (createSentinel as jest.Mock).mockReturnValue(failedSentinelClient);

    await expect(getRedisClient()).rejects.toMatchObject({ name: "RedisUnavailableError" });

    const metrics = getRedisMetrics();
    expect(metrics.failuresByOperation.connect).toBeGreaterThanOrEqual(1);
    expect(metrics.lastFailureAt).not.toBeNull();
  });
});
