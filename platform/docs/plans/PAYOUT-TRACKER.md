# Payout tracker — daily client report + Mon–Sat email

**Status:** LIVE on prod since `44341503` (owner-deployed + verified 2026-11-27 22:45 IST; staging since 20:57 IST).
Bajaj prod `payoutTracker` setting written 2026-11-27 (358 recipients, 10:00 Mon–Sat); emails start once the Cloud
Scheduler job `payout-tracker-prod` exists. Current state lives in [`RESUME.md`](RESUME.md) §1. First user: **Bajaj**. Inert for every other tenant (no setting row ⇒ nothing runs).
Code: `api/src/reports/payout-tracker/` (each file's header comment is the detailed contract).

## 1. What it is

An outlet-level "where does each outlet stand on this month's payout" report in the client's own format (Bajaj's
**Book4** outlet sheets + **Book3** summary tables), e-mailed to the client's configured recipients every scheduled day
with the workbook attached and the full summary tables in the email body. The figures are **month-to-date and
provisional** — a preview, not a credit.

- Tenant-scoped feature on shared code. The shared pieces (owner-approved 2026-11-27): `Msg91Service.sendEmail`
  gained optional text / attachments / opt-in ambiguous-delivery detection (byte-identical for every existing caller),
  and one additive table `tenant_report_runs`.

## 2. Data sources

- **Points / payouts:** `PointsComputeService.previewCompute` — the same read-only preview the Compute page uses
  (monthly period, plus the FY quarter for the Ws consistency bonus). The tracker never re-implements the rules.
- **Refusals before any compute:** the tenant's points-engine **first live month** (`settings.pointsEngine.firstLiveMonth`)
  must be set, and the month must not be before it (imported months from the old system are never computed); the
  engine's own `importedMonths` flag is checked again. Prod and staging Bajaj: `firstLiveMonth = 2026-11`.
- **Outlets:** only outlets whose KYC is **currently** approved (latest submission via `resolveEffectiveKycStatus`);
  re-KYC / suspended / pending / never started drop out. Excluded counts by status go to the ops note; the About sheet
  says so.
- **"Sales up to":** `SalesDaySet.lastDay` (last invoice day in the applied DMS file); when the file was applied on the
  same IST day as its last invoice day, the day before (a same-day file is partial — the 27-Nov prod file had 4
  same-day invoice lines → "26 Nov 2026"). No day set → "data applied <date>".
- **Month:** the current IST month, or the previous month when the current one has no applied sales yet.
- **Visibility:** approved / attempted captures for the month (summary columns J–M).

## 3. Workbook and email

Sheets: **Summary · retail · Ws · Exceptions** (only when non-empty) **· About**. Codes (Customer Code, SAP Code, CODE)
are always text; every string passes the formula-injection guard.

- **retail** (RLP): Zone … Beat Name, Program, Sub-Program, Outlet Type, Sub Channel; Total / ADHO / Non ADHO / FB /
  Line target, achieved, %; Payout per Window, Potential Payout, Visibility Status, WORKING, Approved Visibility Payout,
  ECO, WOA; Performance / Visibility / Line / Total Payout; Reason; Gifsy Approval.
- **Ws** (wholesale): hierarchy, CODE, Customer / WH Name, Target, Ach, Ach %, Ach WOA, Total / FB1 / FB2 Cases, Base /
  FB1 / FB2 / Total Points, Reason, Consistency Bonus (<quarter>), Final Points, Gifsy Approval.
- **Summary** (also the email body): RLP lines by zone / SM HQ / ASM HQ — outlets, outlets over 100% (WOA), value
  target / achieved / %, visibility eligible / attempted / approved / %, lines over 100%, a score
  `0.3·WOA + 0.3·Ach% + 0.2·Vis approved% + 0.2·Lines%` and its rank; plus a "not billing" table (retail / Ws outlets
  with no sales this month and last month).
