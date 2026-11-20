# Pull Request

## Description

<!-- Describe the change and its motivation. Link related issues. -->

Fixes #

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Refactor / chore
- [ ] Security fix

## How Has This Been Tested?

<!-- Describe the tests you ran and how to reproduce them. -->

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing

## Checklist

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes

## Security: IDOR (Insecure Direct Object Reference) Review

> **Required for any PR that adds or modifies a resource endpoint** (any route that
> reads, updates, or deletes a resource by ID). Complete this section before merge.
> If this PR does not touch resource endpoints, check the box below and skip the rest.

- [ ] This PR does **not** add or modify any resource endpoint (skip the checklist below)

### Ownership Enforcement Checklist

For **each** new or modified resource endpoint, confirm:

- [ ] The endpoint enforces ownership: the authenticated user must own (or be
      explicitly authorized for) the resource being accessed.
- [ ] Ownership is checked **server-side** against the authenticated session/user,
      never trusted from client-supplied input (e.g. `userId` in body/query).
- [ ] Accessing another user's resource returns **`403 Forbidden`** (not `200`,
      not `404` leaking existence, unless intentionally chosen and documented).
- [ ] The check applies to **all** HTTP methods exposed for the resource
      (`GET`, `PATCH`, `PUT`, `DELETE`, etc.), not just the primary one.
- [ ] List/collection endpoints filter results to the authenticated user's
      resources only.
- [ ] Nested/related resources (e.g. items within a wishlist, messages within a
      support case) also enforce ownership of the parent resource.
- [ ] Notifications: mark-read / update / delete operations verify the
      notification belongs to the authenticated user.

### Resources Covered by Ownership Enforcement

Confirm the checklist above was applied to any affected resources:

- [ ] Gifts (`GET` / `PATCH` / `DELETE` by ID)
- [ ] Wishlists (`GET` / `PATCH` / `DELETE` by ID)
- [ ] Occasions (`GET` / `PATCH` / `DELETE` by ID)
- [ ] Support cases (`GET` / `PATCH` / `DELETE` by ID)
- [ ] Notifications (mark-read / update / delete)
- [ ] Other: <!-- list any additional resource endpoints -->

### Regression Tests

- [ ] I have added or updated IDOR regression tests in
      `src/server/__tests__/idor-regressions.test.ts` covering user A accessing
      user B's resource and asserting `403 Forbidden`.
- [ ] Tests run in CI on every PR.

## Screenshots (if applicable)

<!-- Add screenshots to help explain your change. -->

## Additional Notes

<!-- Anything else reviewers should know. -->