# Incident Response Playbook

**Owner:** Engineering Lead
**Last reviewed:** 2025-01-01
**Review cadence:** Quarterly, or after any P0/P1 incident
**Status:** Active — Launch readiness gate M-3

---

## 1. Purpose & Scope

This playbook defines how the team detects, responds to, communicates about, and learns from incidents affecting the platform. It covers security incidents, payment failures, and service outages.

**Related documents:**
- Security-specific incident handling: [`docs/security/incident-response.md`](../security/incident-response.md)
- Operational runbooks and procedures: [`docs/ops/runbook.md`](./runbook.md)

If a security incident involves data breach, credential compromise, or contract exploit, follow **both** this playbook and the security incident response document. This playbook governs coordination and communication; the security document governs forensic and containment specifics.

---

## 2. Severity Levels

| Severity | Definition | Examples | Response Time Target | Update Cadence |
|----------|-----------|----------|----------------------|----------------|
| **P0 — Critical** | Complete outage, active data breach, funds at risk, or contract exploit in progress. Broad user impact. | DB down for all users; payment processing fully failing; smart contract exploit draining funds; production secrets leaked. | **Acknowledge ≤ 15 min**, all-hands page immediately | Every 15–30 min |
| **P1 — High** | Major functionality degraded or a subset of users blocked. Significant financial or security exposure but contained. | Payment provider degraded (some transactions failing); elevated error rates; single-region outage; suspected (unconfirmed) unauthorized access. | **Acknowledge ≤ 30 min** | Every 30–60 min |
| **P2 — Medium** | Partial degradation with a workaround, or limited user impact. No immediate financial/security risk. | Slow API responses; non-critical feature broken; single integration failing with fallback. | **Acknowledge ≤ 2 hours** (business hours) | Daily or at milestones |
| **P3 — Low** | Minor issue, cosmetic, or single-user impact. No workaround needed for most users. | UI glitch; isolated support ticket; non-urgent bug. | **Acknowledge ≤ 1 business day** | As needed |

**Escalation rule:** When in doubt, declare one severity higher. It is cheap to downgrade and expensive to under-react.

**Timing:** Response-time targets are measured from the moment an alert fires or a report is received. "Acknowledge" means a responder has claimed the incident and posted an initial status update.

---

## 3. Roles (RACI)

Every P0/P1 incident must have these roles filled. One person may hold multiple roles for P2/P3 or small teams, but **the Incident Commander must never also be the Tech Lead** on a P0/P1.

| Activity | Incident Commander (IC) | Comms Lead | Tech Lead | Engineering Lead |
|----------|------------------------|------------|-----------|------------------|
| Declare incident & assign severity | **A/R** | C | C | I |
| Coordinate response & run the incident channel | **A/R** | I | C | I |
| Technical diagnosis & remediation | C | I | **A/R** | I |
| Internal status updates | A | **R** | C | I |
| External/user-facing communication | A | **R** | C | C |
| Engage vendors (Paystack, Stripe, cloud provider) | A | I | **R** | I |
| Decide on rollback / failover | A | I | **R** | C |
| Post-mortem scheduling & ownership | **A/R** | C | C | I |
| Sign-off on post-mortem | C | C | C | **A** |

**R** = Responsible, **A** = Accountable, **C** = Consulted, **I** = Informed.

### Role definitions

- **Incident Commander (IC):** Single point of authority during the incident. Declares severity, assigns roles, runs the incident channel, makes the final call on trade-offs (e.g., rollback vs. hotfix), and ensures communication cadence is met. Does **not** debug directly on P0/P1 — stays at the coordination level.
- **Comms Lead:** Owns all internal and external communication. Drafts and posts status updates, updates the status page, handles support macros, and coordinates with any customer-facing teams. Ensures the IC approves external messaging.
- **Tech Lead:** Owns technical diagnosis and remediation. Directs engineers, decides on mitigation steps, engages vendors, and reports findings and ETAs back to the IC.
- **Engineering Lead:** Accountable for post-mortem sign-off and follow-up action tracking. Escalation point for resourcing.

---

## 4. Initial Response Steps

Follow these steps in order. On P0, steps 2–5 may overlap.

### Step 1 — Detect
- Alerts fire via monitoring, or a report arrives via support, on-call, or a team member.
- The first responder acknowledges the alert in the on-call tooling to stop escalation.

