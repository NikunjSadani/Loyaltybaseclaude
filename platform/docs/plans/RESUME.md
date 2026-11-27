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
> Last updated: **2026-11-27 ~22:00 IST** (prod = `fe7900af`, Release 3, deployed 2026-11-26; `main` = `develop` =
> staging = `44341503` — **prod deploy pending** (owner); payout-tracker go-live steps + owner decisions — §1, §3, §4, §8).

Multi-tenant FMCG **trade-loyalty** platform. Operator **Gifsy**; live clients **Deoleo** (since July 2026) and
**Bajaj Consumer Care** (go-live November 2026). Backend `api/` (NestJS + Prisma 7 — owns the DB and ALL business logic)
· thin frontend `platform/` (Next.js; proxies `/api/*` → backend `/v1/*`). Repo `C:\Users\nikun\Loyaltybaseclaude`;
work on **`develop`** (auto-deploys to staging); prod ships from **`main`** by a manual workflow.

---

## 1. Where things stand (2026-11-27 ~22:00 IST)

| | SHA | Since | Notes |
|---|---|---|---|
| **Production** (`gifsy-api`, `gifsy-frontend`, jobs) | **`fe7900af`** ("Release 3" = release/next5 + next6 + next7) | 2026-11-26 ~19:20 IST | Owner-deployed. Since `763e463b` (prod 2026-11-24): migrations `20261125100000` … `20261126140000` (8); any 2026-11-25 intermediate prod deploys are not recorded in the repo. Contents: release log in [`../DOCS-INDEX.md`](../DOCS-INDEX.md) |
| **`main` = `develop` = staging** | **`44341503`** | 2026-11-27 | Staging verified serving `44341503` at 20:57 IST 27 Nov. **Prod deploy PENDING** — the owner runs "Deploy — Production (main)" |

**On `main`, not yet on prod (`fe7900af..44341503`, all gates green):**
- `7cad7a6c` **Catalogue fix** (platform-wide, owner-approved 2026-11-27): partner Rewards + sales Catalogue load every
  page (they asked for one page of 20, sorted by points, so on Bajaj prod the 20 "choose an amount" vouchers hid every
  physical gift); a failed load shows "Couldn't load…" + Retry; admin Gifts pages through all items; id tiebreak on
  catalogue ordering. Staging verified 21/21 items.
- `43179f71` + `03895e46` + `ca2b03dc` + `44341503` **Bajaj Payout Tracker** — daily outlet-level payout report + email
  Mon–Sat 10:00 IST, tenant-scoped, inert unless the tenant has a `payoutTracker` ProgramSetting (Deoleo none);
  KYC-currently-approved outlets only; errored outlets held back with a client note; recipients batched ≤ 50 per email
  with per-batch progress so retries never re-send; prod `deploy.yml` sets `PAYOUT_TRACKER_EMAIL_LIVE=true`. New
  migration `20261127100000_payout_tracker_report_runs`. → [`PAYOUT-TRACKER.md`](PAYOUT-TRACKER.md)
- `03895e46` **Per-tenant WhatsApp variable order** (⚠️ PLATFORM-WIDE, owner-approved in-session 2026-11-27; inert unless
  set): optional `whatsappVariables` per event in the notification-templates config (Gifsy console → Notification
  templates); an invalid stored override blocks that send loudly. For Bajaj's 4-variable `bajaj_loyalty_points`.
  → [`BAJAJ-CUSTOMIZATIONS.md`](BAJAJ-CUSTOMIZATIONS.md) §16

**Staging test 2026-11-27 (payout tracker):** first run answered "already-done" (an earlier old-code run row was SENT);
owner approved clearing that one staging row (backup printed, 1 deleted) → re-run SENT on the new code. The email said
"sales up to 18 Nov" because staging's latest Bajaj sales file (applied 25 Nov) only reaches 18 Nov — expected; prod
has the 27-Nov file → "26 Nov".

**Go-live steps after the prod deploy (owner-gated, in order):** (1) confirm prod serves `44341503` + migration
`20261127100000` applied (§7); (2) owner approves the prod ProgramSetting write `bajaj / payoutTracker`
{enabled, 358 recipients, `sendTimeIst` 10:00, Mon–Sat, `sendOnHolidays` true} — backup printed, guarded `gifsy_prod`;
(3) owner creates Cloud Scheduler `payout-tracker-prod` `*/15 9-21 * * 1-6` Asia/Kolkata, POST with
`REPORTS_RUN_SECRET`; (4) owner sets the Bajaj WhatsApp templates in the console: points `bajaj_loyalty_points` vars
[ownerName, pointsCredited, redeemableBalance, dateCredited]; payout `bajaj_payout_loyalty`. **First automatic email
target: Sat 28 Nov 10:00 IST.** Runbook: `PAYOUT-TRACKER.md` §8.

