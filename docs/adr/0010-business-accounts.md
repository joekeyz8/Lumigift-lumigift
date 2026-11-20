# ADR-0010: Business Accounts Model

- **Status:** Accepted
- **Date:** 2025-01-15
- **Deciders:** Engineering, Product
- **Related:** [ADR-0003: Paystack Integration](./0003-paystack-integration.md), [ADR-0009: Referral Programme Design](./0009-referral-programme.md)

## Context

We are seeing growing demand from corporate customers who want to gift airtime and data to employees, customers, or event attendees in bulk. These customers currently work around our consumer flow by making many individual purchases, which is slow, error-prone, and gives them no consolidated invoicing or reporting.

Key requirements gathered from prospective corporate customers:

- Ability to gift to many recipients in a single operation (up to 500 recipients per order).
- A single payment per order rather than per-recipient charges, to simplify reconciliation.
- Proper invoices (PDF) for their finance departments.
- A named point of contact (account manager) for support and onboarding.
- Clear separation between personal and business usage on the same platform.

We needed a model that supports these needs without fragmenting the codebase into a separate product or duplicating the existing gifting and payment infrastructure.

## Decision

We will model business accounts as a **flag on the existing `users` table** rather than a separate entity, and layer business-specific capabilities on top of the existing gifting and payment flows.

Specifically:

1. **Account type column.** Add an `account_type` column to the `users` table (values: `personal`, `business`). Business users are otherwise normal users and share the same authentication, wallet, and gifting primitives. See `migrations/0009_business_accounts.sql`.

2. **Bulk CSV upload.** Business users can upload a CSV of recipients (up to **500 recipients per order**). The CSV is validated (format, phone numbers, amounts, duplicates) before an order is created. Validation and orchestration live in `src/server/services/business.service.ts`.

3. **Single Paystack charge per order.** A bulk order is charged **once** via Paystack for the aggregate amount, rather than charging per recipient. This keeps reconciliation simple and reduces Paystack transaction fees and failure surface.

4. **PDF invoices.** Each completed order generates a PDF invoice suitable for corporate finance workflows, including line items for recipients and the aggregate charge.

5. **Dedicated account manager.** Business accounts are assigned an account manager, surfaced in the account settings and used as the escalation contact for support.

## Consequences

### Positive

- **New revenue stream.** Opens the platform to corporate gifting, a higher-value segment than individual consumers.
- **Efficient bulk gifting.** A single order can reach up to 500 recipients, dramatically reducing the effort versus individual purchases.
- **Reuses existing infrastructure.** Building on `users`, the wallet, and Paystack avoids a parallel product and keeps maintenance cost low.
- **Better reconciliation for customers.** One charge and one invoice per order matches how corporate finance teams operate.

### Negative

- **Larger blast radius for payment failures.** Because a single charge covers up to 500 recipients, a payment or fulfillment failure affects the whole order at once. We mitigate this with idempotent order processing, clear failure states, and the ability to retry or partially fulfill.
- **CSV validation complexity.** Robust validation (malformed rows, invalid phone numbers, duplicate recipients, amount limits, row count caps) is non-trivial and must be well-tested to avoid partial or incorrect orders.
- **Mixed concerns on `users`.** Business-specific fields and behavior now live alongside consumer data, requiring care to avoid leaking business logic into consumer paths.

## Alternatives Considered

1. **Separate `businesses` entity table.** A dedicated table (with its own auth, wallet, and relationships) would give cleaner separation. Rejected because it duplicates authentication, wallet, and payment logic, and increases the surface area for bugs and maintenance. The `account_type` flag achieves the needed separation with far less complexity.

2. **Per-recipient charges.** Charging Paystack once per recipient would simplify partial-failure handling but multiplies transaction fees, complicates reconciliation, and produces many small charges that corporate finance teams dislike. Rejected in favor of a single aggregate charge per order.

3. **Manual concierge processing.** Handling bulk gifting manually (ops team processes CSVs by hand) would ship faster but does not scale, offers no self-service, and creates operational risk. Rejected as a long-term solution; the automated CSV flow is the chosen approach.

## References

- `src/server/services/business.service.ts` — bulk order orchestration and CSV validation.
- `migrations/0009_business_accounts.sql` — `account_type` column and related schema.
- [ADR-0003: Paystack Integration](./0003-paystack-integration.md) — payment provider decisions.