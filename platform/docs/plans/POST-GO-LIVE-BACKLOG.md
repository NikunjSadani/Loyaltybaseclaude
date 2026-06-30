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

## B. First weeks post-launch (security / correctness fast-follows)

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
| **Pagination on all tenant-scoped list endpoints** | Fine at launch data volumes | When any tenant's lists grow large | #26; P8.3 |
| **Observability baseline** (structured logs, metrics, tracing) | Not blocking a controlled launch | Before/with broader rollout | #27; P8.4 |
| **Notification engine / worker** (templates, queue, delivery — banners, leaderboard, ticket SLA/escalation) on MSG91; WhatsApp delivery | P7 scope; OTP works for launch | As engagement features go live | #21; P7 |

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