Earlier releases (2026-11-15 → 2026-11-26) — contents, migrations and verification are in the release log in
[`../DOCS-INDEX.md`](../DOCS-INDEX.md); the long per-release write-ups that used to sit here are in git history
(`git show 44341503:platform/docs/plans/RESUME.md`) and in each feature's own doc. Still-relevant facts from them are
kept in §4 (owner queue) and §8 (traps).

## 2. Tenants

- **Deoleo** (`deoleo`; hosts `deoleo.gifsy.in`, `deoleoloyalty.gifsy.in`) — live since July 2026 (tenant created 2026-07-01). Must stay
  **byte-identical** for every Bajaj-driven change unless the owner approved a platform-wide change.
  TDS method: GROSS_UP everywhere (₹0 withheld). Reversal engine: the LEGACY engine was retired for every tenant
  (owner 2026-11-21, platform-wide, approved; shipped in release/next2, prod 2026-11-22). Deoleo had nothing to backfill (98 wallets, zero wallet transactions — prod dry run 2026-11-21).
- **Bajaj** (`bajaj`; prod hosts `bajajloyalty.gifsy.in` + `bajaj.gifsy.in`; staging `uat-bajaj.gifsy.in`) — prod data
  imported and verified 2026-11-12/13 (outlets/KYC/docs, visibility, wholesaler points, payout history, partial vendor
  TDS, targets + achievements Apr 2025 → Oct 2026): [`BAJAJ-PROD-OUTLET-IMPORT.md`](BAJAJ-PROD-OUTLET-IMPORT.md).
  **November 2026 sales applied on prod 2026-11-15** via Sales Import and verified per outlet (6,452 records); the month
  is **OPEN**. Customisations: [`BAJAJ-CUSTOMIZATIONS.md`](BAJAJ-CUSTOMIZATIONS.md); decisions:
  [`BAJAJ-GO-LIVE-DECISIONS-LOG.md`](BAJAJ-GO-LIVE-DECISIONS-LOG.md); prod set-up: [`BAJAJ-PROD-GO-LIVE-CHECKLIST.md`](BAJAJ-PROD-GO-LIVE-CHECKLIST.md).

## 3. In progress (not on prod — do not describe as shipped)

| Work | Branch / worktree | State | Read |
|---|---|---|---|
| **Hide achievement-only KPIs** (case KPIs BSC / FB1 / FB2 Cases, `KpiDef.achievementOnly`) from sales / partner screens + offers — ⚠️ PLATFORM-WIDE helper, owner-approved | `feat/payout-tracker` (worktree `rel-next5`), **uncommitted** | Built; independent audit found 9 defects — fixes in progress | this row |
| **Target "to go" display rules** (same branch): ₹ and counts whole; volumes 1 decimal; target / "to go" = exact gap rounded up (owner reconfirmed 27 Nov: keep the exact gap even when it differs from shown target − achieved); achieved exact once met, with "✓ Achieved · +X over"; charts short (₹5.2K) only; % floored; "No sales yet"; group totals count targeted outlets only | `feat/payout-tracker` (`rel-next5`), **uncommitted** | Same audit / fix round | this row |
| **MSG91 webhook "Add Condition"** (receive only portal reports) | — | Owner deferred 2026-11-19. ⚠️ Can't simply filter on `crqid`: scheme sends and some untracked paths carry none (their reports would be lost). Needs a design. | this row |

Everything listed here on 2026-11-24 (delivery address on the fulfilment sheet etc.) shipped in `fe7900af`.

## 4. What's next / waiting on the owner

0. **Prod deploy of `44341503`** + the payout-tracker go-live steps (§1). First email Sat 28 Nov 10:00 IST.
1. **Open owner decisions (2026-11-27):**
   - KYC business-document change — estimate only so far.
   - October cases for the Oct–Dec (Q3) consistency bonus.
   - Beat names missing for approved outlets.
   - Bajaj cash-redemption WhatsApp message.
   - Zomato ₹1,001 item.
   - Test outlet `11111111`.
   - WhatsApp number formatting (`12535` vs `12,535`).
   - Disable the staging legacy KPIs.
   - Excel / email formatting request (coloured header sections + conditional formatting on summary values) — **not
     started**.