### Step 2 — Triage
- Assess impact: Who is affected? How many users? Is money or data at risk? Is it ongoing?
- Assign a provisional severity using Section 2.
- If it looks like a security incident or contract exploit, **also** open the security incident process in [`docs/security/incident-response.md`](../security/incident-response.md) immediately.

### Step 3 — Declare
- Open an incident channel (e.g., `#incident-YYYYMMDD-<short-name>`).
- Post the declaration using the template in Section 5.1.
- Assign the IC, Comms Lead, and Tech Lead. If you are the first responder and no IC is present, you are the IC until you hand off explicitly.
- Page additional responders per severity.

### Step 4 — Contain
- Stop the bleeding before root-causing: roll back, disable the affected feature, fail over, rotate credentials, or pause contract interactions as appropriate.
- Preserve evidence (logs, snapshots) before destructive remediation, especially for security incidents.
- See scenario runbooks in Section 7.

### Step 5 — Communicate
- Comms Lead posts the first internal status update within the severity's response-time target.
- For P0/P1 with user impact, publish a status page update (Section 5.2).
- Maintain the update cadence from Section 2 until resolved.

### Step 6 — Resolve
- Confirm the fix with monitoring and, where possible, a user-facing verification.
- Announce resolution internally and externally.
- Downgrade or close the incident; keep the channel open for the post-mortem.
- Schedule the post-mortem (Section 6) within 5 business days for P0/P1.

---

## 5. Communication Templates

### 5.1 Internal status update (incident channel)

```
[STATUS UPDATE — <SEVERITY>] <Incident title>
Time: <HH:MM UTC>
Current status: Investigating | Identified | Monitoring | Resolved
Impact: <who/what is affected, scope>
What we know: <1–3 bullets>
What we're doing: <current mitigation actions>
Next update: <HH:MM UTC>
IC: <name> | Comms: <name> | Tech Lead: <name>
```

### 5.2 User-facing status page update

```
[<Investigating|Identified|Monitoring|Resolved>] <Short title>

We are currently <experiencing / investigating> <brief description of impact>.
<What customers may notice.>

We have identified the cause and are working on a fix. / We are investigating the cause.

We will provide another update by <HH:MM UTC>.
```

Keep it factual, free of internal jargon, and free of speculation about root cause or blame. Never include customer PII, credentials, or exploit details.

### 5.3 Post-incident summary (external / stakeholder)

```
Post-Incident Summary — <Incident title>

Incident date: <date>
Duration: <start> to <end> UTC (<total>)
Severity: <P0–P3>
Affected services: <list>

Summary:
<2–4 sentences describing what happened in plain language.>

Impact:
<Who was affected and how. Include any financial impact or data exposure if applicable.>

Root cause:
<One or two sentences. No blame.>

What we've done:
<Bullet list of remediation and preventive actions completed.>

What we're doing next:
<Bullet list of follow-up actions with target dates.>

We apologize for the disruption and are committed to preventing recurrence.
```

---

## 6. Post-Mortem Process

**Required for:** all P0 and P1 incidents. Recommended for P2.

**Timeline (5 business days):**

| Day | Milestone |
|-----|-----------|
| Day 0 | Incident resolved; post-mortem owner assigned by IC; doc created from template. |
| Day 1–2 | Timeline reconstructed from logs and channel history; contributing factors drafted. |
| Day 3 | Draft circulated to responders and stakeholders for comment. |
| Day 4 | Review meeting held; action items agreed with owners and due dates. |
| Day 5 | Final post-mortem signed off by Engineering Lead; action items filed as tracked tickets. |

**Blameless principle:** Post-mortems focus on systems, processes, and conditions — never on individuals. People are not the root cause; the conditions that allowed an error to reach production are. Everyone is expected to speak candidly.

### 6.1 Post-mortem template

```
# Post-Mortem: <Incident title>

- **Date:** <date>
- **Severity:** <P0–P3>
- **Duration:** <start> to <end> UTC (<total>)
- **Author / Owner:** <name>
- **Incident Commander:** <name>
- **Status:** Draft | In review | Final

## Summary
<2–4 sentences: what happened, impact, and how it was resolved.>

## Impact
- Users affected: <number / scope>
- Financial impact: <amount or "none identified">
- Data / security impact: <describe or "none identified">
- Duration of user-facing impact: <duration>

## Timeline (UTC)
| Time | Event |
|------|-------|
| HH:MM | <first signal / alert> |
| HH:MM | <incident declared> |
| HH:MM | <key mitigation step> |
| HH:MM | <resolved> |

## Root Cause & Contributing Factors
<Describe the technical root cause and the contributing factors (process gaps, missing alerts, unclear ownership, etc.). Focus on systems, not people.>

## What Went Well
- <bullet>

## What Went Poorly
- <bullet>

## Action Items
| Action | Owner | Due date | Ticket |
|--------|-------|----------|--------|
| <action> | <name> | <date> | <link> |

## Lessons Learned
<Key takeaways to feed back into runbooks, monitoring, and this playbook.>
```

