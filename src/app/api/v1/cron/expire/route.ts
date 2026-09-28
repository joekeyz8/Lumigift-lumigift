import { NextRequest, NextResponse } from "next/server";
import { processExpiries } from "@/server/services/scheduler.service";
import { startTimer, recordCronSuccess, recordCronFailure } from "@/lib/metrics";
import type { ApiResponse } from "@/types";

/**
 * Called daily by Vercel Cron.
 * Expires unlocked gifts that have been unclaimed for more than 365 days,
 * triggers a refund to the sender, and sends an SMS notification.
 */
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
    await processExpiries();
    const durationMs = elapsed();

    recordCronSuccess("cron/v1/expire", durationMs);

    return NextResponse.json<ApiResponse<{ message: string }>>({
      success: true,
      data: { message: "Expiry check complete" },
    });
  } catch (err) {
    const durationMs = elapsed();
    recordCronFailure("cron/v1/expire", durationMs, err);
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Expiry cron job failed" },
      { status: 500 }
    );
  }
};
