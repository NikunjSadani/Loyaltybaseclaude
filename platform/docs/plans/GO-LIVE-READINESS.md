# Go-Live Readiness — the enforcement mechanism + the gate

> ## 🔄 RECONCILED 2026-06-30 — live source of truth = `GO-LIVE-ISSUE-LIST.md` + the memory bundle
> Several status notes below predate the last few days. Net-current state (verified 2026-06-30):
> - **Gate is GREEN**: api jest **1259** · nest 0 · FE vitest **1694** · tsc 0. (Older notes saying jest 921 / vitest 1459 are point-in-time snapshots.)
> - **Cloud Monitoring is LIVE + backups/PITR are ON** (2026-06-29). The "≥1 alert still OPEN / PITR OFF" notes are RESOLVED — see §3.1.
> - **Admin sub-dashboards consolidated** to 4 REAL pages (KYC + Program-Health + Operations + Finance); the 3 fake
>   sub-dashboards were **DELETED** (2026-06-27). **Gap #57(a) "sub-dashboards render mock" is RESOLVED** — the
>   pre-UAT-blocker notes about `/admin/dashboards/{payments,engagement,redemptions,kyc}` showing "4,821"/"Kumar General Store" are stale.
> - **Sales leaderboard BUILT** (`a525739`+`a272dca`); **AF-6 cookie-only auth + refresh-on-401, AF-5 xlsx, AF-7/8/9/10 DONE**;
>   **AF-12 RBAC deliberately OFF for launch** (`@Roles`+service are the real gates — `RBAC-ENABLEMENT.md`).
> - **Prod is ALREADY LIVE**; cutover = a low-risk UPDATE of an empty prod (0 users/0 data), auto-migrated behind a
>   `production` gate; runbook = [`runbooks/CUTOVER-RUNBOOK.md`](runbooks/CUTOVER-RUNBOOK.md). **Prod bootstrap script BUILT**
>   (`api/prisma/bootstrap.ts`, `262027a`) — run it before #76.
> - **Custom domain LIVE** via Cloudflare **Worker** (the GCP load balancer was archived 2026-06-13 — any "GCP LB + Google SSL" text is stale).
> - **PWA fully ACTIVATED + Android-verified on staging**; prod PWA activation is a cutover step (see POST-GO-LIVE-BACKLOG §F).
> - **Session Report shipped 2026-06-30** (`7021c58`): per-user active-days usage report.
>
> **Genuinely OPEN at 2026-06-30:** #76 real Deoleo data load into empty prod (+ run bootstrap) · AF-3 partner hardcoded-bank
> (in progress 2026-06-30) · prod env-hygiene sweep (NODE_ENV=production / NO FIXED_OTP / NO DEMO_MODE / no debug routes) ·
> MSG91 prod DLT templates + creds + 1 real test OTP · owner UAT sign-off (redemption + KYC) on staging · click the 2 GCP
> alert-email verification links · points-expiry scheduler wiring (post-launch) · AF-12 RBAC (post-launch). History below is preserved.

> ## 🟢 2026-06-26 update — UAT fast-follows shipped (all gate-green + independently audited + runtime-verified on staging):
> **sales leaderboard BUILT** (`GET /v1/sales/leaderboard`, live-computed, same-level peers, ZNM territory — `a525739`+`a272dca`);
> **per-tenant Visibility ON/OFF** master toggle shipped (`visibilityEnabled`, default OFF — **Deoleo launches OFF** — `d5d175e`);
> **Outlet program/category lists made configurable** per tenant (`outletPrograms`/`outletCategories` — `1bc9315`); **AF-5 export
> formula-injection substantially closed** at the `buildXlsx` serialisation boundary (`cellSafe` on every string cell — `1bc9315`;
> residual = the K12 `reviewDump` signed-URL surface). See [`GO-LIVE-ISSUE-LIST.md`](GO-LIVE-ISSUE-LIST.md).

