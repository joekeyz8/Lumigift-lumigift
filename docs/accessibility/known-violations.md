# Accessibility — WCAG 2.1 AA Audit Record

This document is the authoritative record of the WCAG 2.1 AA accessibility
audit for the project. It lists every known violation, its severity, the owner
responsible for remediation, the target date, and the status. It also documents
the audit methodology and the practitioner sign-off required by launch
readiness gate **M-4** (Issue #577).

> **Policy:** Any new critical or serious axe violation must either be fixed
> before merging, or documented here with a justification and a linked ticket.
> Violations with impact `moderate` or `minor` are logged but do not block CI.

---

## Audit Methodology

The audit combines automated tooling with manual testing. Automated checks
catch roughly 30–50% of WCAG issues; the manual passes cover the remainder.

### Automated (axe-core)

- **Component level:** `jest-axe` assertions run in the unit/component test
  suite (e.g. `accessibility.test.tsx`, `accessibility-routes.test.tsx`,
  `accessibility-all-routes.test.tsx`).
- **Full-page E2E:** `@axe-core/playwright` runs against every audited route in
  `e2e/accessibility-axe.spec.ts`.
- **CI:** both suites execute in `.github/workflows/accessibility.yml` on every
  pull request and on the default branch.
- **Rule tags:** the axe runs are configured with the tags `wcag2a`, `wcag2aa`,
  `wcag21a`, and `wcag21aa`, so only WCAG 2.1 A/AA rules are enforced.
- **Blocking threshold:** violations with impact `critical` or `serious` fail
  CI. `moderate`/`minor` violations are logged and tracked in the table below.

### Manual testing

- **Keyboard-only navigation:** every audited route is traversed using only
  `Tab`/`Shift+Tab`, `Enter`, `Space`, and arrow keys to verify focus order,
  visible focus indicators, and the absence of keyboard traps.
- **Screen reader spot checks:** representative flows (send, claim, login,
  notifications) are exercised with at least one desktop screen reader
  (NVDA on Windows / VoiceOver on macOS) to verify names, roles, states, and
  live-region announcements.
- **Colour-contrast sampling:** text and non-text contrast are sampled against
  the requirements in
  [a11y-localization-requirements.md](a11y-localization-requirements.md)
  (see `AC-CR-*` criteria) using browser devtools and a contrast analyser.

### Reporting

Each finding is recorded in the violations table with its WCAG 2.1 success
criterion, the affected component/file, a severity rating, the remediation
owner, a target date, and the tracking ticket/PR. When a violation is resolved
it is moved to the **Fixed violations** section with a link to the fixing PR.

---

## Open Violations

| ID    | WCAG 2.1 criterion | Component / file | Severity | Owner | Target date | Status | Linked PR / ticket |
| ----- | ------------------ | ---------------- | -------- | ----- | ----------- | ------ | ------------------ |
| V-001 | 4.1.2 Name, Role, Value | `src/components/gift/GiftCard.tsx` (`nested-interactive`) | serious | Gift team | 2026-06-30 | open | Fix ticket: refactor GiftCard navigation (see justification below) |

### V-001 — `nested-interactive` in GiftCard claim view

| Field         | Value                                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule ID       | `nested-interactive`                                                                                                                                                                                                                                                                                           |
| WCAG criterion| 4.1.2 Name, Role, Value                                                                                                                                                                                                                                                                                        |
| Impact        | serious                                                                                                                                                                                                                                                                                                        |
| Component     | `src/components/gift/GiftCard.tsx`                                                                                                                                                                                                                                                                             |
| Description   | `ClaimButton` (renders a `<button>`) is a child of `<article role="button">`, creating nested interactive elements. Screen readers may not announce the inner button correctly, and keyboard focus order can be confusing.                                                                                     |
| Justification | Pre-existing structural issue in the GiftCard component. The outer `role="button"` navigates to the gift detail page; the inner `ClaimButton` triggers the claim flow. These two interactions need to be separated (e.g. remove `role="button"` from the article and use a dedicated navigation link instead). |
| Accepted      | 2026-04-24                                                                                                                                                                                                                                                                                                     |
| Fix tracked   | Refactor GiftCard to use `<a>` or `<Link>` for navigation instead of `role="button"` on the article element.                                                                                                                                                                                                   |

---

## Fixed Violations

Resolved violations are moved here from the table above, with the fixing PR
linked. None recorded yet.

| ID | WCAG 2.1 criterion | Component / file | Severity | Fixed on | Linked PR |
| -- | ------------------ | ---------------- | -------- | -------- | --------- |
| —  | —                  | —                | —        | —        | —         |

---

## Route coverage (Issue #293)

The following routes are now audited automatically by jest-axe (component level)
and `@axe-core/playwright` (full-page E2E) in CI:

| Route                 | jest-axe file                       | Playwright spec                 |
| --------------------- | ----------------------------------- | ------------------------------- |
| `/`                   | `accessibility.test.tsx`            | `e2e/accessibility-axe.spec.ts` |
| `/send`               | `accessibility.test.tsx`            | `e2e/accessibility-axe.spec.ts` |
| `/dashboard`          | `accessibility.test.tsx`            | `e2e/accessibility-axe.spec.ts` |
| `/auth/login`         | `accessibility.test.tsx`            | `e2e/accessibility-axe.spec.ts` |
| `/auth/register`      | `accessibility-routes.test.tsx`     | `e2e/accessibility-axe.spec.ts` |
| `/help`               | `accessibility-routes.test.tsx`     | `e2e/accessibility-axe.spec.ts` |
| `/notifications`      | `accessibility-all-routes.test.tsx` | `e2e/accessibility-axe.spec.ts` |
| `/claim`              | `accessibility-all-routes.test.tsx` | `e2e/accessibility-axe.spec.ts` |
| Navbar                | `accessibility-routes.test.tsx`     | —                               |
| Button, Input, Dialog | `accessibility-routes.test.tsx`     | —                               |

_Added 2026-10-20 — Issue #293_

---

## Accessibility & Localization Requirements

Full testable requirements for contrast levels, assistive-technology targets,
supported languages, date formats, and translation key conventions are defined
in a separate document:

👉 **[a11y-localization-requirements.md](a11y-localization-requirements.md)**

That document supersedes any informal requirements previously described in this
file. When adding a new known violation, cross-reference the relevant
acceptance criteria from that requirements doc (e.g. `AC-CR-1`, `AC-AT-3`).

_Section added 2026-09-29 — Issue #155_

---

## Practitioner Sign-off

This audit record must be reviewed and signed off by a certified accessibility
practitioner before the M-4 launch gate can be considered satisfied.

| Field       | Value |
| ----------- | ----- |
| Reviewer    | _Pending — to be completed by a certified accessibility practitioner_ |
| Credentials | _e.g. IAAP CPACC / WAS_ |
| Review date | _YYYY-MM-DD_ |
| Scope       | WCAG 2.1 AA audit record, methodology, and open/fixed violation tracking |
| Outcome     | _Approved / Approved with conditions / Rejected_ |
| Notes       | _Any conditions or follow-ups_ |

_Sign-off block added for Issue #577 (M-4 launch gate)._
