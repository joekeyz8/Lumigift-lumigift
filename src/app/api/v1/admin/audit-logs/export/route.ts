import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAuditLog, queryAuditLogsStream } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_SECONDS = 300;
const RATE_LIMIT_MAX = 1;
const PAGE_SIZE = 500;

function parseQuery(searchParams: URLSearchParams) {
  const formatParam = (searchParams.get('format') || 'csv').toLowerCase();
  const format = formatParam === 'json' ? 'json' : 'csv';
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
  return { format, from, to };
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function serializeCsvRow(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((col) => escapeCsvValue(row[col])).join(',') + '\r\n';
}

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) {
    return authResult;
  }
  const admin = authResult;
  const userId = admin.id;

  const rateLimitKey = `rl:audit-export:${userId}`;
  const rateLimit = await checkRateLimit(
    rateLimitKey,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS
  );

  if (!rateLimit.allowed) {
    const retryAfter = Math.max(
      1,
      Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
    );
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        message: 'Audit log export is limited to 1 export per 5 minutes.',
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  const { format, from, to } = parseQuery(request.nextUrl.searchParams);

  await createAuditLog({
    eventType: 'audit_log_export',
    actorId: userId,
    metadata: {
      adminId: userId,
      format,
      from: from ?? null,
      to: to ?? null,
    },
  });

  const encoder = new TextEncoder();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `audit-logs-${timestamp}.${format}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let columns: string[] | null = null;
        let isFirstJson = true;

        if (format === 'json') {
          controller.enqueue(encoder.encode('['));
        }

        let offset = 0;
        while (true) {
          const rows = await queryAuditLogsStream({
            from,
            to,
            limit: PAGE_SIZE,
            offset,
          });

          if (!rows || rows.length === 0) {
            break;
          }

          if (format === 'csv') {
            if (columns === null) {
              columns = Object.keys(rows[0]);
              controller.enqueue(encoder.encode(columns.join(',') + '\r\n'));
            }
            for (const row of rows) {
              controller.enqueue(
                encoder.encode(
                  serializeCsvRow(row as Record<string, unknown>, columns)
                )
              );
            }
          } else {
            for (const row of rows) {
              const serialized = JSON.stringify(row);
              if (isFirstJson) {
                controller.enqueue(encoder.encode(serialized));
                isFirstJson = false;
              } else {
                controller.enqueue(encoder.encode(',' + serialized));
              }
            }
          }

          if (rows.length < PAGE_SIZE) {
            break;
          }
          offset += PAGE_SIZE;
        }

        if (format === 'json') {
          controller.enqueue(encoder.encode(']'));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  const contentType =
    format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
      'X-RateLimit-Remaining': '0',
    },
  });
}