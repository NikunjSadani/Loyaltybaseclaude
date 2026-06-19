# Runbook — Enabling RBAC enforcement

> **Why this doc exists:** RBAC enforcement is built but ships **OFF**. Turning it on is a deliberate,
> reversible operation with a short checklist. This is the process so it doesn't have to be memorized.
> Owner: Gifsy platform admin. Last updated: 2026-06-15 (P1).

> **LAUNCH DECISION (2026-06-19): ship `@Roles`-only — RBAC stays OFF for go-live.** With the **fixed built-in
> roles** (the configurable sub-role portal is deferred, gap #47), the permission layer would only duplicate the
> role enum, and it is fail-open today. Launch enforcement = `@Roles` + in-service role checks + tenant-scoped
> queries, **plus a one-time route-coverage audit** (gap #2, P0.6 Phase A3) that guarantees *every* sensitive route
> has a real guard (the audit found enforcement is a mix of `@Roles` / in-service / inert `@RequirePermission`).
> Turning RBAC on (below) becomes worthwhile once custom sub-roles exist. Decision home: `DATA-VISIBILITY.md §3.1`.

## What "RBAC enforcement" is
The admin backend has a permission engine (`src/lib/rbac/`): a catalog of permission keys, a default
**role → permission** map, and `requirePermission(...)` checks wired into every admin route. Until it's
enabled, those checks are **no-ops** and access is governed by the older coarse role checks (`role !==
'GIFSY_ADMIN'` etc.). When enabled, the finer rules apply — e.g. a **Client Admin is blocked from
visibility invoicing, money settlement/UTR, and activation creation** (the Gifsy-operated set), while
keeping reward upload, payout-status view, activation view/enrollments/reports, etc.

## The two-level flag (both must be ON to enforce)
1. **Global master switch** — env var `RBAC_ENFORCEMENT=true` (default unset/false). When off, every
   check is a no-op with **no DB read**. This is the single switch you flip per environment.
2. **Per-tenant opt-in** — `Client.features.rbacEnforcement` (boolean, default false). Only consulted
   when the master switch is on. Lets you enable RBAC tenant-by-tenant.

**Rollback is instant and total:** set `RBAC_ENFORCEMENT` back to anything but `'true'` → all checks
no-op again, immediately, no deploy of code required (just the env change + restart).

## The default role → permission split (the operating model)
- **GIFSY_ADMIN** — everything (over-and-above every role).
- **CLIENT_ADMIN** — everything EXCEPT the Gifsy-operated set: tenancy config; visibility self-billing
  invoices (hidden entirely); money settlement (bank file, UTR/mark-paid, reversals **approval**, fund,
  batch, reconcile, TDS); activation **create/delete**. Client Admin DOES keep: reward/award upload,
  reversal **request** (maker-checker — see below), payout-status view, activation view + enrollments +
  reports, KYC, users, partners, catalog, targets, wallet, rewards, visibility capture/approval, support.
- **MIS_USER** — read-only (`:read` + `reports:export`).
- **Sales / Partner roles** — none in admin (governed by portal routing + hierarchy/identity data-scope).
Per-tenant **overrides** (full-replacement of a role's set) are supported by the engine; storage + an
admin UI to edit them is future work (only needed if a tenant must deviate from this default).

### Maker-checker on reversals (best practice, implemented)
A credit reversal (clawing back a wrongly-credited points award or a wrongly-processed payout) uses
**separation of duties**: a **Client Admin requests** it (`credits:request_reversal`) and **Gifsy
approves/executes** it (`credits:approve_reversal`, Gifsy-only). This gives a clean audit trail and
four-eyes control over money corrections.

## Pre-activation checklist (do BEFORE setting `RBAC_ENFORCEMENT=true`)
- [x] Route → permission mappings reviewed; the 4 audit-flagged ones fixed (reversal-initiate →
      `credits:request_reversal`; `force-logout-all` requirePermission removed [GIFSY-only guard suffices];
      schemes-export got an explicit role guard; kpi-config left as `reports:manage_scheduled`).
- [ ] Decide whether any tenant needs a permission **override** beyond the default split. If yes, that
      needs the override storage/UI (future) before enabling for that tenant.
- [ ] **⚠️ Seed `kyc:*` for the field-sales approver roles (Phase S kyc-audit finding).** `SALES_SO`,
      `SALES_ASM`, `SALES_STATE_HEAD` map to `EMPTY_PERMISSIONS` in the default role→permission map, but they are
      the KYC **field approvers** (first-approve / reject / list their pending bucket). With RBAC OFF this is
      harmless (the in-service role checks gate access); but enabling enforcement **without** granting these roles
      `kyc:read`/`kyc:approve`/`kyc:reject` would 403 the entire field-approval chain. Add those grants (default map
      or per-tenant override) before flipping the flag.
- [ ] (Optional perf) add caching to `requirePermission`'s per-tenant config read.

## Enablement steps
1. **Staging first.** On a staging/dev-cloud deploy, set `RBAC_ENFORCEMENT=true` and set the target
   tenant's `Client.features.rbacEnforcement = true`.
2. **Validate as each role** (~10 min): log in as a **Client Admin** and confirm you CAN do the allowed
   actions and are blocked (403) from the Gifsy-operated ones (try opening invoicing / a settlement
   action / creating an activation → expect "Forbidden"). Log in as **MIS_USER** → read works, writes
   blocked. Log in as **GIFSY_ADMIN** → everything works.
3. **Production.** Once staging is clean, set `RBAC_ENFORCEMENT=true` in the prod environment and set the
   per-tenant flags for the tenants you want enforced. Watch logs for unexpected 403s for a day.
4. **If anything legit is blocked** → set `RBAC_ENFORCEMENT=false` (instant rollback), fix the mapping or
   add an override, retry on staging.

## Where the details live
- Default map + engine: `src/lib/rbac/can.ts`, `src/lib/rbac/permissions.ts`.
- The check + flag: `src/lib/rbac/require-permission.ts`.
- Per-route mapping table + audit notes: `docs/plans/reconcile/P1-identity-tenancy.md` §1.6.
