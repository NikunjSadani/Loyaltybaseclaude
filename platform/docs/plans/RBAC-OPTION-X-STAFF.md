# RBAC Option-X — Gifsy staff roles + self-service role editor (Flavour B)

**Owner-locked 2026-08-18.** Adds a limited Gifsy-staff tier below the all-powerful Owner
(`GIFSY_ADMIN`), a self-service role editor, and a platform-only staff-management panel.
Additive + DORMANT until enforcement is explicitly enabled for the `gifsy` tenant — building
this changes nothing live. Builds on the existing (built-but-off) RBAC engine
(`api/src/common/rbac/*`, `guards/permission.guard.ts`). Supersedes the generic
`RBAC-COMPLETION-PLAN.md` for the Gifsy-staff use case.

## Owner decisions (locked)
- **Flavour B** — self-service role editor (owner creates/edits custom Gifsy roles in the UI).
- **Owner tier unchanged** — `GIFSY_ADMIN` = the single Owner account (prod: only `9830011252`) = ALL permissions. No guard sweep; can never be locked out.
- **Reserved set** = greyed in the editor by default AND grantable only through an explicit warning acknowledgement (safe default, owner can override per-role). **Once knowingly granted, a reserved permission is FULLY USABLE by that staff member** — the owner's decision (2026-08-18): the point of self-service delegation is that the owner *can* hand a sensitive power to a trusted staffer. No route-level owner-only hard-block (the earlier "Lock 2" was DROPPED — it would make the grant pointless).
- **Enforcement** — enabled for the `gifsy` operator only, behind a reversible, UNCACHED flag; staging per-role walk before any prod enable. Owner-gated for prod.
- **Seed roles** = Ops, Project Manager (below). Editable in-UI afterward.

## Architecture
- **`GIFSY_STAFF`** — one new `UserRole` enum value (additive migration). Staff accounts carry this coarse role; it grants NOTHING by default. Their real access = their assigned custom role.
- **`GifsyRole`** — new DB entity `{ id, clientId('gifsy'), name (unique per client), description?, permissions String[] (Postgres `text[]`), isSystem Boolean, createdAt, updatedAt, deletedAt? }`. The custom roles (Ops, PM, + any the owner creates). `isSystem` marks the seeded ones (can be edited, not deleted). ✅ P0 BUILT (uncommitted working tree): schema + 2 additive migrations (`20260818120000_gifsy_staff_role` enum-only, `20260818120100_gifsy_roles` table+FK), `gifsy-role.service.ts` resolver (30s cache, fail-closed), `permission.guard.ts` GIFSY_STAFF branch, `reserved-permissions.ts` (18 keys), seed (Ops/PM `isSystem`), `gifsyRoleId` on JWT. Gates green (api jest 2404, nest build 0); enforcement still no-op.
- **`users.gifsyRoleId`** — nullable FK → the staff member's assigned `GifsyRole`.
- **Resolution** — effective permissions of a `GIFSY_STAFF` user = their `GifsyRole.permissions`, resolved PER-REQUEST (so a role edit takes effect immediately; removing/deactivating a staff member is instant). `GIFSY_ADMIN` = ALL (unchanged). Other roles unchanged.
  - Implement as an extension of `PermissionGuard`: when `role === 'GIFSY_STAFF'`, load the user's `GifsyRole` (short in-proc cache keyed by roleId, TTL ~30s) and check membership; else fall back to the existing `can(role, perm)`.
