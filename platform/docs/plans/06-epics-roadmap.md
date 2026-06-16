> ⚠️ **SUPERSEDED (2026-06-16) by [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md).** Historical roadmap. E1 (config-as-data)
> and E2 (RBAC engine) were **delivered in P1**; E3 (KYC tree) is partly in P1/P3. **Do not plan from this doc** —
> the phase plan + status live in `00-MASTER-PLAN.md`. Also note the model correction in
> [`MODEL-ALIGNMENT.md`](MODEL-ALIGNMENT.md) (parameter-based, program-segmented, no compute).

# Milestone E · Epics roadmap (plan before you task)

These four are **large features**, not bite-sized tasks. Each needs its own planning session to
break into Milestone-B-style tasks. They're sequenced by dependency. **Do not start one without
written sign-off on its design** — they touch the spine of the system.

Why they're here and not tasked yet: each changes data model + multiple contexts, carries
migration risk, and has open product decisions. Tasking them now would be guessing (violates the
"don't guess" rule).

---

## E1 · Config-as-data: a real `Client` model (Gaps #22, #18)

**Goal.** Move tenant config out of code (`CLIENT_REGISTRY`) and out of JSON blobs
(`ProgramSetting`) into a DB-backed, admin-managed model — so onboarding a tenant or flipping a
feature is data, not a redeploy.

**Why an epic.** New `Client`/`Tenant` table + FK from the `clientId` everywhere; a migration to
backfill from the registry; a decision *per domain* of blob-vs-relational (#18); a Gifsy admin UI.

**Rough phases.** (1) Introduce `Client` model + backfill, keep registry as read-through. (2) Move
feature flags to DB; registry becomes a cache/seed. (3) Per-domain: pick relational vs blob, migrate
the worst offenders (hierarchy, targets). (4) Admin UI to edit config.

**Prerequisites/risks.** Touches every tenant-scoped query; coordinate with Milestone D (isolation).
High migration risk — needs a backfill + rollback plan and a staging dry-run.

## E2 · Configurable admin RBAC (Gaps #2, #3)

**Goal.** Replace the fixed `UserRole` checks (admin side) with **tenant-defined roles** that have
**sections/features tagged** to them (Finance, HR, Reporting…). Sales stays hierarchy-scoped;
Partner stays own-data-only (see `spec/01` context #1).

**Why an epic.** Needs a **permission catalog** (the capability list in `spec/01` becomes the
permission set), `Role`/`Permission`/`RoleAssignment` tables, a server-side `can(user, feature)`
check used by every admin route + a UI gate, and a migration mapping current roles → new roles.

**Rough phases.** (1) Define the permission catalog (enumerate admin sections). (2) Data model +
`can()` helper (pure, unit-testable). (3) Enforce in admin routes (incremental, behind a flag).
(4) Admin UI to compose roles. **Depends on E1** (roles are tenant config).

## E3 · KYC routing via the real reporting tree (Gap #9)

**Goal.** Route first approval to the submitter's **direct reporting manager** via
`SalesUser.reportingToId`, escalating up when a manager is inactive; then Gifsy. Retire the flat
`ROLE_PHONES` table (`lib/sales-role.ts`) and the hardcoded SO→ASM→RSM chain.

**Why an epic (medium).** Changes `lib/kyc-approval.ts` + `initialKycStatus` to walk the tree,
needs an explicit `SalesUser.isActive` "inactive" signal (not blank phone), and a migration off
`ROLE_PHONES`. Logic is pure → **very testable** once designed.

**Rough phases.** (1) Pure `resolveApprover(tree, submitterId)` with escalation, fully unit-tested.
(2) Swap `initialKycStatus` to use it. (3) Remove `ROLE_PHONES`. **Smallest epic — good candidate
to do right after Milestones A–D.**

## E4 · Configurable activation enrollment forms (Gap #6)

**Goal.** Per-activation enrollment forms with **variable fields**, **self-vs-sales enrollment
mode**, and **conditional pre-fill** from the loyalty profile for KYC'd outlets.

**Why an epic.** `SchemeEnrollment` is currently just `(schemeId, userId, status)` — needs a
field-definition model, a captured-values store, pre-fill resolution, and per-activation mode
(today it's only a tenant-wide flag). Plus form-builder + form-render UI.

**Rough phases.** (1) Field-definition + submission-values data model. (2) Pure pre-fill +
validation logic (unit-tested). (3) Enrollment API. (4) Form-builder (admin) + form-render
(partner/sales) UI. **Depends on E1** (per-activation config lives in tenant config).

---

## Suggested overall order

**A → B → C → D → E3 (KYC tree) → E1 (config-as-data) → E2 (RBAC) → E4 (enrollment forms).**
Rationale: ship the user-visible fix (B) and money/security guards (C, D) first; do the small,
high-clarity epic (E3) next; then the foundational E1 that E2 and E4 depend on.

Each epic gets its own `docs/plans/` file when its design is signed off — written in the same
bite-sized, TDD, DRY/YAGNI style as Milestones A–D.
