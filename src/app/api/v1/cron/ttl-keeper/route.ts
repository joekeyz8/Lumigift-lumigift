import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCronRequest } from '@/lib/cron/auth';
import {
  recordCronSuccess,
  recordCronFailure,
  recordDeadLetter,
} from '@/lib/cron/monitoring';
import { runTtlKeeper } from '@/lib/contracts/ttlKeeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * TTL Keeper cron route.
 *
 * Scheduled daily (see vercel.json: "0 3 * * *").
 *
 * Queries gifts whose `unlock_time > NOW() + 20 days` and calls
 * `extend_ttl()` on their escrow contract instances to prevent archival.
 * Logs successes/failures, fires alerts when any contract TTL drops below
 * the 7-day buffer, and tracks XLM keeper fees for budgeting.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const jobName = 'ttl-keeper';

  try {
    const result = await runTtlKeeper();

    const durationMs = Date.now() - startedAt;

    console.info(
      `[cron:${jobName}] completed in ${durationMs}ms ` +
        `extended=${result.extended} failed=${result.failed} ` +
        `alerts=${result.alerts} totalFeeXlm=${result.totalFeeXlm}`,
    );

    if (result.failed > 0) {
      await recordDeadLetter({
        job: jobName,
        reason: 'ttl_extension_failures',
        details: {
          extended: result.extended,
          failed: result.failed,
          alerts: result.alerts,
          totalFeeXlm: result.totalFeeXlm,
          failures: result.failures ?? [],
        },
      });
    }

    await recordCronSuccess(jobName, {
      durationMs,
      extended: result.extended,
      failed: result.failed,
      alerts: result.alerts,
      totalFeeXlm: result.totalFeeXlm,
    });

    return NextResponse.json(
      {
        ok: true,
        extended: result.extended,
        failed: result.failed,
        alerts: result.alerts,
        totalFeeXlm: result.totalFeeXlm,
      },
      { status: 200 },
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[cron:${jobName}] failed after ${durationMs}ms: ${message}`,
      error,
    );

    await recordCronFailure(jobName, {
      durationMs,
      error: message,
    });

    await recordDeadLetter({
      job: jobName,
      reason: 'ttl_keeper_exception',
      details: { error: message },
    });

    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}