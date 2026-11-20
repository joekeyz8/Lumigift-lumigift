import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { withErrorHandler, withCsrf, validateBody } from "@/server/middleware";
import { validateInvitationToken, acceptInvitation } from "@/server/services/invitation.service";
import { createAuditLog } from "@/server/services/audit.service";
import { createHash, randomUUID } from "crypto";
import { registerSchema } from "@/types/schemas";
import type { ApiResponse } from "@/types";

/** Directs the user to the login flow instead of registration. */
const DUPLICATE_ERROR = "This phone number is already registered. Please log in instead.";

const PG_UNIQUE_VIOLATION = "23505";

function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
}

async function logDuplicateAttempt(phoneHash: string): Promise<void> {
  try {
    await createAuditLog({
      eventType: "registration_duplicate_attempt",
      metadata: { phoneHash },
    });
  } catch (error) {
    // Audit logging must never block the duplicate response.
    console.error("[register] Failed to write duplicate-attempt audit log:", error);
  }
}

async function duplicateResponse(phoneHash: string) {
  await logDuplicateAttempt(phoneHash);
  return NextResponse.json<ApiResponse<never>>(
    { success: false, error: DUPLICATE_ERROR },
    { status: 409 }
  );
}

export const POST = withErrorHandler(
  withCsrf(async (req: NextRequest) => {
    const validation = await validateBody(req, registerSchema);
    if (!validation.success) return validation.response;
    const { phone, displayName, invitationToken } = validation.data;
    const phoneHash = hashPhone(phone);

    const { rows: existingUsers } = await pool.query(
      "SELECT 1 FROM users WHERE phone_hash = $1 AND deleted_at IS NULL LIMIT 1",
      [phoneHash]
    );
    if (existingUsers.length > 0) return await duplicateResponse(phoneHash);

    let invitationId: string | null = null;
    if (invitationToken) {
      const invitation = await validateInvitationToken(invitationToken);
      if (!invitation) {
        return NextResponse.json<ApiResponse<never>>(
          { success: false, error: "Invalid or expired invitation" },
          { status: 400 }
        );
      }

      if (invitation.recipientPhone !== phone) {
        return NextResponse.json<ApiResponse<never>>(
          { success: false, error: "Phone number does not match invitation" },
          { status: 400 }
        );
      }

      invitationId = invitation.id;
    }

    const userId = randomUUID();
    try {
      await pool.query(
        "INSERT INTO users (id, phone, phone_hash, display_name) VALUES ($1, $2, $3, $4)",
        [userId, phone, phoneHash, displayName]
      );
    } catch (error) {
      // Concurrent registration with the same phone hits the unique index.
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        return await duplicateResponse(phoneHash);
      }
      console.error("[register] Error creating user:", error);
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "Failed to create user account" },
        { status: 500 }
      );
    }

    if (invitationId) await acceptInvitation(invitationId);

    return NextResponse.json<ApiResponse<{ userId: string; phone: string }>>(
      { success: true, data: { userId, phone } },
      { status: 201 }
    );
  })
);
