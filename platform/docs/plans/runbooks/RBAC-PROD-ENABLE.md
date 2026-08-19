# RBAC Option-X — PROD ENABLE runbook (owner-gated; execute nothing without explicit go)

**Status:** DRAFT for owner review (2026-08-19). Nothing here runs until the owner explicitly
authorizes each irreversible step. RBAC P0–P4-verify are done + verified on staging; ALL DORMANT
(no `GIFSY_STAFF` exists in prod). Detail: memory `[[rbac-option-x-staff]]`.

> **Key fact:** GIFSY_STAFF permission enforcement is **always-on / fail-closed** — there is NO
> feature flag to flip. "Enabling RBAC in prod" therefore = **(1)** the RBAC tables reach prod (via
> the cutover migrations) and **(2)** the owner creates the seed roles + actual staff. Until a staff
> row exists, the whole feature is inert. **Reversible** = deactivate/delete the staff (session cut
> immediately per the P4 fix) and/or delete the roles.

---

## 0. Preconditions (all ✅ as of 2026-08-19)
- develop HEAD carries RBAC P0–P3 + the P4 security fixes (`4d662ce`) + the outlet-wallet bundle.
- Gates green on develop: api jest 2465 · nest 0 · FE tsc 0 · FE vitest 2174.
- P4 staging walk 58/58; dual auth audit's CRITICAL + HIGH both fixed + runtime-verified (18/18).
- **OPEN — owner decision D-B4** (seed-role write-perm completeness) must be resolved FIRST, because
  it changes which permissions the seed roles carry (see §3). D-B2 (tenancy:write money overloading)
  is optional/deferrable (reserved + dormant).

---

## 1. Cutover #32 — ship code + migrations to prod  *(owner-gated: merges develop→main)*
This is the normal prod cutover; it carries THREE additive+dormant bundles together:
(A) RBAC P0–P3 + P4 fixes, (B) outlet-wallet + money-hardening, and the two RBAC migrations.

1. Owner gives explicit go to merge `develop` → `main`.
2. Merge; CI runs the FULL suite (a red suite silently SKIPS deploy via `needs: test` — confirm green).
3. Prod migrate job applies the 2 additive migrations:
   - `20260818120000_gifsy_staff_role` (enum `GIFSY_STAFF` + `users.gifsyRoleId`)
   - `20260818120100_gifsy_roles` (`gifsy_roles` table + FK)
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
- The role permission sets come from `api/src/common/rbac/gifsy-seed-roles.ts` — **adjusted per the
  D-B4 decision** (widen / trim / document). Do NOT seed until D-B4 is locked.
- Verify: `GET /v1/gifsy/roles` (owner) lists Ops + Project Manager with the expected permissions.

## 3. Create the actual staff  *(owner-gated; reversible; THIS is where staff first exist)*
- Owner creates each staff via the prod operator console `/gifsy/staff` (or `POST /v1/gifsy/staff`):
  name + 10-digit phone + assigned role. Role pinned to GIFSY_STAFF, clientId 'gifsy' by the service.
- **Prod uses REAL OTP** — each staff logs in with an OTP to their own phone (no FIXED_OTP in prod).
- Reserved permissions: only granted if the owner consciously acknowledges (Lock-1). Seed roles carry none.

## 4. Per-role real-login verification IN PROD  *(do before trusting the rollout)*
Mirror the staging walk (`scratchpad/p4_walk.py`) but against prod with REAL OTP logins:
- Each staff logs in; confirm granted reads → 200, non-granted/reserved/staff-mgmt → 403.
- Confirm platform-wide reads match the owner (not zeroed).
- Confirm the P4 fixes hold in prod: a staff cannot mutate an operator row (403); deactivating a
  staff cuts their session (refresh → 401).
- Spot-check the D-B4-affected actions behave as decided.

---

## 5. Rollback / kill-switch (fast, reversible)
- **Disable one staff:** owner sets the staff status INACTIVE (or deletes) via `/gifsy/staff` →
  session is cut immediately (P4 fix: deactivate/delete revokes sessions on the general path too).
- **Disable everyone:** deactivate all staff rows; the feature is inert again (enforcement is
  always-on but has no staff to act on). Optionally delete the roles.
- **Nuclear:** `POST /v1/admin/force-logout-all` (owner-only) cuts every session platform-wide.
- The RBAC tables/columns remain (additive) — harmless when empty.

---

## Open decisions blocking a clean enable
- **D-B4 (blocks §2/§3):** seed-role write-perm completeness — widen safe operational writes
  (visibility approve/reject, scheme delete, invoice read) like KYC while KEEPING the rewards/money
  path owner-only, vs trim from seed roles, vs document as assume-tenant-only. Owner to choose.
- **D-B2 (optional):** split the cross-tenant conversion-rate/expiry writes out from `tenancy:write`
  into a finance/wallet reserved key. Reserved + dormant today → deferrable.
