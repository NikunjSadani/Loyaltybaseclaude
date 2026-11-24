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
> Last updated: **2026-11-24** (prod = `main` = `develop` = `763e463b`, deployed + verified 2026-11-24 — release/next4;
> nothing else in flight; owner decisions 2026-11-24 — §1, §4, §8).

Multi-tenant FMCG **trade-loyalty** platform. Operator **Gifsy**; live clients **Deoleo** (since July 2026) and
**Bajaj Consumer Care** (go-live November 2026). Backend `api/` (NestJS + Prisma 7 — owns the DB and ALL business logic)
· thin frontend `platform/` (Next.js; proxies `/api/*` → backend `/v1/*`). Repo `C:\Users\nikun\Loyaltybaseclaude`;
work on **`develop`** (auto-deploys to staging); prod ships from **`main`** by a manual workflow.

---

## 1. Where things stand (2026-11-24)

> **2026-11-24 — PROD = main = develop = `763e463b`** (release/next4; owner deployed ~17:19 IST; verified: api + frontend
> images `763e463b`, migrations `20261123150000_fund_reconciliation` + `20261124100000_tds_recovery_download_link`
> applied, 0 unfinished, both hosts 200). Contents (platform-wide items all owner-approved in-session 2026-11-24):
> - **Redemption Orders**: server-side search (reward / order no. / Outlet ID / partner code / name / phone in any format;
>   `%` `_` literal), "Redeemed on (IST)" column (+ fulfilment Excel, which follows search + filter and leaves out
>   Hubble orders with no code), Outlet ID + Phone columns.
> - **Hubble**: automatic re-check of open Hubble orders (`POST /v1/hubble/sweep`, Cloud Scheduler `hubble-sweep-prod` /
>   `-staging` every 2 min, secret `HUBBLE_SWEEP_SECRET[_STAGING]`; in-process timer OFF via
>   `HUBBLE_ORDER_SWEEP_ENABLED=false`); flags (still open > 1 h / indeterminate / not eligible / > 7 days) surface on the
>   console + Daily Ops Digest; never auto-refunds on "no order"; voucher message once per code (code-hash marker),
>   refund message on Hubble FAILED, failed sends listed in the digest; "Retry with Hubble" + "Fulfil manually" on any
>   waiting Hubble order; **"Advance" blocked** on Hubble orders with no code (console, bulk upload, vendor portal).
>   Runbook: `HUBBLE-RECONCILE-RUNBOOK.md` §2a/§2b. First prod run 18:10 IST delivered stuck order BAJAJ-26-000050.
> - **Vacant positions**: blank name + phone in Edit User = vacant (login off, email/push cleared); refill = brand-new
>   login; non-ACTIVE logins can't refresh. App Adoption for Gifsy staff = "Reporting & Analytics → view".
> - **Session Report**: App installed + ISR/SO/ASM/SM/ZH ID columns. **Visibility**: "Incorrect POSM" reject reason.
> - **Outlet ID fix**: Points Ledger report + outlet Profile show the client's Outlet ID (not the row id / `CP-` code).
> - **Fund reconciliation** (`FUND-RECONCILIATION-DESIGN.md` §8): live, **client low-balance e-mails OFF**
>   (`FUND_ALERTS_LIVE=false` in `deploy.yml` — flip only on the owner's word). No client data entered yet (§4).
> Staging-verified with real logins on Bajaj (incl. a real ₹500 Hubble voucher → delivered + exactly one notice).
> Watch: 4× `/v1/auth/refresh` 503 at 17:59 IST (refresh-row lock timeout `55P03`, two simultaneous refreshes of one
> login; pre-existing lock design) — none in the 7 days before; recheck.

> **2026-11-23 — PROD = main = develop = `9bda3b71`** (owner deploy run 45229559935; verified: api / frontend /
> `gifsy-sales-import` on 9bda3b71, migration `20261123120000_sales_import_processed_roster` applied, 0 errors / 0 5xx,
> hosts 200). Contents (release/next3): Sales Import roster-only aggregates (staging real 178 MB file: worker memory
> 63% → 20%, 6.5 → 3.8 min, identical roster results; rollback rule = runbook §E) · Target vs Sales report columns /
> billing bucket / filters + Overview download (`TARGET-VS-SALES-REPORT.md`) · adoption Excel Employee ID + rank 1–5
> level ID columns (`PWA-PLAN.md`) · visibility review State / Zone. Earlier on 2026-11-22: prod `13f5c555` (held
> balances loaded 40 / 1,22,843 pts PENDING; 15 Bajaj help guides + 8 videos copied; Help & videos ON). In progress:
> fund reconciliation (`FUND-RECONCILIATION-DESIGN.md`, branch `feat/fund-reconciliation`, not on staging/prod).
> The table below is the 2026-11-21 snapshot (history).

| | SHA | Since | Notes |
|---|---|---|---|
| **Production** (`gifsy-api`, `gifsy-frontend`, jobs `gifsy-sales-import` + `gifsy-migrate`) | **`97332c95`** (`release/2026-11-21` code tip `27581819` + docs; deployed and verified 2026-11-21; visibility review-history backfill verified on `gifsy_prod`: **51,140** Bajaj captures with history, **51,123** imported ones labelled "Imported — old app approval", **0** admin names) | 2026-11-21 | `origin/main` = `97332c95`. Migrate exec `gifsy-migrate-djpdq` (applied `20261120140000_visibility_review_events` only; 0 errors / 0 5xx after; both tenants 200). Backfill checked read-only via job `bajaj-prod-vis-verify` exec `wg6mm`. Pre-release backup id: not recorded (owner-run deploy). |
| **`main` = `develop`** | **`97332c95`** — same as prod; full gates green on push 2026-11-21. Next batch = **`release/next`** (local, not pushed — §4 item 12) | 2026-11-21 | |
| **Staging** (`*-staging`) | **`develop`** (code tip **`27581819`** = `release/2026-11-21`; later commits up to `97332c95` are docs-only). Migrate execution `gifsy-migrate-staging-7hg7c` (2026-11-20 19:20 UTC) applied `20261120140000_visibility_review_events` cleanly. **Real-login check 2026-11-21: ALL PASS** (§3) | 2026-11-20/21 | see §3 |
| Previous prod | `4a48dc0d` (owner-deployed 2026-11-20 night IST; migrate `gifsy-migrate-lnsg2` applied 8 migrations — WRE debt, tickets, auth) → `1fa2305c` → `7ba69566` → `71df01f7` → `de2f3700` → `4e395b21` → `720ffce9` → `2eb8271d` | 2026-11-19 … 11-15 | rollback targets (⚠️ a rollback below `4a48dc0d` leaves its 8 migrations in place — tickets rollback trap in `SUPPORT-TICKETS.md`; TODO confirm the WRE/auth ones are harmless to older code; a rollback below `1fa2305c` leaves the 45 additive reversal-engine/help columns+tables — harmless to older code) |

**The 2026-11-20 (night) prod release `4a48dc0d`** (owner-deployed; platform-wide items owner-approved in-session):
- **Visibility Excel redesign**: per-photo columns grouped by photo label, "Open photo" links to the signed-in
  `/visibility/photo` viewer page, timestamps, rep/manager, plain statuses; sheets **Visibility / Review history / Not
  captured / About**; link cap 60k per sheet; old-app windows show "No approved record" / "Not tracked". Client admins
  get an Excel download button.
- **Per-client App name** (`branding.appName`): installed-app name, tab title, sign-in and headers; the company
  `displayName` stays on consent / PDF / emails. Bajaj prod set to **"Bajaj Loyalty Club"** by the owner 2026-11-21,
  verified live (manifests "Bajaj Loyalty Club" / "Bajaj Loyalty Club Sales", sign-in title "Sign In | Bajaj Loyalty
  Club"; ~2 min to propagate); Bajaj staging same name since 2026-11-20. Deoleo has no appName (prod manifest "Deoleo").
  → [`BAJAJ-CUSTOMIZATIONS.md`](BAJAJ-CUSTOMIZATIONS.md) §15
- **Capture-form fix**: Submit is blocked with "Getting location…" while a photo's GPS fix is pending; values are
  re-read after the submit-time wait; a manual location counts as pending; `uploadFile` can no longer get stuck — no
  more false `"Window 1" is required`.
- **Wallet Reversal Engine over-reversal debt** (owner D1/D2) — engine still DORMANT (LEGACY on prod); see §4 item 9.
  (⚠️ The LEGACY engine is being RETIRED on branch `feat/retire-legacy-wallet-engine` — local, not pushed; §3.)
- **Support tickets** assign / escalate + per-client ticket remarks email → [`SUPPORT-TICKETS.md`](SUPPORT-TICKETS.md).
- **Help & Guides UX** fixes; **visibility review polish**.
- **Login rolling-session refresh race fix**: 6 s grace, handback when the tip is unused, `INTERNAL_PROXY_SECRET`.
- **Least-privilege deployer** + keyless `gifsy-ops` identity for laptop ops (§7, §8).

**2026-11-20 16:20–16:27 UTC outage (Cloudflare Workers free-plan cap)** — every `*.gifsy.in` tenant returned
Cloudflare **Error 1027** because the Workers FREE plan's 100k requests/day cap was hit. The owner upgraded to
**Workers Paid** ($5/mo, 10M requests/mo). Cause (Cloud Run logs): normal ~1–2k req/h jumped to ~30k req/h from
~17:30 IST with 87 concurrent Bajaj sales users; ~42% of frontend requests were Next.js RSC fetches (prefetch of every
visible outlet-detail link on `/sales/kyc` and of the bottom-nav pages), plus a per-screen refetch of `/sales/me`,
`/auth/me`, `/settings`, `/settings/outlet-types`, `/partner/banners`, `/notifications/unread-count`. Fix branch
`feat/request-volume` is **in build, local only** (§3); the owner wants measured trade-offs before it ships (§4 item 10)
→ [`REQUEST-VOLUME.md`](REQUEST-VOLUME.md).

**The 2026-11-19 (night) prod release `f61aec24` + `1fa2305c`** (all owner-approved; platform-wide items approved in-session; money paths dual-audited; staging-verified with real Bajaj logins):
- **Wallet Reversal Engine** shipped DORMANT: schema (45 additive migrations), LEGACY/SHADOW/V2 per-tenant flag (no rows on prod → LEGACY everywhere), backfill + verify jobs. Bajaj **staging** = V2 after the §9.1 wallet backfill (2,321 wallets, 0 blocked). Bajaj **prod** = LEGACY until its own backfill + owner go. → `WALLET-REVERSAL-ENGINE-DESIGN.md` (the per-tenant flag is being retired — §3)
- **Location gate + Location Report** (flag `features.requireLocation`; **Bajaj prod ON since 2026-11-21**, explicit
  `true`). ⚠️ TRAP: on branch `feat/require-location-default` (in `release/next`, not deployed) it is **DEFAULT ON for
  every tenant** — ON unless explicitly `false` (console = emergency off); read it ONLY via `isLocationRequired` (api
  `common/location-gate.helper.ts`, FE `lib/location-required.ts`), never `=== true`. Prod: Deoleo key absent → goes ON
  at that deploy with no data change (tell Deoleo's field team first). → [`LOCATION-GATE.md`](LOCATION-GATE.md)
- **Visibility**: fence only the photos that apply to the outlet (fixes "Unverifiable" from a hidden Window 2); centred review dialog with Program/Sub-Program + large photos.
- **Wholesaler wallet "Incl. Activation"** note under Lifetime Payout (flag `wholesalerPayoutInclActivation`; display-only for WHOLESALER outlets, no payout math change; Bajaj staging ON, **Bajaj prod ON since 2026-11-21**).
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
  TDS method: GROSS_UP everywhere (₹0 withheld). Reversal engine: LEGACY on prod today; owner 2026-11-21 (platform-wide,
  approved): **move Deoleo to the new engine and retire LEGACY** — branch `feat/retire-legacy-wallet-engine` (§3).
  Deoleo has nothing to backfill (98 wallets, zero wallet transactions — prod dry run 2026-11-21).
- **Bajaj** (`bajaj`; prod hosts `bajajloyalty.gifsy.in` + `bajaj.gifsy.in`; staging `uat-bajaj.gifsy.in`) — prod data
  imported and verified 2026-11-12/13 (outlets/KYC/docs, visibility, wholesaler points, payout history, partial vendor
  TDS, targets + achievements Apr 2025 → Oct 2026): [`BAJAJ-PROD-OUTLET-IMPORT.md`](BAJAJ-PROD-OUTLET-IMPORT.md).
  **November 2026 sales applied on prod 2026-11-15** via Sales Import and verified per outlet (6,452 records); the month
  is **OPEN**. Customisations: [`BAJAJ-CUSTOMIZATIONS.md`](BAJAJ-CUSTOMIZATIONS.md); decisions:
  [`BAJAJ-GO-LIVE-DECISIONS-LOG.md`](BAJAJ-GO-LIVE-DECISIONS-LOG.md); prod set-up: [`BAJAJ-PROD-GO-LIVE-CHECKLIST.md`](BAJAJ-PROD-GO-LIVE-CHECKLIST.md).

## 3. In progress (not on prod — do not describe as shipped)

| Work | Branch / worktree | State | Read |
|---|---|---|---|
| **Delivery address for physical gifts** (PLATFORM-WIDE, owner-approved 2026-11-24): fulfilment Excel gains Outlet name, Owner name, Deliver to (name), Delivery phone, Address line 1/2, City, State, PIN code after "Redeemed on (IST)" (physical rows filled, voucher/cash blank; PIN + phones as TEXT; read-only — the header-based upload ignores them, old sheets still upload). Redemption Orders shows a "Deliver to" block + "Copy address" on PHYSICAL_GIFT rows. Address shown ONLY to GIFSY_ADMIN / GIFSY_STAFF with `rewards:manage_orders` (same rule as the full voucher code); omitted from the list/getOrder payload for everyone else (CLIENT_ADMIN, read-only staff, sales); partner My Orders unchanged. | `feat/fulfilment-delivery-address` (worktree `ship-addr`) | Built + targeted tests + build/tsc green; not pushed | `api/src/rewards/rewards-fulfilment.helpers.ts` header |
| Other work — every earlier row shipped (release/next2 → 2026-11-22, release/next3 → 2026-11-23, release/next4 → 2026-11-24; see §1). | — | — | §1 |
| **MSG91 webhook "Add Condition"** (receive only portal reports) | — | Owner deferred 2026-11-19. ⚠️ Can't simply filter on `crqid`: scheme sends and some untracked paths carry none (their reports would be lost). Needs a design. | this row |

## 4. What's next / waiting on the owner

0. **Added 2026-11-24 (owner to decide / supply):**
   - **Fund reconciliation data per client**: opening balance + as-of date, agency fee (% or flat), discount per voucher
     item, low-balance threshold + recipients (Gifsy console → client → Fund). And whether to switch client alert
     e-mails ON (`FUND_ALERTS_LIVE=true` in `deploy.yml`, then a deploy).
   - **Hubble prod webhook**: never called in 14+ days → ask Hubble to register
     `https://gifsy-api-4d4n5mc6yq-el.a.run.app/v1/hubble/webhook` (+ the shared signing secret). The 2-min re-check
     covers it meanwhile.
   - **MSG91 WhatsApp report webhook auto-paused 2026-11-24 10:31 IST** (burst of 972 reports/min from direct MSG91
     campaigns; our side answered every request in < 0.25 s; owner re-enabled ~13:40 IST). Prevention options, none
     chosen: keep 2 API instances warm / schedule the existing missed-report reconcile / send big campaigns from a
     separate MSG91 number.
   - **Program Health (optional)**: "Redeemed (period)" includes imported vendor burns (Nov: 3,13,142 portal +
     1,24,691 imported 1–11 Nov = 4,37,833); held balances (40 outlets, 1,22,843 pts — 28 inactive on portal, 12 not on
     portal, none KYC'd) are not in the liability. Offered: split the card / show held next to liability.
   - **Edge**: estimate only (½ day check + 1 h – 2 days fixes) — needs screenshots of what client users see.
   - Owner said **leave** the visibility "Unverifiable" rule (photo GPS accuracy worse than the 200 m radius) as is.
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
6. Owner process items still open: ~~`gifsy-deployer` over-privilege review~~ DONE 2026-11-20 (deployer stripped to the 7 roles in `terraform/iam.tf`; laptop ops use the KEYLESS `gifsy-ops` account via `--account=<owner> --impersonate-service-account=gifsy-ops@gifsy-platform.iam.gserviceaccount.com`; IAM snapshot before the change kept by the operator); stray `gifsy` `tdsPolicy` row from the F1 bug
   (harmless; delete when convenient); rotate the Hubble client secret (was shared in a screenshot).
7. **After the 2026-11-19 prod release.** DONE 2026-11-19: Bajaj `gifsyRejectFastTrack` ON (Deoleo unset), verified
   read-only; Daily Ops Digest prod recipients = 4 `@gifsy.in` addresses, verified; `reports-run-prod` 300 s / 0 retries;
   `dve` tag removed (100% on the latest revision); prod backup `1795056648426` ("pre-trim 2026-11-19").
   **Sales trim — DONE 2026-11-19:** trim applied on prod, `SALES_RETENTION_V2=on` on api + worker (revision
   `gifsy-api-00094-9rp`; kept across deploys by `deploy.yml` since `f61aec24`), prod DB disk alert at 50% (policy
   `11636917613043922792`). Recipe kept for reference: `trim` on the `gifsy-migrate` job
   (`--args=node,dist/sales-import/oneoff/sales-history-trim.main.js,trim`), `rebuild-days` on the 2 GiB
   `gifsy-sales-import` job, both with `--update-env-vars=TRIM_TARGET_DB=gifsy_prod`.
7a. **After the 2026-11-19 night release (`1fa2305c`).** DONE 2026-11-21 (owner, Gifsy console → Clients → Bajaj;
   `requireLocation` is under **Behaviour flags**, not "Feature Flags"): Bajaj prod `requireLocation` ON and
   `wholesalerPayoutInclActivation` ON — verified read-only (probe job `bajaj-prod-vis-verify` exec `n9vdj` on
   `gifsy_prod`: Bajaj `requireLocation` true, `outletMasterGeo` true, `wholesalerPayoutInclActivation` true,
   `helpVideos` absent; Deoleo all four absent, no explicit `false`). Server-side location test on Bajaj staging passed
   the same day (`LOCATION-GATE.md`; real-phone GPS not exercised). Default ON for every tenant is on
   `feat/require-location-default` (next batch; no Deoleo heads-up needed (owner 2026-11-21: reps already keep location on for KYC/visibility) before that deploy). **Still waiting on the
   owner:** `helpVideos` ON after the content load; OK to load the Help & videos content on prod; OK to correct the remaining non-Privilege "Unverifiable" visibility captures in one go (list + SQL + backup
   first — 2 were corrected earlier, backup `1795068290437`). Bajaj prod wallet backfill — APPLIED (2,281 wallets
   sequenced, 0 blocked); no switch call is needed — `feat/retire-legacy-wallet-engine` (in `release/next2`, §3) retires the engine setting.
7b. **Month-end sales files (300–350 MB):** test a 200 MB+ real Bajaj file on staging before 30 Nov (owner to send the
   file). Next release: processing as a Cloud Run Job end-to-end + direct-to-storage resumable uploads; ask Bajaj about
   daily rolling 2–3-day files.
7c. ~~Alerts for people without phone notifications~~ — owner chose an after-login reminder with device-specific steps
   (built, shipped in `1fa2305c`, Bajaj).
8. **Hubble:** ask which of Ajio / MakeMyTrip / Myntra / Uber are claim-code-only → add product ids to
   `HUBBLE_CLAIM_CODE_PRODUCT_IDS`.
9. Wallet Reversal Engine rollout: schema + engine + over-reversal debt fix (D1/D2) are on prod since `4a48dc0d`
   (DORMANT, LEGACY everywhere; D3 not built). Bajaj prod backfill DRY RUN 2026-11-20: 6,491 wallets, 2,281 planned,
   0 blocked, 0 anomalies, 8 debt wallets (−3,549). Backfill APPLIED on prod (2,281 sequenced, 0 blocked, 0
   un-sequenced-with-history, 8 debt wallets 3,549 pts); the engine flag was never flipped (needs a GIFSY_ADMIN prod
   call). **Superseded 2026-11-21:** owner retired LEGACY for every tenant (§3 `feat/retire-legacy-wallet-engine`) —
   no switch call for Bajaj, nothing to backfill for Deoleo. Until that ships: **no credit reversal on Bajaj prod**
   (prod still runs LEGACY). After it ships: check the credits-screen readiness line for Bajaj (re-run the backfill if
   it shows un-sequenced wallets) before the first reversal. **Never run points compute for
   Bajaj imported months (Apr 2025 – Oct 2026).** → `WALLET-REVERSAL-ENGINE-DESIGN.md` §8.7–§8.12
10. **Request volume (Cloudflare Workers outage 2026-11-20, §1)** — `feat/request-volume` (local): no prefetch
    on list links, bottom-nav prefetch once per session, session cache for me / settings / outlet-types / banners,
    dashboard 2-min reuse, post-submit invalidation. **Owner approved 2026-11-21 on condition screen switching stays
    smooth**; audit found cross-tab staleness, a failed read cached as 0, and prefetch-once ineffective without
    `loading.tsx` — fix round in progress; **owner sees the measured trade-offs before it ships** →
    [`REQUEST-VOLUME.md`](REQUEST-VOLUME.md). **Sales banners**: owner 2026-11-21 → ON via the new sales read path
    `GET /v1/sales/banners` (branch `feat/small-owner-asks`, not yet pushed). Workers Paid is in place (10M req/mo) —
    TODO: confirm the monthly request budget against the ~30k req/h peak.
11. **`release/2026-11-21`** (§3): staging real-login check DONE 2026-11-21 (all pass); **deployed to prod — prod =
    `main` = `97332c95`, verified 2026-11-21** (§1; visibility review-history backfill verified: 51,140 Bajaj captures
    with history, 51,123 imported ones labelled "Imported — old app approval", 0 admin names). TODO if missing: the
    release-log row in `DOCS-INDEX.md`.
12. **Next batch = `release/next`** (local, not pushed): `fix/gps-photo-overlap` `0003f706` + `fix/hydration-418`
    `55155ce0` (done + audited), `feat/request-volume`, `feat/ticket-remarks-cc` (per-client To + CC),
    `feat/require-location-default` (⚠️ platform-wide, owner-approved 2026-11-21: location required ON BY DEFAULT for
    every client incl. Deoleo; console switch = emergency off; Deoleo goes ON with no data change — no heads-up needed
    (owner 2026-11-21: reps already keep location on); 200 m blocking unaffected — `outletMasterGeo` / visibility `geoFence` only).
    **Before it ships:** independent audit of the location change, full gates, staging check + the measured
    request-volume numbers, then the owner's go. **Owner decisions still pending (2026-11-21):** (a) remove the prod
    deploy's second click (§6 step 4); (b) Bajaj prod ticket remarks inbox — still unset; (c) sales banners on the sales
    app — DECIDED 2026-11-21: on (branch `feat/small-owner-asks`); (d) request-volume measured trade-offs; (e) real-phone location test (Android + iPhone).
13. HO / State-head **City** cells → "N cities" (State → "N states" when > 5) — DECIDED + built 2026-11-21 on branch
    `feat/small-owner-asks` (see USAGE-REPORT.md). Ticket remarks emails lose the "Asked:" and "copied for
    information" lines on the same branch (SUPPORT-TICKETS.md). The Usage report Mobile column shows full numbers (pre-existing, not changed).
14. **Held opening balances (Bajaj, 40 outlets, Σ 1,22,843 pts)** — ships in `release/next2` (§3). After deploy:
    runbook §D in order (deploy → §C-POST → dry run → backup → APPLY → verify → sweep). Operator uploads the manifest to
    `gs://gifsy-platform-files/migrations/held/bajaj-held-opening-balances-2026-11-11-v1.json` first. The 293 File-1-only outlets (2,22,995.55 pts) are IGNORED (owner decision 2026-11-21).
15. **App Adoption installed-users Excel → "Employee ID" column** (before Outlet Code; `SalesUser.employeeCode`, blank for non-sales) — branch `feat/adoption-employee-id` (off `release/next2`, local, not pushed; ⚠️ platform-wide, owner-approved 2026-11-21 for all clients incl. Deoleo; additive column; see PWA-PLAN.md).

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
  (fix on `fix/hydration-418`, local). Gating a redirect on such a hook before it is ready bounces users (an assumed
  GIFSY_STAFF went to `/gifsy` on hard refresh) — wait for a ready flag.
- **Photo GPS:** two photos taken close together share ONE precise-GPS lookup; never reuse a reading > 10 s old;
  PERMISSION_DENIED latches, TIMEOUT / POSITION_UNAVAILABLE are transient (`fix/gps-photo-overlap`, local).
- **Location required ≠ distance blocking.** `requireLocation` only requires a real fix (and records
  `LOCATION_FENCE_BLOCK` audit rows where a fence already blocks). The 200 m block is separate: KYC blocks only under
  `outletMasterGeo`; visibility only under `outletMasterGeo` or the tenant's own `visibilityConfig.geoFence.enabled` +
  radius. The flag lives in the console's **Behaviour flags** section, not "Feature Flags". Once
  `feat/require-location-default` ships, an ABSENT key means ON (Deoleo included) — the switch is an emergency OFF.

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
