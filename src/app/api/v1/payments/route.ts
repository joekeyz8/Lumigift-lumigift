import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { serverConfig } from "@/server/config";
import { updateGiftStatus } from "@/server/services/gift.service";
import { getRedisClient } from "@/lib/redis";

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

function verifySignature(rawBody: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha512", serverConfig.paystack.secretKey)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.padEnd(a.length, "\0").slice(0, a.length));
  return a.length === Buffer.from(signature).length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature") ?? "";

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: {
    event: string;
    data: { reference: string; status: string; metadata?: { giftId?: string } };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { reference } = event.data;
  const redis = await getRedisClient();
  const idempotencyKey = `paystack:ref:${reference}`;

  // ── Atomic SET NX (set-if-not-exists) ─────────────────────────────────────
  // NX guarantees that exactly one concurrent request wins the lock and
  // processes the event. Any other delivery of the same reference gets the
  // key already set and is acknowledged without side effects.
  //
  // The previous two-step GET → SET had a TOCTOU race: two simultaneous
  // deliveries could both see alreadyProcessed=false and both execute the
  // state transition. SET NX is atomic at the Redis command level.
  const acquired = await redis.set(idempotencyKey, "1", {
    NX: true,
    EX: IDEMPOTENCY_TTL_SECONDS,
  });

  if (!acquired) {
    // Already processed (or another delivery is currently processing it)
    return NextResponse.json({ received: true });
  }

  // At this point we own the idempotency slot — process the event exactly once.
  try {
    if (event.event === "charge.success") {
      const giftId = event.data.metadata?.giftId;
      if (giftId) {
        await updateGiftStatus(giftId, "locked");
      }
    }
  } catch (err) {
    // Processing failed — delete the idempotency key so the next delivery
    // (Paystack retries on non-2xx, but we returned 200 optimistically above;
    // this path handles unexpected runtime errors so operators can debug).
    console.error("[paystack-webhook] event processing failed", { reference, err });
    // Do NOT delete the key here — returning 200 tells Paystack we handled it.
    // Log the error for manual inspection instead.
  }

  return NextResponse.json({ received: true });
}
