# Partner Webhook Integration Guide

This guide is for third-party partners integrating with Lumigift gift lifecycle webhooks. It covers how to subscribe, the event types you will receive, payload schemas, signature verification, retry behaviour, rate limits, and security requirements.

> **Internal setup:** If you are running Lumigift yourself and need to configure webhook delivery infrastructure, see `docs/webhook-setup.md` instead.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Subscribing to Webhooks](#2-subscribing-to-webhooks)
3. [Gift Lifecycle Event Types](#3-gift-lifecycle-event-types)
4. [Payload Schemas & Examples](#4-payload-schemas--examples)
5. [Signature Verification](#5-signature-verification)
6. [Retry Policy](#6-retry-policy)
7. [Rate Limits](#7-rate-limits)
8. [Security Requirements](#8-security-requirements)
9. [Error Codes](#9-error-codes)

---

## 1. Overview

Lumigift delivers webhooks for gift lifecycle events. When a gift transitions between states (funded, locked, unlocked, claimed, cancelled, expired), Lumigift sends an HTTP `POST` request to the endpoint(s) you have registered.

Each delivery:

- Is sent as `POST` with `Content-Type: application/json`.
- Includes an `X-Lumigift-Signature` header (`sha256=<hex>`) and an `X-Lumigift-Timestamp` header (Unix seconds).
- Contains a unique event `id` that you should use for idempotency.
- Expects a `2xx` response within **10 seconds**. Any non-`2xx` response, timeout, or connection error is treated as a failed delivery and retried (see [Retry Policy](#6-retry-policy)).

---

## 2. Subscribing to Webhooks

### 2.1 Register an endpoint

Register your HTTPS endpoint through the Lumigift partner dashboard or the partner API. You must provide:

| Field | Description |
| --- | --- |
| `url` | Your HTTPS endpoint. Must be `https://` — plain HTTP is rejected. |
| `events` | The list of event types you want to receive (see [Event Types](#3-gift-lifecycle-event-types)). |
| `description` | Optional human-readable label. |

Example registration request:

```http
POST /v1/webhooks/endpoints
Authorization: Bearer <your-api-key>
Content-Type: application/json

{
  "url": "https://partner.example.com/webhooks/lumigift",
  "events": ["gift.funded", "gift.claimed", "gift.cancelled"],
  "description": "Production gift lifecycle listener"
}
```

Response:

```json
{
  "id": "whe_01HXYZABCDEF",
  "url": "https://partner.example.com/webhooks/lumigift",
  "events": ["gift.funded", "gift.claimed", "gift.cancelled"],
  "secret": "whsec_9f2c...redacted...",
  "status": "active",
  "created_at": "2024-06-01T12:00:00Z"
}
```

### 2.2 Shared secret provisioning

When an endpoint is created, Lumigift provisions a **shared secret** (`whsec_...`). This secret is used to sign every delivery (see [Signature Verification](#5-signature-verification)).

- Store the secret in a secure secret manager. Never commit it to source control or expose it to clients.
- The secret is shown **once** at creation time. If you lose it, rotate it (see [Secret Rotation](#83-secret-rotation)).
- Each endpoint has its own secret. Do not reuse secrets across endpoints or environments.

### 2.3 Verifying your endpoint

After registration, Lumigift sends a `webhook.ping` test event. Respond with `2xx` to confirm your endpoint is reachable and your signature verification is working.

---

## 3. Gift Lifecycle Event Types

Lumigift emits the following gift lifecycle events:

| Event | Description |
| --- | --- |
| `gift.funded` | A gift has been funded and is ready to be locked. |
| `gift.locked` | A gift has been locked to a recipient. |
| `gift.unlocked` | A gift has been unlocked and is available to claim. |
| `gift.claimed` | A gift has been claimed by the recipient. |
| `gift.cancelled` | A gift has been cancelled by the sender or platform. |
| `gift.expired` | A gift has expired without being claimed. |

### 3.1 Common envelope

Every delivery shares a common envelope. The `data` object varies by event type.

```json
{
  "id": "evt_01HXYZ1234567890",
  "type": "gift.funded",
  "created_at": "2024-06-01T12:00:00Z",
  "api_version": "2024-06-01",
  "data": { }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique event ID. Use for idempotency. |
| `type` | string | Event type (see table above). |
| `created_at` | string (ISO 8601) | When the event occurred. |
| `api_version` | string | Payload schema version. |
| `data` | object | Event-specific payload. |

---

## 4. Payload Schemas & Examples

### 4.1 `gift.funded`

Emitted when a gift is funded.

```json
{
  "id": "evt_01HXYZ1234567890",
  "type": "gift.funded",
  "created_at": "2024-06-01T12:00:00Z",
  "api_version": "2024-06-01",
  "data": {
    "gift_id": "gft_01HABC0000000001",
    "sender_id": "usr_01HSENDER000001",
    "amount": {
      "value": "50.00",
      "currency": "USD"
    },
    "funded_at": "2024-06-01T12:00:00Z",
    "status": "funded"
  }
}
```

### 4.2 `gift.locked`

Emitted when a gift is locked to a recipient.

```json
{
  "id": "evt_01HXYZ1234567891",
  "type": "gift.locked",
  "created_at": "2024-06-01T12:05:00Z",
  "api_version": "2024-06-01",
  "data": {
    "gift_id": "gft_01HABC0000000001",
    "sender_id": "usr_01HSENDER000001",
    "recipient_id": "usr_01HRECIPIENT001",
    "locked_at": "2024-06-01T12:05:00Z",
    "unlock_at": "2024-06-08T12:05:00Z",
    "status": "locked"
  }
}
```

### 4.3 `gift.unlocked`

Emitted when a gift becomes available to claim.

```json
{
  "id": "evt_01HXYZ1234567892",
  "type": "gift.unlocked",
  "created_at": "2024-06-08T12:05:00Z",
  "api_version": "2024-06-01",
  "data": {
    "gift_id": "gft_01HABC0000000001",
    "sender_id": "usr_01HSENDER000001",
    "recipient_id": "usr_01HRECIPIENT001",
    "unlocked_at": "2024-06-08T12:05:00Z",
    "expires_at": "2024-07-08T12:05:00Z",
    "status": "unlocked"
  }
}
```

### 4.4 `gift.claimed`

Emitted when a recipient claims a gift.

```json
{
  "id": "evt_01HXYZ1234567893",
  "type": "gift.claimed",
  "created_at": "2024-06-09T09:30:00Z",
  "api_version": "2024-06-01",
  "data": {
    "gift_id": "gft_01HABC0000000001",
    "sender_id": "usr_01HSENDER000001",
    "recipient_id": "usr_01HRECIPIENT001",
    "amount": {
      "value": "50.00",
      "currency": "USD"
    },
    "claimed_at": "2024-06-09T09:30:00Z",
    "status": "claimed"
  }
}
```

### 4.5 `gift.cancelled`

Emitted when a gift is cancelled.

```json
{
  "id": "evt_01HXYZ1234567894",
  "type": "gift.cancelled",
  "created_at": "2024-06-02T08:00:00Z",
  "api_version": "2024-06-01",
  "data": {
    "gift_id": "gft_01HABC0000000001",
    "sender_id": "usr_01HSENDER000001",
    "cancelled_at": "2024-06-02T08:00:00Z",
    "reason": "sender_request",
    "status": "cancelled"
  }
}
```

### 4.6 `gift.expired`

Emitted when a gift expires without being claimed.

```json
{
  "id": "evt_01HXYZ1234567895",
  "type": "gift.expired",
  "created_at": "2024-07-08T12:05:00Z",
  "api_version": "2024-06-01",
  "data": {
    "gift_id": "gft_01HABC0000000001",
    "sender_id": "usr_01HSENDER000001",
    "recipient_id": "usr_01HRECIPIENT001",
    "expired_at": "2024-07-08T12:05:00Z",
    "status": "expired"
  }
}
```

---

## 5. Signature Verification

Every delivery is signed so you can verify it originated from Lumigift and was not tampered with.

### 5.1 Headers

| Header | Description |
| --- | --- |
| `X-Lumigift-Signature` | `sha256=<hex>` — HMAC-SHA256 of the signed payload. |
| `X-Lumigift-Timestamp` | Unix timestamp (seconds) of when the delivery was signed. |

### 5.2 Signed payload

The signed payload is the concatenation of the timestamp, a literal `.` character, and the **raw request body**:

```
signed_payload = "<timestamp>.<raw_body>"
signature      = HMAC-SHA256(secret, signed_payload)  // hex-encoded
```

> **Important:** Compute the HMAC over the **raw request body bytes exactly as received**. Do not parse and re-serialize the JSON — key ordering and whitespace differences will change the bytes and break verification.

### 5.3 Replay protection

Reject any delivery whose `X-Lumigift-Timestamp` is more than **5 minutes (300 seconds)** away from your current time. This window is enforced by Lumigift's reference implementation in `src/lib/webhook-verify.ts`.

### 5.4 Timing-safe comparison

Always compare signatures using a **constant-time** comparison to avoid timing attacks. Do not use `==` / `===` on the hex strings.

### 5.5 JavaScript (Node.js) example

```javascript
const crypto = require('crypto');

const MAX_SKEW_SECONDS = 300; // 5-minute replay window

/**
 * Verify a Lumigift webhook.
 * @param {Buffer} rawBody - The raw request body bytes (do NOT parse first).
 * @param {string} signatureHeader - Value of X-Lumigift-Signature.
 * @param {string} timestampHeader - Value of X-Lumigift-Timestamp.
 * @param {string} secret - Your endpoint's shared secret (whsec_...).
 * @returns {boolean} true if the signature is valid and fresh.
 */
function verifyLumigiftSignature(rawBody, signatureHeader, timestampHeader, secret) {
  if (!signatureHeader || !timestampHeader) return false;

  // 1. Replay protection: reject stale timestamps.
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_SKEW_SECONDS) return false;

  // 2. Compute expected signature over "<timestamp>.<raw_body>".
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestampHeader}.`, 'utf8'),
    rawBody,
  ]);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // 3. Parse the "sha256=<hex>" header.
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  const provided = parts[1];

  // 4. Timing-safe comparison.
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Example Express handler.
const express = require('express');
const app = express();

app.post(
  '/webhooks/lumigift',
  express.raw({ type: 'application/json' }), // keep raw body
  (req, res) => {
    const ok = verifyLumigiftSignature(
      req.body,
      req.get('X-Lumigift-Signature'),
      req.get('X-Lumigift-Timestamp'),
      process.env.LUMIGIFT_WEBHOOK_SECRET
    );
    if (!ok) {
      return res.status(401).json({ error: 'PAYMENT_INVALID_SIGNATURE' });
    }

    const event = JSON.parse(req.body.toString('utf8'));
    // TODO: idempotency check on event.id, then handle event.type.
    res.status(200).json({ received: true });
  }
);
```

### 5.6 Python example

```python
import hashlib
import hmac
import time

MAX_SKEW_SECONDS = 300  # 5-minute replay window


def verify_lumigift_signature(raw_body: bytes, signature_header: str,
                              timestamp_header: str, secret: str) -> bool:
    """Verify a Lumigift webhook.

    :param raw_body: Raw request body bytes (do NOT parse first).
    :param signature_header: Value of X-Lumigift-Signature.
    :param timestamp_header: Value of X-Lumigift-Timestamp.
    :param secret: Your endpoint's shared secret (whsec_...).
    :return: True if the signature is valid and fresh.
    """
    if not signature_header or not timestamp_header:
        return False

    # 1. Replay protection: reject stale timestamps.
    try:
        timestamp = int(timestamp_header)
    except ValueError:
        return False
    if abs(int(time.time()) - timestamp) > MAX_SKEW_SECONDS:
        return False

    # 2. Compute expected signature over "<timestamp>.<raw_body>".
    signed_payload = timestamp_header.encode("utf-8") + b"." + raw_body
    expected = hmac.new(
        secret.encode("utf-8"), signed_payload, hashlib.sha256
    ).hexdigest()

    # 3. Parse the "sha256=<hex>" header.
    if not signature_header.startswith("sha256="):
        return False
    provided = signature_header[len("sha256="):]

    # 4. Timing-safe comparison.
    return hmac.compare_digest(expected, provided)


# Example Flask handler.
from flask import Flask, request, jsonify

app = Flask(__name__)


@app.post("/webhooks/lumigift")
def lumigift_webhook():
    raw_body = request.get_data()  # raw bytes
    ok = verify_lumigift_signature(
        raw_body,
        request.headers.get("X-Lumigift-Signature", ""),
        request.headers.get("X-Lumigift-Timestamp", ""),
        os.environ["LUMIGIFT_WEBHOOK_SECRET"],
    )
    if not ok:
        return jsonify(error="PAYMENT_INVALID_SIGNATURE"), 401

    event = request.get_json(force=True)
    # TODO: idempotency check on event["id"], then handle event["type"].
    return jsonify(received=True), 200
```

---

## 6. Retry Policy

If your endpoint does not return a `2xx` response within **10 seconds**, or the connection fails, Lumigift retries delivery using **exponential backoff**.

| Attempt | Approximate delay after previous attempt |
| --- | --- |
| 1 | immediate |
| 2 | ~30 seconds |
| 3 | ~2 minutes |
| 4 | ~10 minutes |
| 5 | ~1 hour |
| 6 | ~6 hours |
| 7 | ~24 hours |

- **Maximum attempts:** 7 deliveries per event.
- **Dead-letter behaviour:** After the final attempt fails, the event is moved to a dead-letter queue. Dead-lettered events are retained for **7 days** and can be inspected and replayed from the partner dashboard.
- **Ordering:** Retries may arrive out of order. Use the event `created_at` and `id` to reconcile state; do not assume strict ordering.
- **Idempotency:** Because retries can deliver the same event more than once, always deduplicate by event `id` (see [Idempotency](#84-idempotency)).

---

## 7. Rate Limits

| Limit | Value |
| --- | --- |
| Concurrent in-flight deliveries per endpoint | 20 |
| Delivery throughput per endpoint | 100 events / second (burst) |
| Endpoint registration calls | 60 / minute |

If you exceed the delivery throughput, Lumigift queues events and delivers them as capacity frees up. Queued events are subject to the same retry policy once delivery begins.

When you call the partner API (e.g. to register endpoints), rate-limited requests receive `429 Too Many Requests` with the error code `RATE_LIMIT_EXCEEDED`. See [Error Codes](#9-error-codes).

---

## 8. Security Requirements

### 8.1 TLS only

- Endpoints **must** use `https://`. Plain HTTP endpoints are rejected at registration.
- Use a valid, publicly trusted TLS certificate. Self-signed certificates are not accepted.

### 8.2 Verify every delivery

- Always verify the `X-Lumigift-Signature` before acting on a payload.
- Reject deliveries outside the 5-minute replay window.
- Use timing-safe comparison (see [Signature Verification](#5-signature-verification)).

### 8.3 Secret rotation

- Rotate your shared secret periodically and immediately if you suspect compromise.
- During rotation, Lumigift supports a brief **dual-secret** window where deliveries are signed with the new secret but the old secret remains valid for verification. Complete rotation within 24 hours.
- After rotation, update your secret manager and redeploy.

### 8.4 Idempotency

- Every event has a unique `id`. Persist processed event IDs and ignore duplicates.
- Retries and out-of-order delivery mean the same event may arrive more than once.

### 8.5 IP allowlisting (optional)

If your infrastructure supports it, restrict inbound traffic to Lumigift's published egress IP ranges. These are available in the partner dashboard and may change; subscribe to change notifications.

### 8.6 Respond quickly

- Acknowledge with `2xx` as soon as you have durably queued the event. Do heavy processing asynchronously.
- Respond within 10 seconds to avoid triggering retries.

---

## 9. Error Codes

The following error codes may be returned by the partner API and are relevant to webhook integration. For the full list, see [`docs/api-auth-and-errors.md`](./api-auth-and-errors.md).

| Code | HTTP Status | Meaning | Resolution |
| --- | --- | --- | --- |
| `PAYMENT_INVALID_SIGNATURE` | `401` | The `X-Lumigift-Signature` did not match the expected HMAC, or the timestamp was outside the replay window. | Verify you are using the raw body and the correct secret; check clock skew. |
| `UNAUTHORIZED` | `401` | Missing or invalid API credentials when calling the partner API. | Provide a valid `Authorization: Bearer <api-key>` header. |
| `RATE_LIMIT_EXCEEDED` | `429` | Too many requests to the partner API. | Back off and retry after the `Retry-After` header interval. |

> **Note:** `PAYMENT_INVALID_SIGNATURE` is the code your endpoint should return (with HTTP `401`) when signature verification fails, so Lumigift can distinguish a verification failure from a transient error. Returning `401` for an invalid signature does **not** trigger retries; returning `5xx` does.

---

## Related Documentation

- [`docs/api-auth-and-errors.md`](./api-auth-and-errors.md) — API authentication and error reference.
- `docs/webhook-setup.md` — Internal webhook infrastructure setup.
- `src/lib/webhook-verify.ts` — Reference signature verification implementation.