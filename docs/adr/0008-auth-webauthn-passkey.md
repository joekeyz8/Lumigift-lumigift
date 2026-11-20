# ADR-0008: WebAuthn Passkey Authentication

- **Status:** Accepted
- **Date:** 2025-01-15
- **Deciders:** Engineering Team
- **Related:** ADR-0004 (Redis Usage), ADR-0006 (Paystack Integration)

## Context

The platform originally relied on one-time passwords (OTP) delivered via SMS and email as the primary second factor and, in some flows, as the primary authentication mechanism. While OTP is widely understood and requires no special hardware, it has several well-documented weaknesses:

- **Phishing susceptibility:** Users routinely relay OTP codes to attackers who are running real-time phishing proxies. Because the code is a bearer token, possession is sufficient to authenticate.
- **SIM-swap and interception risk:** SMS OTP is vulnerable to SIM-swap attacks and SS7 interception.
- **Friction and cost:** Delivery latency, per-message costs, and failed deliveries degrade the login experience and increase support load.
- **Replay and brute-force exposure:** Short numeric codes have limited entropy and require rate limiting to remain safe.

We need an authentication mechanism that is **phishing-resistant** (bound to the origin), **low-friction** (no app switching, no code entry), and **standards-based** so it works across modern browsers and platforms without bespoke client software. WebAuthn / passkeys satisfy these requirements: the credential is cryptographically bound to the relying party's origin, the private key never leaves the authenticator, and the user experience is typically a single biometric or device-PIN prompt.

This ADR records the decision to adopt WebAuthn passkeys as a first-class authentication method alongside existing OTP flows.

## Decision

We will implement WebAuthn passkey authentication using the following design:

1. **Library:** Use [`@simplewebauthn/server`](https://github.com/MasterKhelo/simplewebauthn) on the server for registration and authentication ceremony verification. It handles challenge generation, attestation/assertion verification, and CBOR/COSE parsing, reducing the risk of subtle cryptographic mistakes.

2. **Authenticators:** Support **platform authenticators** (Touch ID, Face ID, Windows Hello, Android biometrics) as the primary experience, with the `residentKey`/discoverable-credential preference enabled so users can sign in without first entering a username. Cross-platform (roaming) authenticators such as hardware security keys are permitted but not required.

3. **Challenge storage:** Challenges are generated server-side and stored in **Redis** as **single-use** values with a **5-minute TTL**. The challenge is keyed to the ceremony (registration vs. authentication) and the user/session context, and is deleted immediately upon successful verification to prevent replay. This leverages the existing Redis infrastructure (see ADR-0004).

4. **Credential storage:** Verified credentials are persisted in a dedicated `webauthn_credentials` table (see `migrations/0009_webauthn_credentials.sql`). Each row stores the credential ID, public key, signature counter, transports, the associated user, and metadata (AAGUID, creation/last-used timestamps). The signature counter is checked on each authentication to detect cloned authenticators where the authenticator supports it.

5. **Implementation location:** The ceremony logic (option generation, verification, credential persistence) lives in `src/lib/webauthn.ts`, keeping the cryptographic and protocol concerns isolated from route handlers.

6. **Coexistence:** Passkeys are additive. Existing OTP-based login remains available, and users may register one or more passkeys. Passkey authentication is offered as the preferred path when a user has at least one registered credential.

## Consequences

### Positive

- **Stronger security:** Credentials are origin-bound and phishing-resistant; there is no shared secret to phish, replay, or intercept. Private keys never leave the user's device.
- **Better UX:** Sign-in is a single biometric/PIN prompt with no codes to type or wait for, reducing login time and drop-off.
- **Lower operational cost:** Fewer OTP messages sent, reducing delivery costs and support tickets related to undelivered codes.
- **Standards-based:** WebAuthn is a W3C standard supported across major browsers and platforms, avoiding vendor lock-in.

### Negative

- **Device dependency:** Passkeys are tied to the device/authenticator (or a synced passkey provider). Users who lose access to all registered devices cannot authenticate with a passkey alone.
- **Recovery flow required:** We must provide a secure account-recovery path (e.g., verified email + OTP fallback, or admin-assisted recovery) for users who lose their authenticators. This flow itself becomes a security-sensitive surface.
- **Browser/platform variability:** Behavior differs across platforms (e.g., conditional UI support, synced vs. device-bound passkeys), requiring feature detection and graceful fallback.
- **Added infrastructure dependency:** The ceremony flow depends on Redis availability for challenge storage; outages must degrade gracefully to OTP.

## Alternatives Considered

- **TOTP (authenticator apps):** Phishing-resistant relative to SMS but still a bearer code that can be relayed in real time; requires users to install and manage an app; worse UX than a single biometric prompt. Rejected as the primary mechanism, though it remains a possible fallback.
- **SMS-only OTP (status quo):** Simple and universal but vulnerable to SIM-swap, interception, and real-time phishing; higher cost and friction. Retained only as a fallback, not the primary method.
- **Hardware security keys (FIDO2 roaming authenticators only):** Very strong security but imposes hardware purchase and logistics on users; poor fit for a consumer-facing product. Supported as an optional authenticator rather than mandated.
- **Passwordless magic links:** Convenient but email-dependent, phishable via link forwarding, and subject to email deliverability issues. Not phishing-resistant in the WebAuthn sense.

## References

- Implementation: `src/lib/webauthn.ts`
- Schema: `migrations/0009_webauthn_credentials.sql`
- Related ADRs: ADR-0004 (Redis Usage), ADR-0006 (Paystack Integration)
- W3C Web Authentication (WebAuthn) Level 2 specification