/**
 * JWT key-rotation helpers for NextAuth.
 *
 * When NEXTAUTH_SECRET is rotated, set the old value in NEXTAUTH_SECRET_PREVIOUS.
 * Tokens signed with the previous secret are accepted for ROTATION_GRACE_HOURS
 * (default 24 h) so active sessions are not invalidated mid-rotation.
 *
 * Usage: pass `jwt: jwtRotationOptions` inside authOptions.
 */

import { encode, decode } from "next-auth/jwt";
import { randomUUID } from "crypto";
import { withRedis } from "@/lib/redis";

/** Grace period in hours during which old tokens remain valid. */
const ROTATION_GRACE_HOURS = parseInt(process.env.NEXTAUTH_ROTATION_GRACE_HOURS ?? "24", 10);

const GRACE_MS = ROTATION_GRACE_HOURS * 60 * 60 * 1000;

/** Prefix for denylisted refresh-token JTIs. */
const DENYLIST_PREFIX = "jwt:denylist:";

/** Default refresh-token lifetime in seconds (30 days). */
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Add a refresh-token JTI to the Redis denylist for its remaining lifetime.
 * Once the TTL elapses the key expires automatically, so the denylist stays
 * bounded.
 */
export async function rotateRefreshToken(
  oldJti: string,
  remainingTtlSeconds: number,
): Promise<void> {
  if (!oldJti) return;
  const ttl = Math.max(1, Math.floor(remainingTtlSeconds));
  await withRedis((redis) => redis.set(`${DENYLIST_PREFIX}${oldJti}`, "1", "EX", ttl));
}

/** Returns true if the given refresh-token JTI has been revoked. */
export async function isRefreshTokenDenylisted(jti: string): Promise<boolean> {
  if (!jti) return false;
  const value = await withRedis((redis) => redis.get(`${DENYLIST_PREFIX}${jti}`));
  return value !== null && value !== undefined;
}

/** Generate a fresh refresh-token JTI. */
export function generateRefreshJti(): string {
  return randomUUID();
}

/**
 * NextAuth `jwt` callback wrapper implementing refresh-token rotation.
 *
 * On every access-token refresh a new refresh-token JTI is issued and the old
 * one is denylisted for its remaining TTL. If the incoming refresh token has
 * already been denylisted (i.e. it was reused), the callback returns null so
 * NextAuth responds with 401.
 */
export async function jwtCallback(params: {
  token: Record<string, unknown> | null;
  user?: unknown;
  account?: unknown;
  trigger?: "signIn" | "signUp" | "update";
  [key: string]: unknown;
}): Promise<Record<string, unknown> | null> {
  const { token, trigger } = params;

  // Initial sign-in: mint a refresh-token JTI.
  if (!token) return token;

  const incomingJti = typeof token.refreshJti === "string" ? token.refreshJti : undefined;

  // Reject reused (denylisted) refresh tokens.
  if (incomingJti && (await isRefreshTokenDenylisted(incomingJti))) {
    return null;
  }

  // Only rotate on access-token refresh, not on sign-in/update.
  const isRefresh = trigger !== "signIn" && trigger !== "signUp" && trigger !== "update";
  if (!isRefresh) {
    if (!incomingJti) {
      return { ...token, refreshJti: generateRefreshJti() };
    }
    return token;
  }

  // Compute remaining TTL of the old refresh token.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = typeof token.refreshExp === "number" ? token.refreshExp : undefined;
  const remainingTtl = exp ? exp - nowSeconds : DEFAULT_REFRESH_TTL_SECONDS;

  // Denylist the old JTI (if any) for its remaining lifetime.
  if (incomingJti) {
    await rotateRefreshToken(incomingJti, remainingTtl);
  }

  // Issue a new refresh token JTI with a fresh expiry.
  const newJti = generateRefreshJti();
  const newExp = nowSeconds + DEFAULT_REFRESH_TTL_SECONDS;

  return {
    ...token,
    refreshJti: newJti,
    refreshExp: newExp,
  };
}

export const jwtRotationOptions = {
  /**
   * Encode always uses the current NEXTAUTH_SECRET so new tokens are signed
   * with the new key immediately.
   */
  async encode(params: Parameters<typeof encode>[0]) {
    return encode(params); // uses params.secret (= NEXTAUTH_SECRET)
  },

  /**
   * Decode tries the current secret first; if that fails and a previous secret
   * is configured, it falls back to the previous secret — but only within the
   * grace window measured from the token's `iat`.
   */
  async decode(params: Parameters<typeof decode>[0]) {
    // 1. Try current secret
    try {
      const token = await decode(params);
      if (token) return token;
    } catch {
      // fall through to previous-secret attempt
    }

    // 2. Try previous secret within grace period
    const previousSecret = process.env.NEXTAUTH_SECRET_PREVIOUS;
    if (!previousSecret) return null;

    try {
      const token = await decode({ ...params, secret: previousSecret });
      if (!token) return null;

      // Enforce grace window: reject tokens older than GRACE_MS
      const iat = typeof token.iat === "number" ? token.iat * 1000 : 0;
      if (Date.now() - iat > GRACE_MS) return null;

      return token;
    } catch {
      return null;
    }
  },
};
