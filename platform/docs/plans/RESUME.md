# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/` (thin Next.js 16).
Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic). Last verified state: 2026-06-21.

═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
⚠️ STATE: DEOLEO IS LIVE IN PRODUCTION ON THE CORE LOOP — but the prod DB is intentionally EMPTY.
═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
The whole P0–P6 + P0.6 platform is built, audited, and **now serving in prod** (`gifsy-api`+`gifsy-frontend` on
`b3ab2e0`, at `https://deoleoloyalty.gifsy.in`). The prod cutover is DONE; staging works end-to-end with REAL MSG91 OTP.
**We are in the GO-LIVE phase now — NOT building new features.** The remaining work is launch-readiness:
(1) close the E2E coverage gap (owner directive: before UAT), (2) load real Deoleo data into empty prod,
(3) owner UAT, (4) owner ops. **Read FIRST:** `DEOLEO-GO-LIVE-BUNDLE.md` · `GO-LIVE-READINESS.md` ·
`runbooks/PROD-CUTOVER-RECORD.md` · `E2E-COVERAGE-PLAN.md` · `MIGRATIONS.md` · `ENVIRONMENTS.md`.

## ✅ What is LIVE / DONE
- **The platform** — P0–P6 (onboarding/KYC, programs/targets/enrollment, wallet/points/rewards, finance/credits/
  invoicing/TDS) + **P0.6 A–D** (Gifsy cross-tenant oversight + operator switcher, payouts money-path, enforcement
  coverage audit, sales-assisted redemption, invoices+Excel, gifsy console real data, P0.7 cleanup, platform-Prisma
  retirement). All built + independently audited + runtime-verified; **all LIVE in prod now**. Records: `reconcile/*`
  + the memories ([[p3-kyc-complete]] [[p4-complete]] [[p5-complete]] [[p6-finance-decisions]]).
- **🚀 PROD CUTOVER DONE (2026-06-20)** — recreate `gifsy_prod` empty (double-guarded) → apply the squashed baseline
  (72 tables, World-A gone) → `develop`→`main` deploy (GitHub prod gate) → removed the temporary worker host-alias
  (native resolution). Verified: login 200, FE→backend routing 400 (`NEXT_PUBLIC_API_URL`=api.gifsy.in), health 200.
  Full as-run log: `runbooks/PROD-CUTOVER-RECORD.md`.
- **🗄️ MIGRATION MODEL FIXED** — ONE squashed baseline (`api/prisma/migrations/00000000000000_baseline/`; old 6 →
  `migrations-archive/`; `migrations-manual/` is now LEGACY) applied via `prisma migrate deploy` run as an **in-VPC
  Cloud Run Job** (the staging/prod instance is private-IP). Staging auto-migrates on `develop` push, prod on `main`.
  Full model: `MIGRATIONS.md` / [[migration-model]].
