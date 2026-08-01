# RBAC Workstream Completion — end-to-end plan (zero-bug bar)

**Goal:** finish the fine-grained-permission (`@RequirePermission`) layer so it can be safely ENABLED —
without 403'ing a single legitimate user. Owner-requested (2026-08-01). PLAN — awaiting approval + the
Phase-0 decisions before any build.

## Where it stands (from the survey)
- **Engine + guard + decorator are BUILT** (`common/rbac/can.ts`, `permissions.ts`, `guards/permission.guard.ts`,
  `decorators/require-permission.decorator.ts`). 69 permission keys, per-role default map, global guard.
- **Enforcement is OFF at both levels** — env `RBAC_ENFORCEMENT` unset AND per-tenant `features.rbacEnforcement`
  defaults false. Guard is a complete no-op today (AND of both flags).
- **THREE real gaps block a safe enable:**
  1. **🔴 Coverage mismatch (the big one).** `DEFAULT_ROLE_PERMISSIONS` gives SALES = `visibility:read/write` only,
     and PARTNER = `[]` (empty) — by original design ("sales/partner are governed by proxy routing + hierarchy
     scoping, not the permission catalog"). BUT their routes carry `@RequirePermission` keys they don't hold. So
     flipping enforcement on today **403s the ENTIRE sales portal and the ENTIRE partner portal** (wallet, rewards,
     leaderboard, targets, scheme-enrollment, sales KYC approve/reject). Plus scattered admin mismatches
     (`task-config` sales read, `tickets` MIS setStatus) and ∅Roles+permission latent gaps.
  2. **No override storage.** Engine accepts a per-tenant `TenantRoleOverrides` map, but nothing supplies it — the
     guard calls `can(role, perm)` with NO overrides, so it can only ever evaluate the hardcoded defaults. No
     `Client.rolePermissions` column, no admin UI.
  3. **Zero test coverage** of `can()`/`permissionsForRole()`/the guard. The one adjacent test is the tenant-flag read.
- **Cache trap:** `rbacEnforcement` is read via the 5-min-cached `resolveClient`, so a toggle takes up to 5 min to
  take effect per instance — wrong for an enable/kill control (contrast `resolveVisibilityEnabled`, uncached).

---

## PHASE 0 — DESIGN LOCK (owner decisions — needed before build)

**D1 — Scope of enforcement: which portals does RBAC layer 2 gate?**
The coverage mismatch exists because sales/partner routes carry `@RequirePermission` but those roles were
deliberately given minimal defaults. Two coherent resolutions:
- **D1-a (RECOMMENDED): admin-portal granularity only.** RBAC layer 2 governs the ADMIN roles
  (GIFSY_ADMIN / CLIENT_ADMIN / MIS_USER) — the case where fine-grained "view-but-not-approve" actually matters.
  Sales/partner access stays governed by portal routing + hierarchy scoping (as designed). Implementation: GRANT
  sales/partner the permission keys their own routes need (enrich the defaults so enforcement is a no-op for them),
  OR drop `@RequirePermission` from the pure sales/partner routes. Either way enforcement never bites a legit
  sales/partner user; it only adds granularity among admin staff.
- **D1-b: full permission model for every portal.** Sales/partner get proper, curated permission sets and the
  matrix is driven to zero mismatches for all 11 roles. More work, more surface, more 403-risk — only worth it if
  you foresee restricting sales/partner *by permission* (not just by hierarchy).

**D2 — Per-tenant customization: do we build the override storage + admin UI now?**
- **D2-a (RECOMMENDED for a single tenant): defaults-only enforcement now; override layer LATER.** Fix + enforce
  the DEFAULT map (correct for every role), skip the per-tenant editor until a tenant actually needs a custom grant.
  Smaller, safer, still delivers "enforce fine-grained permissions."
- **D2-b: full flexibility now.** Build `Client.rolePermissions` storage + wire into the guard + a GIFSY-only
  permissions-matrix admin UI. This is the "complete the workstream" maximal scope.

**D3 — Rollout:** enable per-tenant (behind `features.rbacEnforcement`, reversible) after the env master is on, and
gate the prod enable on you. Make the flag read UNCACHED (kill-switch semantics) so on/off is instant.

> My recommendation: **D1-a + D2-a first** (correct + enforce defaults for the admin portal, sales/partner exempted-
> by-grant, tests + staging per-role verify, reversible enable), then **D2-b (override UI) as a fast-follow** if you
> want per-tenant custom grants. This gets real enforcement live with the least 403-risk; the override editor is
> additive on top. But if "complete" means the whole thing in one go, the plan below covers D1-b + D2-b too.

---

## BUILD PHASES (orchestrated; each = gate + independent audit + staging-verify)

**P1 — Coverage fix + engine truth-table tests (the zero-bug core).**
- Produce the authoritative **route × role × required-permission matrix** (every `@RequirePermission` + its `@Roles`),
  driven to ZERO 🚩 mismatches per the D1 decision (grant the missing keys in `DEFAULT_ROLE_PERMISSIONS`, and/or
  narrow keys / add `@Roles` on ∅Roles routes).
- Resolve the ∅Roles+permission latent gaps (`admin-programs/visibility records`, `schemes` list reads, `kyc`
  initiate rows, `tickets` read/write) — add explicit `@Roles` so intent is unambiguous.
- Add `can.spec.ts` asserting the EXACT permission set per role, and lock the matrix as a test fixture so any future
  route/role/permission drift fails a test (not a prod 403).

**P2 — Guard hardening + (if D2-b) override loading.**
- `permission.guard.spec.ts` covering all four branches (no-decorator, master-off, tenant-off/fail-open, has/lacks).
- Make the per-tenant `rbacEnforcement` read UNCACHED (mirror `resolveVisibilityEnabled`) so enable/kill is instant.
- **(D2-b only)** add `Client.rolePermissions` JSON (additive migration) + load it in the guard → `can(role, perm,
  overrides)`; validate override shape; cache-safe.

**P3 — (D2-b only) Admin UI: GIFSY-only permissions-matrix editor** (role × permission checkboxes per tenant) +
surface the per-tenant `rbacEnforcement` enable toggle. Writes `Client.rolePermissions` + busts cache.

**P4 — FE permission-awareness (optional but recommended to avoid FE/BE drift).**
Today the FE gates nav/actions on ROLE + feature-flags, not permissions. When enforcement is on, the FE would still
render actions the BE now 403s. Teach the FE the effective permission set (from `/me`) and hide/disable actions the
user lacks — so the UX matches the enforcement.

**P5 — Enablement + per-role staging runtime-verify (the proof).**
- Flip env `RBAC_ENFORCEMENT=true` on STAGING + `features.rbacEnforcement=true` for a test tenant.
- Walk the FULL matrix per role (real login per role): every legit flow must still work (0 unexpected 403), every
  genuinely-unauthorized call must 403. This is the go/no-go — a per-role e2e so nothing reaches prod unproven.
- Then owner-gated PROD enable behind the per-tenant flag (start with one tenant, reversible instantly).

## Verification bar (owner will not re-test)
Full gate + INDEPENDENT adversarial audit each phase; P1 matrix locked as a test; P5 = real-login-per-role staging
walk of every 🚩 route. Nothing enabled in prod until the staging per-role walk is 100% clean.

## Effort (rough, orchestrated)
- **D1-a + D2-a path:** P1 (coverage+tests) ~1–1.5 days · P2 (guard tests + uncached flag) ~0.5 day · P4 (FE, optional)
  ~0.5–1 day · P5 (staging per-role verify) ~0.5 day → **~2.5–3.5 days**, reversible enable.
- **+ D2-b (override storage + admin UI):** add ~1.5–2 days (migration + guard wiring + matrix UI + audit).
- Additive + DORMANT until enabled; zero impact on live Deoleo while building (guard stays a no-op with the env off).
