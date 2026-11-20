import { jwtRotationOptions } from "../jwt-rotation";
import { encode, decode } from "next-auth/jwt";
import { isRefreshTokenDenylisted, denylistRefreshToken } from "../redis";

jest.mock("next-auth/jwt", () => ({
  encode: jest.fn(),
  decode: jest.fn(),
}));

jest.mock("../redis", () => ({
  isRefreshTokenDenylisted: jest.fn(),
  denylistRefreshToken: jest.fn(),
}));

describe("JWT Secret Rotation (jwtRotationOptions)", () => {
  const originalEnv = process.env;
  const currentSecret = "current_super_secret_signing_key_32_chars_12345";
  const previousSecret = "previous_super_secret_signing_key_32_chars_123";

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NEXTAUTH_SECRET: currentSecret,
      NEXTAUTH_SECRET_PREVIOUS: previousSecret,
      NEXTAUTH_ROTATION_GRACE_HOURS: "24",
    };
    jest.clearAllMocks();
    (isRefreshTokenDenylisted as jest.Mock).mockResolvedValue(false);
    (denylistRefreshToken as jest.Mock).mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("encode", () => {
    it("delegates to next-auth/jwt encode using current active secret", async () => {
      const mockTokenString = "mock.jwt.token";
      (encode as jest.Mock).mockResolvedValue(mockTokenString);

      const params = {
        token: { sub: "user_123", email: "user@example.com" },
        secret: currentSecret,
      };

      const result = await jwtRotationOptions.encode(params as any);

      expect(encode).toHaveBeenCalledWith(params);
      expect(result).toBe(mockTokenString);
    });
  });

  describe("decode", () => {
    it("successfully decodes a token signed with the current secret", async () => {
      const mockPayload = { sub: "user_123", iat: Math.floor(Date.now() / 1000) };
      (decode as jest.Mock).mockImplementation(async ({ secret }) => {
        if (secret === currentSecret) {
          return mockPayload;
        }
        return null;
      });

      const result = await jwtRotationOptions.decode({
        token: "token_signed_with_current",
        secret: currentSecret,
      } as any);

      expect(result).toEqual(mockPayload);
      expect(decode).toHaveBeenCalledTimes(1);
    });

    it("falls back to previous secret when current secret fails within grace period", async () => {
      const recentIat = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000); // 2 hours ago
      const mockPayload = { sub: "user_old_session", iat: recentIat };

      (decode as jest.Mock).mockImplementation(async ({ secret }) => {
        if (secret === currentSecret) {
          throw new Error("Invalid signature");
        }
        if (secret === previousSecret) {
          return mockPayload;
        }
        return null;
      });

      const result = await jwtRotationOptions.decode({
        token: "token_signed_with_old_key",
        secret: currentSecret,
      } as any);

      expect(result).toEqual(mockPayload);
      expect(decode).toHaveBeenCalledTimes(2);
      expect(decode).toHaveBeenLastCalledWith(
        expect.objectContaining({ secret: previousSecret })
      );
    });

    it("rejects tokens signed with previous secret if older than grace period", async () => {
      const expiredIat = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000); // 48 hours ago (grace is 24h)
      const mockPayload = { sub: "user_expired_session", iat: expiredIat };

      (decode as jest.Mock).mockImplementation(async ({ secret }) => {
        if (secret === currentSecret) {
          return null;
        }
        if (secret === previousSecret) {
          return mockPayload;
        }
        return null;
      });

      const result = await jwtRotationOptions.decode({
        token: "token_older_than_grace_period",
        secret: currentSecret,
      } as any);

      expect(result).toBeNull();
    });

    it("returns null if neither current nor previous secret can decode the token", async () => {
      (decode as jest.Mock).mockImplementation(async () => {
        throw new Error("Signature verification failed");
      });

      const result = await jwtRotationOptions.decode({
        token: "completely_invalid_token",
        secret: currentSecret,
      } as any);

      expect(result).toBeNull();
    });

    it("returns null if current secret fails and NEXTAUTH_SECRET_PREVIOUS is unset", async () => {
      delete process.env.NEXTAUTH_SECRET_PREVIOUS;

      (decode as jest.Mock).mockResolvedValue(null);

      const result = await jwtRotationOptions.decode({
        token: "some_token",
        secret: currentSecret,
      } as any);

      expect(result).toBeNull();
      expect(decode).toHaveBeenCalledTimes(1);
    });
  });

  describe("refresh token rotation", () => {
    const oldJti = "old-refresh-jti-123";
    const newJti = "new-refresh-jti-456";
    const refreshTtlSeconds = 60 * 60 * 24 * 30; // 30 days

    it("rotates the refresh token and denylists the old jti on refresh", async () => {
      const now = Math.floor(Date.now() / 1000);
      const oldRefreshExp = now + refreshTtlSeconds;
      const mockPayload = {
        sub: "user_123",
        iat: now,
        refreshJti: oldJti,
        refreshExp: oldRefreshExp,
      };

      (decode as jest.Mock).mockResolvedValue(mockPayload);
      (encode as jest.Mock).mockResolvedValue("new.jwt.token");

      const result = await jwtRotationOptions.decode({
        token: "token_with_old_refresh",
        secret: currentSecret,
      } as any);

      expect(result).toEqual(mockPayload);
      expect(isRefreshTokenDenylisted).toHaveBeenCalledWith(oldJti);

      const rotated = await jwtRotationOptions.rotateRefreshToken({
        token: mockPayload,
        secret: currentSecret,
        newJti,
      } as any);

      expect(rotated).toBeTruthy();
      expect(denylistRefreshToken).toHaveBeenCalledTimes(1);

      const [denylistedJti, ttl] = (denylistRefreshToken as jest.Mock).mock.calls[0];
      expect(denylistedJti).toBe(oldJti);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(refreshTtlSeconds);
      expect(ttl).toBeCloseTo(oldRefreshExp - Math.floor(Date.now() / 1000), -1);
    });

    it("rejects reuse of an old refresh token with 401 semantics", async () => {
      const now = Math.floor(Date.now() / 1000);
      const mockPayload = {
        sub: "user_123",
        iat: now,
        refreshJti: oldJti,
        refreshExp: now + refreshTtlSeconds,
      };

      (decode as jest.Mock).mockResolvedValue(mockPayload);
      (encode as jest.Mock).mockResolvedValue("new.jwt.token");

      // First refresh rotates the token and denylists the old jti.
      await jwtRotationOptions.rotateRefreshToken({
        token: mockPayload,
        secret: currentSecret,
        newJti,
      } as any);

      expect(denylistRefreshToken).toHaveBeenCalledWith(oldJti, expect.any(Number));

      // Simulate reuse: the old jti is now on the denylist.
      (isRefreshTokenDenylisted as jest.Mock).mockResolvedValue(true);

      const result = await jwtRotationOptions.decode({
        token: "token_with_old_refresh",
        secret: currentSecret,
      } as any);

      expect(result).toBeNull();
      expect(isRefreshTokenDenylisted).toHaveBeenCalledWith(oldJti);
    });

    it("does not denylist when the refresh token has already expired", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredPayload = {
        sub: "user_123",
        iat: now - refreshTtlSeconds - 60,
        refreshJti: oldJti,
        refreshExp: now - 60,
      };

      (decode as jest.Mock).mockResolvedValue(expiredPayload);
      (encode as jest.Mock).mockResolvedValue("new.jwt.token");

      const rotated = await jwtRotationOptions.rotateRefreshToken({
        token: expiredPayload,
        secret: currentSecret,
        newJti,
      } as any);

      expect(rotated).toBeNull();
      expect(denylistRefreshToken).not.toHaveBeenCalled();
    });
  });
});
