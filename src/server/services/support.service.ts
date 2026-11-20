/**
 * Support escalation service — issue #152
 *
 * Handles support cases for failed money movement.  Cases are stored in-memory
 * (Map).  A production implementation would persist to the database; the Map
 * is the intentional source of truth here so no migration is required.
 */
import type { SupportCase, SupportCaseMessage, SupportCaseStatus } from "@/types";
import { createAuditLog } from "@/server/services/audit.service";
import { findUsersByRole } from "@/server/services/user.service";

// ─── In-memory store ──────────────────────────────────────────────────────────
/** Primary index: caseReference → SupportCase */
const caseStore = new Map<string, SupportCase>();

/** Maximum number of open cases an agent may hold before being considered at capacity. */
const MAX_OPEN_CASES_PER_AGENT = 20;

/** Round-robin cursor: index into the sorted list of eligible agents. */
let roundRobinCursor = 0;

/** Support lead who receives alerts when no agent is available. */
const SUPPORT_LEAD_ID = "support-lead";

// ─── Assignment helpers ───────────────────────────────────────────────────────

/** Returns the number of open cases currently assigned to the given agent. */
function countOpenCasesForAgent(agentId: string): number {
  let count = 0;
  for (const c of caseStore.values()) {
    if (c.assignedAgentId === agentId && c.status === "open") count += 1;
  }
  return count;
}

/**
 * Selects the next agent for round-robin assignment.
 *
 * Eligible agents are users with the `support` role whose open-case count is
 * below {@link MAX_OPEN_CASES_PER_AGENT}.  Selection advances a round-robin
 * cursor over the (stable) sorted list of eligible agent IDs.
 *
 * @returns The selected agent ID, or `null` if no agent is available.
 */
function selectNextAgent(): string | null {
  const eligible = findUsersByRole("support")
    .filter((u) => countOpenCasesForAgent(u.id) < MAX_OPEN_CASES_PER_AGENT)
    .map((u) => u.id)
    .sort();

  if (eligible.length === 0) return null;

  const agentId = eligible[roundRobinCursor % eligible.length];
  roundRobinCursor = (roundRobinCursor + 1) % eligible.length;
  return agentId;
}

/**
 * Sends an alert to the support lead when a case cannot be auto-assigned.
 * In production this would dispatch an SMS/email; here it is logged.
 */
function alertSupportLead(supportCase: SupportCase): void {
  console.warn(
    `[support] No agent available for case ${supportCase.caseReference}; ` +
      `flagged as unassigned. Alerting support lead ${SUPPORT_LEAD_ID}.`
  );
}

/**
 * Auto-assigns a newly-created support case to an available agent.
 *
 * On success the case is assigned and an audit log entry is written.  If no
 * agent is available the case is flagged `unassigned` and the support lead is
 * alerted.
 *
 * @param supportCase - The case to assign (mutated in place).
 * @param actorId     - ID of the actor performing the assignment (system).
 */
export function assignSupportCase(supportCase: SupportCase, actorId = "system"): void {
  const agentId = selectNextAgent();

  if (!agentId) {
    supportCase.status = "unassigned";
    supportCase.assignedAgentId = undefined;
    supportCase.updatedAt = new Date();
    alertSupportLead(supportCase);
    return;
  }

  supportCase.assignedAgentId = agentId;
  supportCase.updatedAt = new Date();

  createAuditLog({
    eventType: "support_case_assigned",
    actorId,
    targetId: supportCase.caseReference,
    metadata: { agentId, caseReference: supportCase.caseReference },
  });
}

/**
 * Reassigns an existing support case to a specific agent.
 *
 * Validates that the target user has the `support` role before updating the
 * assignment and writing an audit log entry.
 *
 * @param caseReference - Reference of the case to reassign.
 * @param agentId       - ID of the target support agent.
 * @param actorId       - ID of the actor performing the reassignment.
 * @returns The updated {@link SupportCase}.
 * @throws If the case is not found or the target agent is invalid.
 */