2. **Added 2026-11-24 (still open unless the owner says otherwise):**
   - **Fund reconciliation data per client**: opening balance + as-of date, agency fee (% or flat), discount per voucher
     item, low-balance threshold + recipients (Gifsy console → client → Fund); and whether to switch client alert
     e-mails ON (`FUND_ALERTS_LIVE=true` in `deploy.yml`, then a deploy).
   - **Hubble prod webhook** never called → ask Hubble to register
     `https://gifsy-api-4d4n5mc6yq-el.a.run.app/v1/hubble/webhook` (+ the shared signing secret). The 2-min re-check
     covers it meanwhile.
   - **MSG91 WhatsApp report webhook** auto-paused 2026-11-24 (burst from direct MSG91 campaigns). Prevention options,
     none chosen: keep 2 API instances warm / schedule the missed-report reconcile / big campaigns from a separate number.
   - **Program Health (optional)**: "Redeemed (period)" includes imported vendor burns; held balances are not in the
     liability. Offered: split the card / show held next to liability.
   - **Edge**: estimate only — needs screenshots of what client users see.
3. **Bajaj TDS method — decide BEFORE the first live Bajaj credit payout.** With no `tdsPolicy` row Bajaj resolves to
   the default `{SEC_194C, GROSS_UP}` (`api/src/tenant/tenant-settings.service.ts`). Owner to confirm on Gifsy → TDS
   Treatment. (Not re-checked since 2026-11-24.)
4. **Bajaj points (November onward):** rules spec [`BAJAJ-POINTS-RULES-SPEC.md`](BAJAJ-POINTS-RULES-SPEC.md); engine
   first live month = `2026-11` on prod + staging. Do not close November or credit points without the owner.
   **Never run a points compute for Apr 2025 – Oct 2026** (imported, paid by the vendor).
5. **SAMT ADHO / NON ADHO split** (Bajaj RLP card: Total ≠ ADHO + NON ADHO): Bajaj to re-send SAMT targets with the
   split → widen ADHO applies-to on BOTH the KpiDef and the sales KPI definition to Unnati + SAMT (staging first) →
   re-apply November sales. (Status not re-checked since 2026-11-16.)
6. **October files from Bajaj** (rewards + cases) — import when received (cases also feed item 1's Q3 bonus question).
7. **Month-end sales files (300–350 MB):** test a 200 MB+ real Bajaj file on staging before 30 Nov (owner to send it).
8. **Hubble:** ask which of Ajio / MakeMyTrip / Myntra / Uber are claim-code-only → add product ids to
   `HUBBLE_CLAIM_CODE_PRODUCT_IDS`; rotate the Hubble client secret (was shared in a screenshot).
9. **Wallet reversals on Bajaj prod:** the LEGACY engine was retired in release/next2 (prod 2026-11-22). Before the
   first Bajaj reversal, check the credits-screen readiness line (re-run the backfill if it shows un-sequenced wallets).
   → `WALLET-REVERSAL-ENGINE-DESIGN.md`
10. Smaller open items: Bajaj prod ticket-remarks inbox (unset at last check); real-phone location test (Android +
    iPhone); confirm the Cloudflare Workers Paid monthly request budget against the ~30k req/h peak; stray `gifsy`
    `tdsPolicy` row (harmless; delete when convenient); recheck the 4× `/v1/auth/refresh` 503 seen 2026-11-24 17:59 IST
    (refresh-row lock timeout `55P03`, two simultaneous refreshes of one login).

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
4. **Owner dispatches** GitHub Actions → **"Deploy — Production (main)"** → **Run workflow** (branch `main`) — that is the ONLY
   click since 2026-11-21: the owner unticked **Required reviewers** on GitHub Environment `production`, so the
   `approve` job no longer pauses (it stays in `deploy.yml` as a harmless no-op; tests still gate the deploy).
   `deploy.yml` is `workflow_dispatch`-only; a
   push to `main` never deploys. ⚠️ **Never "Re-run" an older run** — it redeploys THAT run's old commit (2026-11-19:
   a re-run put `71df01f7` on prod for ~1 h). Before the deploy: pause `voucher-dispersal-drain-prod` and ask that no
   sales file is applied; resume the scheduler after verification.
   Order: CI tests → (approve) → **PREFLIGHT** (metadata-only: `HUBBLE_CLIENT_ID`, `HUBBLE_CLIENT_SECRET`,
   `HUBBLE_WEBHOOK_SECRET`, `SALES_IMPORT_DRAIN_SECRET` must exist with an ENABLED version — else stop, prod untouched)
   → build → `gifsy-migrate` → `gifsy-sales-import` + `gifsy-exports` jobs → jobsExecutor grant → API (1 GiB, min 1) →
   frontend → health check.
