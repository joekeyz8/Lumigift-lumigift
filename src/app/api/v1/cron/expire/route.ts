import { NextRequest, NextResponse } from "next/server";
import { processExpiries } from "@/server/services/scheduler.service";
import {
  recordCronSuccess,
  recordCronFailure,
  recordDeadLetter,
} from "@/lib/metrics";
import type { ApiResponse } from "@/types";
import { isAuthorizedCronRequest } from "@/server/cron-auth";
import { pingHealthcheck } from "@/server/cron-healthcheck";

/**
 * GET /api/v1/cron/expire
 *
 * Called daily at 02:00 UTC by Vercel Cron (see vercel.json).
 * Expires unlocked gifts that have been unclaimed for more than 365 days,
 * triggers a refund to the sender, and sends an SMS notification.
 *
 * Dead-man's-switch: pings HEALTHCHECK_URL_EXPIRE (or HEALTHCHECK_URL) on
 * success so operators are alerted if the daily cron stops firing.
 */

export const GET = async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  if (!isAuthorizedCronRequest(authHeader)) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const startedAt = new Date();
  console.log("[cron/expire] run started", { startedAt });

  try {
    await processExpiries();
    const durationMs = Date.now() - startedAt.getTime();

    console.log("[cron/expire] run complete", { durationMs });

    await pingHealthcheck("expire"); // success ping

    return NextResponse.json<ApiResponse<{ message: string; durationMs: number }>>({
      success: true,
      data: { message: "Expiry check complete", durationMs },
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    console.error("[cron/expire] run failed", { startedAt, error: err });
    recordCronFailure("cron/v1/expire", durationMs, err);
    await recordDeadLetter("cron/v1/expire", durationMs, err);
    await pingHealthcheck("expire", "/fail"); // failure ping
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Expiry job failed" },
      { status: 500 }
    );
  }
};