export function reassignSupportCase(
  caseReference: string,
  agentId: string,
  actorId: string
): SupportCase {
  const supportCase = caseStore.get(caseReference);
  if (!supportCase) {
    throw new Error(`Support case not found: ${caseReference}`);
  }

  const isSupportAgent = findUsersByRole("support").some((u) => u.id === agentId);
  if (!isSupportAgent) {
    throw new Error(`Invalid agent: ${agentId} does not have the support role`);
  }

  const previousAgentId = supportCase.assignedAgentId;
  supportCase.assignedAgentId = agentId;
  if (supportCase.status === "unassigned") supportCase.status = "open";
  supportCase.updatedAt = new Date();

  createAuditLog({
    eventType: "support_case_assigned",
    actorId,
    targetId: supportCase.caseReference,
    metadata: { agentId, previousAgentId, caseReference: supportCase.caseReference },
  });

  return supportCase;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a unique case reference in the format `SUP-YYYYMMDD-XXXX`
 * where XXXX is a random 4-char uppercase hex string.
 */
function generateCaseReference(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0");
  return `SUP-${yyyy}${mm}${dd}-${hex}`;
}

function generateCaseId(): string {
  return `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Creates a support case for a failed money movement.
 *
 * Idempotent: if an **open** case already exists for the same user + gift
 * combination, the existing case is returned without creating a duplicate.
 *
 * @param userId  - UUID of the authenticated user filing the case.
 * @param giftId  - UUID of the gift that experienced the issue (omit for general enquiries).
 * @param reason  - Short description of the problem.
 * @param details - Optional extended details.
 * @returns The existing or newly-created {@link SupportCase}.
 */
export function createSupportCase(
  userId: string,
  giftId: string | undefined,
  reason: string,
  details?: string
): SupportCase {
  // Deduplication: return any existing open case for the same user+gift
  if (giftId) {
    for (const existing of caseStore.values()) {
      if (existing.userId === userId && existing.giftId === giftId && existing.status === "open") {
        return existing;
      }
    }
  }

  const now = new Date();
  const supportCase: SupportCase = {
    id: generateCaseId(),
    caseReference: generateCaseReference(),
    userId,
    giftId,
    reason,
    details,
    status: "open" as SupportCaseStatus,
    messages: [],
    hasUnreadReply: false,
    createdAt: now,
    updatedAt: now,
  };

  caseStore.set(supportCase.caseReference, supportCase);
  assignSupportCase(supportCase);
  return supportCase;
}

/**
 * Retrieves a support case by its reference string.
 *
 * @param caseReference - Reference in the format `SUP-YYYYMMDD-XXXX`.
 * @returns The {@link SupportCase}, or `null` if not found.
 */
export function getSupportCase(caseReference: string): SupportCase | null {
  return caseStore.get(caseReference) ?? null;
}

/**
 * Lists all support cases, optionally filtered by userId.
 *
 * @param userId - When provided, only cases belonging to this user are returned.
 * @returns Array of {@link SupportCase} sorted newest-first.
 */
export function listSupportCases(userId?: string): SupportCase[] {
  const all = Array.from(caseStore.values());
  const filtered = userId ? all.filter((c) => c.userId === userId) : all;
  return filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Appends a message to a support case thread. Agent replies flag the case as
 * unread for the owning user.
 *
 * @returns The updated {@link SupportCase}, or `null` if not found.
 */
export function addSupportCaseMessage(
  caseReference: string,
  author: SupportCaseMessage["author"],
  body: string
): SupportCase | null {
  const supportCase = caseStore.get(caseReference);
  if (!supportCase) return null;

  const now = new Date();
  supportCase.messages.push({
    id: `msg-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    author,
    body,
    createdAt: now,
  });
  if (author === "agent") supportCase.hasUnreadReply = true;
  supportCase.updatedAt = now;
  return supportCase;
}

/** Clears the unread-reply flag once the owning user has viewed the case. */
export function markSupportCaseRead(caseReference: string): void {
  const supportCase = caseStore.get(caseReference);
  if (supportCase) supportCase.hasUnreadReply = false;
}
