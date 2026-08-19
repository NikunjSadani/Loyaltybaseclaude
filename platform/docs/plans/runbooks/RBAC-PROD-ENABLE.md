# RBAC Option-X — PROD ENABLE runbook (owner-gated; execute nothing without explicit go)

**Status (2026-08-19): ✅ §1 CUTOVER #32 DONE — RBAC P0–P6 + outlet-wallet are LIVE IN PROD (`12fc22a`, `gifsy-migrate-xqtd2` applied the 3 migrations, both services verified, `/health/ready` 200), ALL DORMANT.** REMAINING (owner, in the prod console): §2 seed roles (or use the built-in Ops/PM) + **§3 create the 2 staff + assign brand grants** — that turns access on — then §4 the prod isolation walk. RBAC P0–P6 done + DUAL-audited + staging-verified. Detail: memory `[[rbac-option-x-staff]]`.

> **Key fact:** GIFSY_STAFF enforcement is **always-on / fail-closed** — there is NO feature flag
> to flip. "Enabling RBAC in prod" = **(1)** the RBAC tables reach prod (via the cutover
> migrations), **(2)** the owner creates the seed roles + the actual staff, AND **(3)** the owner
> assigns each staff the **brand(s) they may work in** (P5 tenant grants). Until a staff row + a
> grant exist, the feature is inert AND deny-by-default (an un-granted staff can operate on
> nothing). **Reversible** = deactivate the staff OR revoke a brand grant (both cut the staff's
> live sessions immediately), and/or delete the roles.

---

## 0. Preconditions (all ✅ as of 2026-08-19)
- develop HEAD `b6f86bb` carries RBAC P0–P6 + all security fixes + the outlet-wallet bundle.
- Gates green on develop: api jest 2482 · nest 0 · FE tsc 0 · FE vitest 2201.
- P4 walk 58/58; P5 isolation walk 23/23; P6 /me contract 10/10; dual auth audit + cross-tenant
  write-sweep + P6 UI/UX audit = CLEAN (all findings fixed + re-verified). No open BLOCKING
  decisions — D-B4 resolved by P5; P6 adds the clear "no permission" messaging.
- P6 nav-volume decision RESOLVED (owner): keep show + explain (nav all visible; clear message
  on the ones a staff lacks) — no hiding, no seed-role broadening. Deferred: D-B2 (tenancy:write
  overloading), write-sweep LOW-1 self-guarding `where`.

---

## 1. Cutover #32 — ship code + migrations to prod  *(owner-gated: merges develop→main)*
This is the normal prod cutover; it carries the additive+dormant bundles together:
(A) RBAC P0–P6, (B) outlet-wallet + money-hardening, and the RBAC migrations.

1. Owner gives explicit go to merge `develop` → `main`.
2. Merge; CI runs the FULL suite (a red suite silently SKIPS deploy via `needs: test` — confirm green).
3. Prod migrate job applies the 3 additive migrations:
   - `20260818120000_gifsy_staff_role` (enum `GIFSY_STAFF` + `users.gifsyRoleId`)
   - `20260818120100_gifsy_roles` (`gifsy_roles` table + FK)
   - `20260819120000_gifsy_staff_tenant_grants` (`gifsy_staff_tenant_grants` table + FK — P5)
   These CREATE empty tables/columns — **no data change, no behavior change** (no staff exist).
4. Verify prod serving SHA on BOTH services + `/health/ready` db:up + the migrate job SUCCEEDED.
   `gcloud run services describe gifsy-api|gifsy-frontend --region asia-south1 --project gifsy-platform --format='value(spec.template.spec.containers[0].image)'`
5. **STOP.** At this point RBAC is in prod but 100% dormant. No staff, no exposure. Ship-and-hold is safe.

> Rollback for #1: standard cutover rollback to the prior prod SHA. The additive migrations are
> forward-safe (empty tables); no down-migration needed to keep prod healthy.

---

## 2. Seed the two system roles in prod  *(owner-gated; reversible)*
Creates the Ops + Project Manager `gifsy_roles` rows (isSystem). Two options:
- **Preferred (real seed):** run `api/prisma/seed-gifsy-roles.ts` against prod via the in-VPC
  `gifsy-oneoff` / migrate job pattern (private-IP; guard `current_database()==='gifsy_prod'` FIRST;
  show SQL; backup confirmed; WAIT for owner) — upserts by (clientId,name), idempotent.
- **Alternative (API):** owner logs into the prod operator console and creates the roles via the
  `/gifsy/roles` editor. Slower but no DB op.