> ## 🚦 READINESS STATUS — 2026-06-22: **FIX WAVE COMPLETE + pushed → NOW in OWNER-DRIVEN UAT on staging (fix-as-you-find).** 6 UAT bugs found+fixed this session (U1–U6 in [`GO-LIVE-ISSUE-LIST.md`](GO-LIVE-ISSUE-LIST.md): hierarchy upload ×2, KPI column mis-mapping, downloadable error reports, single-primary KPI, unified cash payout). All pushed except cash-payout `4de8794` (money path — awaiting owner push). Migration `20260622120000` (KPI single-primary, self-healing). The planned 5-agent parallel UAT sweep is still queued. Below = the original fix-wave status (historical).
> The post-audit fix wave (GLM migration · GL-Money · GL-RBAC · GL-FE-enroll[+catalog] · GL-FE-settle[+GLM-5]) closed every
> blocker — GLB-1 eligibility gate on both money rails · GLB-2 zero-value redemption · GLB-3 stale coarse TDS indexes · GLB-4
> CLIENT_ADMIN→GIFSY_ADMIN privilege escalation · GLB-5 scheme enrollment + catalog · GLB-6 payout settlement UI — and the majors
> (GLM-1 reversal clawback, GLM-2 FAILED-credit re-bank, GLM-3 beneficiary validation, GLM-4 one-payout-per-order unique, GLM-5
> fake KYC bulk-approve). Each ran executor → INDEPENDENT adversarial audit → gate → runtime-verify. The money re-audit caught a
> real lost-awards bug (GLM-2 was never implemented in pass 1) + a payouts-rail resolver gap — both fixed + re-verified. A canonical
> `api/src/kyc/kyc-eligibility.ts` resolver now feeds all four payment rails; a new `CreditEntryStatus.REVERSED` separates reversals
> from re-bankable bank failures. **GATE GREEN:** api jest **921/921**, FE vitest **1459**, Playwright E2E green, doc-consistency;
> **GLB-3 runtime-proven** on `gifsy_dev` (2 same-file-hash TDS rows persist, dup rejected); backend boots clean. Per-item table =
> [`GO-LIVE-ISSUE-LIST.md`](GO-LIVE-ISSUE-LIST.md). **➡️ The exhaustive UAT script is now [`UAT-CHECKLIST.md`](UAT-CHECKLIST.md).**
> **REMAINING BEFORE GO-LIVE (not fix-wave; RECONCILED 2026-06-30):** ~~(a) gap #57(a) admin sub-dashboards still render mock~~
> → **✅ RESOLVED — consolidated to 4 REAL dashboards, 3 fakes DELETED (2026-06-27);** (b) real Deoleo master-data load into
> empty prod (#76, + run the bootstrap script first); ~~(c) owner ops — monitoring alert + backups/PITR~~ → **✅ DONE 2026-06-29**
> (alerts LIVE + backups/PITR verified ON); residual owner ops = click the 2 GCP alert-email verification links + optional secret rotation (#74).

> Created 2026-06-19. Documentation alone is **passive** and gets shortcut (proven repeatedly this session).
> "Done / ready to ship" must be **enforced by something executable**, not trusted to a checklist. This doc
> defines (1) the intent, (2) the automated enforcement, (3) the readiness gate, (4) who does what.
>
> 📋 **Complement:** what we deliberately deferred to *after* launch lives in
> [`POST-GO-LIVE-BACKLOG.md`](POST-GO-LIVE-BACKLOG.md). This doc = launch **blockers**; that doc = **fast-follows**.

## 1. Intent (the bar)
A **green comprehensive run on local dev must mean we can push `develop` expecting it to pass staging → prod with
no surprises.** No half-baked merges. Comprehensive ≠ "a representative sample" — it is **every page × every role**,
asserting real scoped data, honest errors, no fabricated values. If a page or role isn't covered, it is **OPEN**,
not "done".

## 2. The enforcement = an automated E2E harness (not a doc)
Build a **Playwright** E2E suite that **is** the `DATA-VISIBILITY.md` matrix, executable:

For **each role × each page**:
1. Log in as that role through the real stack (FE→proxy→backend). *(Local: `FIXED_OTP=123456`. Staging: real MSG91 — the suite handles both; see env-parameterisation below.)*
2. Load the page; assert it renders the **expected real data** for that role/tenant (from `DATA-VISIBILITY.md`).
3. Assert it shows **NO known-fabricated values** (e.g. `8,550`, `248`, `4,821`, `2,947`, `Rajesh Kumar`) — a hard fail-list that catches demo leftovers (gap #40).
4. Assert **role scoping**: a role that should NOT see a thing gets an honest 403/empty (gap #41); a partner sees only its own; an admin sees the whole tenant; cross-tenant data never leaks (gap #6/Q6).
5. For write flows: perform the action, assert it **persisted to the DB** and a different session sees it (no fake success).

**It fails CI when a page fabricates, a scope leaks, or a flow doesn't persist** — the enforcement no human can shortcut. `tsc` + unit tests remain necessary, never sufficient (`VERIFICATION-PROTOCOL.md`).

### Env-parameterised (encodes the local↔staging intent)
The same suite runs against **local** (`BASE_URL=http://localhost:3000`, `OTP_MODE=fixed`) and **staging**
(`BASE_URL=<staging>`, `OTP_MODE=msg91`, real subdomains → real `clientId` resolution). A green **local** run is the
merge gate; a green **staging** run is the pre-prod gate. (This is *why* `ENVIRONMENTS.md` lists the local↔staging
differences — the harness must not assume `FIXED_OTP`/`localhost` semantics.)

### CI integration
- Add the E2E job to CI: run the harness on every PR/`develop` push (spins up the stack + seeded `gifsy_dev`-shape DB).
- A nightly/pre-prod job runs it against **staging**.
- Deploy to prod (`main`) stays behind the existing required-reviewer gate **and** a green staging E2E.

## 3. Readiness gate (broader than pages — all must be ✅ before go-live)
> **Status (2026-06-20):** **Prod cutover is DONE** — prod serves current code (`b3ab2e0`) on `deoleoloyalty.gifsy.in`,
> `gifsy_prod` recreated empty + migrated to the squashed baseline (intentional greenfield, 0 users/0 clients), host-alias
> removed, verified (login/health/routing). See [`runbooks/PROD-CUTOVER-RECORD.md`](runbooks/PROD-CUTOVER-RECORD.md).
> **Update (2026-06-21): the E2E role×page matrix is now COVERED + GREEN (291 passed, Waves 0–4; commits `961d5fa`/
> `7b3828a`/`5119c1d`, pushed).** The expansion caught + fixed real prod bugs (money-path #42, the `/api/auth/me`
> profile-mock bug, outlet-config, admin demo-identity #55) and surfaced **gap #57**.
> **Update (2026-06-21, tasks #77 + #78 — 2 audits + E2E 290/0/9):** **gap #57 (b/c/e) ✅ RESOLVED** — orphan Outlet Master
> removed (live `/admin/users/outlets` already real) + real per-outlet KYC-status join; `/admin/hierarchy` populated (seed now
> writes the `employee_hierarchy` snapshot — the read is snapshot-fed by P2.1 design, so this was a seed-fixture gap not a code
> gap); notification bells hidden (P7). **#78 ✅ RESOLVED** — `createClient`/`provisionOutletTypeConfigs` chokepoint auto-creates
> outlet-type configs on tenant creation (`POST /v1/gifsy/clients` + wizard + seed share it); **so #76 is NO LONGER gated by #78.**
> **🔴 REMAINING before UAT (RECONCILED 2026-06-30):** ~~(a) **gap #57(a) sub-dashboards** `/admin/dashboards/{payments,engagement,redemptions,kyc}` STILL
> render mock ("4,821"/"Kumar General Store")~~ → **✅ RESOLVED — admin dashboards consolidated to 4 REAL pages
> (KYC + Program-Health + Operations + Finance); the 3 mock sub-dashboards were DELETED (2026-06-27).** (b) **real Deoleo
> master-data load** into empty prod (#76, owner provides file; run the bootstrap script first). ~~(c) **observability alerts**
> (#74, owner)~~ → **✅ DONE 2026-06-29** (residual = owner clicks the 2 GCP verification emails).
> (d) gap #57(d) tenant-settings write + (f) MIS KPI-read RBAC — lower, roles not in Deoleo's first UAT.

- [ ] **Auth:** login works for **all roles** (real flow), route-by-role correct, logout clears session. *(GIFSY broken #39 → fixed; staging real-OTP login DONE; full role matrix on prod pending real-data load.)*
- [ ] **RBAC + tenant isolation:** every endpoint role+tenant scoped to the `DATA-VISIBILITY.md` audience; cross-tenant never leaks; the Gifsy operator can reach the cross-tenant data it must (#38/#41). RBAC enablement decided (`RBAC-ENABLEMENT.md`).
- [x] **No fabricated data anywhere** — the E2E fail-list passes on every page (#40). *(Enforced by the harness fail-list; partner slice proven.)*
- [x] **Money-path integrity:** wallet/credits/redemption/payouts/TDS verified end-to-end per role; `payouts.processBatch` transactional+guarded (#42); BigInt-paise throughout; double-spend/oversell audited. *(P5/P6 audited + harness-pinned; sign-off, not new build.)*
- [x] **Every write flow persists** (no fake success) — KYC approve, redemption, visibility submit, invoice generate, tickets (#36/#38). *(#50 redemption money path enforced by the E2E harness; residual proxy-excluded dead writes tracked separately.)*
- [x] **Environments configured + seeded:** staging has a known seeded dataset + the current schema; secrets set; `staging` E2E green. *(Staging auto-migrates on `develop`; 3 staging-infra bugs fixed; real-MSG91 staging login works. **Prod is intentionally NOT seeded yet** — real-data load is the remaining step.)*
- [x] **Custom domain (Deoleo = `deoleoloyalty.gifsy.in`): ✅ LIVE (2026-06-20).** ⚠️ **The edge is a Cloudflare Worker, NOT a GCP load balancer** — `terraform/load-balancer.tf` was **archived 2026-06-13** (LB destroyed; all traffic routes through `cloudflare-worker/`). Done: a Cloudflare **Worker Custom Domain** (managed DNS + SSL) + the branded-domain→slug map (`5de8aa9`, `CLIENT_REGISTRY.domains`) + the login `x-forwarded-host` fix (`37e54f9`). The Worker sets `x-forwarded-host` (it rewrites `Host` to the `.run.app` origin) and the proxy/login read that — so there is **no "preserve Host" requirement** (that earlier note was wrong). **As of the 2026-06-20 cutover the temporary host-alias was REMOVED — prod runs current code and resolves the branded domain natively** (login 200; see [`runbooks/PROD-CUTOVER-RECORD.md`](runbooks/PROD-CUTOVER-RECORD.md)).
- [ ] **Excel round-trips** work (download→fill→upload) where applicable (#44). *(Small fast-follow — confirm Deoleo doesn't need final-target re-upload at launch.)*
- [x] **Observability** baseline (logs/metrics/alerts) (#27 → P8.4) — at least error visibility before prod. *(Structured logging → Cloud Logging + `/health` 200 + **2 Cloud Monitoring alert policies [5xx + uptime] on 2 channels are LIVE — DONE 2026-06-29**; residual = owner clicks the GCP verification emails.)*
- [~] **The E2E matrix is covered + GREEN** (every `DATA-VISIBILITY.md` row, Waves 0–4 — 291 passed / 0 failed / 11 skipped). ✅ Built + runtime-verified ([`E2E-COVERAGE-PLAN.md`](E2E-COVERAGE-PLAN.md)). The 11 skips were the **gap #57** pages (`test.fixme`'d — admin sub-dashboards / Outlet Master / hierarchy / sales notifications render mock/empty data) + a few precondition skips. **RECONCILED 2026-06-30: the admin sub-dashboards were consolidated to 4 REAL pages (3 fakes DELETED, 2026-06-27), so that #57 sub-dashboard pre-UAT blocker is RESOLVED** — point any remaining `test.fixme` cells at the new real dashboards. Staging E2E still needs the OTP read-back endpoint or temp `FIXED_OTP`.

### 3.1 Owner-ops before launch (exact steps in `runbooks/OWNER-OPS-RUNBOOK.md`; CORRECTED 2026-06-29 by live recon)
- [x] **Cloud Monitoring alert email** — **DONE 2026-06-29.** Two email channels (`nikunj.sadani@gifsy.in`, `nikita@gifsy.in`) + two enabled alert policies wired to both: "Prod API — 5xx error rate (gifsy-api)" (>5 5xx/5min) and "Prod API — uptime check failing (gifsy-api /health)". ⚠️ Each address gets a one-time GCP verification email — click it so alerts deliver.
- [x] **Automated backups + PITR** on `gifsy-db` — **ALREADY ON** (verified 2026-06-29: backups enabled, 14 retained, `pointInTimeRecoveryEnabled=true`, 7-day txn-log, daily 20:30). Earlier "PITR is OFF" was stale → VERIFY-ONLY now (optional ZONAL→regional HA).
- [ ] **Rotate prod-only secrets** — prod secrets already EXIST in Secret Manager (`DATABASE_URL`/`JWT_SECRET`/`MSG91_*`); rotation = publish new VERSIONS (owner's call). Steps in the runbook. Task #74.
- 🔴 **PROD BOOTSTRAP GAP (NEW, blocks #76):** no app/API path to create the first GIFSY_ADMIN or the 4 OutletType master rows (seed prod-firewalled) → a one-time in-VPC bootstrap load-script is required before any prod data load. Not yet built.
- ℹ️ **Prod is already live** (`gifsy-api`/`gifsy-frontend` on `b3ab2e0`); `deploy.yml` auto-migrates via the in-VPC job behind a `production` approval gate. Cutover = update, not first deploy. See `runbooks/CUTOVER-RUNBOOK.md`.

### 3.2 Other known gaps (track; mostly non-blocking)
- **Staging E2E can't run there now** — `FIXED_OTP` was removed from staging (real MSG91), so a staging harness run needs the test-only OTP read-back endpoint (unbuilt, → P8) **or** temporarily re-adding `FIXED_OTP`. Local runs are unaffected.
- **Staging shares the prod `gifsy-db` instance** (different DB names) — any DB op double-guards the DB name.
- **Prod deploy health-check is advisory** (the deploy doesn't fail on a bad `/health`) — the migrate `--wait` step is the real gate; making `/health` a hard post-deploy gate is the A-4 residual.
- **Redis** — `REDIS_URL` is bound but OTP is stored in the DB and the throttler is in-memory (per-instance, not global across Cloud Run instances). Verify whether Redis is actually used/needed; minor hardening, not a blocker.

## 4. Who does what
- **Owner:** answer the 🟦 product decisions in `DATA-VISIBILITY.md §3` (who-sees-what); confirm when to run E2E against staging + staging access.
- **Me (orchestrator):** write `DATA-VISIBILITY.md` (done, skeleton) → build the Playwright harness → wire CI → run local (then staging) → fix/log every failure (gap-register with WHEN) → keep RESUME/memory current.
- **Continuity:** RESUME's post-compact prompt + memory carry this plan + state so a fresh session continues seamlessly.

## 5. Sequence
1. Owner answers `DATA-VISIBILITY.md §3`. 2. Build the Playwright harness (the matrix). 3. Run local → fix every red
(real-data, scoping, persistence). 4. Run staging → fix env/config-specific reds. 5. Readiness gate §3 all green →
push with confidence. **Status: not started — this is the foundation that makes "done" real.**