---

## 7. Scenario Runbooks

### 7.1 Database Down

**Symptoms:** Connection errors, elevated 5xx, health checks failing, replication lag alerts.

1. **Confirm scope:** Is it the primary, a replica, or the whole cluster? Check provider status page and monitoring dashboards.
2. **Declare** P0 if all writes/reads fail; P1 if degraded or failover is possible.
3. **Contain:**
   - If a recent deploy or migration is suspected, roll back immediately.
   - If the primary is unhealthy, initiate failover to a replica per [`docs/ops/runbook.md`](./runbook.md).
   - Enable read-only mode or a maintenance page if writes cannot be served.
4. **Preserve evidence:** Snapshot logs and metrics before restarting or failing over.
5. **Engage vendor** (cloud/DB provider) via support if infrastructure-side.
6. **Communicate** per Section 5; update status page for user-facing impact.
7. **Recover:** Verify replication health and data integrity after failover. Reconcile any writes lost during the outage.
8. **Resolve** and schedule post-mortem.

### 7.2 Payment Processing Failure (Paystack / Stripe)

**Symptoms:** Failed charges, webhook delivery failures, elevated payment error rates, reconciliation mismatches.

1. **Identify the provider and failure mode:** Is it Paystack, Stripe, or our integration? Check provider status pages and webhook delivery logs.
2. **Declare** P0 if all payments fail or funds are being misprocessed; P1 if a subset fails or a fallback exists.
3. **Contain:**
   - If a recent integration deploy is suspected, roll back.
   - If the provider is down, enable the documented fallback or queue retries; surface a clear message to users rather than silent failures.
   - **Do not** manually re-run charges without Tech Lead approval — risk of double-charging.
4. **Reconcile:** Identify transactions in an indeterminate state (charged-but-not-recorded or recorded-but-not-charged). Log them for follow-up.
5. **Engage vendor** via their support channel; capture ticket references.
6. **Communicate** per Section 5. For user-facing failures, state clearly whether users were charged and what happens next.
7. **Recover:** Replay queued webhooks idempotently; verify reconciliation against provider dashboards.
8. **Resolve** and schedule post-mortem; flag any customer refunds needed.

### 7.3 Smart Contract Exploit

**Symptoms:** Anomalous on-chain transactions, unexpected fund movement, exploit report, or monitoring alert on contract balances/events.

> This is a **security incident**. Follow this runbook **and** [`docs/security/incident-response.md`](../security/incident-response.md) in parallel.

1. **Declare P0 immediately.** Page the IC, Tech Lead, and security on-call.
2. **Contain (time-critical):**
   - If the contract has a pause/guardian mechanism, pause it per the documented procedure — only with IC + Tech Lead approval.
   - If upgradeable, prepare (but do not rush) a fix; coordinate with security review.
   - Revoke compromised keys/roles if key compromise is suspected.
3. **Preserve evidence:** Snapshot on-chain state, transaction hashes, and logs. Do not alter state unnecessarily.
4. **Assess exposure:** Quantify funds at risk and already moved. Identify affected users.
5. **Engage experts:** Security advisors, auditors, and (if funds are at risk) relevant authorities per the security document.
6. **Communicate:** Comms Lead drafts external messaging with IC approval. Be factual; avoid disclosing exploitable details publicly until contained.
7. **Recover:** Deploy fix after review, migrate funds if applicable, and coordinate any user remediation.
8. **Resolve** and run a post-mortem with security and legal input.

---

## 8. Team Acknowledgement

All team members must read this playbook and acknowledge it. Acknowledgement is tracked below and re-confirmed after each material revision.

| Name | Role | Acknowledged (date) |
|------|------|---------------------|
|      |      |                     |
|      |      |                     |
|      |      |                     |

**Process:** On hire and after each material revision, the Engineering Lead shares this document and records acknowledgement in the table above (or in the linked tracking issue). Launch readiness gate M-3 requires all current team members to be acknowledged.

---

## 9. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2025-01-01 | Engineering Lead | Initial version |