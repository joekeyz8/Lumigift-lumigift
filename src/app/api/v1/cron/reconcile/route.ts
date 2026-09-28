/**
 * GET /api/v1/cron/reconcile
 *
 * Called by Vercel Cron (or an external scheduler) every 15 minutes to poll
 * Paystack for gifts whose webhooks were missed.
 *
 * Security: protected by CRON_SECRET bearer token (same pattern as other cron routes).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  reconcilePendingPayments,
  getDeadLetteredGiftIds,
} from "@/server/services/payment-reconciliation.service";
import { startTimer, recordCronSuccess, recordCronFailure } from "@/lib/metrics";
import type { ApiResponse } from "@/types";
import type { ReconcileResult } from "@/server/services/payment-reconciliation.service";

export const GET = async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const elapsed = startTimer();

  try {
    const result = await reconcilePendingPayments();
    const deadLettered = await getDeadLetteredGiftIds();
    const durationMs = elapsed();

    recordCronSuccess("cron/v1/reconcile", durationMs, {
      reconciled: result.reconciled,
      failed: result.failed,
      deadLetteredTotal: deadLettered.length,
    });

    return NextResponse.json<
      ApiResponse<ReconcileResult & { durationMs: number; deadLetteredTotal: number }>
    >({
      success: true,
      data: {
        ...result,
        durationMs,
        deadLetteredTotal: deadLettered.length,
      },
    });
  } catch (err) {
    const durationMs = elapsed();
    recordCronFailure("cron/v1/reconcile", durationMs, err);
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Reconcile cron job failed" },
      { status: 500 }
    );
  }
};