5. A flaky CI test fails the run **before** anything touches prod: fix the test (test-only commit), re-verify, redeploy.
6. Verify (§7), then update this file + the release log in `DOCS-INDEX.md`.

**Fund reconciliation e-mail switch (in the deploy workflows — `--set-env-vars` REPLACES the env list on every deploy,
so a value set by hand on the service is lost at the next deploy):**
- **Production** (`.github/workflows/deploy.yml`, API step): `FUND_ALERTS_LIVE=false` until the owner decides — one obvious
  line to flip to `true` before cutover (comment above the step). `false` = no client receives a low-balance e-mail (the
  digest and the client view say "switched off on this server").
- **Staging** (`deploy-staging.yml`, API step): `FUND_ALERTS_TEST_RECIPIENT=ops@gifsy.in` — every client alert goes only
  to that internal inbox (subject names who it would have reached); `FUND_ALERTS_LIVE` is never set on staging. The
  address must be on an internal domain (`REPORTS_RECIPIENT_DOMAINS`, default `gifsy.in`) or nothing is sent.

Detailed runbooks: [`runbooks/PROD-CUTOVER-RECORD.md`](runbooks/PROD-CUTOVER-RECORD.md) (preflight + checklist),
[`MIGRATIONS.md`](MIGRATIONS.md), [`ENVIRONMENTS.md`](ENVIRONMENTS.md).

## 7. How to verify

- **Serving SHA** (never branch HEAD):
  `gcloud run services describe gifsy-api --region asia-south1 --project gifsy-platform --account=<owner> --impersonate-service-account=gifsy-ops@gifsy-platform.iam.gserviceaccount.com --format='value(spec.template.spec.containers[0].image)'`
  (same for `gifsy-frontend`; staging = `gifsy-api-staging` / `gifsy-frontend-staging`, tag `staging-<sha>`; prod tag = bare `<sha>`).
  Jobs: `gcloud run jobs describe gifsy-exports|gifsy-sales-import …`.
- Health: API `/health` 200; `deoleo.gifsy.in/auth/login` and `bajajloyalty.gifsy.in/auth/login` render their own branding.
- Runtime: real login per role (staging: `FIXED_OTP` 123456 — accounts in §9), the changed flow end-to-end, an honest
  unhappy path, Deoleo no-change check when the change is platform-wide. Bajaj staging is the default tenant for UI checks.
- Downloads: request a heavy report → QUEUED → RUNNING → READY within minutes; `gcloud run jobs executions list --job=gifsy-exports`.
- After a migration: the `gifsy-migrate` execution succeeded.

## 8. Known traps (read before touching the area)

**Ops access / infra (2026-11-24)**
- The keyless ops identity (`gifsy-ops` impersonation) can read logs, run the read-only probe job and describe
  services, but **cannot create or read secrets, or create Cloud Scheduler jobs**. Those need the owner's own account.
  The owner's PowerShell blocks `gcloud.ps1` (execution policy), so hand them commands using **`gcloud.cmd`**.
- Cloud Run API has **CPU throttling ON** → in-process `@Interval` timers don't run while idle. Every background job
  must be triggered by Cloud Scheduler (push-drain, voucher-dispersal-drain, hubble-sweep, reports-run, expire-sweep).
- Worktrees share packages through junctions. Since 2026-11-24 the REAL `api/node_modules` + `platform/node_modules`
  live in `.claude/worktrees/rel-next4` (clean `npm ci` from the release lock files); `help-videos` and `vd-int` link to
  them. `prisma generate` in any linked worktree replaces the generated client for all — generate from the worktree
  whose schema is the superset, and re-generate before tests.
- ⚠️ **Before deleting ANY worktree, resolve where its node_modules really live** (links chain: A → B → C). Never
  `git worktree remove` / `Remove-Item -Recurse` a folder that holds the real packages or contains a junction — unlink
  junctions with `cmd /c rmdir <link>` first. (2026-11-24: removing merged worktrees deleted the shared packages, which
  sat in `memory-safety` behind a link chain; rebuilt with `npm ci`.)
