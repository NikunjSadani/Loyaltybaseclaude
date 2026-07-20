# RESUME — Loyaltybase restart prompt

Multi-tenant FMCG **trade-loyalty** platform (operator Gifsy; live client Deoleo). Backend `api/`
(NestJS + Prisma — owns the DB + ALL business logic) · thin FE `platform/` (Next.js, proxies
`/api/*` → backend `/v1/*`). Work on **`develop`** (auto-deploys to staging). Repo root:
`C:\Users\nikun\Loyaltybaseclaude`.

> Working agreements, gates, and guardrails live in **`CLAUDE.md`** (auto-loaded) — not duplicated here.
> This file is *current state + the traps + what's open*. **Always verify HEADs via `git log`; never trust a hardcoded SHA.**

---

## 🟢 CURRENT STATE
- **prod == main == `437045a`** (CUTOVER #10, live 2026-07-19 — WALLET-SURFACING + §A-DOMAIN P1/P2/P4/P4b).
  **develop is ~67 commits AHEAD of prod** (HEAD `b1ece3b`) — everything below is on develop/staging,
  staging-verified, **NOT in prod yet** → awaiting the next owner-gated cutover (#11). Verify HEADs via `git log`.
- **develop payload beyond prod (all done + gate-green + staging-verified this session):**
  **sales-ledger payout unification** (`af9948b`), **§A-DOMAIN D-1** (`9872806`, resolveClient→clients table),
  **§A-DOMAIN P5** (`c4d1cf9`, registry-code retired: features from authenticated /me), **P6/S1 edge-secret**
  (`98ea243`+`a90d75b`, code shipped INERT), and the **P6 hardening batch** (`4cab103` favicon-from-DB-branding +
  `ad2b074` proxy/worker unit tests + `f578cad` 2nd-tenant DB-routing E2E + seed). Plus the P3 worker (deployed to
  CF edge, now stamping the edge secret — version `44088f8a`) + branding-backfill (live in prod DB, needed no cutover).
- **DB tenant-routing LIVE in prod** (`TENANT_ROUTING_SOURCE` default `db`, registry fallback → Deoleo
  unaffected). Kill-switch: `TENANT_ROUTING_SOURCE=registry` on the FE service.
- Gate green on develop `b1ece3b`: **api jest 1540 · nest 0 · FE vitest 1917 · tsc 0**. (prod `437045a`
  gate was api 1529 · FE 1844.)

## ▶ IMMEDIATE NEXT — finish §A-DOMAIN P6 + cutover #11
P0–P2 + P4/P4b IN PROD; **P3 + D-1 + P5 ✅ DONE on develop (staging-verified, awaiting cutover #11)**. **P6 is now
~done on develop (tests + favicon + E2E shipped `f578cad`, staging-verified); only the owner-gated S1 enforcement
tail remains.** Plans: `A-DOMAIN-PLAN.md`, `A-DOMAIN-P0-DESIGN.md`. Status:
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
- **P6 (#158) — ~DONE on develop; only the owner-gated S1 enforcement tail remains.**
  - **S1 edge-secret — WORKER ACTIVATED, frontend still INERT (2026-07-20).** The `*.run.app` origins are public
    (`ingress=all` + IAM `allUsers`, verified) → a direct hit could forge `x-forwarded-host` (bounded: post-login scope
    is JWT-enforced). Fix = an **edge secret**: worker stamps `x-edge-secret`; `lib/platform/edge-trust.ts`
    `resolveTrustedHost` (used by `proxy.ts` + `auth/login/actions.ts`) trusts `x-forwarded-host` ONLY when it matches,
    else falls back to Host (safe). **Env-gated** (`EDGE_SECRET` unset/empty → inert → prior behaviour). **DONE:** a
    256-bit secret is bound to the `gifsy-proxy` worker (`wrangler secret put`) + the worker is redeployed (version
    `44088f8a`) so it now strips any inbound `x-edge-secret` and stamps the real one; legit hosts re-smoke-tested 200
    (deoleo prod+uat login, api, apex). The value is in the scratch file `EDGE_SECRET-owner-handoff.txt` (NOT chat).
    **▶ REMAINING (owner + me):** (1) **OWNER adds the `EDGE_SECRET` GitHub Actions repo secret** = that value (gh CLI
    NOT installed → I can't); (2) next staging deploy makes staging ENFORCE → I verify a forged direct-`.run.app` hit no
    longer resolves a foreign tenant; (3) prod enforces at cutover #11 (deploy.yml already injects `EDGE_SECRET`).
    **CRITICAL ORDERING (already satisfied):** the worker must stamp the secret BEFORE any frontend enforces — the worker
    is live now, all frontends inert, so adding the GitHub secret is safe in any order.
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

## 🔶 STANDING MODE — orchestrator
Default to orchestrating substantial work: decompose into **parallel sub-agents** (they write code —
background agents are denied shell; YOU run the gates), integrate shared files yourself, and ALWAYS
personally do the **INDEPENDENT adversarial audit + full gate + runtime-verify** before claiming
done. Own doc + memory consistency in the same pass. The 5 working agreements are in `CLAUDE.md`.
[[default-to-orchestration]] [[audit-every-build-item]] [[verify-flows-at-runtime]] [[own-consistency-no-micromanage]]

## GATES (full suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`)
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` ·
`cd platform && npx tsc --noEmit`. **Latest green (develop `b1ece3b`): api jest 1540 · nest 0 · FE vitest 1917 · tsc 0.**
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
  /me; registry reduced to fallback). **P6 ~DONE on develop (`f578cad`): proxy/worker unit tests + favicon-from-DB-branding
  (runtime-verified) + 2nd-tenant DB-routing E2E all SHIPPED; S1 edge-secret WORKER ACTIVATED (secret bound + worker
  `44088f8a` stamping, frontend still inert). Remaining = owner adds the `EDGE_SECRET` GitHub secret → I runtime-verify
  staging enforcement (forged-host).** All develop work awaits **cutover #11** (owner-gated). **2ND-TENANT list (LOW,
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
| 10 | `437045a` | **CURRENT PROD** (2026-07-19) — wallet-surfacing (credit payouts in partner wallet) + §A-DOMAIN P1/P2/P4/P4b + `client_domains` migration; verified live |
| 11 | *(pending, develop `b1ece3b`)* | **NOT YET CUT** — sales-ledger payout unification + §A-DOMAIN D-1 (resolveClient→clients) + P5 (registry-code retire, features from /me) + P6 (S1 edge-secret [worker activated, FE inert] + proxy/worker tests + favicon-from-DB-branding + 2nd-tenant E2E + the 2 finding-fixes `58ce1ab` + favicon data-hygiene `b1ece3b`). ~67 commits ahead; all staging-verified; owner-gated |

## START THE SESSION
Greet. State: **prod == main == `437045a` (cutover #10 live); develop is ~66 commits AHEAD (HEAD `58ce1ab`),
all staging-verified, awaiting cutover #11.** §A-DOMAIN: P1/P2/P4/P4b IN PROD; **P3 + D-1 + P5 ✅ DONE on develop**
(DB is now the full runtime source-of-truth); **P6 ~DONE** — proxy/worker tests + favicon-from-DB-branding + 2nd-tenant
DB-routing E2E all shipped (`f578cad`, runtime-verified); S1 edge-secret WORKER ACTIVATED (secret bound + worker
`44088f8a` stamping, FE inert) — the ONLY remaining P6 step is the owner adding the `EDGE_SECRET` GitHub secret so I can
runtime-verify staging enforcement. Then cutover #11. Present the OPEN THREADS and ask which to pick up.
```
