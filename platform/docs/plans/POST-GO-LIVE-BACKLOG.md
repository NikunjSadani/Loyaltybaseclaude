# Post-Go-Live Backlog — deferred / fast-follow work (after Deoleo is live)

> Created 2026-06-20. **This is the complement of [`GO-LIVE-READINESS.md`](GO-LIVE-READINESS.md):** that doc lists what
> must be ✅ **before** launch; this one lists what we deliberately deferred to **after** Deoleo is live, so the go-live
> timeline stays clean and nothing gets lost. Each item: why it's safe to defer, the **trigger** (when it becomes
> needed), rough effort, and the source reference. Owner-owned priority. Nothing here blocks the Deoleo launch.

> ⚠️ **Go-live blockers do NOT belong here** — those live in `GO-LIVE-READINESS.md` §3. If an item is actually required
> for Deoleo to launch, move it there. When in doubt, ask: "can Deoleo run for its first weeks without this?" If yes → here.

---

## A. Before the 2ND real client onboards (tenant/provisioning)

These are invisible while Deoleo is the only real tenant; they matter when a second paying client arrives.

| Item | Why deferred / current state | Trigger | Effort | Ref |
|---|---|---|---|---|
| **Multi-tenant SSR branding** — subdomain → per-tenant logo/colors/title. **Today every tenant's *visual shell* defaults to Deoleo** (no middleware resolves the subdomain, so the tenant-config lookup never fires). **Tenant DATA is already correctly isolated** — only the cosmetic branding defaults to Deoleo. **NOTE:** the *login* tenant resolution (domain → clientId, e.g. `deoleoloyalty.gifsy.in` → `deoleo`) **is already DONE** (`5de8aa9`, via `CLIENT_REGISTRY.domains`); this item is the **SSR-branding** half (logo/colors/title by tenant), which additionally needs a wired `middleware.ts` + the per-tenant config read. | Deferred from **D2** (A1 decision 2026-06-20): building it in D2 would bolt a feature onto a retirement. It's **additive, not a refactor** — no migration, no backfill; the `clients` table already holds per-tenant config. Deferring does NOT make it harder later. | **Before client #2 goes live** (else they'd see "Deoleo" in their browser tab/theme — cosmetic, not a data risk) | ~3–5 days | D2 plan §3-A; `architecture-backend-split` |
| **Configurable RBAC + custom sub-roles + provisioning chain** — admin portal where heads define custom sub-roles; bootstrap super-admin → tenant admins → sub-users. RBAC engine exists but is OFF; roles are a fixed enum today. | Current client needs none; launch uses fixed `@Roles` + the coverage audit (A4). | When a tenant needs custom roles, OR at client #2 onboarding (provisioning flow) | medium | #47; `RBAC-ENABLEMENT.md` |
| **WhatsApp KYC generalization** — the KYC submit/approve WhatsApp notifications are currently **per-tenant config-gated to deoleo** via `whatsapp-kyc.config.ts` (hardcoded template names + integrated number). **DECISION (owner, 2026-06-30): generalize by driving it from TENANT SETTINGS** (template names, recipient rules, on/off persisted per-tenant) rather than the hardcoded `whatsapp-kyc.config.ts` — the chosen approach. | Built deoleo-only by config (WHATSAPP-KYC, `3900af3`); no other tenant needs it at launch. | When a **2nd client** needs WhatsApp KYC notifications | small–medium | 2026-06-30; `3900af3` |

### A-DOMAIN — Decouple the tenant DOMAIN from the slug (user-entered + DB-driven routing) — folds into "Multi-tenant SSR branding"

**Owner-raised 2026-06-30 during Deoleo onboarding:** the onboarding wizard **derives the domain from the slug** (`<slug>.gifsy.in`), which conflates two different things and confused the operator (they typed `deoleoloyalty` as the slug to get the right domain). The ask: let the operator **enter the domain directly**, and make that entered domain **actually route** (be "linked right"), not just a cosmetic field.