- The role permission sets come from `api/src/common/rbac/gifsy-seed-roles.ts` (Ops + Project
  Manager, unchanged — P5 handles the tenant axis, so no D-B4 permission edit is needed). The owner
  can tailor them or add a custom role in the `/gifsy/roles` editor at any time.
- Verify: `GET /v1/gifsy/roles` (owner) lists Ops + Project Manager with the expected permissions.

## 3. Create the 2 staff + assign their brand grants  *(owner-gated; reversible; staff first exist here)*
- Owner creates each staff via the prod operator console `/gifsy/staff` (or `POST /v1/gifsy/staff`):
  name + 10-digit phone + assigned role + **"assumable brands"** (the P5 tenant grants — e.g. both
  `deoleo` and `bajaj`). Role pinned to GIFSY_STAFF, clientId 'gifsy' by the service.
- **Prod uses REAL OTP** — each staff logs in with an OTP to their own phone (no FIXED_OTP in prod).
  They then land on the `/gifsy` launchpad and pick a granted brand to work in (assume).
- Deny-by-default: a staff with NO brand grant can operate on nothing. Reserved permissions are
  granted only via the conscious Lock-1 ack (seed roles carry none).
- Bajaj (onboards ~2026-09-02): grant it to the staff the day it's ACTIVE/ONBOARDING (ONBOARDING is
  assumable, so grants can be pre-assigned before go-live).

## 4. Per-role + isolation real-login verification IN PROD  *(do before trusting the rollout)*
Mirror the staging walks (`scratchpad/p4_walk.py` + `p5_isolation.py`) but against prod with REAL OTP:
- Each staff logs in; assumes a granted brand → confirm granted reads → 200, non-granted/reserved/
  staff-mgmt → 403; assume a NON-granted brand → 403.
- Confirm deny-by-default (un-assumed staff sees no tenant data) + assumed read scoped to the brand.
- Confirm the P4/P5 fixes hold in prod: a staff can't mutate an operator row (403); deactivating a
  staff OR revoking a brand grant cuts their session (refresh → 401).

---

## 5. Rollback / kill-switch (fast, reversible)
- **Disable one staff:** owner sets the staff status INACTIVE (or deletes) via `/gifsy/staff` →
  session is cut immediately (P4 fix: deactivate/delete revokes sessions on the general path too).
- **Disable everyone:** deactivate all staff rows; the feature is inert again (enforcement is
  always-on but has no staff to act on). Optionally delete the roles.
- **Nuclear:** `POST /v1/admin/force-logout-all` (owner-only) cuts every session platform-wide.
- The RBAC tables/columns remain (additive) — harmless when empty.

---

## Open items (NONE block the enable)
- **D-B4 — RESOLVED by P5.** Staff work per-brand by ASSUMING a granted tenant (the previously-inert
  writes work once assumed); no seed-role permission edit needed. Deny-by-default + per-staff grants.
- **(P6, recommended follow-up) permission-aware admin nav for staff** — an assumed staff currently
  sees the operator nav with unpermitted items returning a backend 403 (safe, backend-enforced; same
  posture the whole nav already carries). Build per-item nav-hiding driven by the staff's permissions.
- **M3 (minor) — RESOLVED (#34):** verified P6 `AdminRouteGuard` renders AccessDenied (no crash) for a
  limited assumed staff on `/admin/dashboard`; no code change needed.
- **D-B2 — ✅ DONE (cutover #34, `f578b6e`, 2026-08-19):** conversion-rate/points-expiry/`wallet-settings`
  money writes now require the new reserved `tenancy:write_finance`, split off `tenancy:write`.
- **write-sweep LOW-1 — ✅ DONE (#34):** `gifsy-roles.deleteRole` self-guards `where:{id,clientId}`.
- **Four-eyes / maker-checker on credit-batch confirm — POST-STAFF item (needs ≥2 distinct Gifsy operators;
  owner deferred 2026-08-19).** `creditsPayouts.fourEyesEnabled` persists (round-tripped, no UI toggle) but is
  intentionally NOT enforced (`credits.service` `createBatch`/`confirmBatch`). A real second-approver gate is
  unsatisfiable with one Gifsy account → blocked on RBAC staff existing. When staff exist AND the owner wants it:
  enforce on confirm (maker ≠ checker; checker holds `credits:confirm_payout`) + add the Settings toggle + an
  approve step + audit. Money path → DUAL adversarial audit.
