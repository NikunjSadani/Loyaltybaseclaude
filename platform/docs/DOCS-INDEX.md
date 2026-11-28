# Docs index — every doc, what it covers, and the release log

**Start here:** [`plans/RESUME.md`](plans/RESUME.md) — current state, what's next, known traps, how to deploy and
verify. Working agreements: root [`CLAUDE.md`](../../CLAUDE.md). Last updated 2026-11-27.

## Maintenance rules (owner, 2026-11-16)

1. **Update docs in the same PR/commit as the code change** — the design/runbook that owns the fact, plus any doc that
   repeats it. A change is not done until its docs are.
2. **`plans/RESUME.md` is updated at every release** (prod or staging) and whenever a current-state, next-step or trap
   fact changes. Other docs never claim "current prod = …"; they link to RESUME.
3. **Add a row to the release log below at every prod release**, and a line to this index when you add a doc.
4. Status headers of design docs say plainly: *designing / building / on staging / ✅ in prod since <release>*. When a
   status changes, edit the header — don't stack dated banners.
5. User-facing guides (`platform/src/content/guides/`) are seen by every tenant incl. Deoleo — change them only for
   factual errors or real behaviour changes, and say so in the PR.
6. Gate: `node platform/scripts/check-doc-consistency.mjs` must print `✓ docs consistent` (also runs in CI).
   Protocol detail: [`plans/DOC-MAINTENANCE.md`](plans/DOC-MAINTENANCE.md).

## Release log (production)