**Current state (verified in code, 2026-06-30):**
- The `Client` table has **NO `domain`/`domains` column** — a tenant is identified purely by `id` (= the slug).
- Domain→tenant routing is **hardcoded in `CLIENT_REGISTRY`** (`platform/src/lib/platform/client-registry.ts`) and consumed across **two layers / 5+ sites**: the Cloudflare **edge worker** (`cloudflare-worker/`), the Next **proxy** (`proxy.ts`), `lib/platform/server.ts`, and `auth/login/actions.ts` + `lib/auth-actions.ts`. `tenant-resolution.ts` is deliberately a **pure, no-I/O** function.
- **Branding, logo/wordmark assets, WhatsApp template names, and the domain list all live in that same code registry keyed by slug** — not the DB. (Code comment confirms DB-sourced branding is this very §A item.)
- The wizard's derived `domain` is therefore **cosmetic/unused** — the real customer domain resolves via the registry.

**Sizing (two scopes):**
- **Scope 1 — wizard domain becomes a user-entered field, stored in DB: ~1–1.5 days.** Add `domains` to `CreateClientDto` + persist + a migration adding the column + FE input (replaces the 4 slug-derived display spots). ⚠️ **Half-measure** — the domain is *stored* but **still doesn't route** (registry stays authoritative), and it risks a new confusion (DB domain vs registry domain). Not recommended alone.
- **Scope 2 — "linked right": DB-driven domain routing + branding, fully decoupled from slug: ~4–7 days, medium-high risk.** Make the domain→slug resolver DB-backed (cached, invalidated) and propagate to the **edge worker** (KV/pushed map or coarse-edge + resolve-in-Next); move branding + logo assets + WhatsApp template names from the registry to the DB. This IS the "Multi-tenant SSR branding" row above (previously ~3–5 days; +domain-routing → ~4–7). **Natural trigger: before client #2.**

**🔒 HOW WE'RE MOVING AHEAD WITH DEOLEO NOW (so the future transition does NOT impact it):**
- Deoleo launches with **slug / clientId = `deoleo`** (the permanent identity — it is the PK across every table). The customer domain **`deoleoloyalty.gifsy.in`** resolves to `deoleo` via the **code registry** (`CLIENT_REGISTRY.deoleo.domains = ['deoleoloyalty.gifsy.in']`), which is deployed in prod and DNS-live (verified 200). The DB `Client.domain` cosmetic field (whatever the wizard stored) is **ignored by routing** — harmless.
- **The invariant that protects Deoleo through the transition: the slug/clientId `deoleo` NEVER changes.** Scope 2 only moves *where the `deoleoloyalty.gifsy.in → deoleo` mapping is read from* (code → DB); it does not touch Deoleo's identity, so no clientId/PK migration is ever needed.
- **Transition steps that keep Deoleo zero-impact (bake these into the Scope-2 build):**
  1. **Backfill the DB from the registry** as the migration's first step: for `deoleo`, seed the new `clients.domains = ['deoleoloyalty.gifsy.in']` + the branding/asset/template config — the *exact* values the registry holds today. The DB becomes a faithful copy before any switch.
  2. **Keep `CLIENT_REGISTRY` as a runtime FALLBACK during rollout** (resolver tries DB first, falls back to registry) so there is never a resolution gap; retire the registry only after the DB path is authoritative **and** verified.
  3. **Verify on staging first** — `deoleoloyalty.gifsy.in → deoleo` must still resolve + Deoleo branding must still render after the switch, before prod.
  - Result: Deoleo keeps slug `deoleo`, keeps domain `deoleoloyalty.gifsy.in`, keeps its branding — only the lookup *source* moves, behind a fallback, verified on staging. **No Deoleo disruption.**

### A-ONBOARDING — client ACTIVATE + EDIT path (no update endpoint today) — REQUIRED BUILD

**Surfaced 2026-07-01 during Deoleo prod onboarding.** The Gifsy console can **create** a client (`POST /v1/gifsy/clients`) but **cannot update one** — there is **no status/activate/edit endpoint at all**. This makes a client onboarded as **`ONBOARDING` a dead-end**:
- the **"Work in brand" switcher** filters to `status === 'ACTIVE'` (`components/operator/brand-switcher.tsx:32`), so an ONBOARDING tenant never appears; and
- **`assumeTenant` requires `status: 'ACTIVE'`** (`auth.service.ts:368`, throws "Tenant not found or not active"),

