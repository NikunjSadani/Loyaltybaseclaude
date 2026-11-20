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
> Last updated: **2026-11-19 late** (prod release `1fa2305c` — §1, §3, §4, §8).

Multi-tenant FMCG **trade-loyalty** platform. Operator **Gifsy**; live clients **Deoleo** (since July 2026) and
**Bajaj Consumer Care** (go-live November 2026). Backend `api/` (NestJS + Prisma 7 — owns the DB and ALL business logic)
· thin frontend `platform/` (Next.js; proxies `/api/*` → backend `/v1/*`). Repo `C:\Users\nikun\Loyaltybaseclaude`;
work on **`develop`** (auto-deploys to staging); prod ships from **`main`** by a manual workflow.

---

## 1. Where things stand (2026-11-19)

| | SHA | Since | Notes |
|---|---|---|---|
| **Production** (`gifsy-api`, `gifsy-frontend`, jobs `gifsy-sales-import` + `gifsy-migrate`) | **`1fa2305c`** (verified 2026-11-19 ~21:45 IST: api / frontend / worker / migrate images `1fa2305c`; migrate `gifsy-migrate-dhbk7` succeeded 21:15 IST; **45** migrations applied (`20261119120000…124300` reversal engine + `20261120100000_add_help_topics`), 0 failed/rolled back; 0 error logs, 0 429/5xx after deploy; `SALES_RETENTION_V2=on` on api + worker; every tenant's reversal engine = LEGACY (no setting rows)) | 2026-11-19 | `origin/main` = `origin/develop` = `1fa2305c`; pre-release backup `1795096760898` |
| **Staging** (`*-staging`) | **`1fa2305c`** (tickets assign/escalate push in flight — see §3) | 2026-11-19 | |
| Previous prod | `7ba69566` → `71df01f7` → `de2f3700` → `4e395b21` → `720ffce9` → `2eb8271d` | 2026-11-19 … 11-15 | rollback targets (⚠️ a rollback below `1fa2305c` leaves the 45 additive reversal-engine/help columns+tables in place — harmless to older code) |

**The 2026-11-19 (night) prod release `f61aec24` + `1fa2305c`** (all owner-approved; platform-wide items approved in-session; money paths dual-audited; staging-verified with real Bajaj logins):
- **Wallet Reversal Engine** shipped DORMANT: schema (45 additive migrations), LEGACY/SHADOW/V2 per-tenant flag (no rows on prod → LEGACY everywhere), backfill + verify jobs. Bajaj **staging** = V2 after the §9.1 wallet backfill (2,321 wallets, 0 blocked). Bajaj **prod** = LEGACY until its own backfill + owner go. → `WALLET-REVERSAL-ENGINE-DESIGN.md`
- **Location gate + Location Report** (flag `features.requireLocation`, default OFF; owner switches ON for Bajaj prod). → [`LOCATION-GATE.md`](LOCATION-GATE.md)
- **Visibility**: fence only the photos that apply to the outlet (fixes "Unverifiable" from a hidden Window 2); centred review dialog with Program/Sub-Program + large photos.
- **Wholesaler wallet "Incl. Activation"** note under Lifetime Payout (flag `wholesalerPayoutInclActivation`; Bajaj staging ON, prod: owner).
- **Shared outlet wallet view** — the sales outlet page renders the partner's own wallet view (platform-wide, owner-approved).
- **Bajaj notification reminder** with device-specific (iOS / Android) steps + service-worker reload fix.
- **Help & videos** per tenant (flag `helpVideos`, default OFF; content loaded per tenant — prod content load pending owner OK).
- **Sales retention**: `deploy.yml` now keeps `SALES_RETENTION_V2=on` on `gifsy-api` + `gifsy-sales-import` across deploys (set live earlier on 2026-11-19 after the trim).
- **MSG91 + Hubble webhooks exempt from the IP throttler** (`23d35290`, `1fa2305c`): MSG91's "On Outbound Report Received" webhook fires for EVERY outbound WhatsApp on the number (incl. campaigns sent straight from the MSG91 panel — ~6,000 reports on 2026-11-19, ~1,400/min at 11:28 IST, vs 5 portal messages). The 60/min IP bucket returned 3,000+ 429s and MSG91 **auto-disabled** the webhook. Fixed; owner re-enabled it (WhatsApp → Webhook → pencil → **Webhook Status** switch → Update); first report accepted 22:18 IST.

**The earlier 2026-11-19 prod release `7ba69566`** (all owner-approved; platform-wide items approved in-session; money paths dual-audited; release gates: only CRITICAL/HIGH block). Staging runtime checks 2026-11-18 with real logins on Bajaj:
- **Voucher Dispersal — edit + "Add more people" batches** (GIFSY console): whole card clickable + per-card Excel; edit name/budget (floor = spent + with Hubble + failed-may-complete + queued; audited history); numbered batches (preview → confirm / discard; one voucher per phone per campaign across batches → "Already sent in batch N"); **Mark as not bought is FINAL** (admin, audited, releases budget, closes the row); only Hubble's documented statuses (SUCCESS/PROCESSING/FAILED) are trusted; earlier-order alerts (strongest status kept, open count on page + list badge + Daily Ops Digest "still open"). Staging: edit refusal below spent ✓, edit history ✓, batch-2 DUPLICATE ✓, discard ✓, Excel ✓. → [`VOUCHER-DISPERSAL.md`](VOUCHER-DISPERSAL.md) §10–§10f
- **Sales Import Apply / Recalculate as background jobs** + Next `/api` proxy timeout 300 s: Apply returns 202, the `gifsy-sales-import` worker applies month by month (DONE inside the write transaction), one active job per month (409 to a second click / another admin / Close / Reopen), requestId lookup, "Last apply from this file". Staging: 202 → worker in 13 s → done in 18 s; 2nd click 409; same requestId → same job ✓. → [`SALES-IMPORT-PIPELINE-PLAN.md`](SALES-IMPORT-PIPELINE-PLAN.md) §18 items 4–5 (⚠️ migration `20261118170000` is NOT re-runnable — recovery steps there)
- **TDS 194R rules** (owner decisions 2026-11-18): per client; TDS keyed **by PAN** (payee snapshot `payeePan` on every payout / redemption; a PAN change splits the year); base = every benefit; FY = bank-file date; 10% PAN / 20% no-PAN; whole year on the current method; only 194R visibility on DEDUCT is withheld; no 194R TDS or service invoices; excess only flagged; fully withheld payouts settle without a bank line. Staging: raw SQL proven on the real DB in a rolled-back transaction; 194R/194C reports + summary cards ✓. **194C unchanged.** → `VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md` §9 + in-app TDS guide
- **Usage report** (`/admin/reports/usage`): per user — days, visits, minutes (a minimum: first→last action per visit, new visit after 30 min idle), installed app vs browser, phone vs computer; automatic requests (`X-Background: 1`) never count. Staging: phone-app ISR 132 s, browser SO 66 s, background-only traffic added 0 ✓; Excel with About sheet ✓. Tracking starts on the prod ship date. → [`USAGE-REPORT.md`](USAGE-REPORT.md)
- **Also in this release (staging-verified 2026-11-17/18):** KYC hardening + roll-up past removed managers (filing-time manager chain); day-level sales + MTD comparison (retention rules shipped OFF behind `SALES_RETENTION_V2`); **Daily Operations Digest** (staging test-send to the owner + Nikita OK); Sales Import in-app guide; flaky-test follow-ups; and everything from `71df01f7` below.
- **KYC fast-track** (Bajaj flag `gifsyRejectFastTrack`, Gifsy console → Behaviour flags, confirm dialog): a KYC
  resubmitted after a GIFSY rejection goes straight to PENDING_GIFSY when the previous KYC was rejected by GIFSY *after*
  the managers approved it; SO Declaration and manager rejections always go through managers; only the outlet's assigned
  rep (or their managers) gets the shortcut. Visible on the admin KYC banner, approvals-queue badge, sales timeline,
  exports' "Routing" column. Staging flag ON; **prod flag to be switched ON by the owner (pending, 2026-11-19).**
- **Assigned-rep gate (all tenants):** filing a KYC / "Not interested" / consent OTP only for outlets assigned to the
  caller or their downline; partner logins only their own outlet; read-only roles refused.
- **`/admin/approvals`** (dead page whose buttons never saved) → redirects (GIFSY → `/admin/kyc/approvals`, others →
  `/admin/kyc`).
- **Dashboards (all tenants):** program filter on Overview / Program Health / KYC; **Monthly billing progress** card on
  Overview (outlets bucketed by achieved ÷ primary-KPI target, pace to the data date, drill-down + Excel). Staging
  Bajaj primary KPI was switched Month Target → **Total** to match prod.

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
| **Reversal engine — over-reversal debt + display** (⚠️ platform-wide, money path) | `fix/wre-overreversal-debt`, worktree `.claude/worktrees/wre-fix2` (HEAD `05979071`) | Owner decisions 2026-11-15/19: over-reversal → **debt** (negative balance, repaid from future earnings); show the negative balance as-is, redemption blocked; the reversed credit's own expired part counts as already recovered. **D1** "points owed" = how far below zero the balance is, identical on every screen; **D2** (platform-wide, approved) liability = Σ positive balances only + separate "points owed" for ALL tenants; **D3** not built (LEGACY write-offs before a LEGACY→V2 switch are not counted against the expired part — switch Bajaj prod to V2 before any reversal; prod had **0** credit reversals on 2026-11-19). Round 3 done; re-audit round 4 in progress; then full gates → staging (owner OK). WP7 real-Postgres suite not run (needs `WRE_PG_ADMIN_URL`). New migrations `20261119124400`/`124500` (sort before `20261120100000` — fine for a fresh DB; prod applies them as "new"). | `WALLET-REVERSAL-ENGINE-DESIGN.md` §8.7–§8.8 on that branch |
| **Support tickets — assign / escalate to client admin / layout** (⚠️ platform-wide, owner-approved "all programmes"; admin header bell for ALL tenants incl. Deoleo approved 2026-11-19) | `feat/ticket-assign-escalate`, worktree `.claude/worktrees/tickets-escalate` (`8bf3d484` = round 3 `8c82c6cd` + develop) | 3 audit rounds; full gates green 2026-11-19; **push to develop (staging) in flight** (owner OK 2026-11-19); then runtime check on Bajaj staging. Migrations `20261120110000`, `…110100`, `…110200`. ⚠️ Rollback trap: an API build from before these has no note-visibility filter (client admins could read Gifsy-only notes) and breaks on `WAITING_ON_CLIENT`. | `SUPPORT-TICKETS.md` (incl. "Cutover & rollback") |
| **Login renewal race (strict reuse)** | `fix/auth-refresh-race`, worktree `.claude/worktrees/auth-refresh-race` (`95206483`) | Final round built; **owner OK needed** on: grace 5 s → **6 s**; a server action whose refresh failed runs unauthenticated (marked `x-session-refresh-failed`). Then full gates + dual audit + staging. Real two-connection Postgres test not run. | `P1-sessions-design.md` (timing table) |
| **Help & videos UX fixes** | `fix/help-videos-ux` (`8f4d3800`) | Built; full gates → staging. | `HELP-VIDEOS.md` |
| **Visibility review polish** | `fix/visibility-review-polish` (`6f6e7dda`) | Built; full gates → staging. | — |
| **MSG91 webhook "Add Condition"** (receive only portal reports) | — | Owner deferred 2026-11-19. ⚠️ Can't simply filter on `crqid`: scheme sends and some untracked paths carry none (their reports would be lost). Needs a design. | this row |

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
7. **After the 2026-11-19 prod release.** DONE 2026-11-19: Bajaj `gifsyRejectFastTrack` ON (Deoleo unset), verified
   read-only; Daily Ops Digest prod recipients = 4 `@gifsy.in` addresses, verified; `reports-run-prod` 300 s / 0 retries;
   `dve` tag removed (100% on the latest revision); prod backup `1795056648426` ("pre-trim 2026-11-19").
   **Sales trim — DONE 2026-11-19:** trim applied on prod, `SALES_RETENTION_V2=on` on api + worker (revision
   `gifsy-api-00094-9rp`; kept across deploys by `deploy.yml` since `f61aec24`), prod DB disk alert at 50% (policy
   `11636917613043922792`). Recipe kept for reference: `trim` on the `gifsy-migrate` job
   (`--args=node,dist/sales-import/oneoff/sales-history-trim.main.js,trim`), `rebuild-days` on the 2 GiB
   `gifsy-sales-import` job, both with `--update-env-vars=TRIM_TARGET_DB=gifsy_prod`.
7a. **After the 2026-11-19 night release (`1fa2305c`) — waiting on the owner:** switch ON for Bajaj prod
   `features.requireLocation`, `wholesalerPayoutInclActivation`, `helpVideos`; OK to load the Help & videos content on
   prod; OK to correct the remaining non-Privilege "Unverifiable" visibility captures in one go (list + SQL + backup
   first — 2 were corrected earlier, backup `1795068290437`); Bajaj prod wallet backfill → reversal engine V2 (backup +
   owner OK; **before any credit reversal on Bajaj prod** — see §3 D3).
7b. **Month-end sales files (300–350 MB):** test a 200 MB+ real Bajaj file on staging before 30 Nov (owner to send the
   file). Next release: processing as a Cloud Run Job end-to-end + direct-to-storage resumable uploads; ask Bajaj about
   daily rolling 2–3-day files.
7c. ~~Alerts for people without phone notifications~~ — owner chose an after-login reminder with device-specific steps
   (built, shipped in `1fa2305c`, Bajaj).
8. **Hubble:** ask which of Ajio / MakeMyTrip / Myntra / Uber are claim-code-only → add product ids to
   `HUBBLE_CLAIM_CODE_PRODUCT_IDS`.
9. Wallet Reversal Engine rollout: schema + engine are on prod (DORMANT, LEGACY everywhere). Next: ship
   `fix/wre-overreversal-debt` (§3) → Bajaj prod backfill (dry-run → owner OK → apply) → verify → flip Bajaj to V2.
   Deoleo stays LEGACY. **Never run points compute for Bajaj imported months (Apr 2025 – Oct 2026).**

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
4. **Owner dispatches** GitHub Actions → **"Deploy — Production (main)"** → **Run workflow** (branch `main`) → then
   **Review deployments → Approve** (the run waits at the approval gate). `deploy.yml` is `workflow_dispatch`-only; a
   push to `main` never deploys. ⚠️ **Never "Re-run" an older run** — it redeploys THAT run's old commit (2026-11-19:
   a re-run put `71df01f7` on prod for ~1 h). Before the deploy: pause `voucher-dispersal-drain-prod` and ask that no
   sales file is applied; resume the scheduler after verification.
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
- Liability on dashboards (once `fix/wre-overreversal-debt` ships) = Σ **positive** balances; "points owed" = how far
  below zero balances are — never net them (owner D1/D2, 2026-11-19). Bajaj prod's 8 imported negatives = −3,549 pts.

**Webhooks / MSG91**
- Every vendor webhook (MSG91 status, Hubble) must be `@SkipThrottle()` — the global 60/min bucket is keyed per IP and
  vendors post from a few shared IPs. MSG91's WhatsApp "On Outbound Report Received" fires for EVERY message on the
  number, incl. campaigns sent from the MSG91 panel, so volume is unrelated to portal sends. On repeated 4xx MSG91
  **auto-disables** the webhook (email "paused"); re-enable at WhatsApp → Webhook → pencil → **Webhook Status** → Update.
  Proof it works: `gcloud logging read … httpRequest.requestUrl:"/v1/notifications/status"` shows 201s.
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