| Release | Date (IST) | Prod SHA | Headline changes | Migration |
|---|---|---|---|---|
| 2026-11-27 22:45 IST | ✅ owner-deployed + verified (api+frontend `44341503`, migrate `gifsy-migrate-stqql` applied `20261127100000_payout_tracker_report_runs`, 0 errors, hosts 200; staging 20:57 IST) | `44341503` | ⚠️ platform-wide (owner-approved 2026-11-27): **catalogue fix** `7cad7a6c` (partner Rewards + sales Catalogue load every page — partners saw only the 20 cheapest items; staging 21/21); **per-tenant WhatsApp variable order** (`whatsappVariables` override, Gifsy console → Notification templates; inert unless set). Tenant-scoped: **Bajaj Payout Tracker** daily report + Mon–Sat 10:00 IST email (inert unless a `payoutTracker` ProgramSetting exists; KYC-currently-approved outlets; errored outlets held back; ≤ 50 recipients per message with per-batch progress; prod `PAYOUT_TRACKER_EMAIL_LIVE=true`) → [`plans/PAYOUT-TRACKER.md`](plans/PAYOUT-TRACKER.md) | `20261127100000_payout_tracker_report_runs` |
| Release 3 (everything since `763e463b`: release/next5 + next6 + next7) | 2026-11-26 ~19:20 | **`fe7900af`** | Any intermediate prod deploys on 2026-11-25 (e.g. `d1aeb786`, which `UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md` calls "prod `main`") are not recorded in the repo — this row lists the whole range. ⚠️ platform-wide items owner-approved in-session. **next5:** delivery address on the fulfilment sheet + Redemption Orders "Deliver to" for physical gifts (Gifsy fulfilment roles only); sales-team visibility photo view (tenant-scoped `salesPhotoViewLevels`); Gifsy staff see Sales Import; credits upload negative POINTS become wallet deductions (tenant switch, `UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md`); points-engine visibility inputs + gate fail reasons; Targets upload preview → Confirm & apply + upload history; Program Health card fix. **next6:** a focus KPI can use another KPI's focus names (FB Cases = FB products), no focus names → cases KPI not calculated; per-outlet target change history; deduction notice minus sign. **next7:** achievement-only KPIs in targets; reward stock history + stock return on cancel/fail/return; Sales Import Apply bar at top + accept-not-sold-yet; quarterly (FY-quarter) points rules + quarter compute runs; clients see "Via API" instead of the fulfiller name; cancel unpaid / failed payouts + bulk cancel by Excel; **off-portal payments register** (`OFF-PORTAL-PAYMENTS-DESIGN.md`) + double-payment guard; 194C TDS invoice + recovery only when PAID; points rule names; "payout credited" bell + push for every client. Bajaj rules spec `BAJAJ-POINTS-RULES-SPEC.md` | 8: `20261125100000_sales_kpi_focus_names_from_kpi`, `…125120000_target_change_history`, `…125140000_off_portal_payments`, `…125140000_payout_cancellation`, `…126100000_kpi_def_achievement_only`, `…126100000_tds_invoice_on_paid`, `…126120000_reward_stock_history`, `…126140000_points_rule_name` |
| release/next4 | 2026-11-24 ~17:19 | **`763e463b`** | ⚠️ platform-wide (owner-approved 2026-11-24): Redemption Orders server-side search + "Redeemed on (IST)" / Outlet ID / Phone columns; **Hubble automatic re-check** (`POST /v1/hubble/sweep`, scheduler `hubble-sweep-prod` every 2 min; flags on console + digest; Advance blocked on code-less Hubble orders); vacant positions (blank name + phone); Session Report App installed + level ID columns; "Incorrect POSM" reject reason; Outlet ID fix on Points Ledger + Profile; **fund reconciliation** live with client low-balance e-mails OFF (`FUND_ALERTS_LIVE=false`). Staging-verified on Bajaj incl. a real ₹500 Hubble voucher | `20261123150000_fund_reconciliation`, `20261124100000_tds_recovery_download_link` |
| release/next3 | 2026-11-23 | **`9bda3b71`** (deploy run 45229559935) | Sales Import roster-only aggregates (staging 178 MB file: worker memory 63% → 20%, 6.5 → 3.8 min); Target vs Sales report columns / billing bucket / filters + Overview download; adoption Excel Employee ID + rank 1–5 level ID columns; visibility review State / Zone. 0 errors / 0 5xx after | `20261123120000_sales_import_processed_roster` |
| release/next2 (includes `release/next`) | 2026-11-22 | **`13f5c555`** | ⚠️ platform-wide (owner-approved 2026-11-21): **LEGACY wallet engine retired** (every tenant on the new reversal engine); **held opening balances** for migrating clients (Bajaj 40 outlets / 1,22,843 pts loaded PENDING) + Held Balances console; request-volume reductions (prefetch, session caches); location required by default; ticket remarks To + CC; GPS photo-overlap + hydration #418 fixes; sales banners; adoption by role. After: 15 Bajaj help guides + 8 videos copied to prod, Help & videos ON | `20261121100000_held_opening_balances` |
| `release/2026-11-21` | 2026-11-21 | **`97332c95`** (code tip `27581819` + docs) | ⚠️ platform-wide (owner-approved): **visibility integration** (review-events table, report screen with month/window pickers, Operations funnel real fraud flags + Gifsy-only flag list, digest pending counts across months, "Not approved — window closed", stricter capture in-scope rule, per-window scope for closed windows, go-live cache); **ASM/Zone/State/City columns** in App installed-users export + Usage report; new **Redemption report** (Gifsy + client admins; no voucher code/PIN, PAN, full phone, address, raw notes) | `20261120140000` (visibility review events, with backfill) |
| 2026-11-20 night | 2026-11-20 night (verified 2026-11-21 ~00:20) | **`4a48dc0d`** | ⚠️ platform-wide (owner-approved): **Visibility Excel redesign** (per-photo columns by label, "Open photo" → signed-in `/visibility/photo` viewer, sheets Visibility / Review history / Not captured / About, 60k link cap/sheet) + client-admin Excel button; per-client **App name** (`branding.appName`; Bajaj prod "Bajaj Loyalty Club"); capture-form GPS-pending Submit fix; **WRE over-reversal debt** (D1/D2, engine still LEGACY); **tickets assign/escalate** + per-client remarks email; Help & Guides UX; visibility review polish; **login refresh race fix** (6 s grace, handback, `INTERNAL_PROXY_SECRET`); least-privilege deployer + keyless `gifsy-ops`. 0 errors / 0 5xx after. Same evening 16:20–16:27 UTC: Cloudflare Workers free-plan cap → Error 1027 on all tenants → owner moved to Workers Paid | 8 (job `gifsy-migrate-lnsg2`, 14 s): `20261119124400/124500/124600` (WRE), `20261120110000/110100/110200` (tickets), `20261120130000/130100` (auth) |
| 2026-11-19 night | 2026-11-19 ~21:15 | **`1fa2305c`** (release `f61aec24` + webhook fix; backup `1795096760898`) | ⚠️ platform-wide (all owner-approved; money paths dual-audited; staging-verified on Bajaj): **Wallet Reversal Engine** shipped DORMANT (LEGACY everywhere; Bajaj staging V2); **Location gate + Location Report** (flag `requireLocation`, default OFF); visibility fence only applicable photos + centred review dialog; wholesaler **Incl. Activation** note (flag); **shared outlet wallet view** for sales; Bajaj **notification reminder** (iOS/Android steps); **Help & videos** (flag `helpVideos`); release follow-ups (₹0 GST rows, KYC team filter, Voucher Dispersal alerts); `deploy.yml` keeps `SALES_RETENTION_V2=on`; **MSG91 + Hubble webhooks `@SkipThrottle`** (MSG91 had auto-disabled its WhatsApp report webhook after 3,000+ 429s — owner re-enabled it). 0 errors after deploy | 45: `20261119120000…20261119124300` (reversal engine, additive + NOT VALID → VALIDATE) + `20261120100000_add_help_topics` |
| 2026-11-18 combined | 2026-11-19 ~00:30 | **`7ba69566`** (preceded ≈1 h by `71df01f7`, an accidental re-run of an old workflow run — no migrations) | ⚠️ platform-wide (all owner-approved; money paths dual-audited; staging-verified with real Bajaj logins): **Voucher Dispersal** edit + "Add more people" batches (mark-not-bought final, earlier-order alerts); **Sales Import Apply / Recalculate as background jobs** + proxy timeout 300 s; **TDS 194R** per client, PAN-keyed payee snapshots, whole-year on current method, no 194R TDS/service invoices, excess flagged; **Usage report** (app vs browser, minutes); KYC hardening + roll-up past removed managers; day-level sales + MTD comparison (retention OFF behind `SALES_RETENTION_V2`); **Daily Operations Digest**; Sales Import guide; plus the 2026-11-17 items: KYC fast-track (Bajaj flag `gifsyRejectFastTrack`, owner to switch ON), assigned-rep gate, `/admin/approvals` redirect, dashboards program filter + Monthly billing progress card. Payout payee backfill 48,131 rows; 0 errors after deploy. Lessons: use **Run workflow** (never Re-run) + **Approve** | 8: `20261118120000_sales_day_level`, `…130000_sales_day_order_index`, `…140000_kyc_submission_outlet`, `…150000_kyc_submitter_manager_chain`, `…160000_voucher_dispersal_batches`, `…170000_sales_apply_jobs` (not re-runnable), `…180000_tds_payee_snapshot`, `…190000_user_activity_usage` |
| 2026-11-16 (c) | 2026-11-17 | **`de2f3700`** (code = `d5050024` + test-only GIFP9 timeout bump) | ⚠️ platform-wide (owner-approved): every dashboard "… to go / remaining" amount rounded UP to a whole number with Indian grouping (prod ASM card showed "674971.2084833332 INR to go"); hero/card achieved-of-target figures INR whole rupees, other units ≤ 2 dp; float-noise snap so "1 to go" never sits next to "target met". Deoleo sees commas in hero numbers. Dual-audited; staging-verified (ASM + retailer) | none |
| 2026-11-16 (b) | 2026-11-16 | `4e395b21` | ⚠️ platform-wide (owner-approved): Hubble **Amazon Pay sends only the claim code** (no serial / "PIN:" line) in Voucher Dispersal + Bajaj redemptions; claim-code product list = Amazon default + env `HUBBLE_CLAIM_CODE_PRODUCT_IDS`; missing claim code → error log + audit `VOUCHER_DISPERSAL_CLAIM_CODE_MISSING` | none |
| 2026-11-16 (a) | 2026-11-16 (deploy times not recorded in the repo) | `720ffce9` (after `7af6f3e5`) | **Voucher Dispersal** (Gifsy platform admin tool: Excel → Hubble buy → WhatsApp `voucher_code` → report; drain scheduler + `VOUCHER_DISPERSAL_DRAIN_SECRET`); App Adoption "Download installed users"; prod delivery-receipt tracking persisted in deploy.yml | `20261117140000_voucher_dispersal` |
| 2026-11-15 | 2026-11-15 ~22:10 | **`2eb8271d`** | Downloads page (background exports, job `gifsy-exports`); memory safety (page caps, problem-rows-only uploads, heavy-op limiter); payments report paging + uncapped export; credits upload OK-rows only + UTR apply idempotent; payout-credited message = net bank amount; Hubble reconcile hardening (no refund after timeout, 2 h + canary); Bajaj v2 "so far" partner screens; outlet name in login; Bajaj app icon. Backup `1794744368023`; first run failed on flaky CI test VISCFG5 → test-only fix → redeployed | `20261116120000_export_requests` |
| next-release | 2026-11-13/14 (deploy time not recorded in the repo) | `e242b1a1` | FOCUS-FROM-TARGETS (focus products from the target file) + PRODUCT_COUNT ("LINES") measure; 194R export Outlet Code/Name/Type; F1/F9 admin-session fixes (assumed operator saved TDS Treatment to the home tenant); API memory 512Mi → 1Gi | `20261115130000_focus_from_targets` |
| tds-count-imports | 2026-11-13 evening | `ad01ace5` | Bajaj-only `tdsImportedPayouts` (imported payouts from FY 2026-27 count in 194R, liability only) | none |
| payout-without-pan | 2026-11-13 afternoon | `247fae4b` | No-PAN payouts (flag), whole-unit rounding, TDS deposit "TDS for month" + deposit-only rows, applies-to scope (KPI + visibility), wallet never-adds-points + interim reversal rules, 194R VENDOR_IMPORT exclusion re-applied | `20261114120000_kpi_applies_to_scope`, `20261114130000_tds_deposit_for_period`, `20261114140000_credit_reversal_consumed_payout_entries` |
| #59 | 2026-11-12 ~09:10 | `a18cc932` | Batch #59 (UPI manual entry, UTR/order CAS, offers tiles, voucher refund block, Hubble ops exits …) + Sales Import + Bajaj prod config screens + Hubble prod creds/preflight + branding/routing fixes + per-phone/per-user rate limits + OTP hardening. Backup `1794452768704` | 9: `20261107120000_partner_upi_capture_method` … `20261113120000_add_redemption_voucher_pin` (UPI capture method, offer tiles, cancelled voucher codes, sales import ×5, voucher PIN) |
| #58 | 2026-11-07 | `e98f047` | Partner-shell React #418 hydration fix; flaky-test sweep | none |
| #57 | 2026-11-07 | `ff45f6b` | Order-timeline stepper, wallet statement Excel/PDF, delivery-address pre-fill | none |
| #53–#56 | 2026-10 → 2026-11-06 | — | Not tabulated in the repo (FIFO points expiry, rejected-payout recording, capture bank at redemption, hierarchy leaderboard and others reached `main` in this window; see `git log --first-parent origin/main`) | — |
| #52 | 2026-10-01 | `91f9773` | IST timestamp sweep, Payments Report, payout fixes, RBAC route-guard fix | none |
| #47–#51 | 2026-09-15 → 09-23 | `83c4af4` … `af124cf` | Scheme Live Preview; KYC Status Report; exit-tenant fix; GSTIN compulsory; WhatsApp confirmation; roster bulk-remove | none |
| #1–#46 | 2026-06-20 → 2026-09 | — | CUTOVER LEDGER #14–#52 in [`plans/archive/RESUME-ARCHIVE-2026-11-15.md`](plans/archive/RESUME-ARCHIVE-2026-11-15.md); #1–#6 in `plans/runbooks/PROD-CUTOVER-RECORD.md` | — |

