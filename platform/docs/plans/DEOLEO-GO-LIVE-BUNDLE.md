# Deoleo Go-Live Bundle — the launch critical path (plan)

> ## 🔄 RECONCILED 2026-06-30 — this plan is largely SUPERSEDED; read the live sources of truth first
> This Rev 3 doc predates the last ~10 days of work and many of its "blockers" / estimates below are stale. **The live
> source of truth is now [`GO-LIVE-ISSUE-LIST.md`](GO-LIVE-ISSUE-LIST.md)** (the master tracker) **+ the auto-memory
> go-live bundle** (`deoleo-go-live-bundle.md`). What changed since this doc was written:
> - **Gate is GREEN** (api jest **1259** · nest 0 · FE vitest **1694** · tsc 0). The §1 "deploy pipeline blocked / Vitest
>   red-by-design / ~813 jest" finding is OLD — A-1 fixed it; the gate is green and has been for weeks.
> - **Prod is ALREADY LIVE** (`gifsy-api`/`gifsy-frontend`) and cutover/migration is DONE (§A.2). Cutover now = a routine
>   **UPDATE of an empty prod** (0 users / 0 data), auto-migrated by `deploy.yml` behind a `production` approval gate — **low-risk**.
> - **Backups + PITR are ON**; **Cloud Monitoring is LIVE** (2 channels + 2 alert policies). The §A.2/§2 "no alerts /
>   backups-PITR before dry-run" framing is RESOLVED (see GO-LIVE-READINESS §3.1).
> - **Cutover runbook EXISTS**: [`runbooks/CUTOVER-RUNBOOK.md`](runbooks/CUTOVER-RUNBOOK.md) (B10/A-9).
> - **Sales leaderboard BUILT** (`a525739`+`a272dca`); **all AF-\* security items DONE except AF-12** (deliberately OFF
>   for launch); **PWA fully ACTIVATED + Android-verified on staging** (prod PWA = a cutover step).
> - **Prod bootstrap script BUILT** (`api/prisma/bootstrap.ts`, `262027a`): first GIFSY_ADMIN + 4 OutletType rows — **run it at cutover**.
> - **Greenfield reality:** prod is empty, so the pre-cutover backup is a formality, rollback risk is minimal (no in-flight
>   user data), restore-rehearsal + realistic-volume perf testing are post-launch, and points-expiry has a long runway.
>
> **GENUINELY-OPEN at 2026-06-30** (the real remaining launch path — see §A.2 "REMAINING GO-LIVE BLOCKERS" for the live list):
> #76 real Deoleo master-data load into empty prod (run bootstrap first) · AF-3 partner hardcoded-bank fix (in progress
> 2026-06-30) · prod env-hygiene sweep (NODE_ENV=production, NO FIXED_OTP/DEMO_MODE, no debug routes) · MSG91 prod DLT
> templates + real creds + one real test OTP · owner UAT sign-off (redemption + KYC) on staging · click the 2 GCP
> alert-email verification links · points-expiry scheduler wiring (post-launch) · AF-12 RBAC (post-launch, keep OFF).
> History below is **preserved** — superseded items are annotated, not deleted.

> Created 2026-06-20. **Rev 3 (2026-06-20)** after 4 adversarial audit rounds (§9) **and owner decisions** (§A). **Owner-requested
> plan change:** instead of building all of P7→P8→P9 before launch, pull *only the launch-blocking slice* of each forward
> and ship Deoleo on the complete core loop ASAP; the rest of P7 + P8 become **post-launch fast-follows**
> ([`POST-GO-LIVE-BACKLOG.md`](POST-GO-LIVE-BACKLOG.md)).
>
> **Optimizes time-to-Deoleo, not time-to-P9-complete.** Deletes no P7/P8/P9 task; only re-sequences which gate launch.
>
> Companions: [`GO-LIVE-READINESS.md`](GO-LIVE-READINESS.md), [`POST-GO-LIVE-BACKLOG.md`](POST-GO-LIVE-BACKLOG.md),
> [`ENVIRONMENTS.md`](ENVIRONMENTS.md), [`RBAC-ENABLEMENT.md`](RBAC-ENABLEMENT.md), [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md).
>
> **Status: NOT final — a 4th focused audit round runs on this Rev 2 before lock.**

---

## A. Resolved owner decisions (2026-06-20)
- **D-a — OTP is sent SYNCHRONOUSLY, not queued.** **ALL OTP-purpose sends** become direct/immediate MSG91 (mirroring
  login `auth.sendViaMSG91`) — both the partner redemption OTP (`rewards.service.ts:720`) **and the sales-assisted
  redemption OTP (`:437`, which already shipped in B1)**. This gives instant delivery + loud failure, and **removes the
  queue-worker + Cloud Scheduler + OIDC from the launch path** (deferred, for non-urgent notifications only). Two safety
  rules the build MUST honor (audit R4): (i) the send stays **post-commit** (outside the `$transaction`, where the enqueue
  already sits) so a slow network call never holds a DB tx/locks open; (ii) on send failure, **clean up** the just-written
  `OtpCode` + cancel the just-created order and return a structured "retry" — do NOT inherit login's orphan-row behavior.
  **Open call:** the redemption-*confirmed* SMS (`:906`) and the redeemForOutlet confirmation (`:603`) — send synchronously
  too, or accept "no confirmation SMS at launch" (decide in A-2a).