so the operator can neither see nor assume the tenant → **cannot configure it** (Settings, CLIENT_ADMIN, uploads all need the assumed context). The `gifsy/clients/[slug]` detail page's edit (WalletSection) is dead in-memory scaffold ("DB persistence comes in Platform Phase 2"), so it can't help either.

**Deoleo workaround applied (2026-07-01):** onboarded as `ONBOARDING`, then flipped `→ ACTIVE` via a **one-off guarded in-VPC Cloud Run job `gifsy-activate-deoleo`** (double-guarded `current_database()='gifsy_prod'`, single-row `client.update`, backup `1782886598428`; BEFORE `ONBOARDING` → AFTER `ACTIVE`). A DB write, not a supported operation — hence this build.

**REQUIRED BUILD (batch into the next cutover):**
1. **`PATCH /v1/gifsy/clients/:slug`** (GIFSY_ADMIN) — update `status` (ONBOARDING↔ACTIVE↔INACTIVE) at minimum; ideally also `internalName`/`displayName`/`primaryColor`/`supportEmail`/`invoicePrefix`/`features`. Backed by a real `updateClient` service method (replacing the dead WalletSection scaffold).
2. **Gifsy console control** — an "Activate / Set status" action on the client list + a real edit form on the client-detail page.
3. **UX decision** — pick one to remove the dead-end: (a) wizard **defaults status to ACTIVE**, and/or (b) the switcher + `assumeTenant` **allow ONBOARDING** so an operator can configure-before-activate. (Recommend allowing ONBOARDING to be assumed by the GIFSY operator, while partner/public access stays gated by visibility + data + KYC — so "ONBOARDING" is a real staging state, not a dead-end.)
4. **GIFSY_ADMIN-in-tenant-context footgun** (surfaced 2026-07-01) — creating a **GIFSY_ADMIN while assumed into a tenant** silently produces a cross-tenant operator nominally tied to one tenant. `createUser` (`admin-core.service.ts:168,183`) **always stamps `clientId = caller's context`**, and the FE `assignableRoles(GIFSY_ADMIN)` offers **GIFSY_ADMIN regardless of context** — so a Gifsy operator assumed into a tenant who picks "Gifsy Admin" mints a user with `role=GIFSY_ADMIN` but `clientId=<tenant>`. **Not a client-side escalation** (a CLIENT_ADMIN can't mint GIFSY_ADMIN — the GLB-4 escalation guard blocks it); it's a **GIFSY-operator footgun**. **Access facts (verified 2026-07-01):** `/admin/users` is `@Roles('GIFSY_ADMIN','CLIENT_ADMIN')`; a **CLIENT_ADMIN can create only MIS_USER**; **DELETE is GIFSY_ADMIN-only**. **Fix (small):** (a) **FE** — offer GIFSY_ADMIN only when `clientId==='gifsy'` (platform context); in a tenant show **CLIENT_ADMIN + MIS_USER only**; (b) **backend** — harden `assertRoleAssignable` to reject GIFSY_ADMIN when `caller.clientId !== 'gifsy'`.
- **Effort:** small–medium (one endpoint + service + a Gifsy-console form + the user-role-assignment hardening + tests). **Related already-fixed gap:** the onboarding **slug uniqueness** now checks the DB not the code registry (`a2f5929`).

## B. First weeks post-launch (security / correctness fast-follows)

> **🔜 NEXT ACTIVE TASK (not backlog — the first thing to pick up next): KYC "Rejected / Re-upload" consolidation.**
> Owner decision: ALL reviewer-led feedback (incl. "re-upload this specific document") surfaces under **"Rejected"**, NOT a
> separate "Re-upload" tab. Also a **LIVE latent bug**: the backend writes `RE_UPLOAD_REQUIRED` but the FE `KYCStatus` enum only
> has the dead alias `RESUBMISSION_REQUIRED` → a Gifsy re-upload matches neither filter, blank-badges/crashes the unguarded
> `kycBadge[status]`, and is NOT re-entry-eligible → **the rep can't resubmit a Gifsy-re-upload outlet.** Change plan (Size **M**,
> FE-only, **no migration** — all 3 statuses already in the Prisma `KycStatus` enum): **D0** add `RE_UPLOAD_REQUIRED` to the FE enum
> + every badge map; **D1** drop the separate "Re-upload" filter, make "Rejected" match `REJECTED` + `RESUBMISSION_REQUIRED` +
> `RE_UPLOAD_REQUIRED` (filters/badges/dashboard-tiles/rowBorder) + add `RE_UPLOAD_REQUIRED` to the RE_ENTRY sets
> (`sales/kyc/[id]`, `sales/kyc/new`, backend `sales.service.ts:1009`); **D2** KEEP the reviewer "Request Re-upload" action + distinct
> status (preserves per-doc reason via `reKycFlags`, the distinct push, field-verify bridge, admin approval-rate denom) and just
> surface it under Rejected (RECOMMENDED). Backend logic unchanged. **⏳ PENDING owner confirm:** keep the re-upload action vs
> collapse reviewers to a single "Reject" button. (Detail in GO-LIVE-ISSUE-LIST.md 🔜 NEXT section.)

