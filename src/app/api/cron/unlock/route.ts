import { NextRequest, NextResponse } from "next/server";
import { processUnlocks } from "@/server/services/scheduler.service";
import { startTimer, recordCronSuccess, recordCronFailure } from "@/lib/metrics";
import type { ApiResponse } from "@/types";
import { isAuthorizedCronRequest } from "@/server/cron-auth";
import { pingCronHealthcheck } from "@/server/cron-healthcheck";

/**
 * GET /api/cron/unlock
 *
 * Triggered by Vercel Cron (or any scheduler) to unlock gifts whose
 * `unlockAt` timestamp has passed.
 *
 * Authentication: Bearer token checked against CRON_SECRET env var.
 *
 * Monitoring: On success, pings the configured Healthchecks.io check
 * (CRON_UNLOCK_HEALTHCHECK_URL) to confirm completion. On failure, pings
 * the /fail endpoint so missed/failed runs alert within 5 minutes.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");

  if (!isAuthorizedCronRequest(authHeader)) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const elapsed = startTimer();

  try {
    const unlocked = await processUnlocks();
    const durationMs = elapsed();

    recordCronSuccess("cron/unlock", durationMs, { unlocked });

    // Ping only after the job has completed successfully.
    await pingCronHealthcheck("cron/unlock", { status: "success" });

    return NextResponse.json<ApiResponse<{ unlocked: number }>>({
      success: true,
      data: { unlocked },
    });
  } catch (err) {
    const durationMs = elapsed();
    recordCronFailure("cron/unlock", durationMs, err);

    // Signal failure to the healthcheck so alerts fire promptly.
    await pingCronHealthcheck("cron/unlock", { status: "fail" });

    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Cron job failed" },
      { status: 500 }
    );
  }
}