## Living docs (kept current)

| Doc | Covers |
|---|---|
| [`plans/RESUME.md`](plans/RESUME.md) | ⭐ Current state, in-progress work, owner to-dos, process rules, deploy + verify procedure, known traps |
| [`plans/GO-LIVE-ISSUE-LIST.md`](plans/GO-LIVE-ISSUE-LIST.md) | Master issue tracker: current banner + ▶ THINGS TO BE DONE; below = historical issue log |
| [`plans/BAJAJ-CUSTOMIZATIONS.md`](plans/BAJAJ-CUSTOMIZATIONS.md) | Every Bajaj-driven change (Hubble, v2 screens, payout message/TDS, relabels, flags) |
| [`plans/BAJAJ-GO-LIVE-DECISIONS-LOG.md`](plans/BAJAJ-GO-LIVE-DECISIONS-LOG.md) | Owner decisions during the Bajaj go-live, with rejected alternatives |
| [`plans/BAJAJ-PROD-OUTLET-IMPORT.md`](plans/BAJAJ-PROD-OUTLET-IMPORT.md) | Every Bajaj prod data import (outlets, visibility, points, payouts, TDS, targets, Nov sales) — runbook + record |
| [`plans/BAJAJ-PROD-GO-LIVE-CHECKLIST.md`](plans/BAJAJ-PROD-GO-LIVE-CHECKLIST.md) | Bajaj prod set-up map (admin UI steps vs gaps), prod readiness audit |
| [`plans/HUBBLE-RECONCILE-RUNBOOK.md`](plans/HUBBLE-RECONCILE-RUNBOOK.md) | Ops guide for Hubble gift-card flags, Retry / Acknowledge / manual exits |
| [`plans/ENVIRONMENTS.md`](plans/ENVIRONMENTS.md) | What runs where: local / staging / prod, jobs, secrets, hosts, test-only local Postgres |
| [`plans/DOWNLOADS-PAGE.md`](plans/DOWNLOADS-PAGE.md) | Background exports: engine, kinds, lifecycle, runbook |
| [`plans/SALES-IMPORT-PIPELINE-PLAN.md`](plans/SALES-IMPORT-PIPELINE-PLAN.md) | DMS sales file → monthly KPI achievements (design, infra §14, retention runbook §17b, traps + background Apply jobs §18) |
| [`plans/VOUCHER-DISPERSAL.md`](plans/VOUCHER-DISPERSAL.md) | Gifsy Voucher Dispersal: Excel → Hubble buy → WhatsApp; edit + batches + mark-not-bought + order alerts (§10–§10f), deploy runbook §8 |
| [`plans/PAYOUT-TRACKER.md`](plans/PAYOUT-TRACKER.md) | Client payout tracker (Bajaj): daily outlet-level report + Mon–Sat email — data sources, sheets, config, secrets, idempotency / batching, staging vs prod, runbook, traps |
| [`plans/DAILY-OPS-DIGEST.md`](plans/DAILY-OPS-DIGEST.md) | The one internal Daily Operations Digest email (window/run state, sections, statuses, recipients) + `runbooks/email-reports-activation.md` |
| [`plans/USAGE-REPORT.md`](plans/USAGE-REPORT.md) | Per-user Usage report: activity tracking (visits, minutes, app vs browser), background-request rule, runbook |
| [`plans/REDEMPTION-REPORT.md`](plans/REDEMPTION-REPORT.md) | Redemption report (Gifsy + client admins): columns, roles, data handling, staging results |
| [`plans/REQUEST-VOLUME.md`](plans/REQUEST-VOLUME.md) | Edge request volume after the 2026-11-20 Cloudflare Workers cap outage: evidence, fix plan, trade-offs, status |
| [`plans/SUPPORT-TICKETS.md`](plans/SUPPORT-TICKETS.md) | Support tickets: assign / escalate, client remarks email, raised-by / outlet, rollback trap |
| [`plans/LOCATION-GATE.md`](plans/LOCATION-GATE.md) | Location gate (`requireLocation`) + Location Report |
| [`plans/HELP-VIDEOS.md`](plans/HELP-VIDEOS.md) | Help & videos per tenant (`helpVideos`) — design + seed content |
| [`plans/FOCUS-FROM-TARGETS-DESIGN.md`](plans/FOCUS-FROM-TARGETS-DESIGN.md) | Per-outlet focus products read from the target file |
| [`plans/MIGRATIONS.md`](plans/MIGRATIONS.md) | How schema migrations run on dev / staging / prod |
| [`plans/INFRA-ARCHITECTURE.md`](plans/INFRA-ARCHITECTURE.md) | Canonical GCP / Cloudflare infrastructure reference |
| [`plans/DOC-MAINTENANCE.md`](plans/DOC-MAINTENANCE.md) | Doc-drift protocol, consistency checker, source-of-truth map |
| [`plans/POST-GO-LIVE-BACKLOG.md`](plans/POST-GO-LIVE-BACKLOG.md) | Deferred / fast-follow work |
| [`spec/gap-register.md`](spec/gap-register.md) | Gaps and inconsistencies register |
| `WALLET-REVERSAL-ENGINE-DESIGN.md` | **Lives on branch `feat/wallet-reversal-engine`** (maintained there): reversal engine design, owner decisions, WP status |

