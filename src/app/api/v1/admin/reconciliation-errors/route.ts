import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/require-admin';
import { listUnresolvedReconciliationErrors } from '@/lib/services/payment-reconciliation.service';
import type { ApiResponse } from '@/lib/types/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse>> {
  const adminCheck = await requireAdmin(req);
  if (!adminCheck.ok) {
    return NextResponse.json(
      { success: false, error: adminCheck.error },
      { status: adminCheck.status },
    );
  }

  const limitParam = req.nextUrl.searchParams.get('limit');
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid limit parameter' },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  try {
    const errors = await listUnresolvedReconciliationErrors(limit);
    return NextResponse.json({ success: true, data: errors }, { status: 200 });
  } catch (error) {
    console.error('[reconciliation-errors] Failed to list unresolved errors', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list reconciliation errors' },
      { status: 500 },
    );
  }
}