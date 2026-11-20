import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { withErrorHandler, withCsrf } from "@/server/middleware";
import type { ApiResponse } from "@/types";

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_BYTES = (() => {
  const raw = process.env.MAX_UPLOAD_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
})();
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const UPLOAD_FOLDER = "gift-media";
// Incoming transformation: Cloudinary re-encodes the stored original, which
// strips EXIF/GPS metadata from user photos.
const UPLOAD_TRANSFORMATION = "q_auto";

/** Detects the real image type from the file's leading bytes (magic numbers). */
function sniffImageType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function sign(params: Record<string, string | number>): string {
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!secret) throw new Error("CLOUDINARY_API_SECRET is not set");
  const payload = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("sha256")
    .update(payload + secret)
    .digest("hex");
}

// Requires a session and CSRF token: previously anyone could upload to our
// Cloudinary account through this proxy (pentest finding PT-04).
export const POST = withErrorHandler(
  withCsrf(async (req: NextRequest) => {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "Unauthorized", code: "UNAUTHORIZED" },
        { status: 401 }
      );
    }

    // Reject oversized requests before reading the body into memory.
    const contentLength = req.headers.get("content-length");
    if (contentLength !== null) {
      const declared = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return NextResponse.json<ApiResponse<never>>(
          { success: false, error: "Request body exceeds the upload size limit" },
          { status: 413 }
        );
      }
    }

    // Stream the body through a byte counter so we never buffer past the cap,
    // even when Content-Length is missing or understated.
    let formData: FormData;
    try {
      const body = req.body;
      if (!body) {
        return NextResponse.json<ApiResponse<never>>(
          { success: false, error: "Request must be multipart/form-data" },
          { status: 400 }
        );
      }
      let received = 0;
      let exceeded = false;
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > MAX_BYTES) {
              exceeded = true;
              controller.error(new Error("UPLOAD_TOO_LARGE"));
              return;
            }
            controller.enqueue(chunk);
          },
        })
      );
      const contentType = req.headers.get("content-type") ?? "";
      const buffered = new Response(counted, {
        headers: { "content-type": contentType },
      });
      formData = await buffered.formData();
      if (exceeded) throw new Error("UPLOAD_TOO_LARGE");
    } catch (err) {
      if (err instanceof Error && err.message === "UPLOAD_TOO_LARGE") {
        return NextResponse.json<ApiResponse<never>>(
          { success: false, error: "Request body exceeds the upload size limit" },
          { status: 413 }
        );
      }
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "Request must be multipart/form-data" },
        { status: 400 }
      );
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "Missing file field" },
        { status: 400 }
      );
    }

    // Validate MIME type before upload
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json<ApiResponse<never>>(
        {
          success: false,
          error: `Invalid file type "${file.type}". Allowed: jpeg, png, webp, gif`,
        },
        { status: 415 }
      );
    }

    // Validate file size before upload
    if (file.size > MAX_BYTES) {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "File exceeds the upload size limit" },
        { status: 413 }
      );
    }

    // Verify the actual content via magic bytes — the Content-Type is client-controlled
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (sniffImageType(header) !== file.type) {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "File content does not match an allowed image type" },
        { status: 422 }
      );
    }

    // Upload to Cloudinary server-side using a signed request
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { timestamp, folder: UPLOAD_FOLDER, transformation: UPLOAD_TRANSFORMATION };
    const signature = sign(params);

    const cloudForm = new FormData();
    cloudForm.append("file", file);
    cloudForm.append("timestamp", String(timestamp));
    cloudForm.append("folder", UPLOAD_FOLDER);
    cloudForm.append("transformation", UPLOAD_TRANSFORMATION);
    cloudForm.append("api_key", process.env.CLOUDINARY_API_KEY ?? "");
    cloudForm.append("signature", signature);

    const cloudRes = await fetch(
      `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: "POST", body: cloudForm }
    );

    if (!cloudRes.ok) {
      const err = await cloudRes.json().catch(() => ({}));
      return NextResponse.json<ApiResponse<never>>(
        {
          success: false,
          error: (err as { error?: { message?: string } })?.error?.message ?? "Upload failed",
        },
        { status: 502 }
      );
    }

    const data = (await cloudRes.json()) as { secure_url: string; public_id: string };
    return NextResponse.json<ApiResponse<{ url: string; publicId: string }>>({
      success: true,
      data: { url: data.secure_url, publicId: data.public_id },
    });
  })
);