- Numbers use **Indian grouping** (1,23,456).
- An outlet that cannot be placed on either sheet is never dropped silently — it goes to **Exceptions**.
- **Errored outlets are held back:** a per-outlet rule/config problem (engine ERROR rows etc.) removes only those
  outlets; the client email carries a note with the count, ops get the per-outlet list. A tenant-wide problem still
  fails the whole run.

## 4. Schedule and recipients (config)

Per-tenant `ProgramSetting(clientId, 'payoutTracker')`:

```json
{ "enabled": true, "recipients": ["…"], "cc": ["…"], "sendTimeIst": "10:00", "days": [1,2,3,4,5,6], "sendOnHolidays": true }
```

- Absent / `enabled !== true` ⇒ off. An enabled row with a bad value is a FAILED run + ops alert (never ignored).
- Defaults: `sendTimeIst` `10:00`, `days` Mon–Sat (ISO 1–6), `sendOnHolidays` true. Due = today (IST) is a configured
  weekday AND now (IST) ≥ `sendTimeIst`.
- At most **1,000** distinct to + cc addresses.

## 5. Endpoints, env vars and secrets

| What | Value |
|---|---|
| Scheduler trigger | `POST /v1/internal/scheduled/payout-tracker`, header `x-reports-run-secret` = `REPORTS_RUN_SECRET` (prod) / `REPORTS_RUN_SECRET_STAGING` (staging). 200 when nothing failed in the call (incl. not-due / already-done); **500** when any tenant FAILED (ops alert already sent) |
| Manual send-now | `POST …/payout-tracker/send-now` `{clientId, month, recipients?}`, header `x-payout-tracker-send-secret` = `PAYOUT_TRACKER_SEND_SECRET`. **Deliberately NOT bound on staging or prod → 403.** Writes a `payout-tracker-manual` run row |
| `PAYOUT_TRACKER_EMAIL_LIVE` | `true` in prod `deploy.yml` → each enabled client's configured recipients. Unset on staging |
| `PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT` | Staging only (`deploy-staging.yml`): ONE internal address (`nikunj.sadani@gifsy.in`); subject names the real recipients. Must be on an internal domain (`REPORTS_RECIPIENT_DOMAINS`) |
| Neither set | Nothing is sent; ops alerted once a day; the day is NOT claimed (it goes once fixed) |
| `PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL` | Per-message cap, default **50**, allowed 1–500; an invalid value is an error, never a silent default |

## 6. Idempotency, retries, batching

- Table **`tenant_report_runs`** (migration `20261127100000_payout_tracker_report_runs`): unique
  `(clientId, reportKey, runDate)`; `reportKey` `payout-tracker` (scheduled), `payout-tracker-manual` (send-now),
  `payout-tracker-blocked` (once-a-day "could not even try" marker that does not claim the day). Status
  PENDING / SENT / FAILED / SKIPPED.
- The day is **claimed** by inserting a PENDING row before sending — a concurrent scheduler hit loses the claim, so the
  email can never go twice.
- A FAILED day is retried on the next scheduler hits, **max 3 attempts per day**, each failure alerts ops. A retry
  **keeps the month** of the first attempt. Never retried: anything where the email may already have gone (SMTP lost
  after DATA, recording SENT failed, stale PENDING > 30 min).
- **Batching:** to + cc above the cap go as consecutive copies of the same email (first message: configured To, then Cc
  fill; later messages: their chunk in To). Everyone stays visible in To/CC (owner decision). After each chunk the run
  row's `recipients` records `{delivered, uncertain}`, so a retry sends only the chunks not yet sent; an uncertain chunk
  is never retried (UNCERTAIN alert). SENT only when every chunk was accepted. Ops alerts carry exact counts.
- Test mode is ONE email to the test address (subject names the real recipient + message counts).

## 7. Staging vs prod