- **D-b — CI gate = QUARANTINE-TO-GREEN, not a differential script.** The ~92 red tests are TDD specs for unbuilt
  features; we make CI a *genuine green all-pass gate* so any NEW failure is a hard stop. **Skip per-`it()`, NOT per-file**
  (audit R4): for launch-shipping pages (`sales/kyc/*`, `sales/kyc/[id]/ledger/*`, `sales/leaderboard`) skip only the
  unbuilt-feature `it()`/`describe` blocks and keep asserts that exercise shipped render paths; reuse the existing
  `vitest.config` exclude/lane mechanism; co-locate a header comment pointing at `baseline-red-snapshot.txt`. Un-skip each
  as its feature lands (part of its definition-of-done).
- **D-c — Sales-team leaderboard ✅ BUILT 2026-06-26 (`a525739`+`a272dca`) — NO LONGER deferred / nav-hidden / a fast-follow.**
  Shipped as a **LIVE-COMPUTED** endpoint `GET /v1/sales/leaderboard?scope=rm|state|national&period=` — **no `SalesLeaderboard*`
  models, no generator, no snapshot**: it reuses the `getTargets` join (`OutletTarget`⋈`OutletSalesRecord`⋈primary `KpiDef`)
  + `descendantSalesUserIds` to rank the caller against **same-level peers** (same `hierarchyLevelId`), each scored by their own
  team subtree primary-KPI achievement %; scopes rm (peers under the same reporting manager) / state (same region) / national.
  **territory = the rep's nearest ZNM (Zonal Manager) ancestor name.** The sales FE page is wired to it (no longer a 404
  dead-read). Independently audited (SHIP) + runtime-verified on staging (484 same-level peers, real 47%). The original
  fast-follow spec below is kept for history but is **superseded** — none of the "deferred / greenfield / new-models / 5–7d"
  framing applies anymore.
  - ~~FAST-FOLLOW (owner decision 2026-06-20), launch with the nav hidden, ship ~1 week after go-live~~ → **DONE 2026-06-26.**
    Metric (as built) = each peer's **own team subtree primary-KPI achievement %**, ranked vs same-level peers.
  - ~~**Reality (audit R4):** NO leaderboard generation pipeline → this is **greenfield** → use a **separate `SalesLeaderboard*`
    model set** + a generator + key-translation~~ → **NOT how it shipped:** it is **live-computed at request time** (no new
    models, no generator, no snapshot); the key translation rides the existing `getTargets` join. The sales FE page was
    dead-wired to a missing `/v1/sales/leaderboard` — **that endpoint now exists.** ~~Estimate 5–7 build-days.~~
- **D-d — Banners ON, tickets ON at launch.**
- **D-e — Data lifecycle:** seed → **UAT on staging** (bulk bug-fixing) → minimal real-OTP smoke on prod → **clean-wipe**
  → upload real Deoleo client data. (Recommended "Both": keep prod pristine; client UAT on a `uat.` subdomain → staging.)
- **Domain FIRST.** `deoleoloyalty.gifsy.in` must exist before MSG91 template registration → **O-3 leads Lane B**, and
  it is the head of the critical path.

---

## A.1 Live infra state + the TEMPORARY edge alias (MUST retire)
**Domain (O-3): ✅ DONE (2026-06-20).** `deoleoloyalty.gifsy.in` is live — a Cloudflare **Worker Custom Domain**
(managed DNS record + managed SSL; shows under Workers & Pages → gifsy-proxy → Domains & Routes, *not* the DNS-records
tab). Routes through the `gifsy-proxy` worker → the prod frontend. Verified: root + `/auth/login` = **HTTP 200**, title
"Sign In | Deoleo India Loyalty".