- A Cloud-Scheduler POST with no body gets **411** from Google's front end — create jobs with `--message-body="{}"`.
- **`gifsy-oneoff-staging` is unusable (2026-11-27):** its pinned image was garbage-collected ("Image not found") and
  `gifsy-ops` cannot update job images (no Artifact Registry download permission). For staging DB one-offs use
  **`gifsy-exports-staging`** (current image, `DATABASE_URL_STAGING`) with a per-execution override
  `--args="^@@@^-e@@@<script>"`; the script must guard `current_database() = 'gifsy_staging'`.
- **Payout tracker "already-done" on staging:** a `tenant_report_runs` row for today (e.g. from an earlier run on old
  code) blocks the day's send. Clearing it is a staging DB write (owner OK + backup print). Staging's "sales up to" date
  follows staging's own (older) sales file, not prod's. → `PAYOUT-TRACKER.md` §8 / §10

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
- Liability on dashboards (since `4a48dc0d`) = Σ **positive** balances; "points owed" = how far
  below zero balances are — never net them (owner D1/D2, 2026-11-19). Bajaj prod's 8 imported negatives = −3,549 pts.

**Webhooks / MSG91**
- Every vendor webhook (MSG91 status, Hubble) must be `@SkipThrottle()` — the global 60/min bucket is keyed per IP and
  vendors post from a few shared IPs. MSG91's WhatsApp "On Outbound Report Received" fires for EVERY message on the
  number, incl. campaigns sent from the MSG91 panel, so volume is unrelated to portal sends. On repeated 4xx MSG91
  **auto-disables** the webhook (email "paused"); re-enable at WhatsApp → Webhook → pencil → **Webhook Status** → Update.
  Proof it works: `gcloud logging read … httpRequest.requestUrl:"/v1/notifications/status"` shows 201s.
- Hubble's **prod webhook is NOT registered** — Hubble has never POSTed `/v1/hubble/webhook` (14 days to 2026-11-24).
  The automatic re-check (`RewardsService.sweepHubbleOrders`) is the safety net, driven by Cloud Scheduler
  `hubble-sweep-prod` / `-staging` → `POST /v1/hubble/sweep` (secret `HUBBLE_SWEEP_SECRET[_STAGING]`, in the deploy
  preflight — create it BEFORE deploying; create the job PAUSED, resume after the deploy). The in-process `@Interval`
  tick is OFF in both deploys (`HUBBLE_ORDER_SWEEP_ENABLED=false` — prod CPU is throttled when idle). An order still open
  1 h after hand-off is flagged `HUBBLE_STILL_OPEN_STALE` (also once for anything past the 7-day window); an unflagged
  "no order" gets `HUBBLE_INDETERMINATE` (refundable only by ops Retry). It never refunds on "no order". Runbook §2a.
  Register the webhook with Hubble anyway.
- No manual FORWARD move (→PROCESSING / DISPATCHED / DELIVERED) on a Hubble-handed order without a code (owner
  2026-11-24): `transitionOrder` refuses it (console, dispatch controller, bulk upload row error) and the console hides
  "Advance". Exits: Retry with Hubble / Fulfil manually; reconcile + auto re-check are exempt.
- Hubble: a timeout is **not** a "no". Never refund a Hubble order by hand — use the runbook. Hubble only documents
  order statuses SUCCESS / PROCESSING / FAILED — CANCELLED / RETURNED are OUR redemption statuses, not Hubble's.
- TDS 194R is keyed by the **payee PAN snapshot** (`payeePan`), not the outlet's current owner; every new payout path
  must stamp it (see design doc §9 "import rule"). Any new automatic/timer frontend request must carry
  `X-Background: 1` (`{ background: true }`), or the Usage report counts it as activity.

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
- Migrations: use a plain `SET lock_timeout = '5s';` at the top and `RESET lock_timeout;` at the end — **`SET LOCAL` is
  ignored by `prisma migrate deploy`** (Postgres logged "SET LOCAL can only be used in transaction blocks", 2026-11-18).
  Write new migrations idempotent (`IF NOT EXISTS` / guarded `DO` blocks) so a lock-timeout failure can simply be
  resolved and re-run. Never edit a migration already applied anywhere (checksum).
- Worktrees share `node_modules` (junction): a schema change must make the worktree's `.prisma` / `@prisma/client` local
  before `prisma generate`, or it breaks every other worktree's client.

