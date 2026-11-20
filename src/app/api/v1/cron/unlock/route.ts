import { NextRequest, NextResponse } from "next/server";
import { processUnlocks } from "@/server/services/scheduler.service";
import {
  startTimer,
  recordCronSuccess,
  recordCronFailure,
  recordDeadLetter,
} from "@/lib/metrics";
import type { ApiResponse } from "@/types";
import { isAuthorizedCronRequest } from "@/server/cron-auth";
import { pingCronHealthcheck } from "@/server/cron-healthcheck";

/** Called by Vercel Cron or an external scheduler every minute. */
export const GET = async (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  if (!isAuthorizedCronRequest(authHeader)) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const elapsed = startTimer();

  try {
    const processed = await processUnlocks();
    const durationMs = elapsed();

    recordCronSuccess("cron/v1/unlock", durationMs, { processed });
    // Success ping fires only after processUnlocks completes (confirms completion)
    await pingCronHealthcheck("cron/v1/unlock");

    return NextResponse.json<ApiResponse<{ processed: number; durationMs: number }>>({
      success: true,
      data: { processed, durationMs },
    });
  } catch (err) {
    const durationMs = elapsed();
    recordCronFailure("cron/v1/unlock", durationMs, err);
    await recordDeadLetter("cron/v1/unlock", durationMs, err);
    await pingCronHealthcheck("cron/v1/unlock", { fail: true }); // failure ping
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Cron job failed" },
      { status: 500 }
    );
  }
};
