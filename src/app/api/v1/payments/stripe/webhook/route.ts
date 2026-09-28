import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { updateGiftStatus } from "@/server/services/gift.service";
import { getRedisClient } from "@/lib/redis";
import type { ApiResponse } from "@/types";

// Lazily initialised so module evaluation at build time never throws.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
      apiVersion: "2026-04-22.dahlia",
    });
  }
  return _stripe;
}

// Next.js must not parse the body — Stripe needs the raw bytes for signature verification.
// In App Router, request body is not pre-parsed, so no config needed.

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

export async function POST(req: NextRequest) {
  // Guard moved inside handler so missing env var is a 500 at request time,
  // not a module-level crash that breaks the build.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Stripe webhook secret not configured" },
      { status: 500 }
    );
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Missing Stripe-Signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;
  try {
    const rawBody = await req.text();
    event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  // ── Atomic idempotency guard (SET NX) ──────────────────────────────────────
  // Stripe can deliver the same event more than once and can deliver concurrent
  // duplicates. SET NX guarantees exactly one delivery wins the lock and
  // processes the state transition; all others are acknowledged as no-ops.
  const redis = await getRedisClient();
  const idempotencyKey = `stripe:event:${event.id}`;
  const acquired = await redis.set(idempotencyKey, "1", {
    NX: true,
    EX: IDEMPOTENCY_TTL_SECONDS,
  });

  if (!acquired) {
    // Already processed or a concurrent delivery is handling it right now.
    return NextResponse.json<ApiResponse<{ received: boolean }>>({
      success: true,
      data: { received: true },
    });
  }

  // We own the idempotency slot — process the event exactly once.
  try {
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const giftId = intent.metadata?.giftId;
      if (giftId) {
        await updateGiftStatus(giftId, "locked");
      }
    }
  } catch (err) {
    console.error("[stripe-webhook] event processing failed", { eventId: event.id, err });
    // The idempotency key is kept so repeated retries from Stripe don't
    // cause duplicate side effects; the error is observable in logs.
  }

  return NextResponse.json<ApiResponse<{ received: boolean }>>({
    success: true,
    data: { received: true },
  });
}