## Runbooks (`plans/runbooks/`)

| Doc | Covers |
|---|---|
| [`PROD-CUTOVER-RECORD.md`](plans/runbooks/PROD-CUTOVER-RECORD.md) | Prod deploy preflight (current) + as-run record of cutovers #1–#6 |
| [`CUTOVER-RUNBOOK.md`](plans/runbooks/CUTOVER-RUNBOOK.md) | Original develop → main cutover runbook (procedure now in RESUME §6) |
| [`OWNER-OPS-RUNBOOK.md`](plans/runbooks/OWNER-OPS-RUNBOOK.md) | Backups, alerting, secret rotation, MSG91 |
| [`PROD-DB-MIGRATION.md`](plans/runbooks/PROD-DB-MIGRATION.md) | Prod DB migration mechanics |
| [`PROD-DATA-LOAD.md`](plans/runbooks/PROD-DATA-LOAD.md) | Prod data load (#76, Deoleo) |
| [`PROD-DATA-WIPE.md`](plans/runbooks/PROD-DATA-WIPE.md) | Tenant data wipe (prod/staging) |
| [`RBAC-PROD-ENABLE.md`](plans/runbooks/RBAC-PROD-ENABLE.md) | Enabling RBAC Option-X staff on prod (owner-gated) |
| [`DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md`](plans/runbooks/DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md) | Deoleo config checklist + client data templates |
| [`email-reports-activation.md`](plans/runbooks/email-reports-activation.md) | Activating the daily internal email reports |
| [`plans/RBAC-ENABLEMENT.md`](plans/RBAC-ENABLEMENT.md) | Enabling RBAC enforcement (runbook) |
| [`plans/DEV-DB.md`](plans/DEV-DB.md) · [`plans/GIT-WORKFLOW.md`](plans/GIT-WORKFLOW.md) | Dev database ops · git + deploy workflow |

## Feature designs and plans (`plans/`) — status in each file's header

| Doc | Covers |
|---|---|
| [`A-DOMAIN-PLAN.md`](plans/A-DOMAIN-PLAN.md) · [`A-DOMAIN-P0-DESIGN.md`](plans/A-DOMAIN-P0-DESIGN.md) | DB-driven tenant domain routing + branding |
| [`APPLIES-TO-TARGETING-PLAN.md`](plans/APPLIES-TO-TARGETING-PLAN.md) | KPI + visibility scope by outlet type / program / sub-program (in prod) |
| [`BAJAJ-DATA-MIGRATION.md`](plans/BAJAJ-DATA-MIGRATION.md) | Bajaj staging data migration from the prior provider |
| [`CLIENT-MIGRATION-PLAYBOOK.md`](plans/CLIENT-MIGRATION-PLAYBOOK.md) | **Generic client-migration playbook** — existing points programme: vendor closing + dated passbook, **held opening balances** for outlets without a wallet (auto-apply at KYC approval, Gifsy Apply now / Cancel, digest line), reconciliation template, Bajaj numbers |
| [`BAJAJ-ENROLLMENT-IMPORTER.md`](plans/BAJAJ-ENROLLMENT-IMPORTER.md) · [`BAJAJ-HIERARCHY-RENAME.md`](plans/BAJAJ-HIERARCHY-RENAME.md) | Bajaj enrollment importer; ISR/SM/ZH naming |
| [`BAJAJ-POINTS-RULES-SPEC.md`](plans/BAJAJ-POINTS-RULES-SPEC.md) | Bajaj points rules (Unnati / SAMT / BSC) with owner answers 2026-11-25, incl. the BSC consistency bonus (header: draft for owner sign-off) |
| [`OFF-PORTAL-PAYMENTS-DESIGN.md`](plans/OFF-PORTAL-PAYMENTS-DESIGN.md) | Register of payments made outside the portal (fund, payouts, payments report, TDS; double-payment guard) |
| [`CREDIT-BATCH-EVIDENCE-B1.md`](plans/CREDIT-BATCH-EVIDENCE-B1.md) | Audit-evidence attachments on credit/payout batches |
| [`UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md`](plans/UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md) | Credits upload: negative POINTS deduct from the wallet (per-client switch, Bajaj); ledger path, undo, reports |
| [`DATA-VISIBILITY.md`](plans/DATA-VISIBILITY.md) | What each role sees on each page (E2E spec) |
| [`DELIVERY-ADDRESS-PREFILL-PLAN.md`](plans/DELIVERY-ADDRESS-PREFILL-PLAN.md) | Physical-gift delivery address pre-fill |
| [`DELIVERY-STATUS-REPORTING-SCOPE.md`](plans/DELIVERY-STATUS-REPORTING-SCOPE.md) | SMS / OTP / WhatsApp delivery-status reporting (dormant) |
| [`DEOLEO-GO-LIVE-BUNDLE.md`](plans/DEOLEO-GO-LIVE-BUNDLE.md) | Deoleo launch critical path (historical) |
| [`DIRECT-VPC-EGRESS-MIGRATION.md`](plans/DIRECT-VPC-EGRESS-MIGRATION.md) | VPC connector → Direct VPC egress |
| [`GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md`](plans/GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md) | Gift catalogue, dispatch, 3P vendor portal (dormant) |
| [`GLOBAL-SETTINGS-WIRING-PLAN.md`](plans/GLOBAL-SETTINGS-WIRING-PLAN.md) | Per-tenant DB-backed settings |
| [`HIERARCHY-LEADERBOARD-DESIGN.md`](plans/HIERARCHY-LEADERBOARD-DESIGN.md) | Hierarchy-driven leaderboard tabs |
| [`KYC-APPROVAL-REVAMP.md`](plans/KYC-APPROVAL-REVAMP.md) · [`SO-DECLARATION-KYC.md`](plans/SO-DECLARATION-KYC.md) | Gifsy bulk KYC verification; SO declaration KYC (Bajaj-gated) |
| [`OFFER-TILES-PLAN.md`](plans/OFFER-TILES-PLAN.md) | "This month's offers" tiles |
| [`ORDER-TIMELINE-STEPPER-PLAN.md`](plans/ORDER-TIMELINE-STEPPER-PLAN.md) | My Orders timeline stepper + shared status transition |
| [`P1-sessions-design.md`](plans/P1-sessions-design.md) | Sessions and tenant binding |
| [`P6-TDS-EXPLAINER.md`](plans/P6-TDS-EXPLAINER.md) | TDS structure explainer (owner-facing) |
| [`PARTNER-MULTI-OUTLET.md`](plans/PARTNER-MULTI-OUTLET.md) | Parent-child owner groups |
| [`PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md`](plans/PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md) | Capture bank/UPI at redemption |
| [`PAYOUT-COMPUTE-REPORT.md`](plans/PAYOUT-COMPUTE-REPORT.md) · [`PAYOUT-REJECTED-RECORDING-DESIGN.md`](plans/PAYOUT-REJECTED-RECORDING-DESIGN.md) | Payout compute report; recording rejected payouts |
| [`PER-PHOTO-GEOTAG-PLAN.md`](plans/PER-PHOTO-GEOTAG-PLAN.md) | GPS per photo (schemes + visibility) |
| [`POINTS-COMPUTE-ENGINE-DESIGN.md`](plans/POINTS-COMPUTE-ENGINE-DESIGN.md) · [`POINTS-EXPIRY-FIFO-DESIGN.md`](plans/POINTS-EXPIRY-FIFO-DESIGN.md) | Points compute engine; FIFO expiry |
| [`PWA-PLAN.md`](plans/PWA-PLAN.md) | Installable apps + Web Push |
| [`RBAC-COMPLETION-PLAN.md`](plans/RBAC-COMPLETION-PLAN.md) · [`RBAC-OPTION-X-STAFF.md`](plans/RBAC-OPTION-X-STAFF.md) | RBAC completion plan; Gifsy staff roles |
| [`REPORTING-REVAMP.md`](plans/REPORTING-REVAMP.md) · [`REWARDS-FILTER-UX-PLAN.md`](plans/REWARDS-FILTER-UX-PLAN.md) | Reporting track; rewards filter UX |
| [`SCHEME-DATA-COLLECTION-DESIGN.md`](plans/SCHEME-DATA-COLLECTION-DESIGN.md) · [`SCHEME-UX-HARDENING-PLAN.md`](plans/SCHEME-UX-HARDENING-PLAN.md) · [`SCHEME-ROSTER-ROW-REMOVE-PLAN.md`](plans/SCHEME-ROSTER-ROW-REMOVE-PLAN.md) | Scheme data-collection instrument |
| [`UIUX-AUDIT-FIXPLAN.md`](plans/UIUX-AUDIT-FIXPLAN.md) | UI/UX audit fix plan (shipped #23) |
| [`USER-PHONE-DEACTIVATION-PLAN.md`](plans/USER-PHONE-DEACTIVATION-PLAN.md) | Deactivate frees the phone |
| [`VISIBILITY-POSM-DESIGN.md`](plans/VISIBILITY-POSM-DESIGN.md) · [`VISIBILITY-PER-PHOTO-APPROVAL.md`](plans/VISIBILITY-PER-PHOTO-APPROVAL.md) · [`VISIBILITY-SUBPROGRAM-CONDITIONS.md`](plans/VISIBILITY-SUBPROGRAM-CONDITIONS.md) | Visibility (POSM) capture and approval |
| [`VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md`](plans/VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md) · [`VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md`](plans/VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md) | Visibility payouts: 194C invoicing + TDS method |
| [`WALLET-STATEMENT-EXPORT-PLAN.md`](plans/WALLET-STATEMENT-EXPORT-PLAN.md) | Wallet statement Excel/PDF + balance |
| [`WHATSAPP-BROADCASTS-DESIGN.md`](plans/WHATSAPP-BROADCASTS-DESIGN.md) | WhatsApp broadcasts (dormant) |
| `EMPLOYEE-REWARDS-*.md` (11 files) | Employee Rewards product line (Britannia anchor): proposal, design, admin design, build plans, Phase 0/1 status/audit/verify, UAT, ways of working, its own RESUME |
| [`BRITANNIA-DEMO-PROMPT.md`](plans/BRITANNIA-DEMO-PROMPT.md) | Britannia demo prototype prompt |

## Process, testing and planning

| Doc | Covers |
|---|---|
| [`plans/VERIFICATION-PROTOCOL.md`](plans/VERIFICATION-PROTOCOL.md) · [`plans/GO-LIVE-READINESS.md`](plans/GO-LIVE-READINESS.md) | Definition of done for user-facing flows; readiness gate |
| [`plans/01-how-we-test.md`](plans/01-how-we-test.md) · [`../e2e/README.md`](../e2e/README.md) · [`plans/E2E-COVERAGE-PLAN.md`](plans/E2E-COVERAGE-PLAN.md) · [`plans/E2E-HARNESS-REVIVAL.md`](plans/E2E-HARNESS-REVIVAL.md) | Testing approach; Playwright E2E harness |
| [`plans/UAT-CHECKLIST.md`](plans/UAT-CHECKLIST.md) | Deoleo UAT checklist |
| [`plans/08-agent-execution-guide.md`](plans/08-agent-execution-guide.md) | Orchestrator / executor / auditor workflow |
| [`plans/00-MASTER-PLAN.md`](plans/00-MASTER-PLAN.md) · [`plans/README.md`](plans/README.md) · [`plans/00-onboarding.md`](plans/00-onboarding.md) · [`plans/BACKEND-SPLIT-PLAN.md`](plans/BACKEND-SPLIT-PLAN.md) · [`plans/MODEL-ALIGNMENT.md`](plans/MODEL-ALIGNMENT.md) | Original build plan, onboarding, Phase S, real operating model (historical / foundational) |
| `plans/02`–`07-*.md` | SUPERSEDED milestone/epic plans (banner → 00-MASTER-PLAN) |
| `plans/reconcile/*.md` (11 files + `baseline-red-snapshot.txt`) | Per-phase reconcile + build records P0–P6.5, D2 platform-Prisma retirement |
| [`plans/guides/PAYOUTS-GUIDE.md`](plans/guides/PAYOUTS-GUIDE.md) | Pointer to the in-app payouts guide source |
| [`plans/archive/RESUME-ARCHIVE-2026-11-15.md`](plans/archive/RESUME-ARCHIVE-2026-11-15.md) | Full RESUME chronology to 2026-11-15 + CUTOVER LEDGER #14–#52 (historical) |

## Spec (`spec/`)

[`spec/README.md`](spec/README.md) — canonical design & spec: `00-foundation`, `01-capabilities`, `02-workflows`,
`03-data-model`, `04-architecture` (target architecture source of truth), `05-api-surface`, `06-configurability`
(multi-tenancy model), `07-nfr-compliance`, `gap-register`.

## Outside `platform/docs`

| Doc | Covers |
|---|---|
| root `CLAUDE.md` | Always-on working agreements, gates, platform-wide gate, guardrails |
| `platform/CLAUDE.md` → `platform/AGENTS.md` | Next.js version warning for agents |
| `api/README.md` · `platform/README.md` · root `README.md` | Framework boilerplate READMEs (root README is empty) |
| `terraform/README.md` | Infrastructure deployment guide (config has drifted from live in places — plan before apply) |
| `platform/scripts/README-pwa-icons.md` | PWA icon pipeline |
| `HANDOFF.md` · `HANDOFF-API-WIRING.md` · `PRD_Sections_31_to_37.md` | Early handoff briefs and PRD addendum (historical) |
| `platform/src/content/guides/*.ts` | **In-app operator guides** (Help & Guides; seen by every tenant incl. Deoleo): `payouts.ts`, `tds.ts`, `offers.ts` |