| Item | Why deferred / current state | Trigger | Effort | Ref |
|---|---|---|---|---|
| **✅ DONE (2026-06-30)** — **Per-tenant points-expiry, end-to-end** (built + staging-verified, rides next cutover). The wallet engine already expires points via `resolveExpiresAt` reading the tenant's DEFAULT `PointExpiryConfig` row; this wired the **operator surface + the sweep driver**. New `GET/PUT /v1/admin/settings/points-expiry` (GET = GIFSY_ADMIN\|CLIENT_ADMIN; PUT = GIFSY_ADMIN-only) reads/writes that DEFAULT row (single source of truth) + a field on the real `/admin/settings` page (GIFSY-editable; client-admin read-only). New `@Public POST /v1/wallet/expire-sweep` (fail-closed on `EXPIRE_SWEEP_SECRET`, constant-time compare — mirrors `/v1/push/drain`) → `expireDuePoints()`, driven by a Cloud Scheduler job. Migration `20260630130000_point_expiry_default_unique` (partial UNIQUE `clientId WHERE isDefault` → deterministic active-default read). Secrets `EXPIRE_SWEEP_SECRET` (prod) + `EXPIRE_SWEEP_SECRET_STAGING` created + SA accessor; `deploy.yml`/`deploy-staging.yml` ref them; `expire-sweep-staging` scheduler ENABLED (daily 00:30 IST). **NOTE:** the Gifsy client-detail WalletSection `pointsExpiryDays` field was DEAD in-memory scaffold — built on the REAL settings surface instead. Runtime-verified: PUT{90}/GET→90 · PUT{null}→null · PUT{0}→400 · gifsy-context PUT→400 · sweep 403/201. **Prod cutover residual:** create the `expire-sweep-prod` scheduler job (see §G below / `CUTOVER-RUNBOOK.md` Step 7). | Engine already shipped (P5 `#28`); this was the operator field + sweep driver, audit-flagged. Done on `develop` (HEAD `192abb2`). | — (done; `expire-sweep-prod` scheduler = cutover step) | small | 2026-06-30; `192abb2` |
| **Per-user backend logout** (revoke the caller's session server-side). Today logout is **stateless** (owner decision B1, 2026-06-20): FE clears the token; the access token stays valid until it expires (a few hours) even after logout. | Acceptable for a loyalty app; matches current behavior. Admin `POST /v1/admin/force-logout-all` already exists for break-glass. | Fast-follow if the "token-valid-until-expiry" window is deemed too long | small | #32; D2 plan §3-B |
| **`force-logout-all` break-glass admin UI** — the backend route exists but no FE calls it. | Not needed for launch. | When ops wants a one-click "log everyone out" | small | #32 |
| **Systemic tenant isolation (DB-level RLS / Postgres policy)** — today isolation is app-layer (`TenantGuard` + `clientId` scoping, harness-verified). RLS is defense-in-depth. | App-layer scoping is proven by the cross-tenant harness tests; RLS is belt-and-suspenders. | Hardening pass; before high-sensitivity scale | medium | #23; P8.6 |
| **Real staging/prod OTP path** — staging currently runs the E2E harness on `FIXED_OTP`; the real-MSG91 read-back hook is unbuilt. | Interim decision (C2, 2026-06-20). Real MSG91 OTP for **prod login** is a **launch blocker** (→ GO-LIVE-READINESS), but the **test read-back endpoint** for staging E2E is deferred. | When staging must be a true E2E gate | small | C2; P8.7 |
| **WhatsApp KYC approval-template verify** — the `deoleo_kyc_approval` send is built + gate-green but its MSG91 template **isn't owner-verified yet**; the SUBMIT trigger is runtime-verified, the approval one is not. | The submit path is proven on staging (real WhatsApp delivered); the approval path can't be runtime-verified until the template is approved at MSG91. | When the `deoleo_kyc_approval` template is owner-verified — runtime-verify the approval WhatsApp then | small | 2026-06-30; `3900af3` |
| **✅ DONE (2026-06-30)** — **Admin `/admin/users` hardening** (built + staging-verified, rides next cutover). FE **pagination** (closed a latent "can't see users past the first 20" gap — staging showed **608 users / 31 pages**), a `@Max(100)` page-size cap, a **self-deactivate guard** + **last-active-admin guard** on `updateUser` (gated on ANY non-ACTIVE status so SUSPENDED can't bypass — audit flagged HIGH), and hide-own-deactivate via the new `AdminSession.userId`. Runtime-verified: pagination shape · `?limit=99999999`→400 · self-deactivate INACTIVE+SUSPENDED→400. *(Residual still open: source the "creating in `<tenant>`" label from server-truth instead of localStorage; align the old `gifsy/users` hardcoded-Active column.)* | Build shipped FE-only (ADMIN-UI, `d306129`); the audit-flagged hardening is now done on `develop` (HEAD `192abb2`). | — (done; tenant-label/label-source residual = fast-follow) | small | 2026-06-30; `192abb2` |

## C. When scale / usage demands (perf & ops)

| Item | Why deferred | Trigger | Ref |
|---|---|---|---|
| **Observability O3 — OpenTelemetry tracing** (distributed traces / spans) | Deferred from the 2026-07-01 SCALE/OPS build (O1 structured `nestjs-pino` logs + O2 `/health/ready` DB-ping probe ARE done + on `develop` `33543ec`). O3 needs **monitoring-IAM** granted + a **`deploy.yml` probe/env edit** — owner-gated infra. | When distributed tracing is wanted / broader rollout | 2026-07-01; `33543ec`; #27; P8.4 |
| **`/admin/outlets` — lightweight all-ids endpoint** | Pagination Wave 1 (`2d1a50e`) paginated the outlets list, but the FE outlets page still **loads the full list on mount** for its upload-validation step. Fine at launch scale; add a lightweight all-ids (or all-outlet-codes) endpoint so upload validation doesn't fetch the whole list. | When a tenant's outlet count makes the full-list mount fetch heavy | 2026-07-01; `2d1a50e` |
| **✅ DONE (2026-07-01) — Pagination Wave 1 + Wave 2 (the pagination stream is COMPLETE)** | Wave 1 (`2d1a50e`): `/admin/outlets`, `/admin/credits/batches` + `/reversals`. Wave 2 (`9e79e49`): `/admin/invoices` + `/admin/schemes` (same envelope + `@Max(100)`). The Wave 2 audit **caught + fixed a MEDIUM scheme-visibility defect** (`?status` wasn't admin-gated → a non-admin could `?status=DRAFT` to enumerate unpublished schemes; non-admins now forced to `ACTIVE`; runtime-verified on staging). The **tiny KPI / banner / partner-sales user-scoped lists were deliberately SKIPPED** (owner-agreed, low value — a `@Max` cap suffices). | — (done; rides next cutover) | 2026-07-01; `2d1a50e`/`9e79e49`; #26; P8.3 |
| **Notification engine / worker** (templates, queue, delivery — banners, leaderboard, ticket SLA/escalation) on MSG91; WhatsApp delivery. **Recon (2026-07-01): mostly dead scaffold** — the drainer is **PUSH-only** so enqueued SMS/WhatsApp/email never deliver; NotificationTemplate / LeaderboardSnapshot.isPublished / Ticket.slaBreached / in-app-inbox unwired. Notifications **Core** (multi-channel drainer + in-app inbox `InAppNotification` migration + banner event; new events OFF by default; email behind a Noop adapter; ≈$0 infra excl. per-message charges) is **PENDING owner go/no-go**. | P7 scope; OTP works for launch | As engagement features go live | #21; P7; 2026-07-01 |
| **Notifications — `leaderboard-published` + `ticket-SLA` events — BLOCKED (needs upstream)** | 2 of the 3 planned notification events can't be wired yet: **leaderboard-published** needs `LeaderboardSnapshot.isPublished` populated, and **ticket-SLA** needs `Ticket.slaBreached` stamped — both are unwired upstream today. The 3rd (banner) is buildable now (part of Notifications Core above). | When the upstream `isPublished` / `slaBreached` flags are populated | #21; P7; 2026-07-01 |

## D. Compliance / finance (when required)

| Item | Why deferred | Trigger | Ref |
|---|---|---|---|
| **Invoice PDF / email generation** | Invoices generate + export to Excel today; PDF/email is additive | When clients want emailed PDF invoices | P6 deferred |
| **TDS Form-16A / 26Q filing** | The platform computes + tracks + exports TDS; filing is off-platform (TRACES) | When automated filing is wanted (future TRACES/3rd-party API) | P6.5 / #25 |
| **DPDP retention / erasure policy + implementation** | Compliance hardening | Per the DPDP compliance timeline | #24; P8.5 |
| **Points holding / lock period** (schema fields already exist: `lockedUntil`/`lockedPoints`/`LOCK_HOLDING`) | Not needed for launch; ~½-day, no migration | If a scheme needs a holding window | P5 deferred |

## E. Analytics / reporting (P8)

| Item | Why deferred | Ref |
|---|---|---|
| **Admin dashboard trend analytics** — MoM/YoY deltas, Growth Trends, Top Territories, Scheme Activity, Billing-by-class. Removed as fabricated demo chrome in **D1**; the real KPI cards stay. | Needs time-series aggregation endpoints we don't build yet | #48; D1 |
| **Configurable + scheduled reports, exports** | P8 scope | P8.2 |

## F. Tech-debt / cleanup (opportunistic)

| Item | Why deferred | Ref |
|---|---|---|
| **D1 residuals** — admin header notifications dropdown (fabricated "14 KYC pending…"); partner `DemoSwitcher` + `lib/partner-session` demo personas (touch identity wiring → dedicated follow-up); the GIFSY cross-tenant KYC **brand column** (A1 polish); small display bugs (admin/approvals "Invalid Date", sales/catalogue "1 Issue"). | Left out of D1's admin-dashboard scope; partner shell needs careful identity rework | #45; D1 report |
| **Legacy-lib demo retirement** — `lib/targets`/`gifts`/`partner-session`/`redemption-store` (Prisma-free; not D2's scope) | Retire as each consuming page gets real backend wiring | D2 plan §8 |
| **`GIFT_CATALOGUE` cosmetic reliance** (emoji/gradient defaults in sales catalogue) | Cosmetic; real catalog data is wired | D1 |
| **target-config / banner JSON-blob normalization** | Works as blobs today | #18 residual |

## G. Prod-cutover tasks (run at the next develop→main cutover)

These are DONE-on-`develop` features whose only remaining piece is a prod infra step at cutover.

| Item | What | Ref |
|---|---|---|
| **Create the `expire-sweep-prod` Cloud Scheduler job** | At the next cutover, create a daily Cloud Scheduler job (mirrors `push-drain-prod`) → `POST` prod `/v1/wallet/expire-sweep` with the prod `EXPIRE_SWEEP_SECRET` in the drain-secret header. **The prod secret `EXPIRE_SWEEP_SECRET` already exists** and **`deploy.yml` already references it**, and the `20260630130000_point_expiry_default_unique` migration **auto-applies at cutover** via the pipeline migrate step — so the only manual action is creating the scheduler job. See `CUTOVER-RUNBOOK.md` Step 7. | 2026-06-30; `192abb2` |

## Owner decisions (2026-06-30)

- **Session Report v2 = DROPPED** — not required; removed from the backlog (no longer pending work).
- **WhatsApp KYC generalization → drive from TENANT SETTINGS** (the chosen approach) instead of the hardcoded `whatsapp-kyc.config.ts` (see §A row).
- **RBAC enablement (POINT 3) = unchanged** — stays a post-live activity (§A "Configurable RBAC…" row).

---

## How to use this doc
- When something is deferred during a build, **add a row here** (with trigger + ref) instead of letting it live only in a
  commit message or a gap-register cell.
- At launch planning, scan section **A + B** first — those are the soonest-needed.
- Anything that turns out to be a launch blocker → promote it to `GO-LIVE-READINESS.md` §3.

## GIFSY settings page — wire the read-only sections (deferred, owner 2026-06-23)

The GIFSY operator settings page (`platform/src/app/gifsy/settings/page.tsx`) has four sections
now shown **read-only** (disabled inputs, no fake Save) so nothing pretends to persist:
**Platform Identity** (name/domain/support email), **Security** (JWT expiry / OTP expiry / max
OTP attempts), **Notifications** (alert email / SLA hours), **Data Retention** (audit / queue days).
The real **Redemption Thresholds** section on the same page is unaffected (it persists + is enforced).

Pick up per-field as needed — effort is very uneven because several have NO backend consumer yet:
- **Enforceable with moderate work** (read the setting at the enforcement point + audit): OTP expiry
  (`auth.service.ts:121`, hardcoded `10*60*1000`), max OTP attempts (`auth.service.ts:134`, hardcoded
  `3`), JWT expiry (`auth.module.ts:19`, boot-time env), support email / platform name (display only).
- **Need NET-NEW subsystems before they can be "real"** (do NOT just store them — that re-creates the
  fake-setting problem): alert email (no alerting pipeline), SLA breach threshold (no SLA engine
  consumes `slaTargetHours`), audit/queue retention (no scheduled purge job — touches data deletion).

Also deferred from the same audit: the credit-upload-window FE check
(`admin/credits-payouts/upload/page.tsx:46` `isUploadWindowOpen`) blocks any-period-after-cutoff
while the backend (`credits.service.ts:77`) blocks only prior-month. Cosmetic today (the page only
uploads the previous month, and the BACKEND enforces correctly); make the FE check period-aware if
the period selector ever allows the current month.

---

## F. PWA — installable mobile app for the SALES + OUTLET (partner) apps only

> **✅ FULLY ACTIVATED ON STAGING + Android-device-VERIFIED (RECONCILED 2026-06-30).** F1–F5 (install shell + icons +
> service worker + install UX + Web Push, FE subscribe included) are done, gate-green, independently audited, and **running
> live on staging**: sales push notifications (KYC assign → rep + approver / reject → rep / targets → XSR + SO, tenant-scoped)
> + **Cloud-Scheduler delivery** (`push-drain-staging`; the Cloud-Run-idle-worker-throttle trap is handled by a scheduler-pinged
> drain endpoint) + adoption tracking (`pwa_install` table + admin "App Adoption" page) + the real Deoleo icon + a 3-day
> install-prompt snooze + a Profile install/notification entry point. **The earlier "shipping DISABLED / all flags OFF"
> framing is STALE** — on staging the flags are ON and push delivers to real Android devices. The canonical plan + live
> status is **[`PWA-PLAN.md`](PWA-PLAN.md)** — read that, not this sketch. Decisions locked: per-tenant icon pipeline ·
> **single platform-wide VAPID**.
>
> **What REMAINS = prod PWA activation, which is CUTOVER-COUPLED** (owner-gated, NOT a separate post-launch project): add
> the `PUSH_DRAIN_SECRET_PROD` secret + a `push-drain-prod` Cloud Scheduler job + VAPID/PWA env on `deploy.yml`, apply the
> additive `push_subscription` migration, and flip the prod flags at the develop→main cutover. The phase table below is annotated.

**Scope: the `/sales/*` and `/partner/*` shells ONLY** (owner decision 2026-06-26). The `/admin/*` and
`/gifsy/*` consoles are desktop-operator tools and are explicitly OUT of scope — no PWA/install/icons for them.

**Current state (RECONCILED 2026-06-30):** the FE (Next.js 16) is an installable per-tenant PWA for /sales + /partner,
**ACTIVATED + Android-verified on STAGING** (no longer "shipping DISABLED"): per-tenant `manifest.webmanifest` route
handlers + iOS meta (`PwaHead`), a sharp icon pipeline (`public/icons/<slug>/`, now with the real Deoleo icon), a Serwist
service worker (network-first nav, never caches `/api`/RSC/HTML/tenant data, with `push`+`notificationclick` handlers), an
install prompt with a 3-day snooze, and a Profile install/notification entry point. The Web Push **backend + FE subscribe**
are built and **delivering live on staging** via the `push-drain-staging` Cloud Scheduler job, with adoption tracking
(`pwa_install` table + admin "App Adoption" page). Per-tenant branding rides `config.branding`, as designed.

**Why it was safe to build during UAT:** the SW (which must not run over a churning UI) was only built once sales/partner
UAT confirmed those screens stable. **On staging the PWA flags are now ON; on PROD they stay OFF until the develop→main
cutover** — prod SW + push ACTIVATE only at cutover (the cutover-coupled steps above).

| Phase | What | Status |
|---|---|---|
| **F1 — Installable shell** | Per-tenant `manifest.webmanifest` route handlers (name/short_name/icons 192·512·maskable/colors/`display:standalone`/scope=`/sales`+`/partner`) + iOS meta + apple-touch icons. | **✅ DONE** (`185c548`); runtime-verified on the live Deoleo staging edge |
| **F2 — Per-tenant icon pipeline** | sharp generator → each tenant's icon set; monogram placeholder until real logos arrive; re-run swaps a logo in. | **✅ DONE** (deoleo/clientb/gifsy generated) |
| **F3 — Service worker** | Serwist; **network-first nav, never caches `/api`/RSC/HTML/tenant data**, offline fallback, update prompt, `push`+`notificationclick` handlers. Flag-OFF; emitted via esbuild at cutover. | **✅ DONE** (`185c548`+`40d0934`); audit caught a cookie-cache leak, fixed |
| **F4 — Install UX** | `beforeinstallprompt` custom prompt (Android) + instructional A2HS banner (iOS Safari); dismissal persisted. Flag-OFF. | **✅ DONE** (`1b8d349`) |
| **F5 — Web Push** | VAPID (single platform-wide) + backend sender + per-tenant subscription storage + drain worker + triggers (KYC assign/reject, targets) + **FE subscribe + Cloud-Scheduler delivery + adoption tracking**. | **✅ DONE + ACTIVATED ON STAGING** (Android-device-verified, `push-drain-staging`); **prod activation = cutover** |
| **F6 — Store presence (optional)** | Android Play Store via TWA/Bubblewrap; iOS App Store via wrapper. | Not started (optional) |

**Remaining effort (RECONCILED 2026-06-30):** F1–F5 are DONE and activated on staging. **Only the prod-activation cutover
steps remain** (cutover-coupled, owner-gated): `PUSH_DRAIN_SECRET_PROD` secret + a `push-drain-prod` Cloud Scheduler job +
VAPID/PWA env on `deploy.yml` + the additive `push_subscription` migration + flip the prod flags. ≈ part of the cutover, not a separate project.

**iOS reality check:** Android PWAs are first-class (install prompt, push, Play Store wrappable). iOS is
limited — install is Safari "Add to Home Screen" only (no prompt), push needs iOS 16.4+ AND a home-screen
install, plus storage-eviction / no-background-sync constraints.

**Recommended sequencing (RECONCILED 2026-06-30):** SUPERSEDED — F1–F5 are already built and **activated on staging**
(Android-verified). The only remaining work is the **prod-activation cutover steps** listed above, which run at the
develop→main cutover (not a separate post-go-live project). The original "F3–F5 is a focused post-go-live project" framing
no longer applies. (F6 store presence stays optional.)