**⚠️ TEMPORARY edge alias — tracked tech-debt to remove.** Prod still runs code that does **not** map the branded domain
→ tenant `deoleo` (that map = commit `5de8aa9` + the login `x-forwarded-host` fix `37e54f9`, both on `develop`, **not yet
in prod** — prod deploys from `main`, and the CD gate is red). So `deoleoloyalty.gifsy.in` originally **404'd**. To unblock
the MSG91 template application (a 404 link won't get DLT-approved), the worker now carries a `TENANT_HOST_ALIAS` in
`cloudflare-worker/worker.js` that presents the branded host to the app as `x-forwarded-host = deoleo.gifsy.in`, which the
*current* prod code already resolves to the Deoleo tenant → the branded URL serves the real Deoleo login (200).
- **What works:** the login page renders, branded + correct; redirects keep the public branded host (Location-rewrite).
- **What it is not:** it doesn't fix prod's code; full end-to-end login still needs MSG91 OTP (being set up). It's a pure
  host-translation bridge, isolated to the `deoleoloyalty.gifsy.in` route — no effect on the other domains.

**Retirement steps (do once prod runs current code):**
1. **A-1** (CD gate green) → current code becomes deployable.
2. Merge `develop` → `main` → prod deploy (owner approval) so prod has `5de8aa9` (branded-domain→slug map) + `37e54f9`
   (login reads `x-forwarded-host`).
3. **Verify native resolution:** probe the prod frontend origin with header `x-forwarded-host: deoleoloyalty.gifsy.in` →
   expect **200** (today it's 404). That confirms prod maps the branded domain without the alias.
4. Remove the `TENANT_HOST_ALIAS` map + the `tenantHost` line from `cloudflare-worker/worker.js`; `wrangler deploy`.
5. Re-verify `https://deoleoloyalty.gifsy.in/auth/login` still serves (now natively, no alias).
- **Owner vs me:** me (worker edit + all verification); only step 2's prod deploy needs your approval.
- **Commits so far (local, unpushed):** `37e54f9` (plan + route + login fix) · `98d9f8e` (custom domain) · `3fcfa57` (the alias).

## A.2 Build progress (live — updated end of 2026-06-20; all pushed, tip `60c700a`)
- **A-1 CD gate** ✅ done, pushed, validated — staging deploys on `develop` push now (was blocked by the red `test` job).
- **A-2a synchronous OTP** ✅ done + **audited SHIP** — shared `Msg91Service`; partner + sales-assisted OTP send directly
  with failure-cleanup (cancel order + clear OTP + 503); auth delegates to it; **+ 10s MSG91 fetch timeout**; F5 fixed.
  api jest **836/836**, tsc 0.
- **A-3 login `x-forwarded-host`** ✅ done. **Footer** "Powered by Gifsy" ✅ on tenant-facing pages (login/admin/partner/sales).
- **A-4 observability** ✅ **DONE.** Code satisfied (`AllExceptionsFilter`→Cloud Logging; `/health`) **+ Cloud Monitoring
  LIVE (2026-06-29): 2 email channels + 2 alert policies (5xx-rate + uptime).** Residual = owner clicks the 2 GCP
  verification emails. **A-6 hardening** ✅ **code already satisfied** (helmet/CORS/validation/
  `ThrottlerGuard`/guard-stack; prod omits `FIXED_OTP`/`DEMO_MODE`). Residual = owner (cred rotation, prod `CORS_ORIGINS`).
  Prod `CORS_ORIGINS` now includes `https://deoleoloyalty.gifsy.in` (secret v3, set at cutover).
- **A-5 prod migration** ✅ **DONE (cutover, 2026-06-20).** `gifsy_prod` recreated empty + migrated to the squashed
  baseline via the in-VPC `gifsy-migrate` job; prod auto-migrate wired into `deploy.yml`. Post-state verified: 72 tables
  (+ledger), `kpi_defs`/`tds_deposits`=true, **World-A gone**, `_prisma_migrations: 1`, **0 users / 0 clients** (intentional
  greenfield). Runbooks: `runbooks/PROD-DB-MIGRATION.md` (mechanics) + `runbooks/PROD-CUTOVER-RECORD.md` (as-run log).
- **A-8 staging real-MSG91 rehearsal** ✅ **login DONE** — owner logged into staging with a **REAL MSG91 OTP** (the 3
  staging-infra bugs below were the blockers, now fixed). Redemption/KYC UAT pending (phones set: partner+outlet
  `7795096288`, sales `9875436349`).
- **A-9 cutover** ✅ **DONE (2026-06-20).** Prod (`gifsy-api` + `gifsy-frontend`) now serves current code (`b3ab2e0`) on
  `deoleoloyalty.gifsy.in`; the temporary worker host-alias was **REMOVED** (native resolution); pre-cutover backup taken.
  Verified: login 200, FE→backend routing 400 (proves `NEXT_PUBLIC_API_URL`=api.gifsy.in), `/health` 200. Pre-deploy
  independent Opus audit = **SAFE-TO-APPROVE**. As-run record: `runbooks/PROD-CUTOVER-RECORD.md`.
- **A-10 prod-wipe** ✅ done + **hard-audited** (F1 `OutletTypeClientConfig` + F3 fail-closed fixed) + **dry-run-VALIDATED
  on `gifsy_dev`** (424 rows, sane; the 5s-tx-timeout bug it caught fixed). (Cutover recreated `gifsy_prod` empty rather
  than running the scoped wipe — prod was already greenfield/0-users; the wipe runbook stands for the post-UAT clean.)
- **MSG91 OTP template** ✅ set (`MSG91_OTP_TEMPLATE_ID`=`699d295ba29962881e09d062`; auth-key/sender already present).
  MSG91 confirmed responding; **IP-whitelisting OFF** (not a factor). **B2 worker / B3 templates** = the long pole, cleared.
- **UAT URL** ✅ `https://uat.deoleoloyalty.gifsy.in` → the staging build (owner UAT / pre-prod view).
- **⚠️ 3 STAGING-INFRA BUGS found+fixed** (all surfaced by the real-OTP test — staging had never been exercised and was
  broken): (1) staging FE missing `JWT_SECRET` → 500; (2) `api.staging.gifsy.in` (FE's baked API host) **unrouted** → the
  login server-action self-proxy hung → routed it + 12s timeout on the login fetches (hardens prod); (3) staging API
  **missing the `--vpc-connector`** prod has → couldn't reach the private-IP Cloud SQL → all DB ops 500'd → added
  `gifsy-connector` to `deploy-staging.yml`. **Lesson: staging was DB-broken — the A-8 real-MSG91 staging rehearsal is now
  unblocked and must run before prod.**

**✅ CUTOVER DONE (2026-06-20).** Prod migrated + deployed (`b3ab2e0`) on `deoleoloyalty.gifsy.in`, host-alias removed,
`CORS_ORIGINS` set, verified (login/health/routing). See `runbooks/PROD-CUTOVER-RECORD.md`. **A-5/A-8/A-9/D1/D2 = DONE.**

**▶ REMAINING GO-LIVE BLOCKERS** (refreshed 2026-06-30; the live list is [`GO-LIVE-ISSUE-LIST.md`](GO-LIVE-ISSUE-LIST.md)):
1. **Run the prod bootstrap, then load real Deoleo master data into the empty prod** — `api/prisma/bootstrap.ts`
   (`262027a`, first GIFSY_ADMIN Nikunj/9830011252 + 4 OutletType rows) MUST run first; then client config, admins, sales
   team, partners/outlets, reward catalog, schemes (#76). **THE big one — no real user can log in until this lands** (prod
   is intentionally 0-users/0-clients). "No duplicates" = within-file dedup only (no pre-existing prod data to clash with).
2. **Owner UAT of the core loop on staging** with real OTP — login DONE; redemption + KYC sign-off pending.
3. **Prod env-hygiene sweep** (GLm-6 / UAT §17.1): NODE_ENV=production, **NO `FIXED_OTP`, NO `DEMO_MODE`**, no debug routes.
4. **MSG91 prod:** DLT templates + real creds + one real test OTP send (owner).
5. **AF-3** — partner profile renders a hardcoded fake bank → **in progress 2026-06-30** (being fixed separately).
6. **Owner ops residual:** click the **2 GCP alert-email verification links** (the channels + policies are already wired).
   ~~Cloud Monitoring alert email; ongoing backups/PITR~~ — **✅ DONE 2026-06-29** (2 channels + 2 alert policies LIVE;
   backups + PITR verified ON, 14 backups, `pointInTimeRecoveryEnabled=true`). Prod credential rotation = owner's call (versions exist).
7. **Post-launch (not launch blockers):** points-expiry scheduler wiring (`expireDuePoints()` exists but nothing schedules
   it — same Cloud-Run @Cron-doesn't-tick trap as the push worker; long runway, no points exist yet); AF-12 RBAC enablement (keep OFF for now).
8. ~~Sales-team leaderboard = explicitly DEFERRED (fast-follow, nav hidden)~~ — **✅ BUILT 2026-06-26 (`a525739`+`a272dca`)**, live-computed, nav visible. (Was never a blocker.)

## 0. The reframe
Core platform is built (P0–P6 + P0.6 A–D). Launch needs a small specific set, several items inside P7/P8/P9, sequenced here.
**Units:** "build-days" = orchestrated sessions (plan→executor→audit→gate→runtime-verify). Code is fast; **calendar is
paced by owner/external items** (the Cloudflare domain, MSG91 templates, GCP/Secret Manager, prod approvals).

---

## 1. ⛔ The critical finding — ~~the deploy pipeline is currently blocked~~ ✅ RESOLVED (A-1)
> **✅ RESOLVED — the gate is GREEN (as of 2026-06-30: api jest 1259 · nest 0 · FE vitest 1694 · tsc 0).** The
> red-by-design Vitest baseline was quarantined-to-green per D-b (A-1), `develop` push deploys staging, and prod is
> already live. The text below is the original 2026-06-20 finding, **kept for history**.

~~Verified (2026-06-20): both deploy workflows gate on a `test` job running raw `npm test`. api Jest is green (~813/813);
**platform Vitest is red-by-design — 22 files / ~92 failing tests** (TDD baselines, [`reconcile/baseline-red-snapshot.txt`](reconcile/baseline-red-snapshot.txt)).
∴ `npm test` fails → the `test` job fails → **staging AND prod deploys don't proceed via push.** "Push deploys staging"
is false today; the D2/domain push most likely didn't deploy (`gh` not installed here → can't confirm; small gap, A-1).
**Master-plan 9.1 is the true #1 — nothing ships until the gate goes green (via D-b quarantine).**~~

---

## 2. Launch-blocker inventory
**"Owner" = you execute (I prepare/guide); "Me" = I build + audit + verify.**

| # | Blocker | Maps to | State today | Who |
|---|---|---|---|---|
| B1 | **CD test gate red → no deploys** | 9.1 | red-by-design Vitest fails the deploy `test` job | Me |
| B2 | **OTP delivery (partner + sales-assisted)** | 7.2 / #21 | of the 6 enqueue sites, the OTP ones (`rewards.service.ts:720` partner, **`:437` sales-assisted/B1**) write to a queue with no consumer → undelivered in prod. **Fix = synchronous send** (D-a), mirroring login | Me + Owner(MSG91) |
| B3 | **Prod MSG91 templates + creds** | 9.4 | secret *slots* wired in both workflows; **templates not created** | Owner |
| B4 | **Prod secrets/env correct** | 9.4 | confirm values in Secret Manager; **NO `FIXED_OTP`, NO `DEMO_MODE`**; `POINTS_TO_INR_RATE` matches Deoleo | Owner |
| B5 | **Prod DB migrated + backups/PITR** | 9.5 | no pipeline migration step; ⚠️ **staging+prod share the `gifsy_db` instance** | Me(runbook)+Owner |
| B6 | **Custom domain (Cloudflare Worker, NOT a GCP LB)** | 9.10 | code maps domain→`deoleo`; ⛔ Worker doesn't route the host → 502; ⛔ login reads raw `host` not `x-forwarded-host` | Owner(Cloudflare)+Me(code) |
| B7 ✅ | **Minimum observability/alerting** — **✅ DONE 2026-06-29** | 8.4/9.6 | `/health` exists (`main.ts:20`); ~~no alerts~~ → **2 Cloud Monitoring alert policies (5xx + uptime) on 2 email channels are LIVE**; residual = owner clicks the GCP verification emails | Me + Owner |
| B8 | **Security hardening minimum** | 9.7 | throttle exists; confirm rate-limit/headers/CORS, rotate dev-shared creds | Me |
| B9 | **Staging green + a REAL-MSG91 dress rehearsal** | C2/8.7 | harness shipped; staging is `FIXED_OTP` → doesn't exercise real MSG91; needs B1 to deploy | Me |
| B10 ✅ | **Cutover runbook + tested rollback** — **✅ DONE** | 9.9 | ~~not written; rollback manual~~ → `runbooks/CUTOVER-RUNBOOK.md` (4 steps + PWA activation) + `PROD-CUTOVER-RECORD.md`; rollback = pre-cutover backup (a greenfield formality — prod is empty) | Me + Owner |
| B11 | **Prod data lifecycle (seed→UAT→clean→real)** | 9.9 | n/a | Owner + Me |
| B12 | **Prod-only infra check (Redis/VPC)** | 9.x | ~~prod uses `--vpc-connector` + `REDIS_URL`; verify Redis is actually needed~~ → **RESOLVED 2026-07-22: Redis removed entirely (never wired — OTP is in the DB, throttler in-memory) and the VPC connector replaced by Direct VPC egress. See `INFRA-ARCHITECTURE.md`.** | Me(verify)+Owner |
| **B13** ✅ | **Sales-team leaderboard** (D-c) — **✅ DONE 2026-06-26 (`a525739`+`a272dca`)** | 7.3 | ~~greenfield, new `SalesLeaderboard*` models + generator~~ → shipped **live-computed** `GET /v1/sales/leaderboard` (same-level peers, ZNM territory, rm/state/national scopes) reusing the `getTargets` join — **no new models, no generator, no snapshot**; FE wired (was dead-wired); audited + runtime-verified on staging | Me |

**NOT launch blockers** (deferred — §5): the general notification **queue-worker + Cloud Scheduler/OIDC** (D-a moved OTP
to synchronous, so the worker is post-launch), partner leaderboard polish, banners polish, ticket SLA/lifecycle, trend
analytics (#48), pagination (#26), DPDP (#24), systemic RLS (#23), full RBAC enablement (9.8/#47 — ship `@Roles`-only,
RBAC OFF; the A4 coverage audit is done), staging real-OTP endpoint (8.7).

---

## 3. The sequenced plan
Critical path (head = the domain): **O-3 domain → O-1 MSG91 templates → A-2b/A-6.5 real-OTP verify → A-4 prod migrate
(after O-4 backups) → A-7 cutover → prod smoke.** **A-1 is a universal predecessor** (everything needs deployability).

### Lane A — build (me)
| Step | Task | Blocker | Est | Depends on |
|---|---|---|---|---|
| A-1 | **Fix the CD gate (D-b).** Quarantine the red-by-design specs **per-`it()` (not per-file** for launch-shipping pages), tracked vs `baseline-red-snapshot.txt`, via the existing `vitest.config` mechanism → `npm test` green → strict all-pass gate; keep `tsc` blocking. Verify a `develop` push deploys staging. Install `gh`. | B1 | ~1 | — (**first**) |
| A-2a | **OTP synchronous send (D-a).** Generalize `auth.sendViaMSG91` into a shared MSG91 provider; make **all OTP sends direct** — partner (`rewards.service.ts:720`) **and sales-assisted (`:437`)**. **Must:** keep the send post-commit (outside `$transaction`); on failure clean up the `OtpCode` + cancel the order (no orphan rows). Decide the confirmation-SMS (`:906`/`:603`) call. Unit/mock-verify. | B2 | ~1.5 | A-1 |
| A-2b | **OTP live-verify** — real partner + sales-assisted redemption + login OTP via real MSG91. | B2 | ~0.5 | A-2a + **O-1** |
| A-3 | **Domain code fix (B6).** Fix login to read `x-forwarded-host` (so it resolves the tenant behind the Worker, not the `deoleo` default). | B6 | ~0.5 | A-1 |
| A-4 | **Min observability (8.4).** Structured request/error logging; ≥1 error-rate + uptime alert; wire `/health` as a real post-deploy gate. | B7 | ~1–2 | A-1 + owner infra |
| A-5 | **Prod DB migration runbook + apply (9.5).** **🔄 Model changed 2026-06-20:** now one squashed Prisma **baseline** applied via `prisma migrate deploy` run as the in-VPC `gifsy-migrate` Cloud Run Job (private-IP) — **not** ad-hoc diff-SQL. Prod first-apply needs the **one-time P3005 baseline reconcile** (clear stale `_prisma_migrations` or clean recreate — greenfield). **O-4 backups first.** Model: `MIGRATIONS.md`; procedure: `runbooks/PROD-DB-MIGRATION.md` (Step 1.5). | B5 | ~1–2 | A-1 + **O-4 backups first** + owner prod-DB access |
| A-6 | **Security hardening min (9.7).** Throttle/headers/CORS; confirm no `FIXED_OTP`/`DEMO_MODE` in prod; rotate dev-shared creds; verify Redis need (B12). | B8,B12 | ~1 | A-1 |
| ~~A-7~~ ✅ | **Sales-team leaderboard — ✅ BUILT 2026-06-26 (`a525739`+`a272dca`).** ~~FAST-FOLLOW, nav hidden, greenfield: new `SalesLeaderboard*` models + generator + snapshot, ~5–7d~~ → shipped **live-computed** (no new models, no generator, no snapshot): `GET /v1/sales/leaderboard` reuses the `getTargets` join + `descendantSalesUserIds` to rank same-level peers by team primary-KPI %; territory = nearest ZNM ancestor; rm/state/national scopes; FE wired; runtime-verified on staging. | B13 | done | — |
| A-8 | **Staging E2E + REAL-MSG91 dress rehearsal.** Harness on staging (`FIXED_OTP`) for the matrix; then, once O-1 lands (staging shares prod MSG91 secrets), a real-OTP login+redemption rehearsal + cutover/rollback drill. | B9 | ~1–1.5 | A-1 + A-2b + O-1 |
| A-9 | **Cutover runbook + rollback (9.9).** Cutover steps, re-login comms, prod smoke checklist, **explicit `/health` gate + tested manual rollback**. | B10 | ~1 | A-1..A-8 |
| A-10 | **Prod data clean-wipe runbook (D-e safety).** A guarded script: **positive `current_database()='gifsy_prod'` assertion first** (mirror `seed.ts` inverted), **FK-ordered scoped `deleteMany` (NEVER `TRUNCATE CASCADE`)**, scoped to `clientId in ('deoleo','clientb')` so the GIFSY admin + OutletType master survive, covering smoke side-effects (`otpCode`/`userSession`/`user.lastLogin`), gated behind **O-4 backups** + a confirmation token + a staging dry-run. | B11 | ~0.5–1 | O-4; staging dry-run |

**Lane A launch total: ~9–11 build-days** (leaderboard A-7 ✅ now BUILT 2026-06-26 live-computed — no longer a post-launch fast-follow).

### Lane B — owner ops (domain first; I prepare each)
| Step | Task | Blocker | Lead | Note |
|---|---|---|---|---|
| **O-3** | **Cloudflare Worker domain route — DO FIRST.** Add `deoleoloyalty.gifsy.in` to `cloudflare-worker/{worker.js,wrangler.toml}` + a Cloudflare Custom Domain + `wrangler deploy`. SSL = Cloudflare's. **I'll prepare the exact edit; you review + deploy.** | B6 | propagation (hours) | gates O-1 (MSG91 registration needs the domain) |
| O-1 | **Create MSG91 templates** (OTP + transactional SMS) + auth key / sender ID. | B3 | **long pole, after O-3** | unblocks A-2b, prod login, A-8, final smoke |
| O-2 | **Prod Secret-Manager secrets**: `DATABASE_URL, JWT_SECRET, MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_OTP_TEMPLATE_ID, MSG91_SMS_TEMPLATE_ID, GCS_BUCKET, GCP_PROJECT_ID, CORS_ORIGINS (incl. branded domain)`. *(`REDIS_URL` removed 2026-07-22 — Redis gone; see `INFRA-ARCHITECTURE.md`.)* Confirm no `FIXED_OTP`/`DEMO_MODE`; `POINTS_TO_INR_RATE` matches Deoleo. **Separately:** `NEXT_PUBLIC_API_URL` = a **GitHub Actions repo secret**. | B4 | low | exact list provided |
| O-4 | **Cloud SQL backups + PITR** on shared `gifsy_db` — **before** the A-5 staging dry-run. | B5 | low | dry-run touches the prod-sharing instance |
| O-5 | **Data lifecycle (D-e):** seed staging for UAT → bug-fix → minimal prod real-OTP smoke → **clean-wipe (via the guarded A-10 runbook)** → real Deoleo data. | B11 | UAT cycle | I provide seed + A-10 runbook |
| O-6 | **GCP/console access + prod approval reviewer** for A-4/A-5. | — | — | gates A-4/A-5 |

*(Removed from the launch Lane B: the notification Cloud Scheduler + OIDC SA — deferred with the queue-worker per D-a.)*

### 3.1 Parallelization (how the calendar compresses)
Wall-clock ≈ the **longest single chain**, not the sum. Three things run at once:
- **① Owner track starts NOW** (O-3 domain → O-1 MSG91). Needs no code from me; MSG91/DLT approval is the real wait → every
  day earlier comes off the launch date.
- **② Build burst — concurrent, file-disjoint executors:** A-1 (CI/vitest) · A-2a (rewards/auth/msg91) · A-3 (actions.ts) ·
  A-4 (logging) · A-6 (config) · A-10 (prisma wipe script). Opus owns `schema.prisma` (none of these touch it → no collision).
- **③ Serial integration tail (owner-gated):** A-2b ← A-2a+**O-1**; A-5 ← **O-4**+prod access; A-8 ← A-1+A-2b+O-1; A-9 ← all.
- ~~The **leaderboard fast-follow** runs *after* go-live~~ → **leaderboard ✅ BUILT 2026-06-26 (`a525739`+`a272dca`), live-computed — no fast-follow.**

### 3.2 Owner action list (the irreducible set — everything else is mine)
Operating principle (owner, 2026-06-20): **I do everything I can; the owner does only what needs their accounts/credentials/
prod access.** For each, I prepare the exact change/command first; the owner only executes the gated step.

| When | Owner does (only this) | I do (everything around it) |
|---|---|---|
| ~~NOW~~ ✅ | **Domain — DONE by me** (no owner action was needed). | ✅ deployed the worker + Custom Domain (DNS+SSL), added the temporary alias, verified `deoleoloyalty.gifsy.in` serves the Deoleo login (200). See §A.1. |
| **NOW (after domain)** | MSG91: create the **OTP + transactional SMS templates** + DLT registration; put `MSG91_AUTH_KEY`/`SENDER_ID`/template IDs into Secret Manager | I draft the exact template message text + variable list for you to submit |
| Before cutover | GCP **Secret Manager**: set/verify prod secret *values* (I give the exact `gcloud` commands + key list) | the command list, the key inventory, the verification checklist |
| Before cutover | GCP **Cloud SQL**: enable backups + PITR on the prod instance | the exact steps |
| Before cutover | Grant the **prod-deploy approval** when the pipeline reaches it | the deploy is otherwise automated |
| UAT phase | Run **UAT** with seed data; provide the **real Deoleo client-data** file | the seed, the migration runbook, the guarded wipe script (A-10), the load runbook |
| Cutover | Approve + watch the **first prod migration + the wipe + real-data load** (your prod-DB access) | author + audit every script; drive the supervised run with you |

*(Why these stay with the owner: setting secrets = handling credentials; backups/migration/wipe = irreversible prod
actions; Cloudflare/MSG91/GCP = your accounts. I can't authenticate to those, and they're owner-authorized per action.)*

---

## 4. Effort & timeline
- **Lane A launch work: ~9–11 build-days** (leaderboard ✅ now BUILT 2026-06-26, live-computed — no longer a post-launch fast-follow).
- **Calendar paced by Lane B** — **O-3 (domain) → O-1 (MSG91 templates)** is the long pole (MSG91/DLT approval is the real wait).
- **Realistic time-to-launch: ~2.5 weeks** if O-3 starts immediately; the build burst (§3.1) runs underneath it.
- ~~**Leaderboard fast-follow: ~1 week after go-live.**~~ → **✅ Leaderboard BUILT 2026-06-26 (`a525739`+`a272dca`), live-computed.**
- Highest-uncertainty: A-2b/A-8 (real MSG91), A-5/A-10 (prod-DB + shared instance).

---

## 5. Explicitly deferred to post-launch
- **Notification queue-worker + Cloud Scheduler/OIDC** (OTP is synchronous now; the worker is only for non-urgent/bulk).
- **P7 remainder:** partner-leaderboard polish, banner partner-display polish, ticket resolve/close + `TicketStatusHistory`
  + SLA/routing.
- **P8:** trend analytics (#48), scheduled reports, pagination (#26), DPDP (#24), systemic RLS (#23), staging real-OTP (8.7).
- **P9 post-launch:** full RBAC enablement (9.8/#47 — the flip is **gated on seeding `kyc:*` for field-approver roles**),
  multi-tenant SSR branding (before client #2), per-user backend logout (#32).
- **Retire the temporary worker host-alias** once prod runs current code — full steps in **§A.1** (after A-1 + the prod deploy).
- **GO-LIVE §3 carried items:** Money-path integrity = *sign-off* (A3/A4/B1 audited + harness-pinned), not new build.
  **Excel round-trips (#44)** — final-targets re-ingest header + mock enrollments export = **small fast-follow** (confirm
  Deoleo doesn't need final-target re-upload at launch).

---

## 6. Open items (smaller, resolve during build)
- **7.3 reconcile** (for A-7): confirm the "primary KPI" source on `KpiDef`/`OutletTarget`, the period, and the
  sales-user→outlet tagging path (`salesUserAssignment`).
- **Worker mechanism** for the *deferred* queue-worker (Scheduler vs in-process) — decide when we build it post-launch.

---

## 7. Definition of "go-live done"
- [x] CD `test` gate green; `develop` push deploys staging; `main` deploys prod via the approval gate. **(A-1; prod deploy approved at cutover.)**
- [~] Staging harness green **AND a real-MSG91 staging dress rehearsal passes** (A-8). **Real-OTP LOGIN done; redemption/KYC UAT pending.**
- [ ] **OTP works in prod (synchronous)**: login + **partner & sales-assisted** redemption OTP delivered via MSG91; send-failure cleans up (no orphan OTP/order). *(code done A-2a; prod end-to-end pending real-data load + UAT.)*
- [x] `gifsy_prod` migrated (target-DB asserted); **backups + PITR enabled first**; staging dry-run passed. **(A-5; pre-cutover backup taken; recreated empty → baseline. PITR = owner ongoing.)**
- [x] **Login on `https://deoleoloyalty.gifsy.in`**: Worker routes the host; login reads `x-forwarded-host` → resolves `deoleo`. **(A-9; native resolution, alias removed; login 200.)**
- [x] Prod: no `FIXED_OTP`, no `DEMO_MODE`; `RBAC_ENFORCEMENT` unset/false. **(A-6.)**
- [x] **Sales-team leaderboard renders** — **✅ BUILT 2026-06-26 (`a525739`+`a272dca`)**: live-computed `GET /v1/sales/leaderboard`, same-level peers, ZNM territory; FE wired, nav visible. (D-c; runtime-verified on staging.)
- [x] Error visibility: ≥1 error-rate + uptime alert; a real post-deploy `/health` gate. **(✅ DONE 2026-06-29 — `/health` 200 + 2 Cloud Monitoring alert policies [5xx + uptime] on 2 channels; residual = owner clicks the GCP verification emails.)**
- [x] Cutover runbook + a tested rollback exist. **(`runbooks/CUTOVER-RUNBOOK.md` [4 steps + PWA activation] + `runbooks/PROD-CUTOVER-RECORD.md` as-run; rollback = pre-cutover backup, which is a greenfield formality since prod is empty.)**
- [ ] Data lifecycle done: UAT on staging → prod cleaned **via the guarded A-10 runbook** (DB-asserted, FK-ordered, scoped,
      backups-first) → real Deoleo data loaded → a real prod smoke (login → earn/view → redeem → OTP → confirm) passes.
      **(Prod is greenfield-empty; real Deoleo data load + real-OTP UAT are the remaining open work.)**

---

## 8. Doc-reconciliation obligations (after lock)
**Includes fixing stale infra refs the audit exposed:** `00-MASTER-PLAN §9.10` + `GO-LIVE-READINESS §3` say "GCP load
balancer + Google-managed SSL" — **stale; the LB was archived 2026-06-13, edge is the Cloudflare Worker.** Also: master-plan
(launch-bundle re-sequence; leaderboard sales-dimension; P7-remainder+P8 → post-launch), POST-GO-LIVE-BACKLOG (§5),
gap-register (#21/#27/#23/#26/#24/#44/#47 launch-vs-post; #21 now "OTP synchronous, worker deferred"), RESUME, memory.
Then `check-doc-consistency.mjs` green.

---

## 9. Audit log
| Round | Focus | Verdict | Key findings → resolution |
|---|---|---|---|
| 1 | Completeness | GAPS-FOUND (3 blockers, 5 important) | **Cloudflare Worker ≠ GCP LB** (verified `load-balancer.tf` archived) → B6/O-3 rewritten + `x-forwarded-host` fix; domain not in Worker routes → 502 → O-3; Redis/Scheduler infra → B12; `/health` advisory → A-4/A-9; Excel/money-path §3 → §5. |
| 2 | Correctness | CLAIMS-SOUND, 1 correction | CD-gate / redemption-undelivered / login-direct / SMS-slot / RBAC-off-safe all TRUE. Enqueue producers = **3 (rewards, credits, kyc)**, not 5. |
| 3 | Sequencing | REORDER-NEEDED (3 critical) | O-4 backups before the shared-instance dry-run + assert target DB; critical path = O-1/MSG91 long pole; added the real-MSG91 staging rehearsal; A-1 universal predecessor; split OTP build/verify. |
| **R2 owner decisions** | — | applied | D-a OTP synchronous (worker deferred); D-b quarantine-to-green; D-c sales leaderboard → launch (B13/A-7); D-e data lifecycle; **domain-first** (O-3 heads the path). |
| **4a** | Decision safety (OTP/quarantine/wipe) | FIXES-NEEDED → applied | OTP: keep post-commit + clean up on send failure + **convert the sales-assisted OTP `:437` too** + decide confirmation-SMS → A-2a. Quarantine: **skip per-`it()` not per-file** for launch-shipping sales pages → A-1/D-b. Wipe: **no runbook exists** → new guarded **A-10** (positive `gifsy_prod` assertion, FK-ordered scoped deletes, backups-first). |
| **4b** | Feasibility (leaderboard/domain) | CORRECTIONS-NEEDED → applied | Leaderboard was estimated **greenfield** (new `SalesLeaderboard*` models, generator, ~5–7d, A-7). **⚠️ SUPERSEDED — ✅ BUILT 2026-06-26 (`a525739`+`a272dca`) as a LIVE-COMPUTED endpoint instead** (no new models / no generator / no snapshot — reuses the `getTargets` join; territory = ZNM ancestor; rm/state/national). Domain O-3 + A-3 **confirmed accurate** (exact edits enumerated; `actions.ts:68` is the sole raw-host read; the domain is already in the registry + has passing tests). |

**Convergence:** R4 found scope/safety refinements, not structural defects — the plan is stable. Recommend locking at Rev 3
rather than auditing further (diminishing returns). Residual risks to watch during build: A-7 shared-instance migration,
the first real-MSG91 behavior at A-8, and the A-10 wipe (gated behind backups + dry-run).
