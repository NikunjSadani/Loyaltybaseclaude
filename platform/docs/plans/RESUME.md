# RESUME — Loyaltybase restart prompt

Multi-tenant FMCG **trade-loyalty** platform (operator Gifsy; live client Deoleo). Backend `api/`
(NestJS + Prisma — owns the DB + ALL business logic) · thin FE `platform/` (Next.js, proxies
`/api/*` → backend `/v1/*`). Work on **`develop`** (auto-deploys to staging). Repo root:
`C:\Users\nikun\Loyaltybaseclaude`.

> Working agreements, gates, and guardrails live in **`CLAUDE.md`** (auto-loaded) — not duplicated here.
> This file is *current state + the traps + what's open*. **Always verify HEADs via `git log`; never trust a hardcoded SHA.**

---

## 🟢 CURRENT STATE
> ✅ **prod = main = `db5d6df` (cutover #26 LIVE + VERIFIED 2026-08-04). develop is AHEAD (`git log` for HEAD) with prod-worthy + infra-only work NOT yet in prod:** ① **KYC review-SLA fix** (2 commits, FE-only, no migration, PROD-WORTHY → pending cutover #27): the admin KYC list/detail SLA clock now FREEZES at the decision (Approved/Rejected rows stopped counting to "now" — the 718h/740h "SLA!" runaway) via shared `platform/src/lib/kyc-sla.ts` `kycAgeHrs` (keys on terminal STATUS, not reviewedAt-presence), AND the list breach threshold now reads the tenant's configured `slaTargetHours` (settings, 1–168h) instead of a hardcoded 48h. Staging-verified against real data. ② **terraform drift reconcile** (infra-only, not user-facing): Secret Manager tidied 37→25 (12 dead orphan config-secrets deleted in prod, prod-verified healthy) + `secret-manager.tf`/`artifact-registry.tf`/`gcs-memorystore.tf` configs matched to live so a future `terraform apply` is safe (see [[infra-cost-reduction]]). ▶ **cut #27 (the KYC SLA fix) to prod when owner OKs.** Cutover #26 (`db5d6df`) — TENANT read-only parity for scheme reports: a tenant CLIENT_ADMIN now gets the SAME rich enrollments view Gifsy has (roster + detail drawer: answers/media/geo/history) + the full Excel export, READ-ONLY. Backend opened GET `:id/enrollments`/`:id/enrollments/:enrollmentId`/`:id/enrollments/media`/`:id/report/export` to CLIENT_ADMIN (tenant-scoped via loadScheme+clientId — foreign id 404s; writes+deleted-recovery stay GIFSY-only, triple-guarded). FE: one shared `SchemeEnrollmentsView({readOnly})` behind two thin wrappers (Gifsy write page + new `/admin/scheme-reports/[id]/enrollments` read-only). FE-only + role changes, NO migration. Dual-audited (all cross-tenant/read-only/regression invariants hold) + staging-runtime-proven with a real Deoleo CLIENT_ADMIN token (list/detail/export 200; foreign 404; write/deleted 403). Prior: #25 (`2a88436`) edge fix — the `@Public` tokenized report-link endpoints (`/api/schemes/media/view`, `/api/kyc/documents/view`) were 401'd by the Next.js edge auth gate (`proxy.ts` `PUBLIC_PATHS`) before reaching the backend, so scheme-report image links + outlet-master KYC-doc links only worked in-session; added both to `PUBLIC_PATHS` (FE-only, no migration). Prior: cutovers #23 (`ce5267a`) + #24 (`078c404`) LIVE — the whole UI/UX audit fix plan (52 findings) + roster-remove + Auth Option B + KYC grouped-child phone fix + per-photo geotag; migration `20260801120000_scheme_outlet_soft_delete` applied+verified on prod. **develop ahead of prod = the KYC SLA fix (#27-pending) + terraform reconcile (infra-only) — see the ✅ block above.** Verify HEADs via `git log` — never trust a hardcoded SHA. Full per-cutover detail: memory `[[deoleo-go-live-bundle]]` + the CUTOVER LEDGER table below.

## ▶▶ WHAT'S NEXT
- **▶ Cut the KYC review-SLA fix to prod (#27)** — 2 commits on develop (`kyc-sla.ts` freeze-clock + configurable `slaTargetHours` threshold), FE-only, no migration, staging-verified. Owner-gated FF-push. (The terraform-reconcile commits also on develop are infra-only — they ride along harmlessly or can be left; NOT a user-facing cutover.)
- **Owner-side on-device smoke** (nothing blocks Deoleo): KYC submit-lock behavior + camera/GPS/signature on a real phone + a form-bearing scheme enroll. Everything remotely-verifiable is green.
- **Recorded owner decisions (this cutover):** **D1** = KYC geo stays a HARD block + "Retry location" (not flag-and-allow). **H1** = after "Send OTP to Outlet Owner" the KYC form LOCKS + the button relabels "Continue to verification →"; corrections go via admin re-KYC (the OTP step only confirms owner consent, carries no form data). *(An optional in-window-edit path — re-submit-replaces-pending + re-OTP — was OFFERED but NOT built; owner can request it.)*
- **Lower-priority plans, written not built:** `RBAC-COMPLETION-PLAN.md` (⚠️ flipping RBAC today 403s all sales+partner routes) · TDS/194C **Wave 2 frontend** (Gifsy config-UI + dashboards + tenant read-only + retailer invoice tweaks; W0/W0.5/W1 backend DONE + LIVE dormant — see `VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md` §8 + `[[visibility-payout-tds-invoicing]]`).
- **Dormant surfaces awaiting owner UAT (no rush, nothing blocks Deoleo):** VISIBILITY POSM `visibilityConfig` activation (#16) · TDS payout write-path + `/admin/users/parents` grouping UI (#17) · the SCHEME instrument.
- **Also on staging E2E to-do (owner-tracked, non-blocking):** build the staging-mode E2E CI harness as a fast-follow to onboarding the 2nd tenant (see `[[e2e-harness]]`).

## 🔶 STANDING MODE — orchestrator
Default to orchestrating substantial work: decompose into **parallel sub-agents** (they write code —
background agents are denied shell; YOU run the gates), integrate shared files yourself, and ALWAYS
personally do the **INDEPENDENT adversarial audit + full gate + runtime-verify** before claiming
done. Own doc + memory consistency in the same pass. The 5 working agreements are in `CLAUDE.md`.
[[default-to-orchestration]] [[audit-every-build-item]] [[verify-flows-at-runtime]] [[own-consistency-no-micromanage]]

## GATES (full suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`)
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` ·
`cd platform && npx tsc --noEmit`. **Latest green (develop HEAD, KYC SLA fix): FE tsc 0 · vitest 2080 · api jest 2200 · nest 0.** (prod `db5d6df` = #26.)
- **Deploy ≠ pushed** (a docs-only commit re-tags the image) — verify the serving SHA:
  `gcloud run services describe gifsy-api-staging|gifsy-frontend-staging --region asia-south1 --project gifsy-platform --format='value(spec.template.spec.containers[0].image)'`.
- FE tsc gotcha: a stale `.next/types` surfaces a phantom `RejectionModal` error (pre-existing,
  webpack-only) → `rm -rf platform/.next` then re-run tsc.

## REUSABLE TRAPS
- **(a) `CreditPayoutEntry.outletId` == the outlet CODE everywhere** (no FK — join via
  `Outlet.outletCode`; `invoices.service`/`tds.service` confirm). Keying it by the Outlet **PK**
  matches nothing (was the wallet-surfacing HIGH-1, dead since cutover #8).
- **(b) A "completed" `PayoutTransaction` is `status='SUCCESS'`** — the `PayoutStatus` enum has NO
  `PAID`/`COMPLETED`; `payouts.service` writes `SUCCESS` on UTR upload. Any status mapper MUST handle
  it (was the wallet-surfacing HIGH-2).
- **(1)** NEVER use `isActive:true` as an "active outlet" denominator (created `isActive=false` until
  KYC approval — use `deletedAt:null AND deactivatedAt:null`). Conversely `isActive:true` IS the
  denormalised **"approved+active"** predicate (no `kycStatus` column on Outlet).
- **(2)** Prisma `{ not: X }` / `notIn` SILENTLY DROPS NULL rows → OR-wrap `OR:[{col:null},{col:{not:X}}]` (safe on non-nullable enum cols).
- **(3)** a partner's **Wallet row is created ONLY at KYC approval** — any pre-KYC points path must `wallet.upsert`.
- **(4)** tokens are bearer JWTs; the proxy reads the **httpOnly cookie** and injects the backend Bearer (post-AF-6). See SESSION/AUTH MODEL.
- **(5)** Cloud Run **throttles CPU between requests** → NestJS `@Interval`/`@Cron` workers don't tick
  reliably while idle (`min-instances=1` doesn't fix it). Drive via **Cloud Scheduler → internal HTTP
  endpoint** (un-throttles CPU). This is why the push drain runs on a scheduler.
- **(6)** the FE's `outletId` EVERYWHERE = the **Outlet CUID** (`o.id`), NOT `outletCode` — an endpoint
  keyed on `clientId_outletCode` from an FE-sent outletId is WRONG; use `findFirst({id, clientId})`.
  (Note this is the INVERSE of trap (a): FE sends the CUID, but `CreditPayoutEntry.outletId` stores the code.)
- **(7)** the sales `/sales/kyc` LIST is now **ASSIGNMENT-DRIVEN** (`e9b3a21`) — the FE synthesises every
  subtree outlet's derived KYC state from `/api/sales/outlets`; the submitter-scoped `/api/kyc` only
  supplements reassignment-edge outlets. (Raw `kyc.service.list()` is still submitter-scoped by design.)
- **(8)** a **bulk-upload loop of awaited writes in ONE interactive `$transaction` 500s at tenant
  scale** (5s default, ~2,261 Deoleo outlets). Fix = **chunk** into `$transaction([...])` batches of ~100
  for idempotent paths, or **raise `{timeout:180_000, maxWait:20_000}`** for MONEY paths that must stay atomic.
- **(9)/(15)** **re-KYC has TWO entry paths**: in-app admin action flips submission→`RE_KYC_REQUIRED`;
  bulk re-KYC upload sets ONLY `Outlet.reKycFlags` (submission stays APPROVED). `reKycFlags` persist
  until approval clears them → gate DISPLAY/actionability on **`isReKycActionable(flags, latestStatus)`**
  (flags set AND latest NOT in-flight — `common/kyc-rekyc.helper.ts` + `platform/src/lib/rekyc-fields.ts`),
  NOT bare `isReKycPending`. The approver highlight keeps using the RAW flags.
- **(11)** a FE **response-merge must match the service's ACTUAL projection shape** (the Gifsy client
  editor read nested `.branding.x` while the service returns it FLAT → edits silently reverted).
- **(12)** a spec `$transaction` mock typed `(cb) => cb(tx)` makes `.mock.calls[0][1]` a TS error →
  widen to `(cb, _opts?) => cb(tx)` when asserting the timeout option.
- **(13)/(14)** Employee Hierarchy upload keys User by `(clientId, phone)` but SalesUser by
  `(clientId, employeeCode)` → a phone correction orphaned the old User (phone stayed reserved in
  `users @@unique([clientId, phone])`, invisible in the UI). A "number in use" not in sales/outlet
  lists is an orphaned/other-role `users` row → query the `users` table.
- **(16)** guarded staging/prod one-off DB ops run via the **`gifsy-oneoff-staging` Cloud Run Job** —
  override `--args` with `^@^-e@eval(Buffer.from('<b64>','base64').toString())` (custom `@` delimiter so
  the comma inside `Buffer.from` isn't split); the image uses **Prisma 7 driver-adapter so bare
  `new PrismaClient()` fails → use raw `pg` on `DATABASE_URL`**; guard `current_database()==='gifsy_staging'`
  FIRST; reset args to a no-op after. (Staging writes still need a backup + owner OK per guardrails.)
- **(17)** a static asset under a NEW `public/` subdir needs the `platform/src/proxy.ts` auth-middleware
  `config.matcher` exclusion — else a no-token page 307's the asset to `/auth/login` (broken image).
  **Local `npm run dev` does NOT reproduce the edge 307 — curl the REAL staging edge.**
- **(18)** a backend `@Public` `/api/*` endpoint is NOT reachable session-less until its path is ALSO in
  `platform/src/proxy.ts` `PUBLIC_PATHS` — the edge auth gate 401s any `/api/*` without a `token` cookie
  BEFORE the request reaches the `@Public` backend. This bit the tokenized report-link endpoints
  (`/api/schemes/media/view`, `/api/kyc/documents/view`): backend-direct 404 (public, bad token) but
  through-edge 401, so Excel report image/doc links only worked in-session (fixed #25 `2a88436`). Rule:
  ANY endpoint meant to be hit from a downloaded file / email / no-session context needs BOTH `@Public`
  (backend) AND a `PUBLIC_PATHS` entry (edge). `startsWith` matches — keep the entry the exact leaf so a
  sibling LIST route stays gated. Prove it by curling the REAL edge host (401→404 flip), not the backend.
- **(19) `terraform plan` is runnable HEADLESS (no ADC/browser)** — `export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)`, `terraform -chdir=terraform init -reconfigure -backend-config="access_token=$TOKEN"`, then `terraform plan -lock=false -var="db_password=DUMMY"` (the ONLY required var; plan is READ-ONLY so a dummy pw is safe — it only adds a noise diff on the DATABASE_URL *version* + sql_user). **`terraform plan`'s refresh is the SOURCE OF TRUTH for live state — a `gcloud …yesno()` on a possibly-EMPTY object misreads** (Secret Manager `replication.automatic:{}` printed as "user" via `yesno(yes=auto,no=user)`, so I wrongly "fixed" secret-manager.tf `auto{}`→`user_managed`, which the plan showed would DESTROY+recreate all 12 secrets — reverted). **Also: terraform CONFIG had DIVERGED from out-of-band gcloud changes** (AR `gifsy-images` cleanup-policies, uploads-bucket CORS) — a blind `terraform apply` would have DELETED the AR cost-cleanup policies. Reconcile CONFIG→REALITY (edit the .tf to match live, verify by re-plan = no change), NEVER blind-apply. Detail: [[infra-cost-reduction]].
- **(KYC-SLA)** the KYC review-SLA "age" FREEZES at the decision — a decided row (`APPROVED`/`REJECTED`/`RESUBMISSION_REQUIRED`/`RE_KYC_REQUIRED`) must use `approvedAt ?? reviewedAt ?? updatedAt`, NOT `now`, else it climbs for days and false-breaches. Shared helper `platform/src/lib/kyc-sla.ts` `kycAgeHrs(submittedAt, status, {reviewedAt,approvedAt,updatedAt})`. **Key on the terminal STATUS, not on `reviewedAt` being present** — a still-pending multi-level row (e.g. `PENDING_GIFSY`) carries a `reviewedAt` from a lower approval level yet must keep counting. The list breach threshold reads the tenant's `slaTargetHours` (settings, 1–168h, default 48) via `fetchKycSlaHours`.
- **(IST)** server-local `Date` getters read **UTC in prod** (no TZ in the image) — user-facing IST
  dates MUST go through `api/src/common/ist-date.ts` (`monthYearIST`/`formatDateIST`), or shift by
  `IST_OFFSET_MIN` then read `getUTC*`.
- **(A-DOMAIN-c)** `client_domains.clientId` is a **bare slug** (= `Client.id`, no FK — matches every
  other model's clientId); `domain` global-uniqueness is a **hand-added `LOWER("domain")` UNIQUE index**
  in the migration (Prisma can't model an expression index) — don't expect Prisma `@@unique` to enforce it,
  and match domains case-insensitively (`{ equals, mode:'insensitive' }`).
- **(A-DOMAIN-d)** the gifsy client-detail **Wallet/Invoicing/Feature cards edited INERT `Client.*` JSON
  blobs the runtime never reads** — the REAL per-tenant config lives in `program_settings` (conversion
  rate/floors, via `TenantSettingsService`/`settings.controller`), `PointExpiryConfig` (expiry), the
  hardcoded `TECH_GIFSY` invoice constant, and `clients.features` (the runtime feature/RBAC store — post-D-1).
  "Make the card persist" ≠ "make it work" — wire the card to the REAL store (P4b did Wallet via a tenant-targeted
  `/gifsy/clients/:slug/wallet-settings`; Invoicing/Features left read-only).
- **(A-DOMAIN-e) D-1 DONE:** `resolveClient` (tenant.service) reads the **`clients` table** now (not `AdminConfig`
  `client_config`, which is RETIRED). It returns the raw `clients.features` blob; RBAC reads `(features as any)
  .rbacEnforcement` dynamically (fail-open: missing row/flag/non-object → false). `visibilityCaptureMode` lives on
  `clients.features`. Console create/update MUST `tenant.invalidateCache(slug)` (5-min cache). `RBAC_ENFORCEMENT`
  env master-switch is OFF — flipping it needs a per-tenant `clients.features.rbacEnforcement` audit first.
- **(A-DOMAIN-f) P5 features seam:** FE feature-gating reads `features` from the **authenticated** role endpoint
  (`/partner/me`, `/sales/me`, admin `/admin/settings/config`) via `lib/tenant-features.ts` (`useTenantFeatures`/
  `normalizeFeatures` — sparse/absent blob → `DEFAULT_FEATURES`, guaranteed nested `partnerApp`), NOT `CLIENT_REGISTRY`.
  The registry is REDUCED to a domain→slug + `DEFAULT_CLIENT_CONFIG` fallback (kill-switch/cold-start) — do NOT delete it.
- **(A-DOMAIN-g) worker route matches across dots:** `*.gifsy.in/*` also matches `api.gifsy.in`/`uat.x.gifsy.in` — safe
  only because they hit the SAME `gifsy-proxy` worker + its explicit API-host check wins. `wrangler deploy` does NOT
  prune Custom Domains absent from `wrangler.toml`, and it ROTATES the local `.wrangler` oauth_token (a cached-token
  CF-API script 401s after — re-read or use wrangler). Reserved `www/mail/status.gifsy.in` 502 by worker design.
- **(A-DOMAIN-h) S1 edge-secret:** the `*.run.app` origins are public (`ingress=all` + IAM `allUsers`) → `x-forwarded-host`
  is forgeable by a direct hit. `lib/platform/edge-trust.ts` `resolveTrustedHost` trusts it only when the worker's
  `x-edge-secret` matches; **env-gated** (`EDGE_SECRET` unset → inert). The CI frontend `--set-env-vars` REPLACES the
  whole env set → `EDGE_SECRET` must live in the workflow (GitHub secret), never a manual `gcloud run update` (wiped next
  deploy). Activation order: worker must send the secret BEFORE the frontend env is set, else legit login breaks.
- **(ASSUME-TENANT-SCOPE) GIFSY operator reads scope to the ASSUMED tenant.** A GIFSY_ADMIN assumed into a tenant
  (JWT `assumed:true`) is READ-scoped to that tenant; un-assumed GIFSY at home stays platform-wide. **Invariant:** any
  new GIFSY-wide read MUST use `api/src/common/tenant-scope.ts` `platformWide(user) = role==='GIFSY_ADMIN' && !assumed`
  (NOT a bare `role==='GIFSY_ADMIN'` check — that ignores assume-tenant and leaks the platform view to the operator's
  scoped context). `compute194C`/`summary194C` stay platform-wide (correctness); write-auth (`isGifsyAdmin`) untouched;
  194C views are un-assumed-GIFSY-only. LIVE develop `706efd1`+`12045db`, runtime-proven. Full detail: memory
  [[gifsy-assume-tenant-scoping]]. (Owner found it onboarding a 2nd staging tenant `uatbajaj`; NOT a tenant leak.)

## META-LESSONS (baked into CLAUDE.md agreements 1 & 2)
1. A fix is DONE only when **EVERY consumer + alternate data path + scale case** is traced (grep all
   consumers; 10-row vs 2,261-row; bulk-upload vs in-app entry produce different DB states).
2. **Clarify before an imperfect build** — if an approach isn't the ideal/complete solution, present
   ideal-vs-shortcut and let the owner choose; do NOT ship a caveated partial and iterate.

## SESSION/AUTH MODEL (post-AF-6 — answer precisely if asked)
Access token = httpOnly `token` cookie, **7-day** JWT (operator assume-tenant = **24h**); refresh =
httpOnly `refresh_token` cookie, **30-day** single-use rotating; the edge proxy reads the cookie +
injects the backend Bearer; `SessionExpiryGuard` does single-flight **refresh-on-401** + retry.
Practical rule: a user stays logged in if they open the app ≥ once every ~7 days; a cold return after
>7 days lands on login (page nav is edge-redirected before the client refresh runs). Phone-change →
logout: sessions tie to the USER row (revocable); at Gifsy approval a re-KYC phone change syncs
`User.phone` + revokes the owner's sessions. All KYC mobiles validated `^[6-9]\d{9}$`.

## CONSTRAINTS (full list in CLAUDE.md guardrails)
Work on `develop`; **NEVER `prisma migrate dev`**; any prod/staging DB op = double-guard
`current_database()` + backup + show SQL + WAIT for owner (staging+prod share the private-IP
`gifsy-db`; reads need only the guard). Never merge to `main` / trigger a cutover without the owner.
Never expose secrets. gcloud/wrangler are authed.

## STAGING (FIXED_OTP=`123456`)
GIFSY admin `9830011252`/clientId `gifsy`; deoleo admin `6289864191`; partner `7795096288`/deoleo
(active, no payouts); sales `9900000041`(ISR) · `9900000002`(SO) · `9900000011`(XSR). Credit-payout
test partner: `9000000007` (deoleo, outlet O003 — reactivated 2026-07-18). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (login: POST `/v1/auth/send-otp` {phone,channel:'SMS'}
then `/v1/auth/verify-otp` {phone,otp:'123456',clientId}; operator cross-tenant = POST
`/v1/auth/assume-tenant` {clientId}).

## OPEN THREADS
- **💸 INFRA COST-REDUCTION — remaining LEVERS (owner-gated, blocked on 2 owner answers). Full detail = memory [[infra-cost-reduction]].**
  Done this session (~₹10k/mo / ~57%, zero prod impact): Redis deleted, VPC connector → Direct-VPC-egress, Artifact Registry
  cleanup policy live. **Remaining levers (owner decision open, if go-live slips post-Sept):** prod Cloud Run min=1→0 + pause
  prod schedulers (~₹800/mo — note push-drain pings every minute, so staging isn't truly idle); stop `gifsy-db`/`gifsy-db-dev`
  when fully frozen (needs the staging-UAT?/dev-continuing? answers). All prod/staging infra changes owner-gated. Architecture
  record `INFRA-ARCHITECTURE.md`.
- **Blocked on an owner DECISION — Notifications-Core go/no-go:** the queue drainer is **PUSH-only**, so enqueued SMS/EMAIL/WhatsApp
  never deliver (genuinely dead: credit-batch EMAIL, KYC owner SMS for UNDER_REVIEW, redemption-fulfilment SMS). Recipients recorded
  (nikunj.sadani@ / payel.ghosh@ / nikita@gifsy.in). + **email provider** ZeptoMail (~$0.25/1k) vs SES (~$0.10/1k).
- **#74 owner-ops residual:** optional cred/secret rotation + real prod MSG91 (monitoring + backups/PITR already ON).
- **POST-GO-LIVE-BACKLOG (later):** multi-tenant SSR branding, configurable RBAC (AF-12 kept OFF), WhatsApp per-tenant
  generalization, OTel O3, DB-RLS, invoice-PDF/email, TDS filing, DPDP, analytics.

## READ FIRST
`GO-LIVE-ISSUE-LIST.md` (⭐ master tracker) · memories **[[deoleo-go-live-bundle]]** (FIRST for any
launch/UAT/staging/cutover work — holds the full NEWEST chronology) · [[audit-every-build-item]] ·
[[scheme-data-collection]] · [[visibility-posm]] · [[partner-multi-outlet]] · [[staging-deploy-gate]] ·
[[migration-model]] · [[e2e-harness]]. Full cutover as-run record = `runbooks/PROD-CUTOVER-RECORD.md`.

## CUTOVER LEDGER (compact — full detail in `[[deoleo-go-live-bundle]]`)

| # | prod SHA | payload (one line) | migration | rollback |
|---|---|---|---|---|
| **26** | `db5d6df` | **CURRENT PROD** (2026-08-04) — TENANT read-only parity for scheme reports: CLIENT_ADMIN gets the rich enrollments view (roster + drawer answers/media/geo/history) + Excel export, read-only; opened 4 GET endpoints to CLIENT_ADMIN (tenant-scoped; writes+deleted stay GIFSY-only); one shared `SchemeEnrollmentsView({readOnly})` + new `/admin/scheme-reports/[id]/enrollments`; dual-audited + staging real-token verified | none | `2a88436` |
| 25 | `2a88436` | (2026-08-04) — edge fix: add `@Public` tokenized report-link paths (`/api/schemes/media/view`, `/api/kyc/documents/view`) to `proxy.ts` `PUBLIC_PATHS` so scheme-report image + outlet-master KYC-doc links resolve from a downloaded .xlsx with no session (were edge-401'd before reaching the @Public backend); FE-only, +4 proxy tests | none | `078c404` |
| 24 | `078c404` | (2026-08-03) — scheme "Enroll"→"Select" button rename (Tasks card + outlet-picker row open selection, not enroll); FE-only | none | `ce5267a` |
| 23 | `ce5267a` | (2026-08-03) — the WHOLE UI/UX audit fix plan (52 findings, P1–P4+G1) + roster-row soft-delete + Auth Option B check-first login OTP + KYC grouped-child shared-phone fix + per-photo geotag + camera-copy correction; dual audit caught 4 HIGH | `20260801120000_scheme_outlet_soft_delete` (additive `scheme_outlets.deletedAt`; applied+verified prod) | `fb996d8` |
| 22 | `fb996d8` | (2026-07-31) — reactivate pending-outlet leak fix + enrollment Excel report rebuild (public tokenized `/v1/schemes/media/view`) + PARKED remove-from-KYC-queue outlet state + grouped-child GST-cert/cheque doc carry-forward + "Activations/Tasks" rename | `20260731170000_outlet_kyc_intent_parked` (`ADD VALUE 'PARKED'`, additive; applied) | `a83b2f4` |
| 21 | `a83b2f4` | (2026-07-31) — scheme UAT batches (downline reach, camera-only capture, edit/delete filled enrollment + consent carry-forward, roster export) + child-KYC group-identity prefill + Identity/Payout Uniqueness toggle | `20260730160000_scheme_enrollment_soft_delete` (additive; applied) | `8c08af3` |
| 20 | `8c08af3` | (2026-07-30) — scheme UX-hardening (dual-source prefill `FormField.outletField` + H1–H6) + Parent-ID outlet-master DOWNLOAD export (57 cols) | none (code-only) | `daa4f3f` |
| 19 | `daa4f3f` | (2026-07-30) — scheme roster-upload Excel report (Summary + per-row disposition + Duplicates + Unmatched-Employees) | none (code-only) | `f193127` |
| 18 | `f193127` | (2026-07-30) — scheme prefill Editable/Locked (backend-enforced Excel-variable prefill, per-field Editable/Locked) | none (code-only) | `52fc19f` |
| 17 | `52fc19f` | (2026-07-29) — visibility-led payouts/194C-TDS + GIFSY assume-tenant scoping + partner→multi-outlet admin grouping FE + POSM post-cutover infra | 2 additive (`..._visibility_payout_tds_foundation` + `..._credit_code_per_tenant_unique`; applied) | `4ebf12c` |
| 16 | `4ebf12c` | (2026-07-28) — VISIBILITY (POSM) live: Scheme-based recurring, per-window, sales-captured, geo-fenced, Gifsy-approved POSM proof (reward-free) | `20260727120000_visibility_posm_rebuild` (destructive-but-guarded, 0-row abort-guard) | `bda9bf3` |
| 15 | `bda9bf3` | (2026-07-27) — SCHEME data-collection instrument live (Gifsy-admin roster + form-builder + immutable versioned submissions; no reward engine) | `20260725120000_scheme_data_collection` (destructive-but-guarded, 0-row abort-guard) | `eca351e` |
| 14 | `eca351e` | (2026-07-24) — PARTNER→MULTI-OUTLET Waves 1–4 (uniqueness engine + parent entity + admin grouping + re-KYC-at-approval + login picker + child-KYC prefill; opt-in DORMANT) | 4 additive migrations (all applied+verified) | `2187498` |

Earlier cutovers #1–#13: see `[[deoleo-go-live-bundle]]` + `runbooks/PROD-CUTOVER-RECORD.md`.