- **⚠️ GIFSY_STAFF enforcement is ALWAYS ON (fail-closed), independent of the global `RBAC_ENFORCEMENT` / `features.rbacEnforcement` flag.** The global flag exists only to avoid mass-403'ing the LEGACY roles (sales/partner/etc.) on routes whose `@RequirePermission` coverage isn't yet complete — it governs THOSE roles. `GIFSY_STAFF` is a brand-new role with zero legacy routes, so enforcing its permissions from day one carries no regression risk. This is REQUIRED for safety once Lock 2 is dropped (below): a reserved route now admits `GIFSY_STAFF` at `@Roles`, so if the staff permission check were flag-gated-off, a staff member would hit that money route UNCHECKED while the flag is off. Always-on staff enforcement closes that hole. (Safe during dormancy because NO `GIFSY_STAFF` users exist until the owner creates them.) **This refines the P0 guard branch (currently written as "only reached when enforcement active") — P1/P2 must make the GIFSY_STAFF branch unconditional.**
- **Gating model (post-Lock-2-drop):** every route keeps its coarse `@Roles`. Routes Ops/PM need — INCLUDING reserved ones the owner may delegate (wallet:adjust, money execution, etc.) — get `GIFSY_STAFF` ADDED to `@Roles` + the correct `@RequirePermission`. The **`@RequirePermission` check (always-on for staff) is the real gate**: a staff member reaches the action iff their role holds that key. `@Roles` is just the coarse floor admitting the role class. Owner (`GIFSY_ADMIN`) short-circuits to allow everywhere. (Staff/role-MANAGEMENT routes themselves — `/v1/gifsy/roles`, `/v1/gifsy/staff` — stay `@Roles('GIFSY_ADMIN')` owner-only, since `users:manage_roles` is who-can-create-staff and is not something staff self-administer.)

## Seed roles (editable in-UI)
**Ops** — KYC review · visibility · employees · outlets · schemes · tickets
`kyc:read/approve/reject/gifsy_approve/view_documents`, `visibility:read/write/approve/reject/view_fraud_log`,
`sales_org:read/write/manage_hierarchy/manage_tasks`, `partners:read/write/delete/manage_outlets`,
`schemes:read/write/delete/manage_enrollments/export`, `targets:read/write/upload/manage_config`,
`support:read/write/escalate/manage`

**Project Manager** — Ops + finance-view + dashboards/reports + gift catalogue
= all of Ops, plus `credits:read`, `payouts:read`, `payouts:view_tds`, `invoices:read`,
`reports:read/export`, `rewards:read/write/manage_inventory/manage_orders`

## Reserved set (Owner-only sensitive — greyed + warn-to-grant)
`wallet:adjust`, `wallet:manage_expiry`,
`credits:upload/confirm_payout/download_bank_file/mark_paid/request_reversal/approve_reversal/manage_fields`,
`payouts:manage_fund/process_batch/reconcile`,
`invoices:manage`, `invoices:upload`,
`tenancy:read/write/manage_flags`,
`users:manage_roles`.
(Read-only finance — `credits:read`, `payouts:read/view_tds`, `invoices:read` — is NOT reserved; PM holds it.)
The reserved list is a code constant (`reserved-permissions.ts`, 18 keys) shared by the editor (grey/warn) and surfaced via `GET /v1/gifsy/permissions`.
**Enforcement (owner-locked 2026-08-18 — LOCK 1 ONLY):** the create/update-role endpoint REJECTS a reserved-key grant unless the request carries `allowReserved: true` (the value the UI warn-ack sets). This makes the backend — not the greying-out — the real persistence gate: a raw API call can't silently grant a reserved perm; granting one is a deliberate, acknowledged act. **Once granted, the permission is fully usable by that staff member** (no route-level owner-only hard-block — the earlier "Lock 2" was DROPPED per the owner: a knowingly-delegated power must actually work, else the grant is pointless). Safety comes from (a) the conscious-override gate on the grant + (b) always-on GIFSY_STAFF permission enforcement (see Architecture) so a staff member can only reach a reserved action if the owner deliberately gave them that exact key.

