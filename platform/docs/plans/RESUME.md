# RESUME — Loyaltybase restart prompt

Multi-tenant FMCG **trade-loyalty** platform (operator Gifsy; live client Deoleo). Backend `api/`
(NestJS + Prisma — owns the DB + ALL business logic) · thin FE `platform/` (Next.js, proxies
`/api/*` → backend `/v1/*`). Work on **`develop`** (auto-deploys to staging). Repo root:
`C:\Users\nikun\Loyaltybaseclaude`.

> Working agreements, gates, and guardrails live in **`CLAUDE.md`** (auto-loaded) — not duplicated here.
> This file is *current state + the traps + what's open*. **Always verify HEADs via `git log`; never trust a hardcoded SHA.**

---

## 🟢 CURRENT STATE
- **prod == main == `2187498`** (CUTOVER #12 `d028566` + #13 `2187498`, both LIVE 2026-07-22). **develop = `a7fca57`**
  (verify via `git log`; docs `a7fca57` on feature `04008d0`) = prod + **🏗️ PARTNER→MULTI-OUTLET Waves 1–4 — the FULL
  feature COMPLETE** (uniqueness engine + parent entity + admin grouping + re-KYC stage-at-approval + login picker + group
  overview + child-KYC pre-fill/badge + scheme re-key + order-bound OTP + **W4** group-leave-via-re-KYC + Phase-2 roll-ups +
  scheme-catalog fix). Additive+opt-in (dormant until an admin sets a parentId → zero impact on live Deoleo). **✅ ON STAGING
  + runtime-verified** (W1+W2 migrations verified; W3+W4 flows verified on the `w3test-*` group). Gate at `04008d0`: **api
  jest 1745 · nest 0 · FE vitest 1984 · tsc 0**; adversarial-audited (no HIGH; MED-1 orphan-sibling + LOW-3 fixed). **NOT in
  prod.** Full as-built + cutover checklist = `platform/docs/plans/PARTNER-MULTI-OUTLET.md` §9; memory **[[partner-multi-outlet]]**;
  the detailed ACTIVE-WORK block is under START THE SESSION below.
  - **🛑 CUTOVER ATTEMPTED 2026-07-23 → BLOCKED on prod dup-PAN (owner decision needed; nothing merged to main — prod untouched).**
    Prod is pre-Wave-1 so ALL **4 additive migrations** apply. Guarded prod read (`gifsy-oneoff-prodcheck`): scheme-orphans **0**,
    but **2 dup-PAN pairs among 4 UNAPPROVED go-live SMOKE-TEST partners** (`AAACT9811F`×2 + placeholder `ABCDE1234F`×2; Deoleo has
    no real partners yet) → the W2 PAN index would fail. **▶ owner: confirm test → guarded prod cleanup (soft-delete all 4 / null
    dup PANs) → re-run read→0 → merge develop→main + owner GitHub approval → 4 migrations → verify → post-cutover Cloud Scheduler
    → `POST /v1/kyc/cleanup-stale-drafts` daily + `KYC_CLEANUP_SECRET`.** (3) sweep dup bank/UPI **before** ever flipping a tenant's
    `uniquenessPolicy.bank`/`upi` to true (no DB index reveals them). *(§4.5 PAN-change-to-leave-group is now IMPLEMENTED in W4 — no
    longer a TODO.)*
- **✅ CUTOVER #12 (`d028566`, live 2026-07-22) shipped BOTH develop features + the infra-workflow changes to prod:**
  (1) **PER-OUTLET PAYOUT MANDATE** — `Outlet.requiredPaymentType BANK|UPI|ANY` (migration `..._add_outlet_required_payment_type`),
  **fully LIVE, needs no flag** (defaults BANK); (2) **KYC ADDRESS-PROOF WAIVER** (migration `..._add_kyc_address_name_mismatch`);
  plus `deploy.yml` Direct-VPC-egress + `/health/ready` startup probe + `REDIS_URL` removal (matched the manual prod state).
  Both migrations verified applied on prod (additive, zero-downtime). Smoke: both services `/health/ready` 200 `{db:up}`.
- **✅ CUTOVER #13 (`2187498`, live 2026-07-22, code-only) shipped the WAIVER SEMANTICS-FIX + set the prod flag:** the waiver
  now drops ONLY the self-declaration (Address Proof stays required — owner-corrected before the flag went live). Prod deoleo
  `clients.features.kycAddressProofWaiver=true` SET (guarded write, keycount 10→11, `rbacEnforcement` untouched at false;
  backup captured). **Waiver is now LIVE for Deoleo in prod.** Remaining verify = owner real-OTP prod check of the KYC form
  (Address Proof still required + self-declaration gone) — FE gating is unit-tested + staging-verified + audit-clean.
- **🆕 PER-OUTLET PAYOUT MANDATE (develop `11fe3a8`, gate-green, audit-clean, ✅ STAGING-VERIFIED):** the client can configure
  PER OUTLET (at master-upload) which payout details an outlet must give — new `Outlet.requiredPaymentType` enum `BANK|UPI|ANY`
  (NOT NULL DEFAULT BANK, additive migration). HARD MANDATE: the uploaded value pins the KYC Bank/UPI toggle (rep can't change);
  backend `create()` guard rejects a mismatched `paymentMode` + requires the matching fields; UPI is never allowed when tenant
  `salesApp.upiEnabled` is false (a UPI upload row under a UPI-disabled tenant is REJECTED in the error report). Shared
  `payment-type` helper (api `common/` + FE `lib/` mirror) is the single contract. Independent audit clean (no HIGH; MED-1
  re-KYC-locked-empty deadlock FIXED + all LOWs). Gate: api jest 1557 · nest 0 · FE vitest 1924 · tsc 0. **✅ STAGING-VERIFIED**
  (upload UPI-under-deoleo REJECTED + case-insensitive accept; KYC submit guard 400s a mode-mismatch + missing-fields; migration
  live). **⚠️ needs the same migration cutover; no prod flag/DB write required (the column defaults to BANK).** See memory
  [[deoleo-go-live-bundle]] NEWEST-59.
- **🆕 KYC ADDRESS-PROOF WAIVER (develop `2f21a8e` + semantics-correction, gate-green, ships NEXT cutover):** in `sales/kyc/new`,
  ticking "shop board name & address proof name do not match" DROPS the extra signed self-declaration document — the **Address Proof
  upload itself stays REQUIRED** (owner-corrected 2026-07-22: the original build wrongly made the Address Proof optional too; now the
  waiver only removes the self-declaration). Deoleo-only, gated on new `clients.features.kycAddressProofWaiver` (a runtime behaviour
  flag, EXCLUDED from the gifsy-console `FeatureKey` module set → DB/seed-set only). Gating is a pure helper `lib/kyc-document-gating.ts`
  (unit-tested — address proof never becomes optional). Persisted as new `KycSubmission.addressNameMismatch` (additive migration) + a
  neutral "Names differ" reviewer badge on both `kyc/[id]` pages. Flag-OFF = byte-identical. Staging flag ON (backup was `features={}`).
  **⚠️ GO-LIVE: at the next cutover also `jsonb_set` `kycAddressProofWaiver=true` onto PROD deoleo `clients.features`** (likely `{}`
  today → additive is fine; ~5-min `resolveClient` cache). See memory [[deoleo-go-live-bundle]] NEWEST-58.
- **§A-DOMAIN is FULLY LIVE on prod (verified post-cutover):** DB-driven routing (D-1, resolveClient→`clients`),
  features-from-authenticated-`/me` (P5, registry reduced to fallback), and **S1 edge-secret ENFORCING on production**
  — prod smoke confirmed: legit Deoleo login 200 + secret matches the worker; a forged direct-`.run.app`
  `x-forwarded-host` resolves to `default`, NOT the spoofed tenant (forge rejected). Code-only cutover — **no new
  migrations**. Also live: favicon-from-DB-branding, proxy/worker unit tests, 2nd-tenant DB-routing E2E, the sales-ledger
  payout unification. P3 worker (`44088f8a`) stamps the edge secret for all `*.gifsy.in`.
- **DB tenant-routing LIVE in prod** (`TENANT_ROUTING_SOURCE` default `db`, registry fallback → Deoleo
  unaffected). Kill-switch: `TENANT_ROUTING_SOURCE=registry` on the FE service. **⚠️ `RBAC_ENFORCEMENT` env still OFF.**
- Gate green on `e8de31a`: **api jest 1540 · nest 0 · FE vitest 1917 · tsc 0**. Pre-cutover backup `1784547142461`;
  rollback ref = prior prod `437045a`.
- **✅ E2E HARNESS REVIVED + CLEAN-BASELINED (2026-07-21, `4b0d03f`+`f89697c`): 295 passed / 0 failed / 3 skipped, now REPRODUCIBLE on a fresh gifsy_dev.** See below + the dedicated plan.

## ▶ E2E HARNESS REVIVAL — ✅ DONE (2026-07-21, `4b0d03f`)
**Full pickup/record: `platform/docs/plans/E2E-HARNESS-REVIVAL.md` (§0 = the resolved story + the NEW run-book).**
The go-live Playwright harness (`platform/e2e`), dead since AF-6, is REVIVED and **fully green (294/0/4)**. Key
resolutions: (A) the `requestAs`/401 "mystery" was the RUN TARGET — local `next dev` (Turbopack) does NOT run the
proxy for `/api/*`; a **prod build does**, so the harness now runs against a local **`next build`+`next start`** (NOT
`next dev`). (B) tenant steering via the new **`hostHeader`** strategy (`x-forwarded-host` per role, trusted locally
via the unset EDGE_SECRET path). (C) server-action CSRF handled by a **default-OFF `E2E_LOCAL_ORIGIN`** gate in
`next.config`. (D) ~25 stale specs reconciled; a dedicated **CP004/`partnerApproved`** approved-partner fixture added
(both redeem money-paths gate on KYC-APPROVED); visibility enabled for the test tenants in the seed. (E) two tiny
**prod-source** fixes surfaced by the harness: the `/admin/outlets` client-redirect fix + the gated next.config origin.
Gate: api jest 1540 · nest 0 · FE vitest 1917 · tsc 0. **✅ CLEAN-BASELINE DONE (`f89697c`, 295/0/3 on a FRESH DB):**
`e2e/global-setup.ts` now TRUNCATEs + re-seeds `gifsy_dev` before every run (gated LOCAL-only via `E2E_ENV!==staging`,
skippable with `E2E_SKIP_RESET`; guarded to `current_database()==='gifsy_dev'`) → the suite resets itself, no more
manual re-seed and no residue drift. The seed now OWNS deoleo's canonical branding + module config (previously
residue-only), clientb is ONBOARDING, and the reward-name specs use the seed values. A one-off owner-consented
`prisma migrate reset` reapplied all 11 migrations cleanly (no drift). Only the STAGING run mode remains a separate,
not-yet-exercised path (there, no reset is possible — robust assertions carry it). See the plan doc §"CLEAN BASELINE".

<details><summary>§A-DOMAIN P6 + cutover #11 — ✅ DONE + LIVE (reference, superseded)</summary>

P0–P2 + P4/P4b IN PROD; **P3 + D-1 + P5 ✅ DONE on develop (staging-verified, awaiting cutover #11)**. **P6 ✅ DONE
on develop + staging — S1 edge-secret now ENFORCING on staging (verified); tests + favicon + E2E shipped. The only
§A-DOMAIN item left is prod enablement, which happens automatically at cutover #11.** Plans: `A-DOMAIN-PLAN.md`,
`A-DOMAIN-P0-DESIGN.md`. Status:
- **P3 edge worker — ✅ DEPLOYED + VERIFIED LIVE (2026-07-20).** Owner added the proxied wildcard `*.gifsy.in`
  DNS record (AAAA `*`→`100::`, orange-cloud) + Universal SSL already covers `*.gifsy.in` (cert SAN
  `DNS:gifsy.in, DNS:*.gifsy.in`, GTS, Active; plus ACM Advanced certs for the existing 2-level hosts). Both
  prereqs were runtime-confirmed (a random `<x>.gifsy.in` resolves to CF anycast + presents the valid `*.gifsy.in`
  cert). Then I `npx wrangler deploy`'d `cloudflare-worker/` (tenant-agnostic coarse worker, new version
  `eb56c29b`) → triggers now `*.gifsy.in/*` + `api.gifsy.in/*` + `api.staging.gifsy.in/*`. **The 5 pre-existing
  Worker Custom Domains (deoleoloyalty, uat.deoleoloyalty, api.staging, app, uat.app) were untouched** (config
  has NO `custom_domain` entries, so wrangler doesn't reconcile them). **VERIFIED:** `deoleoloyalty.gifsy.in/auth/login`
  200, `api.gifsy.in/health` 200, `app.gifsy.in` 200, apex `gifsy.in` 200 — all unaffected; and a NEVER-configured
  `newtenant-probe-x9z.gifsy.in` → **404 from the frontend** (routes through worker→frontend→Next fail-closes on
  unknown slug, NOT a CF black-hole) = **zero-touch routing PROVEN**. **Independently pre-audited** (2 agents:
  Cloudflare-docs auditor CONFIRMED all 6 platform claims w/ cited docs; repo-config auditor confirmed
  `wrangler.toml` already declared the `*.gifsy.in/*` route + same prereqs). **Owner-flag (2 reserved hosts now
  502 by worker design — NOT regressions): `mail.gifsy.in` & `status.gifsy.in` return 502 "No backend configured"
  on HTTPS.** `status` had no prior record (only resolves via the new wildcard → nothing was ever there). `mail`
  EMAIL/MX is unaffected (worker only touches HTTP); only a hypothetical webpage at `https://mail.gifsy.in` 502s.
  `www.gifsy.in` is a SEPARATE grey-cloud Firebase record (199.36.158.100) the worker never touches — its TLS-SNI
  mismatch (`SEC_E_WRONG_PRINCIPAL`) is PRE-EXISTING, unrelated. If the owner wants mail/status/www to serve real
  content, drop them from the worker's `RESERVED_HOSTS` or add explicit handling. **Now truly zero-touch:
  onboarding client #2 needs NO Cloudflare edit — just a DB `client_domains` row + console.**
- **D-1 (#159) — ✅ DONE on develop (`9872806`, audited GO, staging-verified).** `resolveClient` (tenant.service)
  now reads the `clients` table (`mapClientRow`) instead of `AdminConfig` `client_config` (prod had **0** such rows
  for deoleo → resolveClient already fail-open-threw; converging onto `clients.features.rbacEnforcement=false` is a
  **byte-identical RBAC posture**, verified). `visibilityCaptureMode` moved onto `clients.features` (writer repointed
  to a fresh-read merge base); gifsy console create/update now bust the 5-min resolveClient cache; `upsertClientConfig`
  deleted. Fail-open RBAC preserved (missing row / absent flag / non-object features → false). Staging-verified: deoleo
  `/admin/settings/config` 200+features, RBAC still off, operator `gifsy` dashboards 200 (resolveClient throws → caught).
  **⚠️ `RBAC_ENFORCEMENT` env master-switch still OFF — before ever flipping it ON, confirm no tenant has an
  unexpected truthy `clients.features.rbacEnforcement`.**
- **P5 (#157) — ✅ DONE on develop (`c4d1cf9`, audited GO, staging-verified).** Branding backfill done earlier (prod+
  staging, live). Registry-code retirement: FE features now served from **authenticated DB-backed /me** (`/partner/me`,
  `/sales/me`, admin `/admin/settings/config`) via `lib/tenant-features.ts` (`useTenantFeatures`/`normalizeFeatures`,
  fail-soft `{}`); admin/partner layouts + partner leaderboard read features from there, NOT `CLIENT_REGISTRY`. Registry
  **REDUCED, not deleted** (it's the kill-switch/cold-start domain→slug fallback): `DEOLEO`/`CLIENT_B` now spread a new
  `DEFAULT_CLIENT_CONFIG` overriding only slug/status/domains/branding; the 2 hard `DEOLEO_CONFIG` imports →
  `DEFAULT_CLIENT_CONFIG`. Deoleo nav provably unchanged; branded-host SSR still resolves. **2 LOW future-tenant notes
  (NOT Deoleo blockers → 2ND-TENANT list):** admin layout doesn't gate on features-loading (flash for a future
  non-default tenant); MIS_USER gets `DEFAULT_FEATURES` (`/admin/settings/config` is GIFSY/CLIENT_ADMIN-only).
- **P6 (#158) — ✅ DONE on develop + staging (S1 ENFORCING + verified). Prod enforces automatically at cutover #11.**
  - **S1 edge-secret — ✅ ACTIVATED + ENFORCING on staging (2026-07-20, verified).** The `*.run.app` origins are public
    (`ingress=all` + IAM `allUsers`, verified) → a direct hit could forge `x-forwarded-host` (bounded: post-login scope
    is JWT-enforced). Fix = an **edge secret**: worker stamps `x-edge-secret`; `lib/platform/edge-trust.ts`
    `resolveTrustedHost` (used by `proxy.ts` + `auth/login/actions.ts`) trusts `x-forwarded-host` ONLY when it matches,
    else falls back to Host (safe). **Env-gated** (`EDGE_SECRET` unset/empty → inert → prior behaviour). **AS-BUILT:** a
    256-bit secret is bound to the `gifsy-proxy` worker (`wrangler secret put`) + worker redeployed (version `44088f8a`)
    so it strips any inbound `x-edge-secret` and stamps the real one; the OWNER added the matching `EDGE_SECRET` GitHub
    Actions repo secret (gh CLI not installed → owner did it in the UI); an empty-commit redeploy (`8f817b9`) baked it into
    the staging frontend env → **staging now ENFORCES.** **RUNTIME-VERIFIED on staging:** (1) legit login via the edge
    worker `uat.deoleoloyalty.gifsy.in/auth/login` → 200 + slug=deoleo (login intact, secret matches); (2) a FORGED direct
    `*.run.app` hit with `x-forwarded-host: clientb.gifsy.in` → 404 + slug=`default` (NOT clientb — forge REJECTED);
    (3) baseline direct hit (no forge) → identical 404 + `default`. (2)==(3) ⇒ the spoofed host had zero effect. **Secret
    value in scratch file `EDGE_SECRET-owner-handoff.txt` (owner can delete it now).** **▶ REMAINING: prod enforces
    automatically at cutover #11** (deploy.yml already injects `EDGE_SECRET` from the same GitHub secret). Ordering safe:
    the worker stamps for prod too, but prod FE has no `EDGE_SECRET` until #11 → inert until then.
  - **Tests + favicon + E2E — ✅ SHIPPED `f578cad` (audited GO, full gate green, staging-verified).**
    `4cab103` **favicon-from-DB-branding**: `layout.tsx` now uses `resolveFaviconIcoHref(branding.faviconUrl, slug)` —
    prefers the DB `faviconUrl` ONLY when it's an absolute http(s) URL (a console-uploaded GCS asset), else the static
    `/icons/<slug>/favicon.ico`. This FIXES a DB-only tenant's broken favicon WITHOUT regressing Deoleo (whose DB
    `faviconUrl=/favicons/deoleo.ico` is a never-committed path → correctly falls back; **runtime-verified on staging:
    emitted `/icons/deoleo/favicon.ico` 200, the DB `/favicons/deoleo.ico` is 404**). `ad2b074` **proxy.ts + worker.js
    unit tests** (43: role-gating incl. the /admin/gifsy-before-/admin ordering; the FULL S1 x-edge-secret boundary).
    `f578cad` **2nd-tenant DB-routing E2E** (deterministic vitest acceptance slice proving a registry-absent tenant routes
    via the DB map + kill-switch DB-dependence + Deoleo no-clobber + resolver isolation; Playwright spec on
    `GET /v1/tenants/routing`; seed adds `client_domains` rows + distinctive clientb DB branding — seed is NEVER auto-run
    on staging/prod).
  - **Two non-blocking findings — ✅ FIXED `58ce1ab`.** (a) `proxy.ts` unreachable `/api/*` 403 branch removed +
    documented that API-route role enforcement is the NestJS backend guards' job (proxy authenticates `/api/*` + gates
    PAGES only) + a test asserting a wrong-role `/api/*` passes through (guards against re-adding a broken gate).
    (b) worker.js `relative Location` comment corrected (a relative Location resolves against the `.run.app` backendBase
    and IS rewritten to the public host — harmless; comment-only change → deployed `44088f8a` behavior identical, no
    redeploy needed).
- **P4b money-path runtime-verify** (owner, OTP-gated): as GIFSY_ADMIN change a tenant's conversion rate
  on the client-detail Wallet card → confirm a redemption uses it + the tenant Settings panel matches.

⚠️ **FLAKY-CI TRAP:** CI + the prod-deploy `test` job can flake (25s fast-fail; the exact command
passes clean locally + in the staging deploy on the same code). `deploy.yml` gates the approval on
`needs: test == success`, so a flaked test job = **NO "Review deployments" gate appears** (reads as
"no approve option"). FIX: on the "Deploy — Production (main)" run, **"Re-run failed jobs"** → tests
pass → gate appears → approve. `deploy.yml` has an emergency `skip_tests` dispatch input.

### §A-DOMAIN — what it is (the current cutover payload)
DB-driven `*.gifsy.in` tenant routing + branding-to-DB, so a new tenant is provisionable from the
console/DB with no code edit. **Backend** (`client_domains` table [global LOWER(domain) unique],
`GET /v1/tenants/routing`, gifsy client CRUD domains + branding-asset upload). **FE resolver** reads
that endpoint (SWR cache, cold-start block-warm, registry fallback, prod fail-closed login,
`TENANT_ROUTING_SOURCE` kill-switch). **P4b** wired the gifsy client-detail Wallet card to the REAL
per-tenant money stores (conversion/expiry/floors via a tenant-targeted GIFSY settings write);
Invoicing/Features made read-only. Every phase: gate + INDEPENDENT adversarial audit (the P1 audit
caught 2 HIGH dead-feature bugs; P2 caught the cold-start branded-host mis-route; P4b money-path clean)
+ staging runtime-verify. Traps (a)/(b) below still apply. **See the two new A-DOMAIN traps at the
bottom of TRAPS.**

</details>

## 🔶 STANDING MODE — orchestrator
Default to orchestrating substantial work: decompose into **parallel sub-agents** (they write code —
background agents are denied shell; YOU run the gates), integrate shared files yourself, and ALWAYS
personally do the **INDEPENDENT adversarial audit + full gate + runtime-verify** before claiming
done. Own doc + memory consistency in the same pass. The 5 working agreements are in `CLAUDE.md`.
[[default-to-orchestration]] [[audit-every-build-item]] [[verify-flows-at-runtime]] [[own-consistency-no-micromanage]]

## GATES (full suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`)
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` ·
`cd platform && npx tsc --noEmit`. **Latest green (develop `11fe3a8`, incl. waiver + payout-mandate): api jest 1557 · nest 0 · FE vitest 1924 · tsc 0.** (The
`4b0d03f` E2E-harness-revival commit is mostly test-only — e2e specs aren't in the jest/vitest gate; the 2 tiny FE
fixes + next.config are tsc-clean & vitest-green. The E2E harness itself is a SEPARATE runtime gate: 294/0/4 green.)
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
- **💸 INFRA COST-REDUCTION — IN PROGRESS. Full detail = memory [[infra-cost-reduction]].** Deoleo go-live MAY postpone to post-Sept →
  cut idle cost (~₹17.5k/mo bill). **✅ DONE: both Redis instances DELETED (owner "turn it off then") + terraform/deploy wiring stripped
  (develop `748fd81`, `terraform validate` Success) → ~₹8,500/mo (52%) removed, permanent, zero runtime impact** (Redis was never wired —
  in-memory throttler, no ioredis/cache-manager imports, scaffold leftover). The `REDIS_URL` Secret Manager secret + the prod env var are
  now **DELETED too** (2026-07-22) — Redis is fully gone everywhere. *(History: the secret was briefly RETAINED because the running prod
  revision read it at startup; the Direct-VPC-egress prod redeploy dropped that dependency, so the secret was then deleted.)*
  The VPC connector was likewise removed: earlier in the session I wrongly called it "vestigial" (owner challenged; `gifsy-db` is
  PRIVATE-IP-ONLY `10.49.0.3` and both live services routed to it THROUGH the connector, so a straight delete = full DB outage — the fix
  was to **migrate to Direct VPC egress**, a tested change, not a delete)
  — **Direct-VPC-egress migration: Phase 1 (staging) ✅ + Phase 3 (PROD) ✅ DONE + runtime-verified 2026-07-22 (owner "go ahead").**
  prod `gifsy-api` on Direct VPC egress (canary rev `00026-hap` + `/health/ready` startup probe → ramp 10→50→100%, DB SELECT 1 over
  direct egress 200 throughout, zero errors; connector rev `00024-7sp` @0% = instant rollback). All 7 jobs off the connector; both
  workflows updated (`ef8d697`, flags + startup probe = R2 fix). Manual `services update` cutover, decoupled from feature cutover #12.
  **✅ Phase 4 DONE (2026-07-22, owner option-b — portal not live → no soak): connector `gifsy-connector` DELETED, ~₹1,445/mo saved,
  MIGRATION COMPLETE.** Post-delete verified prod+staging `/health/ready` 200 `{db:up}`, zero errors; terraform connector resource removed
  (`0b8b5f0`, validate Success). Combined session infra savings (Redis+connector) ≈ **₹10k/mo (~57%)**, zero prod impact. Residual cosmetic
  only (stale `00025-xey` canary rev, empty `gifsy-repo`, old connector revs auto-GC'd). Architecture record: `platform/docs/plans/INFRA-ARCHITECTURE.md` (all 3 changes); migration plan: `platform/docs/plans/DIRECT-VPC-EGRESS-MIGRATION.md`; detail [[infra-cost-reduction]].
  **✅ DONE (2026-07-22): Artifact Registry durable cleanup policy LIVE on `gifsy-images`** (independent-audited SAFE, dry-run-verified,
  enabled live; 4 serving images confirmed intact). Was a KEEP-only `keep-last-10` that deleted nothing (repo ~94GB / 699 imgs, all <40d
  = temporary build churn). New policy per owner steering (design for FUTURE steady-state, not current churn): keep-prod-latest (anchors
  current prod via `latest` tag) + keep-recent-30 + delete-untagged>7d + delete-old>30d (self-adapting retention). Untagged=0 disproved the
  multi-arch outage risk. Immediate reclaim small (~62 old imgs); bulk self-reduces as staging ages out + building slows. Policy JSON in
  session scratchpad. Trivial pending: drop empty `gifsy-repo` (0 bytes) after a ref-check. **REMAINING LEVERS (owner decision open):**
  prod Cloud Run min=1→0 + pause prod schedulers (~₹800/mo — note push-drain pings every minute, so staging isn't truly sleeping either);
  stop `gifsy-db`/`gifsy-db-dev` when fully frozen (needs the staging-UAT?/dev-continuing? answers). (Dead `ioredis`/`cache-manager`
  deps ✅ REMOVED from api/package.json 2026-07-22, gate-green.) All prod/staging infra changes owner-gated; gcloud+wrangler authed; terraform in `terraform/`.
- **✅ E2E HARNESS REVIVAL — DONE (test-only, zero prod impact) — `platform/docs/plans/E2E-HARNESS-REVIVAL.md`.**
  Revived + clean-baselined (`4b0d03f`+`f89697c`, 295/0/3, reproducible on a fresh gifsy_dev; runs against a local
  prod build, auto reset+seeds via `e2e/global-setup.ts`). ALL of (A) requestAs (was the run-target, not a bug),
  (B) the stale specs, (C) operator-switch — resolved. Only optional remainder: the **STAGING run mode**
  (`E2E_ENV=staging`, real subdomains, OTP-fetch) is a separate, not-yet-exercised path (there, no DB reset is
  possible — the specs' robust assertions carry it) — do it only if wiring the harness into CI against staging.
- **§A-DOMAIN — ✅ COMPLETE + LIVE ON PROD** (cutover #11 `e8de31a`, 2026-07-20): DB routing (D-1) + features-from-`/me`
  (P5) + S1 edge-secret enforcing (verified). Nothing left except the owner's real-OTP prod smoke.
- **Owner-gated Deoleo go-live: ✅ ALL CLEARED** (master data #76 loaded, both KYC WhatsApp templates
  verified on staging, two reward catalog items fixed+active). Only remaining owner step = the **live
  end-to-end prod smoke** (above).
- **Blocked on an owner DECISION:** Notifications-Core go/no-go — the queue drainer is **PUSH-only**, so
  enqueued SMS/EMAIL/WhatsApp never deliver (genuinely dead: credit-batch EMAIL, KYC owner SMS for
  UNDER_REVIEW, redemption-fulfilment SMS). Recipients recorded (nikunj.sadani@ / payel.ghosh@ /
  nikita@gifsy.in). + **email provider** ZeptoMail (~$0.25/1k) vs SES (~$0.10/1k).
- **§A-DOMAIN** — P1/P2/P4/P4b IN PROD (cutover #10); P3 worker DEPLOYED (`eb56c29b`, live); branding-backfill
  live in prod DB. **D-1 ✅ + P5 ✅ DONE on develop (`9872806`/`c4d1cf9`, audited GO, staging-verified)** — the DB
  is now the full runtime source-of-truth (features/RBAC/capture-mode read `clients`; FE features from authenticated
  /me; registry reduced to fallback). **P6 ✅ DONE on develop + staging: proxy/worker unit tests + favicon-from-DB-branding
  (runtime-verified) + 2nd-tenant DB-routing E2E all SHIPPED; S1 edge-secret ENFORCING on staging (owner added the
  `EDGE_SECRET` GitHub secret; redeploy `8f817b9` → runtime-verified: legit edge login 200+deoleo, a forged direct-`.run.app`
  `x-forwarded-host: clientb` → 404+`default` = forge rejected). Prod enforces automatically at cutover #11.** All develop
  work awaits **cutover #11** (owner-gated). **2ND-TENANT list (LOW,
  before client #2): admin features-loading gate · MIS_USER feature fallback · Option-C multi-outlet.**
  See IMMEDIATE NEXT. **Data-hygiene ✅ DONE `b1ece3b`: committed `public/favicons/{deoleo,clientb}.ico` (byte-identical
  copies of the canonical `/icons/<slug>/favicon.ico`) so the stored `branding.faviconUrl=/favicons/<slug>.ico` now resolves
  (no DB write). The layout still emits the canonical `/icons/<slug>/` path via the helper — the copies just make the stored value valid.**
- **#74 residual:** optional secret rotation + real prod MSG91 (monitoring + backups/PITR already ON).
- **POST-GO-LIVE-BACKLOG (later):** multi-tenant SSR branding, configurable RBAC (AF-12 kept OFF),
  WhatsApp per-tenant generalization, OTel O3, DB-RLS, invoice-PDF/email, TDS filing, DPDP, analytics.

## READ FIRST
`GO-LIVE-ISSUE-LIST.md` (⭐ master tracker) · memories **[[deoleo-go-live-bundle]]** (FIRST for any
launch/UAT/staging/cutover work — holds the full NEWEST chronology) · [[employee-rewards-product]] ·
[[admin-dashboard-consolidation]] [[global-settings-wiring]] [[sales-hierarchy-scoping]]
[[migration-model]] [[staging-deploy-gate]] [[audit-every-build-item]]. Full cutover as-run record =
`runbooks/PROD-CUTOVER-RECORD.md`; runbook = `runbooks/CUTOVER-RUNBOOK.md`.

## CUTOVER LEDGER (compact — detail in [[deoleo-go-live-bundle]])
| # | prod SHA | payload |
|---|---|---|
| 1 | `2fa020c` | first prod (213 commits + 8 migrations) + bootstrap (first GIFSY_ADMIN + 4 OutletTypes) + PWA live |
| 2 | `a2f5929` | onboard-slug fix + per-tenant points-expiry + admin pagination; Deoleo tenant created |
| 3 | `9d366f9`→`eb841e9` | field-level re-KYC batch + hierarchy phone-orphan fix + Deoleo login logo + `/brand/*` matcher fix |
| 4 | `824eac0` | rewards FREE_AMOUNT blank-max fix + Credits/Payouts Config card |
| 5 | `5c2bb65` | sales-KYC UAT (per-doc tag, re-KYC amber badges, approval stepper + reviewer label) |
| 6 | `c36f6c8` | per-tenant per-purpose OTP templates + re-KYC wizard skip + 24h assume TTL |
| 7 | `98ced7a` | targets-404, `isPrimary` blank-outlet sweep, push click-URLs, KYC-SLA wiring, `deoleo_points_credit`/`payout_credit` money WhatsApps + audit fixes |
| 8 | `4b33e4c` | presence-based partner wallet, sales+partner ledger field-name (shared resolver), pre-OTP copy |
| 9 | `ebd474b` | payout UTR "Apply" query-vs-body fix |
| 10 | `437045a` | (2026-07-19) — wallet-surfacing (credit payouts in partner wallet) + §A-DOMAIN P1/P2/P4/P4b + `client_domains` migration; verified live |
| 11 | `e8de31a` | (2026-07-20) — §A-DOMAIN COMPLETE: sales-ledger payout unification + D-1 (resolveClient→clients) + P5 (registry-code retire, features from /me) + P6 (S1 edge-secret NOW ENFORCING on prod + proxy/worker tests + favicon-from-DB-branding + 2nd-tenant E2E + 2 finding-fixes `58ce1ab`). 24 commits, CODE-ONLY (no migrations); verified live. Backup `1784547142461` |
| 12 | `d028566` | (2026-07-22) — per-outlet PAYOUT MANDATE (`Outlet.requiredPaymentType`, live no-flag) + KYC address-proof WAIVER + infra-workflow (Direct-VPC-egress + `/health/ready` startup probe + `REDIS_URL` removal). 33 commits, **2 additive migrations** (`..._add_outlet_required_payment_type`, `..._add_kyc_address_name_mismatch`) verified applied; both services `/health/ready` 200. Rollback ref `e8de31a` |
| 13 | `2187498` | **CURRENT PROD** (2026-07-22) — waiver SEMANTICS-FIX (drops ONLY the self-declaration; Address Proof stays required) + prod deoleo `clients.features.kycAddressProofWaiver=true` SET (guarded write, keycount 10→11, rbac untouched). 1 commit, CODE-ONLY (no migrations); verified live (SHA, /health/ready). Waiver now LIVE for Deoleo. Rollback ref `d028566` |

## START THE SESSION
Greet. State current status, then present the open pickups and ask which to take (do NOT hard-lead one — the next move is
the owner's choice among the leftovers below).

**🏗️ ACTIVE WORK — PARTNER → MULTIPLE OUTLETS (parent-child owner groups). Full AS-BUILT + cutover checklist =
`platform/docs/plans/PARTNER-MULTI-OUTLET.md` §9; memory [[partner-multi-outlet]] (READ BOTH FIRST).** Owner-driven, multi-wave
orchestrated build. **✅ WAVE 1 + 2 + 3 + 4 ALL DONE — the FULL feature is complete on develop (verify HEAD via `git log`;
develop HEAD = docs `a7fca57` on top of feature `04008d0`), gate GREEN (api jest 1745 · nest 0 · FE vitest 1984 · tsc 0),
adversarial-audited + staging-verified. NOT in prod — owner-gated cutover pending.**

> 🛑 **CUTOVER ATTEMPTED 2026-07-23 → BLOCKED on the prod dup-PAN pre-check (owner decision needed).** The cutover ships 6
> commits (`origin/main..origin/develop`) + **4 additive migrations** (`_partner_multi_outlet_foundation`, `_partner_group_uniqueness`,
> `20260723130000_otp_reference_id`, `20260723140000_scheme_enrollment_by_partner`) — ALL FOUR apply to prod (prod == `2187498`
> is pre-Wave-1). Guarded prod read (`gifsy-oneoff-prodcheck`, GUARD current_database=gifsy_prod) found: scheme-orphans **0** (W3
> migration safe), but **2 duplicate-PAN pairs among the 4 (unapproved, `onboardedAt=null`) prod partners** → the W2 PAN
> partial-unique index would FAIL to build. All 4 are **go-live SMOKE-TEST entries** (names Payel Ghosh / St hukke / niinj /
> nikunj; PAN `ABCDE1234F` is a placeholder; outlet codes `Testoutlet`/`Test23`/`OUT-2026-001/002`): `AAACT9811F`×2
> (CP-OUT-2026-001, CP-OUT-2026-002) + `ABCDE1234F`×2 (CP-Testoutlet, CP-Test23). Deoleo has **no real partners yet**.
> **▶ RESOLUTION NEEDED (owner): confirm these are test → then a guarded prod write (backup + shown SQL + owner OK) to
> soft-delete all 4 (recommended — cleans prod for real onboarding; reversible via `deletedAt=null`) OR null the dup PANs.**
> Then re-run the prod dup-PAN read → 0 → **merge `develop`→`main` + push (I do the merge-push; owner approves the GitHub
> "Deploy — Production" gate)** → CI applies the 4 migrations → verify prod SHA/`/health/ready`/smoke → **post-cutover: create
> the Cloud Scheduler job → `POST /v1/kyc/cleanup-stale-drafts` daily + set `KYC_CLEANUP_SECRET` on prod.** (⚠️ flaky-CI: if the
> prod `test` job flakes, "Re-run failed jobs" so the approval gate appears.) NOTHING has been merged to main — prod untouched. **W4 (final, additive, NO new migrations):** group-leave
via re-KYC (Option A — a PAN-change-away-from-group is an atomic Gifsy-approval departure: standalone-uniqueness-or-rollback,
clears `parentId` in-tx, `willLeaveGroup` reviewer banner) + Phase-2 group roll-ups (`GET /partner/group/{targets,visibility,
leaderboard}`, own-group-guarded, visibility gated on the tenant flag) + scheme-catalog eligibility fix (opt-in allowlist —
was a dead `id IN ()` hiding ALL schemes from ALL partners; threaded through the picker). **W3 + W4 runtime-verified on the
staging `w3test-*` group (`04008d0`): picker/switch/overview + Phase-2 roll-ups (targets/visibility-flag-gated/leaderboard) +
scheme-catalog `0→2` + own-group-guard all green; group-leave covered by 223 kyc unit tests + audit (owner UAT for the full
re-KYC→approval flow).** W1+W2 as-built (design evolved — §9 authoritative): single-source-of-truth
`Outlet.parentId` + trigger-derived `ChannelPartner.groupId`; PAN+GST hard partial-unique DB indexes, bank/UPI app+advisory-lock;
parent entity + admin Parent-ID upload + dedicated un-group; **re-KYC STAGE-AT-APPROVAL** (proposed identity/payout+address staged
on `KycSubmission.proposedPartner`, applied only at Gifsy approval); reserve-at-submit + 48h cleanup. **W3 as-built:** **login picker**
(outlet identity is NOT in the JWT → re-resolved per request; login-less same-group same-phone siblings reached via httpOnly cookie
`active_partner_id` → proxy header **`x-active-partner-id`** → EVERY partner-self site re-authorizes via `resolveActivePartnerId`;
money/write paths **fail-closed**, shell `/partner/me` **degrades-to-own** + `activeSelectorInvalid`→FE self-heals + logout clears the
cookie — a stale/shared-device cookie never bricks the portal); **read-only group wallet overview** (`GET /v1/partner/group/wallet`,
new GroupService, sum of Int POINTS + per-outlet drill-down + own-group cross-check); **Stream C** child KYC parent pre-fill (PAN
locked to group PAN) + verified-on-parent badge (server booleans, pre-mask, PII-safe); **scheme enrollment RE-KEYED by shop**
(`@@unique[schemeId,partnerId]`, userId nullable) so login-less siblings self-enroll; **order-bound redemption OTP** (`OtpCode.referenceId`).
**4 additive migrations** (all on staging; ALL FOUR apply to prod at cutover — prod is pre-Wave-1). **▶ NEXT = resolve the CUTOVER
BLOCKER (prod dup-PAN test data — see the 🛑 note in CURRENT STATE) → owner UAT on staging (real OTP) → owner-gated cutover.**
**⚠️ CUTOVER CHECKLIST (prod dup-PAN [FOUND: 4 test partners, 2 dup pairs — clean first] + scheme-orphan [0] pre-checks · Cloud
Scheduler + `KYC_CLEANUP_SECRET` post-cutover · bank/UPI dup sweep before flipping policy) — see PARTNER-MULTI-OUTLET.md §9.**
Owner decisions locked this session: Option-A group-leave (built, §4.5 `TODO(wave4)` now RESOLVED); scheme-enrollment re-keyed by
shop (built); `parentPrefill` kept in the sales-outlet list (authorized staff only, not tightened).

**STATE (prior work, all LIVE):** prod == main == `2187498` (CUTOVERS #12 `d028566` + #13 `2187498`, LIVE 2026-07-22). Both develop
features LIVE in prod: PER-OUTLET PAYOUT MANDATE (no flag) + KYC ADDRESS-PROOF WAIVER (semantics-corrected + prod flag SET). Only
remaining verify = the owner's real-OTP prod check of the KYC form. Verify HEADs via `git log`.

**✅ INFRA COST-REDUCTION — FULLY COMPLETE this session (2026-07-22). Canonical doc = `platform/docs/plans/INFRA-ARCHITECTURE.md`
(current topology + the change log + the "Leftover / open infra items" pick-up list); detail in memory [[infra-cost-reduction]].**
Three changes DONE + runtime-verified, **~₹10k/mo (~57% of the bill) saved, zero prod impact:** (1) **Redis DELETED** (both
Memorystore instances + `REDIS_URL` secret + prod env + the dead `ioredis`/`cache-manager` deps — was never wired); (2) **VPC connector
→ Direct VPC egress** (`gifsy-connector` migrated then DELETED — prod cut over via canary→ramp + a `/health/ready` startup probe; both
workflows + terraform updated; all 7 jobs migrated); (3) **Artifact Registry durable cleanup policy LIVE** + stray `gifsy-repo` deleted.
All stale Redis/connector refs swept from code + docs; independent grep-audit clean; gate green; `terraform validate` OK.

**▶ LEFTOVER / NEXT PICKUPS (all owner-DECISION-gated — nothing half-built; see INFRA-ARCHITECTURE.md "Leftover / open infra items"):**
1. **Infra pause levers** — only if Deoleo go-live slips post-Sept: prod Cloud-Run-min-0 + pause prod schedulers (~₹800/mo), stop
   `gifsy-db-dev`/`gifsy-db` in a full freeze (~₹1k/₹2k/mo). **Blocked on two owner answers: is staging-UAT needed during the pause? is
   dev continuing?** Reversible; bring-up < 1hr.
2. ✅ **Cutover #12/#13 DONE** (2026-07-22) — both develop features + the waiver semantics-fix + the prod waiver flag are LIVE.
   Only remaining = the owner's real-OTP prod UAT of the KYC form.
3. **Other open threads** (below): Notifications-Core go/no-go (owner decision), #74 owner-ops (monitoring/backups/cred-rotation), the
   E2E harness STAGING run-mode (optional), the 2ND-TENANT LOW items + POST-GO-LIVE-BACKLOG.

Then ask which to pick up. **REMEMBER: never unilaterally defer follow-up work — surface it, let the owner decide** [[no-unilateral-deferral]];
orchestrate substantial work by default [[default-to-orchestration]].
```
