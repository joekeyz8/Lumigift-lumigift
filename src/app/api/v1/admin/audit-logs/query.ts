import { AuditEventType, type AuditLogQuery } from "@/server/services/audit.service";

const MAX_LIMIT = 100;
const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  "gift_created",
  "payment_received",
  "gift_funded",
  "gift_claimed",
  "gift_cancelled",
  "payment_failed",
  "gift_refunded",
];

function parseIntegerParam(value: string | null, defaultValue: number): number | null {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

export type AuditLogExportFormat = "csv" | "json";

export interface AuditLogExportQuery extends AuditLogQuery {
  format: AuditLogExportFormat;
}

const EXPORT_FORMATS: readonly AuditLogExportFormat[] = ["csv", "json"];

function parseEventTypeParam(
  searchParams: URLSearchParams
): { eventType: AuditEventType | undefined } | { error: string } {
  const eventType = searchParams.get("eventType");
  if (eventType !== null && !AUDIT_EVENT_TYPES.includes(eventType as AuditEventType)) {
    return { error: "Invalid eventType" };
  }
  return { eventType: (eventType as AuditEventType | null) ?? undefined };
}

function parseDateRange(
  fromStr: string | null,
  toStr: string | null
): { from?: Date; to?: Date } | { error: string } {
  const from = fromStr ? new Date(fromStr) : undefined;
  const to = toStr ? new Date(toStr) : undefined;

  if (fromStr && Number.isNaN(from?.getTime())) {
    return { error: "Invalid from format" };
  }
  if (toStr && Number.isNaN(to?.getTime())) {
    return { error: "Invalid to format" };
  }
  if (from && to && from > to) {
    return { error: "from must be before or equal to to" };
  }

  return { from, to };
}

export function parseAuditLogQuery(
  searchParams: URLSearchParams
): { query: AuditLogQuery } | { error: string } {
  const eventTypeResult = parseEventTypeParam(searchParams);
  if ("error" in eventTypeResult) {
    return { error: eventTypeResult.error };
  }

  const limit = parseIntegerParam(searchParams.get("limit"), 50);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be between 1 and ${MAX_LIMIT}` };
  }

  const offset = parseIntegerParam(searchParams.get("offset"), 0);
  if (offset === null) {
    return { error: "offset must be a non-negative integer" };
  }

  const startDateStr = searchParams.get("startDate");
  const endDateStr = searchParams.get("endDate");
  const startDate = startDateStr ? new Date(startDateStr) : undefined;
  const endDate = endDateStr ? new Date(endDateStr) : undefined;

  if (startDateStr && Number.isNaN(startDate?.getTime())) {
    return { error: "Invalid startDate format" };
  }
  if (endDateStr && Number.isNaN(endDate?.getTime())) {
    return { error: "Invalid endDate format" };
  }
  if (startDate && endDate && startDate > endDate) {
    return { error: "startDate must be before or equal to endDate" };
  }

  return {
    query: {
      userId: searchParams.get("userId") ?? undefined,
      giftId: searchParams.get("giftId") ?? undefined,
      eventType: eventTypeResult.eventType,
      startDate,
      endDate,
      limit,
      offset,
    },
  };
}

export function parseAuditLogExportQuery(
  searchParams: URLSearchParams
): { query: AuditLogExportQuery } | { error: string } {
  const formatParam = searchParams.get("format");
  if (formatParam !== null && !EXPORT_FORMATS.includes(formatParam as AuditLogExportFormat)) {
    return { error: "format must be one of: csv, json" };
  }
  const format = (formatParam as AuditLogExportFormat | null) ?? "json";

  const eventTypeResult = parseEventTypeParam(searchParams);
  if ("error" in eventTypeResult) {
    return { error: eventTypeResult.error };
  }

  const dateRangeResult = parseDateRange(searchParams.get("from"), searchParams.get("to"));
  if ("error" in dateRangeResult) {
    return { error: dateRangeResult.error };
  }

  return {
    query: {
      userId: searchParams.get("userId") ?? undefined,
      giftId: searchParams.get("giftId") ?? undefined,
      eventType: eventTypeResult.eventType,
      startDate: dateRangeResult.from,
      endDate: dateRangeResult.to,
      limit: MAX_LIMIT,
      offset: 0,
      format,
    },
  };
}