- **STAGING login WORKS with REAL MSG91 OTP** (owner logged in end-to-end). The earlier login bugs (empty staging DB,
  empty-host secret, Next-16 Server-Action CSRF abort behind the worker, BOM'd MSG91 key) are all fixed. Redemption-UAT
  phones set on staging: deoleo admin `9830011252`, partner+outlet `7795096288`, sales `9875436349`.

## 🔴 The GO-LIVE critical path — what's LEFT
1. **CLOSE THE E2E COVERAGE GAP (owner directive — do BEFORE UAT so bugs surface in CI, not UAT).** The Playwright
   harness (`platform/e2e`, `npm run e2e`) is green for SLICES (~59) but **NOT the full role×page matrix**: uncovered =
   most admin sub-pages (schemes/targets/achievements/outlets/catalog/credits/TDS/payouts/settings/tickets/banners),
   partner targets/leaderboard/schemes/orders/KYC, sales team/outlets/targets/tasks, and many WRITE flows. Plan +
   phased build: **`E2E-COVERAGE-PLAN.md`**. ⚠️ Staging-run dependency: `FIXED_OTP` was REMOVED from staging (real
   MSG91), so a staging harness run now needs the test-only OTP read-back endpoint (unbuilt) OR temporarily re-adding
   `FIXED_OTP`. Local runs use `FIXED_OTP=123456`. Tasks #75.
2. **LOAD REAL DEOLEO MASTER DATA into the empty prod** — prod is migrated but has 0 users/0 clients; no real user can
   log in until the real client + admins + sales team + partners/outlets + reward catalog + schemes are loaded (owner
   provides the file; I author+audit the load). THE blocker. Task #76.
3. **Owner UAT** of the core loop on staging with real OTP (login done; KYC/earn/redeem pending).
4. **Owner ops** (owner-only; I prepare exact steps): Cloud Monitoring alert email · automated backups + PITR on
   `gifsy-db` (a one-off backup was taken at cutover; ongoing is OFF) · rotate prod-only secrets. Task #74.
- **Deferred fast-follows (NOT blockers):** sales-team leaderboard (nav hidden), rest of P7 (notification worker,
  banners, ticket lifecycle), P8 (RLS, DPDP, trend analytics, the staging real-OTP endpoint), multi-tenant SSR
  branding (before client #2). Full list: `POST-GO-LIVE-BACKLOG.md`.

## Known gaps to watch (staging + prod)
- **Staging E2E can't run there right now** (FIXED_OTP removed → needs the OTP read-back endpoint or temp FIXED_OTP).
- **Staging shares the prod `gifsy-db` Cloud SQL instance** (different DB names) — any DB op must double-guard the DB name.
- **Prod is empty** (the data-load blocker) · **no backups/PITR, no monitoring alerts, creds not rotated** (owner ops).
- **Prod deploy health-check is advisory** (doesn't fail the deploy) — the migrate `--wait` step is the real gate.
- **Redis:** `REDIS_URL` is bound but OTP is stored in the DB; the throttler is in-memory (per-instance, not global) —
  verify whether Redis is actually used / needed; minor hardening, not a blocker.

## Infra realities (these bite — all confirmed)
- **Edge = Cloudflare Worker** (`cloudflare-worker/worker.js` + `wrangler.toml`), **NOT a GCP load balancer** (archived
  2026-06-13). Add a domain / change routing = edit the worker + `wrangler deploy` (machine is Cloudflare-authed).
- **Staging + prod SHARE the private-IP `gifsy-db` instance**; dev is a separate PUBLIC instance `gifsy-db-dev`. You
  CANNOT reach staging/prod DB from a laptop or a GH runner — run migrations/seeds/one-off SQL as **in-VPC Cloud Run
  Jobs** (for one-off SQL: a `node -e eval(Buffer.from('<base64>','base64'))` job with the prod/staging `DATABASE_URL`
  secret + `--vpc-connector=gifsy-connector` + `--set-cloudsql-instances=gifsy-platform:asia-south1:gifsy-db` +
  `--service-account=gifsy-api-sa@…`; the `^@^` gcloud arg-delimiter avoids comma-splitting). [[migration-model]]
- **`gcloud` is authed and CAN read+write secrets here** (used it to fix `DATABASE_URL_STAGING`, the BOM'd
  `MSG91_AUTH_KEY` v5, `CORS_ORIGINS` v3). **`wrangler` is Cloudflare-authed.** The dev Cloud SQL proxy uses the
  `--token` trick (`& "$env:TEMP\cloud-sql-proxy.exe" <conn> --port 5433 --token (gcloud auth print-access-token)`;
  ADC is NOT set up — don't ask the owner for `application-default login`).
- **Real MSG91 OTP everywhere** (no `FIXED_OTP` on staging/prod). **MSG91 secrets must be saved WITHOUT a UTF-8 BOM**
  (a BOM on `MSG91_AUTH_KEY` 500'd OTP via a fetch ByteString error; `.trim()` in `msg91.service` now defends).
- **The Chrome extension blocks NEW domains** until the owner adds them to the extension's own allowed-sites list
  (separate from Chrome's site-access). It refused `uat.deoleoloyalty.gifsy.in` ("Navigation to this domain is not
  allowed") even with Chrome site-access on — so own-domain UI driving may need the owner to allow the domain first.

## Operating model (unchanged — owner-agreed)
You ORCHESTRATE, plan, GATE, own docs. **Per task: plan (Opus) → execute (Sonnet executor, background, NO shell — you
run the gate) → ONE independent adversarial audit (fresh agent, Read/Grep) → Opus gate → RUNTIME-VERIFY → commit → doc
sweep.** **AUDIT EVERYTHING — do not risk-tier** (the owner caught me skipping audits TWICE this session; the audit
then found a real defect every time, incl. a money-path TDS-index drop on the prod cutover). Parallelize disjoint-file
streams; **Opus owns `schema.prisma` + migrations** so executors never collide. **Definition of done
(`VERIFICATION-PROTOCOL.md`):** a real user, in the correct role, completes the flow end-to-end at RUNTIME against
realistic data — `tsc`/unit-tests/audits are necessary, NEVER sufficient. ⚠️ **The hard lesson this session: staging
had NEVER been exercised end-to-end, so 4 stacked login bugs sat latent until the owner logged in. Run real flows
EARLY — don't trust "it's deployed" = "it works".** The gate (run it YOURSELF): `cd api && npx tsc -p
tsconfig.build.json --noEmit` (0) + `npx jest <area>`; FE: `cd platform && npx tsc --noEmit` + `npx vitest run <area>`
(platform = **vitest**) + `node scripts/check-doc-consistency.mjs` GREEN. Sweep docs (RESUME/bundle/gap-register/
reconcile/memory) after every task (`DOC-MAINTENANCE.md`).

## Constraints (must hold)
- **Work on `develop`.** `main` = prod releases — they go out via the cutover/CI path WITH the owner approving the
  GitHub "production" gate (that's how the cutover shipped). **Commit/push ONLY when the owner asks.** Never expose
  secrets. ⚠️ Don't `git add -A` while a background executor is mid-write.
- **DB migrations:** baseline + `migrate deploy` via the in-VPC job (above). **NEVER `prisma migrate dev`** (resets
  `gifsy_dev`). `migrations-manual/` is LEGACY (don't add to it). For any **prod/staging DB op**: double-guard
  (`current_database()` assert) + take a backup + show the SQL + WAIT for owner go (the instance hosts prod).
- **DEV DB** = `gifsy-db-dev` via Auth Proxy on `127.0.0.1:5433` / `gifsy_dev` (drops after reboot — `DEV-DB.md`).
  `SELECT 1` + confirm `current_database='gifsy_dev'` before touching it. NEVER point dev at prod. ⚠️ `api/.env` was
  once found pointing at PROD — re-verify it reads `127.0.0.1:5433/gifsy_dev`. **Schema source of truth =
  `api/prisma/schema.prisma`.**
- **Backend dev gotchas:** runs a compiled `dist/`; repeated `tsc --noEmit` poisons `tsconfig.tsbuildinfo` → rebuild
  with `tsc -p tsconfig.build.json --incremental false` then `node dist/main.js`; a stale backend may hold :4000
  (`Get-NetTCPConnection -LocalPort 4000` → `Stop-Process`). FE :3000 is `next dev` (live from disk).

## Architecture + the REAL model (do not relitigate)
- **API-first:** `api/` (NestJS) owns the DB + all logic; thin Next.js FE over a `next.config.ts` proxy (`/api/*` →
  backend `/v1/*`, wrapped `{success,data}`). **Never add local `app/api/*` routes** (the proxy forwards; such routes
  are dead). [[architecture-backend-split]] · `docs/spec/04-architecture.md`.
- **The real model** ([[platform-real-model]]): sales/achievement = **upload FINAL amounts per outlet × parameter, NO
  compute**; program = a reporting/filter facet, NOT a targeting dimension; no point-tiers, no SKU. Validate inherited
  concepts against this before building ([[reconcile-fit-before-build]]).

## Reference (read before building)
- Launch: `DEOLEO-GO-LIVE-BUNDLE.md` · `GO-LIVE-READINESS.md` · `POST-GO-LIVE-BACKLOG.md` · `runbooks/PROD-CUTOVER-RECORD.md`
  · `E2E-COVERAGE-PLAN.md` · `MIGRATIONS.md` · `runbooks/{PROD-DB-MIGRATION,PROD-DATA-WIPE}.md` · `ENVIRONMENTS.md`
- Build/process: `00-MASTER-PLAN.md` · `08-agent-execution-guide.md` · `VERIFICATION-PROTOCOL.md` · `DATA-VISIBILITY.md`
  · `DOC-MAINTENANCE.md` · `RBAC-ENABLEMENT.md` · `DEV-DB.md` · `GIT-WORKFLOW.md` · `docs/spec/gap-register.md` (latest #54)
- memory: [[deoleo-go-live-bundle]] · [[migration-model]] · [[audit-every-build-item]] · [[verify-flows-at-runtime]] ·
  [[e2e-harness]] · [[environments-topology]] · [[architecture-backend-split]] · [[platform-real-model]] · the P3–P6 completes.
- **Seeded phones — LOCAL `gifsy_dev`** (FIXED_OTP=123456): gifsy `9830011252`/clientId `gifsy`, deoleo admin
  `9000000001`, partner `9000000002`, sales `9000000003`, clientb admin `9000000020`. **STAGING `gifsy_staging`**
  (REAL OTP): deoleo admin `9830011252`, partner+outlet `7795096288`, sales `9875436349`. **PROD `gifsy_prod`: EMPTY.**
- Local: dev proxy `127.0.0.1:5433` (DEV-DB.md); FE `:3000` (`next dev`); backend `:4000` (rebuild `dist` + `node
  dist/main.js`). Confirm on `develop` + dev DB reachable. Before any irreversible/prod step, show the plan (audited) + wait.
```