- **Staging never emails clients:** `PAYOUT_TRACKER_EMAIL_LIVE` unset → only the test recipient. Send-now 403.
- **Prod:** `PAYOUT_TRACKER_EMAIL_LIVE=true`; only clients with an enabled `payoutTracker` row are emailed — none
  configured ⇒ nothing sent. Send-now 403.

## 8. Runbook

**Staging test run** (owner's account — `gifsy-ops` cannot read secrets; use `gcloud.cmd` on the owner's PowerShell):

```bash
SECRET=$(gcloud secrets versions access latest --secret=REPORTS_RUN_SECRET_STAGING --project=gifsy-platform --account=<owner>)
curl -sS -X POST -H "x-reports-run-secret: $SECRET" -H "Content-Type: application/json" -d '{}' \
  https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app/v1/internal/scheduled/payout-tracker
```

The reply lists one outcome per enabled tenant: `sent` / `failed` / `skipped` / `not-due` (before `sendTimeIst` or not
a configured weekday) / `already-done` (today's row already exists).

**Reset a staging day** (owner approval + backup print first — it is a DB write): delete that one
`tenant_report_runs` row (`reportKey = 'payout-tracker'`, the tenant's clientId, `runDate` = today IST) on
`gifsy_staging`, then re-run. Run it through the `gifsy-exports-staging` job with a per-execution override
(`--args="^@@@^-e@@@<script>"`; the job carries `DATABASE_URL_STAGING`); the script must guard
`current_database() = 'gifsy_staging'` and print the row before deleting. Do NOT use `gifsy-oneoff-staging` (§9).

**Prod enable (owner, in order, after the prod deploy of `44341503`):**
1. Confirm prod serves `44341503` (RESUME §7) and migration `20261127100000_payout_tracker_report_runs` applied.
2. Owner approves the prod `ProgramSetting` write `bajaj / payoutTracker`
   `{enabled: true, recipients: [358 addresses], sendTimeIst: "10:00", days: [1..6], sendOnHolidays: true}` — backup
   printed first, script guarded `current_database() = 'gifsy_prod'`.
3. Owner creates Cloud Scheduler job **`payout-tracker-prod`**: `*/15 9-21 * * 1-6`, time zone `Asia/Kolkata`, POST
   `…/v1/internal/scheduled/payout-tracker`, header `x-reports-run-secret` = `REPORTS_RUN_SECRET`,
   `--message-body="{}"` (no body ⇒ 411), attempt deadline 300 s, 0 retries. (`gifsy-ops` cannot create scheduler jobs.)
4. First automatic email target: **Sat 28 Nov 2026 10:00 IST**. Check the run row + ops inbox afterwards.

## 9. Owner decisions (2026-11-27)

10:00 IST Mon–Sat · `sendOnHolidays` true · 358 recipients, all in To/CC · KYC-approved outlets only (current status) ·
errored outlets held back with a client note · MTD provisional figures · Book4 sheets + Book3 summary, full tables in
the email body, Indian number grouping. **Not started:** coloured header sections + conditional formatting on summary
values (owner request, RESUME §4).

## 10. Known traps

- **Staging "already-done":** a run row from an earlier (old-code) run blocks today's send. 2026-11-27: the first test
  returned already-done; the owner approved clearing that one staging row (backup printed, 1 deleted) → re-run SENT on
  the new code.
- **Staging "sales up to" lags prod:** staging's latest Bajaj sales file (applied 25 Nov) only reaches 18 Nov, so the
  staging email says "sales up to 18 Nov" — expected; prod (27-Nov file) says "26 Nov".
- **`gifsy-oneoff-staging` is broken:** its pinned image was garbage-collected ("Image not found") and `gifsy-ops`
  cannot update job images (no Artifact Registry download permission). Use `gifsy-exports-staging` (current image) with
  the `--args` override above.
- The tracker refuses to run without `firstLiveMonth` — never "fix" that by computing an imported month.
- Cloud Run CPU is throttled when idle — the tracker only runs when Cloud Scheduler calls it.