**Platform / infra**
- Cloud Run throttles CPU between requests → periodic work runs from Cloud Scheduler → internal endpoint, not `@Cron`.
- A new `public/` subdirectory needs the `platform/src/proxy.ts` matcher exclusion; a no-session `@Public` API path also
  needs a `PUBLIC_PATHS` entry. Prove on the real staging edge, not `next dev`.
- Any new GIFSY-wide read uses `platformWide(user)` (assumed operators are scoped to the tenant).
- `FIXED_OTP` disables rate limiting on staging — throttling can only be proven on prod.
- Windows-created secrets can carry a trailing `\r` or a BOM — strip before saving.
- gcloud on the owner's machine may default to another project/account — always pass the account + project. Since
  2026-11-20 `gifsy-deployer` is CI-only (least-privilege); laptop ops use the KEYLESS `gifsy-ops` identity:
  `--account=<owner> --impersonate-service-account=gifsy-ops@gifsy-platform.iam.gserviceaccount.com --project=gifsy-platform`.
- **Cloudflare Workers request quota:** every page view, RSC prefetch and API call through `*.gifsy.in` passes the
  `gifsy-proxy` Worker. On the FREE plan (100k req/day) the cap returned **Error 1027 on every tenant** (2026-11-20,
  87 concurrent Bajaj reps ≈ 30k req/h). Now on **Workers Paid** (10M req/mo). Any change that adds per-screen fetches,
  polling or `<Link>` prefetch on long lists multiplies edge requests — count them.
- A new npm import missing from `package.json` passes gates but crashes at boot (prefer `node:` built-ins).
- **React #418 (hydration mismatch):** hooks whose value differs between server render and the browser
  (`useGifsySettings`, the header date hook, `useAssumedContext`, `useInstallPrompt`) must use `useSyncExternalStore`
  (fix `fix/hydration-418`, shipped in release/next). Gating a redirect on such a hook before it is ready bounces users (an assumed
  GIFSY_STAFF went to `/gifsy` on hard refresh) — wait for a ready flag.
- **Photo GPS:** two photos taken close together share ONE precise-GPS lookup; never reuse a reading > 10 s old;
  PERMISSION_DENIED latches, TIMEOUT / POSITION_UNAVAILABLE are transient (`fix/gps-photo-overlap`, shipped in release/next).
- **Location required ≠ distance blocking.** `requireLocation` only requires a real fix (and records
  `LOCATION_FENCE_BLOCK` audit rows where a fence already blocks). The 200 m block is separate: KYC blocks only under
  `outletMasterGeo`; visibility only under `outletMasterGeo` or the tenant's own `visibilityConfig.geoFence.enabled` +
  radius. The flag lives in the console's **Behaviour flags** section, not "Feature Flags". Since
  `feat/require-location-default` shipped (release/next), an ABSENT key means ON (Deoleo included) — the switch is an
  emergency OFF.

**Visibility (since `release/2026-11-21`)**
- Capture is refused for outlets not KYC-approved / deactivated / Not Interested / Parked (`visibilityUniverseWhere`):
  outlet-status answers 200 `{inScope:false, canCapture:false, reason}`, submit answers 400. A re-KYC outlet (approved
  before, sent back e.g. for an address change) stays in scope — intended.
- The Operations fraud-flag list is Gifsy-only: client roles get counts (`flagDetailsAvailable:false`) and 403 on `/flags`.
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
Since `4a48dc0d` the refresh race is handled with a 6 s reuse grace + handback when the rotated tip was never used,
and a new `INTERNAL_PROXY_SECRET` (timing table in `P1-sessions-design.md`).
Rolling idle window 30 days per device (`SESSION_TTL_DAYS`, `api/src/auth/auth.constants.ts`); an operator's
assumed-tenant session slides on the same 30-day window (`ASSUMED_SESSION_TTL_HOURS` = 720). Detail: `P1-sessions-design.md`.

**Staging logins (`FIXED_OTP` 123456):** GIFSY admin `9830011252` (clientId `gifsy`); Deoleo admin `6289864191`; Deoleo
partner `7795096288`; sales `9900000041` (ISR) · `9900000002` (SO) · `9900000011` (XSR). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (POST `/v1/auth/send-otp` → `/v1/auth/verify-otp`; operator
cross-tenant = `/v1/auth/assume-tenant`). Staging hosts `uat-<slug>.gifsy.in`.

**Constraints:** see root `CLAUDE.md` (gates, platform-wide gate, guardrails). Memory (`~/.claude/projects/.../memory`)
holds per-topic history; this file wins on current state.
