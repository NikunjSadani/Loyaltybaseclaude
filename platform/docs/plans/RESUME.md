# RESUME — Loyaltybase: current state, what's next, known traps

> **The single living source of truth.** Read this first in every session (it is the restart prompt after a
> context compaction). Working agreements, gates and guardrails live in the root **`CLAUDE.md`** (auto-loaded);
> the index of every other doc is **[`../DOCS-INDEX.md`](../DOCS-INDEX.md)**.
>
> **Maintenance rule:** update this file **at every release** (prod or staging) and whenever a "current state",
> "what's next" or "trap" fact changes — in the same commit/PR as the change. Replace stale lines; don't append dated
> banners on top of old ones. History goes to the release log in `DOCS-INDEX.md` and to
> [`archive/RESUME-ARCHIVE-2026-11-15.md`](archive/RESUME-ARCHIVE-2026-11-15.md) (the full chronology up to 2026-11-15,
> incl. the CUTOVER LEDGER #14–#52). **Never trust a SHA written here over `git log` + the serving image (§7).**
>
> Last updated: **2026-11-16** (docs sweep after the 2026-11-15 release).

Multi-tenant FMCG **trade-loyalty** platform. Operator **Gifsy**; live clients **Deoleo** (since July 2026) and
**Bajaj Consumer Care** (go-live November 2026). Backend `api/` (NestJS + Prisma 7 — owns the DB and ALL business logic)
· thin frontend `platform/` (Next.js; proxies `/api/*` → backend `/v1/*`). Repo `C:\Users\nikun\Loyaltybaseclaude`;
work on **`develop`** (auto-deploys to staging); prod ships from **`main`** by a manual workflow.

---

## 1. Where things stand (2026-11-16)

| | SHA | Since | Notes |
|---|---|---|---|
| **Production** (`gifsy-api`, `gifsy-frontend`, jobs `gifsy-sales-import`, `gifsy-exports`) | **`de2f3700`** (verified serving 2026-11-17: api rev `gifsy-api-00091`, frontend rev `gifsy-frontend-00081`; `/health` 200) | 2026-11-17 | `origin/main` = `origin/develop` |
| **Staging** (`*-staging`) | **`de2f3700`** | 2026-11-17 | same code as prod |
| Previous prod | `4e395b21` → `720ffce9` → `2eb8271d` | 2026-11-16 / 11-15 | rollback targets |

**2026-11-16 releases** (release log in `DOCS-INDEX.md`): **Voucher Dispersal** (Gifsy platform admin tool — Excel →
Hubble buy → WhatsApp; → [`VOUCHER-DISPERSAL.md`](VOUCHER-DISPERSAL.md)) + App Adoption installed-users export
(`720ffce9`); **Amazon Pay claim-code-only** voucher message (`4e395b21`; other Hubble brands still send code + PIN —
ask Hubble which are claim-code-only and add their product ids to env `HUBBLE_CLAIM_CODE_PRODUCT_IDS`); **dashboard
rounding** (`d5050024`, shipped as `de2f3700` = + a test-only GIFP9 timeout bump; `platform/src/lib/pace.ts` `fmtRemaining` / `remainingOf` / `fmtKpiNum`).

**The 2026-11-15 release (`e242b1a1` → `2eb8271d`, 67 commits)** — all owner-approved; platform-wide items were
approved in-session and dual-audited where money/identity was involved:
- **Downloads page** (background exports): heavy reports are built by a new Cloud Run job (`gifsy-exports` /
  `gifsy-exports-staging`) and listed on a Downloads page; light ones stay instant. Migration
  `20261116120000_export_requests`. The deploy workflows grant `roles/run.jobsExecutor` to `gifsy-api-sa` on the job.
  → [`DOWNLOADS-PAGE.md`](DOWNLOADS-PAGE.md)
- **Memory safety**: page-size caps on every list query, uploads return only problem rows (cap 500 + `truncated`),
  per-instance heavy-operation limiter (max 2, 503 + Retry-After), multer size limits (413), photo/document proxies
  stream, Prisma query logging off unless `PRISMA_LOG_QUERIES=true`, API memory 1 GiB (from `e242b1a1`).
- **Payments report**: server-side paging (50/100/200) + whole-range DB totals + uncapped streamed export (the old
  10,000-row cap is gone; wide ranges go via Downloads).
- **Credits/payouts money path**: credit upload posts only OK rows (proxy body limit 15 MB); UTR apply truly idempotent
  and multi-entry outlets settle together; **payout-credited WhatsApp/SMS states the amount actually credited to the
  bank** (net of DEDUCT-method TDS) — Deoleo unaffected (all its entries are GROSS_UP with ₹0 withheld, checked on prod
  2026-11-15).
- **Hubble gift-card reconcile hardening** (LIVE on prod for Bajaj, flag `hubbleVoucherEnabled`): never refund after a
  timeout/5xx/network error; ops "Retry with Hubble" refunds only when Hubble's own "no order" is ≥ 2 h old AND a
  canary lookup passes; late webhooks always re-checked and flagged. → [`HUBBLE-RECONCILE-RUNBOOK.md`](HUBBLE-RECONCILE-RUNBOOK.md)
- **Bajaj partner screens v2** (flag `partnerDashboardV2`): "₹X so far" for KPIs without a target, multi-outlet KPIs
  count only targeted outlets, "Change vs last month" on total sales. All tenants: Targets-page outlet table aligned by
  KPI code; ParamCard "₹10,414 · ₹10,000" / "₹X to go". → [`BAJAJ-CUSTOMIZATIONS.md`](BAJAJ-CUSTOMIZATIONS.md) §10
- Smaller: visibility amount-upload "Download Report" pages ≤ 100 rows (was a rejected 10,000 → button did nothing);
  ISR redeem-for-outlet sheet enforces the reward's min/max; voucher sheet uses the item's admin min/max; outlet name in
  the login reply (retailer header right from first paint); honest error copy on upload/money screens; KYC programme
  copy uses the tenant name (Deoleo PDF unchanged; Deoleo OTP note now "Deoleo India Loyalty Programme"); signature pad
  no longer jumps; Bajaj app icon.
- **How it went out:** pre-release on-demand prod backup **`1794744368023`** → first "Deploy — Production (main)" run
  failed at **CI Tests** on a flaky platform test (VISCFG5, sync `getBy` before a second request resolved on the slower
  GitHub runner) → test-only fix `2eb8271d` → redeployed green. Prod untouched by the failed run (tests run before the
  preflight/build/migrate).

**Staging proof of the Hubble change (2026-11-15):** Bajaj staging orders BAJAJ-26-000032 / -000038 / -000039 refunded
through "Retry with Hubble" (+500 points each); Hubble's real 404 "no order" body was accepted by the canary check.

## 2. Tenants

- **Deoleo** (`deoleo`; hosts `deoleo.gifsy.in`, `deoleoloyalty.gifsy.in`) — live since July 2026 (tenant created 2026-07-01). Must stay
  **byte-identical** for every Bajaj-driven change unless the owner approved a platform-wide change.
  TDS method: GROSS_UP everywhere (₹0 withheld). Reversal engine: stays **LEGACY** (owner 2026-11-15/16).
- **Bajaj** (`bajaj`; prod hosts `bajajloyalty.gifsy.in` + `bajaj.gifsy.in`; staging `uat-bajaj.gifsy.in`) — prod data
  imported and verified 2026-11-12/13 (outlets/KYC/docs, visibility, wholesaler points, payout history, partial vendor
  TDS, targets + achievements Apr 2025 → Oct 2026): [`BAJAJ-PROD-OUTLET-IMPORT.md`](BAJAJ-PROD-OUTLET-IMPORT.md).
  **November 2026 sales applied on prod 2026-11-15** via Sales Import and verified per outlet (6,452 records); the month
  is **OPEN**. Customisations: [`BAJAJ-CUSTOMIZATIONS.md`](BAJAJ-CUSTOMIZATIONS.md); decisions:
  [`BAJAJ-GO-LIVE-DECISIONS-LOG.md`](BAJAJ-GO-LIVE-DECISIONS-LOG.md); prod set-up: [`BAJAJ-PROD-GO-LIVE-CHECKLIST.md`](BAJAJ-PROD-GO-LIVE-CHECKLIST.md).

## 3. In progress (not on prod — do not describe as shipped)

| Work | Branch / worktree | State | Read |
|---|---|---|---|
| **Wallet Reversal Engine** (⚠️ platform-wide, owner-approved; money path) | `feat/wallet-reversal-engine` (+ `feat/wre-*`), worktree `.claude/worktrees/reversal-engine` | WP0–WP7 built on the branch (WP7 real-Postgres concurrency suite 2026-11-16); not merged, not deployed. Per-tenant flag `reversalEngine: LEGACY / SHADOW / V2` (default LEGACY). **Owner decisions 2026-11-15/16:** Deoleo stays **LEGACY**; Bajaj → **V2**; a reversal of an already-paid payout becomes a **net receivable**, with **TDS credited back on the PAN**; every reversal shows an **outcome summary** (all tenants). Prod today runs the INTERIM rule (points reversals refused on wallets carrying debt; payout reversals whole-entry only). | `WALLET-REVERSAL-ENGINE-DESIGN.md` **on that branch** (maintained there) |
| **Daily Operations Digest** (⚠️ platform-wide, owner approved option A) | `feat/daily-ops-digest`, worktree `.claude/worktrees/ops-digest` | One build commit `70744e63` (2026-11-13), not audited/merged; paused behind go-live. | branch |

## 4. What's next / waiting on the owner

1. **Bajaj TDS method — decide BEFORE the first live Bajaj credit payout.** Bajaj has **no `tdsPolicy` row**, so it
   resolves to the default `{SEC_194C, GROSS_UP}` (`api/src/tenant/tenant-settings.service.ts`). Owner to confirm
   GROSS_UP vs DEDUCT on Gifsy → TDS Treatment.
2. **Bajaj points rules for November** (SAMT eligibility gate on NON ADHO: ≥ ₹200 → Elite, ≥ ₹400 → Privilege, plus the
   rest of the rule) — needs a **dedicated rule-engine session** with the owner. `points_rules` had no Bajaj rule at the
   last check. Do not close November or compute points before the rule is agreed.
3. **SAMT ADHO / NON ADHO split (Bajaj RLP card: Total ≠ ADHO + NON ADHO).** Prod Nov targets: SAMT outlets
   (861) carry only TOTAL + LINES; Unnati sums exactly. SAMT achievement has NON ADHO but no ADHO (KpiDef + sales-import
   definition for ADHO are scoped `programs: [Unnati]`), so the card's NON ADHO % counts SAMT sales against an
   Unnati-only target. Plan (owner 2026-11-16, Bajaj will provide the split): Bajaj re-sends SAMT targets with the split →
   widen ADHO applies-to on BOTH the KpiDef and the sales KPI definition to Unnati + SAMT (tenant config, staging
   first) → re-apply November sales. No Bajaj points rules exist on prod, so points are unaffected.
4. **Metro / Non-Metro for 71 Bajaj outlets** — DONE 2026-11-16 (71 updated; Metro 1,657 / Non Metro 4,834).
5. **October files from Bajaj**: the October **rewards** file and the October **cases** file — import when received.
   **Never run a points compute for Apr 2025 – Oct 2026** (paid by the vendor; imported).
6. Owner process items still open: `gifsy-deployer` over-privilege review; stray `gifsy` `tdsPolicy` row from the F1 bug
   (harmless; delete when convenient); rotate the Hubble client secret (was shared in a screenshot).
7. Then: Wallet Reversal Engine finish + rollout (Bajaj V2 first) → Daily Ops Digest.

## 5. Owner process rules (adopted — apply to every change)

- **No silent pass-throughs.** Every skip, refusal, fallback or "not applied" is called out in plain words to the
  admin/user on screen (and in logs) — never swallowed.
- **Platform-wide changes need explicit in-session owner approval before building** (root `CLAUDE.md` 🚦; enforced by a
  `PreToolUse` hook on push / prod dispatch). Prefer tenant-scoped.
- **Batch deploys** — GitHub Actions is metered (free tier); bundle work into releases.
- **Prod deploy = the owner clicks "Deploy — Production (main)"**. Never merge to `main`, deploy prod, or run a
  prod/staging DB write without the owner (show the SQL/commands, confirm a backup, wait).
- Staging role tests: log in yourself with `FIXED_OTP` 123456; prod logins stay with the owner.
- Imports: exhaustive source→DB reconciliation + dual audit; copy vendor files to our storage (vendor links expire).

## 6. How to deploy

**Gates (before every push):** `bash scripts/gates.sh` — api jest (`--maxWorkers=50%`) · api `nest build` (asserts
`dist/main.js`) · platform vitest · platform `tsc --noEmit`. Read ITS exit code / `GATES:` line; never a piped exit code.
The committed pre-push hook (`.githooks/pre-push`, enable once with `bash scripts/setup-hooks.sh`) runs the full gates on
any code push. Gates do not boot the DI container — the staging deploy health check is the boot test.

**Staging:** push to `develop` → `deploy-staging.yml`: tests (`needs: test` — a RED suite silently skips the deploy) →
preflight (`SALES_IMPORT_DRAIN_SECRET_STAGING` exists) → build → `gifsy-migrate-staging` → Sales Import + Downloads
worker jobs → jobsExecutor grant → API (1 GiB) → frontend. "Pushed" ≠ "deployed": verify the serving image (§7).

**Production** (owner-gated; each step needs the owner's go):
1. Staging-verified develop SHA, full gates green on that SHA, owner UAT done.
2. **Backup:** `gcloud sql backups create --instance=gifsy-db --project=gifsy-platform --description="pre-release <sha>"`
   and note the backup id (2026-11-15: `1794744368023`).
3. **Prepare main:** bring `main` to that develop SHA (fast-forward). If a main-only revert is ever pending, it must be
   re-applied explicitly — a merge does not undo a revert.
4. **Owner dispatches** GitHub Actions → **"Deploy — Production (main)"** → Run workflow (branch `main`). `deploy.yml`
   is `workflow_dispatch`-only; a push to `main` never deploys.
   Order: CI tests → (approve) → **PREFLIGHT** (metadata-only: `HUBBLE_CLIENT_ID`, `HUBBLE_CLIENT_SECRET`,
   `HUBBLE_WEBHOOK_SECRET`, `SALES_IMPORT_DRAIN_SECRET` must exist with an ENABLED version — else stop, prod untouched)
   → build → `gifsy-migrate` → `gifsy-sales-import` + `gifsy-exports` jobs → jobsExecutor grant → API (1 GiB, min 1) →
   frontend → health check.
5. A flaky CI test fails the run **before** anything touches prod: fix the test (test-only commit), re-verify, redeploy.
6. Verify (§7), then update this file + the release log in `DOCS-INDEX.md`.

Detailed runbooks: [`runbooks/PROD-CUTOVER-RECORD.md`](runbooks/PROD-CUTOVER-RECORD.md) (preflight + checklist),
[`MIGRATIONS.md`](MIGRATIONS.md), [`ENVIRONMENTS.md`](ENVIRONMENTS.md).

## 7. How to verify

- **Serving SHA** (never branch HEAD):
  `gcloud run services describe gifsy-api --region asia-south1 --project gifsy-platform --account=gifsy-deployer@gifsy-platform.iam.gserviceaccount.com --format='value(spec.template.spec.containers[0].image)'`
  (same for `gifsy-frontend`; staging = `gifsy-api-staging` / `gifsy-frontend-staging`, tag `staging-<sha>`; prod tag = bare `<sha>`).
  Jobs: `gcloud run jobs describe gifsy-exports|gifsy-sales-import …`.
- Health: API `/health` 200; `deoleo.gifsy.in/auth/login` and `bajajloyalty.gifsy.in/auth/login` render their own branding.
- Runtime: real login per role (staging: `FIXED_OTP` 123456 — accounts in §9), the changed flow end-to-end, an honest
  unhappy path, Deoleo no-change check when the change is platform-wide. Bajaj staging is the default tenant for UI checks.
- Downloads: request a heavy report → QUEUED → RUNNING → READY within minutes; `gcloud run jobs executions list --job=gifsy-exports`.
- After a migration: the `gifsy-migrate` execution succeeded.

## 8. Known traps (read before touching the area)

**Sales Import / targets**
- Focus product names come from the **target file's SECOND column with the same heading** as the KPI (the first is the
  value, the second the per-outlet names → `OutletTarget.targetValues.__names[kpiCode]`). A missing/misplaced second
  column = no focus names for that month.
- The Sales Import KPI's scope is **INTERSECTED** with the KpiDef's applies-to scope (Targets → KPIs). A sales KPI scoped
  wider than the target KPI still writes only the target KPI's outlets; disjoint scopes write nothing.
- Never compute points for months that were imported as already-paid (Bajaj Apr 2025 – Oct 2026).
- `__names` is the only non-KPI key in `targetValues`; anything enumerating KPI codes must skip it.

**Money / wallets / TDS**
- `CreditPayoutEntry.outletId` is the outlet **CODE** (no FK); the frontend's `outletId` is the Outlet **CUID**.
- A paid `PayoutTransaction` is `status='SUCCESS'` (no `PAID` in that enum).
- A partner's Wallet row is created only at KYC approval — pre-KYC point paths must upsert.
- Absent `tdsPolicy` → `{SEC_194C, GROSS_UP}`; a malformed one throws (fail-closed).
- Points and ₹ payouts are credited in **whole units**, rounded half-up once.
- 8 Bajaj wallets are intentionally negative (sales returns); the interim rule refuses points reversals on wallets with debt.
- Hubble: a timeout is **not** a "no". Never refund a Hubble order by hand — use the runbook.

**Data / Prisma / DB**
- Never `isActive:true` as an "active outlet" denominator (use `deletedAt:null AND deactivatedAt:null`); `isActive:true`
  means approved+active.
- Prisma `{not: X}` / `notIn` drops NULL rows → `OR:[{col:null},{col:{not:X}}]`.
- Bulk write loops in one interactive `$transaction` time out at tenant scale → chunk, or raise the timeout for money paths.
- Re-KYC has two entry paths (in-app flips the submission; bulk upload sets only `Outlet.reKycFlags`) → gate on
  `isReKycActionable(flags, latestStatus)`.
- Staging and prod share the private-IP Cloud SQL instance `gifsy-db` (DBs `gifsy_staging` / `gifsy_prod`): every
  one-off op guards `current_database()` first. One-off jobs use raw `pg` (Prisma 7 driver adapter: bare `new PrismaClient()` fails).
- Never `prisma migrate dev`. Run `prisma generate` before gating a schema change.

**Platform / infra**
- Cloud Run throttles CPU between requests → periodic work runs from Cloud Scheduler → internal endpoint, not `@Cron`.
- A new `public/` subdirectory needs the `platform/src/proxy.ts` matcher exclusion; a no-session `@Public` API path also
  needs a `PUBLIC_PATHS` entry. Prove on the real staging edge, not `next dev`.
- Any new GIFSY-wide read uses `platformWide(user)` (assumed operators are scoped to the tenant).
- `FIXED_OTP` disables rate limiting on staging — throttling can only be proven on prod.
- Windows-created secrets can carry a trailing `\r` or a BOM — strip before saving.
- gcloud on the owner's machine may default to another project/account — always pass
  `--account=gifsy-deployer@gifsy-platform.iam.gserviceaccount.com --project=gifsy-platform`.
- A new npm import missing from `package.json` passes gates but crashes at boot (prefer `node:` built-ins).
- `terraform` config has drifted from live in places — plan first, never blind-apply.

**Tests**
- **CI-runner flakes:** GitHub runners are slower than the dev box. Rules: `findBy`/`await waitFor` for anything that
  appears after a request or an `await` (never a sync `getBy`); never pass a timeout BELOW the suite defaults (RTL 15 s,
  vitest test 30 s, jest 30 s — raise only); no wall-clock budgets (use fake timers); fake timers always restored; dates
  relative to now. Enforced by `platform/vitest.setup.ts` + `vitest.config.ts`, `api` jest `testTimeout`, and the
  `eslint-plugin-testing-library` rules in `platform/eslint.config.mjs` (sweep shipped in the 2026-11-16 release).
- Local api jest runs at `--maxWorkers=50%` (all workers starved the 18-thread box).
- A local **PostgreSQL 15** (Windows service `postgresql-x64-15`, port **55432**) exists on the dev machine **only for
  disposable test databases** (e.g. the WP7 reversal-engine concurrency suite via `WRE_PG_ADMIN_URL`). Prod and staging
  are Cloud SQL PostgreSQL 15 on `gifsy-db`; never point tests at them.
- Never hardcode a future date in a test; compute relative to `new Date()`.

## 9. Reference

**Session/auth model:** access token = httpOnly `token` cookie, 60-minute JWT that slides on activity; refresh =
httpOnly `refresh_token`, single-use rotating; the edge proxy injects the backend Bearer; refresh-on-401 single-flight.
Rolling idle window 30 days per device (`SESSION_TTL_DAYS`, `api/src/auth/auth.constants.ts`); an operator's
assumed-tenant session slides on the same 30-day window (`ASSUMED_SESSION_TTL_HOURS` = 720). Detail: `P1-sessions-design.md`.

**Staging logins (`FIXED_OTP` 123456):** GIFSY admin `9830011252` (clientId `gifsy`); Deoleo admin `6289864191`; Deoleo
partner `7795096288`; sales `9900000041` (ISR) · `9900000002` (SO) · `9900000011` (XSR). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (POST `/v1/auth/send-otp` → `/v1/auth/verify-otp`; operator
cross-tenant = `/v1/auth/assume-tenant`). Staging hosts `uat-<slug>.gifsy.in`.

**Constraints:** see root `CLAUDE.md` (gates, platform-wide gate, guardrails). Memory (`~/.claude/projects/.../memory`)
holds per-topic history; this file wins on current state.