## Staff & role management surface (platform-only, un-assumed GIFSY, Owner-gated)
**FE home (recon-decided):** host BOTH screens in the **`/gifsy` portal shell** (`platform/src/app/gifsy/layout.tsx`, `NAV` array) — it is already `RequireAuth allowedRoles={PORTAL_ROLES.gifsy}` and platform-level, and assuming a tenant redirects to `/admin/dashboard`, so `/gifsy` is INHERENTLY un-assumed → no extra assumed-check needed. (If ever placed under `/admin` instead, the nav filter must add `&& !getAssumedBrand()` + a per-route RequireAuth.)
- **Role editor** (`/gifsy/roles`) — CRUD `GifsyRole` via new `/api/gifsy/roles`; permission matrix = one `ui/card.tsx` section per the 17 `PERMISSION_GROUPS`, checkboxes in the `admin/credits-payouts/fields` style (no shared Checkbox component exists — hand-roll), driven by a `FEATURE_META`-style permission catalog; reserved perms greyed + warn-on-grant; validate keys via `isPermission`; block delete of a role in use (or force reassign); `isSystem` roles editable not deletable.
- **Staff panel** (`/gifsy/staff`) — add a Gifsy staff member (name/phone → `GIFSY_STAFF` + assign a `GifsyRole`) via new `/api/gifsy/staff`; list, deactivate/reactivate (reuse the phone-lifecycle infra + the `/admin/users` CRUD shapes as a template — but custom-role assignment needs the new endpoint, the `role` field is a fixed enum), reassign role, revoke-sessions. Owner-only (`users:manage_roles` + `@Roles('GIFSY_ADMIN')`).
- **Permission-awareness (P3):** the FE reads NO effective-permission list today (role + feature-flags only). Add a `permissions[]` field to a `/me`/config endpoint (e.g. `/api/admin/settings/config`) + a consumer hook so the UI can hide actions a staff role lacks.
- **API surface** (all `@Roles('GIFSY_ADMIN')`, platform / un-assumed; same-origin `/api/gifsy/*` → `/v1/gifsy/*`, `{success,data}` envelope):
  - `GET /v1/gifsy/permissions` — the catalog (17 groups + keys + which are reserved) that drives the editor matrix.
  - `GET|POST /v1/gifsy/roles` · `PATCH|DELETE /v1/gifsy/roles/:id` — `isSystem` roles rename/edit-OK, delete-blocked; a role in use is delete-blocked (or force-reassign). A create/update that grants a RESERVED key must carry the explicit override flag (`allowReserved: true`, set by the UI warn-ack) — see the reserved-set note; **the backend is the gate, the greying-out is UX.**
  - `GET|POST /v1/gifsy/staff` · deactivate/reactivate/reassign — create a `GIFSY_STAFF` + assign a `GifsyRole`; reuse the deactivate-frees-phone + Edit-User infra ([[admin-user-phone-lifecycle]]). **MUST revoke sessions + stamp `sessionsInvalidBefore` on deactivate/reassign** (the P1 requirement below).
  - Enable flag: per-tenant `features.rbacEnforcement` (UNCACHED read, kill-switch) for `gifsy`, reversible; env master `RBAC_ENFORCEMENT` already exists.

