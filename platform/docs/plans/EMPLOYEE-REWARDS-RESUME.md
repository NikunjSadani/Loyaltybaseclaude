# Employee Rewards — RESUME (post-compact restart brief)

> **Read this first for any employee-rewards build work** (the employee-rewards equivalent of
> [`RESUME.md`](./RESUME.md), which is the *trade* restart brief). Keep it current every wave.
> This is **state**; the authoritative *how/what* live in the doc set below.

## Current state (2026-10-03)
- **BUILD NOT STARTED.** Planning + documentation complete; all decisions locked; awaiting the owner's GO.
- **Foundation is LIVE in prod** (cutover #35, dormant): `Client.loyaltyType` + unified `RewardAccount`
  (OUTLET|EMPLOYEE) + dual-write + back-fill. Deoleo byte-identical. See [[employee-rewards-product]].
- **This is a SECOND product on the same platform/repo** — inherits Loyaltybase's engineering process
  in full, curates out trade product rules, adds the employee gate (see WAYS-OF-WORKING).

## The doc set (source of truth)
1. [`EMPLOYEE-REWARDS-DESIGN.md`](./EMPLOYEE-REWARDS-DESIGN.md) — earner model, `loyaltyType`, three surfaces.
2. [`EMPLOYEE-REWARDS-ADMIN-DESIGN.md`](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md) — the admin cockpit, module-by-module.
3. [`EMPLOYEE-REWARDS-BUILD-PLAN.md`](./EMPLOYEE-REWARDS-BUILD-PLAN.md) — execution, branching, safety gates, go-live, timeline.
4. [`EMPLOYEE-REWARDS-WAYS-OF-WORKING.md`](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md) — process/rules (inherit/adapt/exclude).
5. [`EMPLOYEE-REWARDS-UAT-CHECKLIST.md`](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md) — curated go-live acceptance.
6. Visual/UX target: `britannia-rewards-demo` (`docs/PROJECT-LOG.md`).

## Locked decisions (owner, 2026-10-02) — do not re-litigate
1. **Points crediting = BULK UPLOAD, NO compute engine** (reuse the no-compute credit-batch, keyed by
   `employeeCode` → `EMPLOYEE` RewardAccount). ⚠️ **NOT** the trade "Points Compute Engine" on `develop`.
2. **Target column = INCLUDE** (uploaded, display-only → achievement/"Potential").
3. **Roster = REUSE** the existing employee-hierarchy Excel upload + per-employee edit (`api/src/admin-core`).
4. **Admin operator = BOTH** (Gifsy central + Britannia scoped self-serve).
5. **Regional admin = REUSE** the existing `/sales/**` hierarchy scoping (subtree = `descendantSalesUserIds`).
6. **Field execution (POSM) = OUT** of pilot; opt-in later.

## ⚠️ Traps / rules specific to this build
- **Build in a dedicated git worktree** off `develop`, isolated from the **active trade Points Compute
  Engine** work (its own worktrees + uncommitted WIP live in the primary checkout — do NOT disturb them).
- **Additive + gated** only: everything behind the `loyaltyType` gate; migrations additive + backward-compatible.
- **DUAL audit** the credit/upload money boundary + redemption.
- **Cross-tenant isolation (Deoleo↔Britannia)** + a **Deoleo staging regression** are cutover gates.
- **Doc-consistency:** do NOT add "compute engine" to the global `RETIRED_TERMS` (it's live for trade) —
  annotate locally (WAYS-OF-WORKING §7).
- Gates (full, before every push): `cd api && npx jest --no-coverage` · `cd api && npx nest build` ·
  `cd platform && npx vitest run` · `cd platform && npx tsc --noEmit`.

## Open spec items (surfaced by the 2026-10-03 doc audit — specify before the named phase)
- **Phase 2 — EMPLOYEE owner-generalisation (NET-NEW, not reuse):** the `RewardAccount → SalesUser` profile
  relation does **not** exist in schema yet (`RewardAccount` has only `outletProfile ChannelPartner?`), and
  `ensureOutletAccount` is **OUTLET-only** today. Build the EMPLOYEE account keying + profile link + the
  "exactly one profile per `accountType`" DB constraint (the DESIGN §5.2 invariant is unenforceable until
  then). Grep **all ~7 `resolveActivePartnerId` consumers** (wallet, rewards, partner, schemes,
  scheme-enrollment, invoices, leaderboard) before landing.
- **Phase 2 — employee login identity:** `employeeCode` is the identity key, but how a roster employee
  acquires a **phone** for the (reused) phone-OTP login, and how `employeeCode ↔ phone` map, is not yet
  specified. One explicit line of design needed before Phase 2.
- **Phase C — contest bonus auto-credit:** the "validation rule → credits bonus" path is the vaguest
  money-adjacent spec (only "reframes scheme/campaign"). Give it a concrete data-model + validation spec
  before building (already flagged DUAL-audit).

## Next action (on owner GO)
Phase 0 (BUILD-PLAN §5): create the worktree + first `er/*` lane branch → scaffold the capability-gated
shell + `loyaltyType` flags → stand up the staging `uat-britannia` tenant (empty employee nav; Deoleo
nav unchanged). In parallel, the owner pre-stages external deps (DLT templates, Britannia roster + point
credits + catalogue, pilot vendors).

## Wave log (append as the build progresses)
- *(none yet — build not started)*