## Phase plan (each phase: gate + independent audit; auth path ⇒ DUAL audit; then staging per-role verify)
- **P0 Foundation** — migration (`GIFSY_STAFF` enum + `GifsyRole` table + `users.gifsyRoleId`); reserved-set constant; engine/guard resolution for `GIFSY_STAFF`; seed Ops+PM (`isSystem`); `can()`/guard unit tests. Additive + dormant.
- **P1 Backend CRUD ✅ BUILT (committed on develop, gate-green, dual-audited).** `GET /v1/gifsy/permissions` (catalog, each key flagged `reserved`) + `GifsyRole` CRUD (`GET/POST /v1/gifsy/roles`, `PATCH/DELETE /v1/gifsy/roles/:id`) + staff CRUD (`GET/POST /v1/gifsy/staff`, `PATCH /v1/gifsy/staff/:id`) — all `@Roles('GIFSY_ADMIN')` + service `platformWide` re-gate. Lock-1 reserved-grant gate (reject a reserved key unless `allowReserved:true`) on create+update; `isSystem` roles editable-not-deletable; in-use/system delete blocked; soft-delete frees the name (id-mangle). Best-effort **audit trail** on every role + staff mutation (entityType `GIFSY_ROLE`/`GIFSY_STAFF`, records reserved grants + reassignment from→to + sessionsRevoked). Files: `api/src/gifsy/gifsy-roles.*`, `gifsy-permissions.controller.ts`, `gifsy-staff.*`, `dto/gifsy-*.dto.ts`. Gates: api jest 2449 · nest build 0 · FE tsc 0 · FE vitest 2162.
  - ✅ **P0-audit requirement DONE:** staff **deactivate AND role-reassign** (and phone-change) stamp `users.sessionsInvalidBefore` + revoke all live sessions. **Dual-audit HIGH FIXED:** the stamp+revoke must be TWO separately-committed statements (stamp committed BEFORE the sweep), NOT one `$transaction` — a single txn hides the stamp until commit and lets a concurrently-refreshing staff mint a permanently-renewable surviving session (defeating deactivation). Now matches `admin-core.revokeAllSessionsForUser`; spec asserts stamp-before-sweep ordering.
  - ⏳ **NOT runtime-verified yet** — needs the 2 P0 migrations applied to the staging DB (owner-gated DB op) + a real-login owner walk. Until then the endpoints 500 against staging (no `gifsy_roles` table).
- **P2 Coverage** — the authoritative route × role × permission matrix; ADD `GIFSY_STAFF` to `@Roles` on every route a Gifsy role may hold — INCLUDING reserved routes the owner may delegate (so a granted reserved key is actually usable) — + confirm each carries the right `@RequirePermission`; **make the GIFSY_STAFF guard branch unconditional — always-on / fail-closed, run BEFORE both the env `RBAC_ENFORCEMENT` master switch AND the per-tenant `features.rbacEnforcement` read** (P0-audit MED-1: the guard currently fails OPEN when either flag is off, and a staff member's clientId is `gifsy`, so without this a staff with no enforcement is strictly more dangerous than a fail-open tenant — a GIFSY_STAFF with a narrow role would be admitted to any `@RequirePermission` route once `@Roles` lists them; the branch must NOT depend on the flags); grant sales/partner their own keys so a future LEGACY-role enable can't 403 them; lock the matrix as a test. (Staff/role-management routes stay `@Roles('GIFSY_ADMIN')` owner-only.)
- **P3 Frontend** — role editor + staff panel (platform-only), nav (gifsyOnly + un-assumed), FE permission-awareness so the UI hides actions a staff role lacks.
- **P4 Enable + verify** — create the seeded staff on STAGING and do a real-login-per-role walk of the whole matrix: every allowed flow works (0 unexpected 403); a route whose key the role LACKS 403s; a reserved key the owner DELIBERATELY granted is usable by that staff (proves Lock 2 was correctly dropped); a reserved key NOT granted 403s; owner-lockout is impossible. DUAL auth audit. (GIFSY_STAFF enforcement is always-on, so no flag flip is needed for the staff feature; the `rbacEnforcement` flag remains for the separate legacy-role rollout.) Then owner-gated prod enable (reversible).

## Guardrails / traps
- NEVER `prisma migrate dev` — hand-author the migration SQL; apply to staging/prod via the in-VPC job ([[migration-model]]).
- The LEGACY-role enforcement flag (env `RBAC_ENFORCEMENT` + per-tenant `features.rbacEnforcement`) stays OFF — it governs sales/partner/etc., a no-op meanwhile, so P0–P3 are safe on the live path. GIFSY_STAFF enforcement, by contrast, is ALWAYS ON (fail-closed) but harmless during build because NO `GIFSY_STAFF` user exists until the owner creates the first one at go-live.
- The `rbacEnforcement` flag MUST be read uncached (kill-switch semantics) — the plan's cache trap.
- Money/auth path ⇒ DUAL adversarial audit at each phase.
- Only ONE `GIFSY_ADMIN` in prod today — so nothing is exposed until staff are actually created + enforcement enabled.
