# Bajaj prod follow-ups — runbook for owner approval (A flags · B Help content · C wallet backfill → V2)

> **Status (2026-11-21): part A partly DONE by the owner — `requireLocation` and `wholesalerPayoutInclActivation`
> are ON for Bajaj prod (verified read-only, see A "Read-back"); `helpVideos` still OFF. Parts B and C: NOTHING
> EXECUTED.** Every step below writes to **production** or changes a
> production setting, so each one needs the owner's explicit go. Approving one step does not approve the next one.
> Claude does not run any of it. Prod = `4a48dc0d` (GO-LIVE-ISSUE-LIST "NOW" 2026-11-21) — confirm the serving SHA first.
> Sources: `RESUME.md` §4 items 7a + 9, `BAJAJ-CUSTOMIZATIONS.md`, `LOCATION-GATE.md`, `HELP-VIDEOS.md`,
> `WALLET-REVERSAL-ENGINE-DESIGN.md` §9 / §9.1 / §8.6–§8.12, code in `api/src/gifsy/gifsy.service.ts`,
> `platform/src/app/gifsy/clients/[slug]/page.tsx`, `api/src/help/`, `api/src/wallet/backfill/`,
> `api/src/wallet/wallet.service.ts` (`setReversalEngineMode`).
> Anything marked **UNVERIFIED — needs check** could not be proven from the repo.

**Classification:** all three are **TENANT-SCOPED** (Bajaj only). Deoleo: no flag change, no content, no backfill
(owner 2026-11-16: Deoleo stays LEGACY with no backfill). Every run below uses `TENANTS=bajaj` / slug `bajaj` only.

**Common conventions**
- Ops identity (keyless): append `--account=<owner> --impersonate-service-account=gifsy-ops@gifsy-platform.iam.gserviceaccount.com --project=gifsy-platform`
  to every `gcloud` command below (written as `$OPS`).
- Bajaj tenant id = slug = `bajaj` (`clients.id` is the slug; `schema.prisma` Client model).
- Read-only SQL checks: run through the **read-only probe-job pattern** used for `bajaj-prod-vis-verify` (in-VPC Cloud
  Run job on the api image, prod `DATABASE_URL` secret, first statement `SELECT current_database()` must return
  `gifsy_prod`, SELECTs only). **UNVERIFIED — needs check:** that job's definition (image, command, how it takes a
  query) is NOT in the repo (only its name, `BAJAJ-PROD-OUTLET-IMPORT.md` line 55). It DID run the part-A flag
  read-back on 2026-11-21 (execution `n9vdj`); for other SELECTs, confirm it can run them or add a small read-only
  probe script first. For part C, the WRE `verify.main.js`
  job is itself read-only and covers most checks.
- Every SQL block starts with the guard: `SELECT current_database();  -- must be gifsy_prod, else STOP`.

---

## A. Bajaj prod feature flags — `requireLocation`, `wholesalerPayoutInclActivation`, `helpVideos`

> **Update 2026-11-21:** read-only probe — Bajaj prod `requireLocation` = explicit `true` (already ON). Owner then
> decided `requireLocation` is DEFAULT ON for every tenant (branch `feat/require-location-default`, not deployed; Deoleo
> has no key → goes ON at that deploy). See `LOCATION-GATE.md` "Default ON". The `requireLocation` steps below are
> historical.

### What it does (plain words)
| Flag | Effect when ON | Who sees what |
|---|---|---|
| `requireLocation` ("Require location for KYC and visibility capture", **Behaviour flags** section) | Sales reps cannot start or submit a KYC or a visibility capture without location permission + a real GPS fix. The API refuses such submissions (400). Store-board fix must be ≤ 60 min old; phone clock must be within 24 h. Fence blocks (> 200 m) are recorded and counted. | **Bajaj sales reps** (`SALES_*` only): a full-screen "Location is blocked…" guide with **Test again** on the KYC page / capture sheet when location is off. Partner self-enrolment and admins are never gated. **Admins / MIS**: a **Location Report** tile under Reports. **Daily Ops Digest**: a new "Location" section for Bajaj. |
| `wholesalerPayoutInclActivation` ("Wallet: 'Incl. Activation' (wholesalers)", **Feature Flags** section) | Display only: a small "Incl. Activation" line under "Lifetime Payout" on the wallet card. | **Bajaj wholesalers** only (`outletType === 'WHOLESALER'`). Retailers never see it. No numbers change. |
| `helpVideos` ("Help & videos", **Feature Flags** section) | A "Help & videos" entry on the sales and partner Profile; the member help endpoints start answering (they return 404 while OFF). | **Reps + partners**: the entry on Profile → list of **published** guides. With 0 published guides they see "No guides yet" → do **B first** (authoring works while the flag is OFF). |

### Prerequisites
1. Serving SHA ≥ `1fa2305c` (all three flags shipped there):
   `gcloud run services describe gifsy-api --region asia-south1 $OPS --format='value(spec.template.spec.containers[0].image)'`
   (same for `gifsy-frontend`). Expected tag `4a48dc0d` (or later).
2. `requireLocation`: `LOCATION-GATE.md` asks for a real-phone check on **staging first** (Android + iPhone: allow / deny /
   Location off / Test again). 2026-11-21: server-side staging test passed (`LOCATION-GATE.md` "Staging test
   2026-11-21") and the owner switched Bajaj prod ON the same day. Bajaj staging flag states (2026-11-21):
   `requireLocation` ON, `helpVideos` ON, `wholesalerPayoutInclActivation` ON.
3. `helpVideos`: part B done (guides published), else reps see an empty list.
4. Recommended: tell Bajaj field leads before `requireLocation` goes on (reps with location off are blocked at once,
   on the next page load).

### Read-back BEFORE (record it)
```sql
SELECT current_database();  -- must be gifsy_prod
SELECT id,
       features->'requireLocation'                AS require_location,
       features->'wholesalerPayoutInclActivation' AS incl_activation,
       features->'helpVideos'                     AS help_videos
FROM clients WHERE id IN ('bajaj','deoleo') ORDER BY id;
```
**Read-back 2026-11-21** (read-only probe job `bajaj-prod-vis-verify`, execution `n9vdj`, `current_database()` =
`gifsy_prod`) — AFTER the owner switched the first two on that day:
- `bajaj`: `requireLocation` **true**, `outletMasterGeo` **true**, `wholesalerPayoutInclActivation` **true**,
  `helpVideos` **absent** (OFF).
- `deoleo`: `requireLocation`, `outletMasterGeo`, `wholesalerPayoutInclActivation`, `helpVideos` all **absent** (no
  explicit `false` stored).

Staging (2026-11-21): Bajaj all three ON.

### Backup
Not needed for a flag: each toggle is one audited merge of one key into `clients.features` (every other key kept,
`gifsy.service.ts` `BOOLEAN_FEATURE_KEYS`), and turning it off undoes it. Optional: the read-back above is the record.

### Exact steps (owner, as GIFSY_ADMIN in the prod Gifsy console)
1. Open the operator console → **Clients** → **Bajaj**. (Prod console host: **UNVERIFIED — needs check**; staging is
   `uat-app.gifsy.in`, so prod is presumably `app.gifsy.in`.)
2. **Behaviour flags** → switch on **"Require location for KYC and visibility capture"** → read the confirmation → confirm.
3. **Feature Flags** → switch on **"Wallet: 'Incl. Activation' (wholesalers)"**.
4. (After part B) **Feature Flags** → switch on **"Help & videos"**.
   Each toggle saves at once via `PATCH /api/gifsy/clients/bajaj { features: { <key>: true } }` (GIFSY_ADMIN +
   `tenancy:write`, audited per key). A failed save leaves the switch unchanged — re-check it.

### Verify
1. Re-run the read-back SQL: `bajaj` → `true`, `true`, `true`; **`deoleo` unchanged** (NULL/false).
2. Owner real logins on Bajaj prod (prod logins stay with the owner):
   - Sales rep, Android + iPhone: KYC → New Enrollment with location **off** → guide shows; turn on → **Test again** →
     wizard returns. Visibility → Capture: same. One real submission with location on goes through.
   - Admin / MIS: Reports → **Location Report** tile present and loads.
   - Wholesaler login: Wallet → "Incl. Activation" under Lifetime Payout. A retailer login: line absent.
   - Rep + partner: Profile → **Help & videos** → published guides listed; a video plays.
3. Next Daily Ops Digest email: Bajaj has a "Location" section; Deoleo's section list is unchanged.

### Rollback
Switch the same toggle off in the console (takes effect on the reps' next page load). No data to undo. Location
fence-block audit rows written while ON stay (they are history).

### Risks
- `requireLocation`: reps on old phones / in-store with no GPS are **blocked from KYC and visibility** until they get a
  fix — field complaints likely on day 1. Not exercised on real phones per the doc's "Not verified" list. "Not
  interested" on the KYC page is behind the phone gate but the API for it is not gated (documented, harmless).
- `helpVideos` ON before content → empty "No guides yet" screen.
- `wholesalerPayoutInclActivation`: display only; risk = wording only.

---

## B. Help & Guides content load (Help & videos guides for Bajaj prod)

### What it does (plain words)
Creates Bajaj's how-to guides (title, short description, 3–6 numbered steps, optional MP4 video ≤ 50 MB + poster) in
the `help_topics` table, uploads the videos/posters to OUR uploads bucket under `help-videos/bajaj/<topicId>/…`, and
publishes them. Members see only **published** guides and only when `helpVideos` is ON (part A step 4).

**There is no loader script.** `HELP-VIDEOS.md` §3: the seed content is "enter via the console after deploy — NOT
seeded into the DB". `api/src/help/` has only the console/member services (no bulk import). So "loading content" =
typing the guides in the console. Content source = `HELP-VIDEOS.md` §3 (9 SALES guides, 5 PARTNER guides).

### Prerequisites
1. Prod serving `1fa2305c` or later (table `help_topics` = migration `20261120100000_add_help_topics`; Help UX fixes
   shipped in `4a48dc0d`).
2. The video files: "3 sales training videos recorded" (`HELP-VIDEOS.md`). **UNVERIFIED — needs check:** where the
   files are, which 3 guides they belong to, and that each is an H.264 MP4 ≤ 50 MB (QuickTime/HEIF are refused; ideal
   720p < 20 MB, portrait).
3. Owner decision on the guide list (all 14 from §3, or a subset) and on role filters (default: empty = everyone in the
   audience).
4. **UNVERIFIED — needs check:** whether the same guides were entered and checked on Bajaj **staging** first
   (recommended — the console flow and video playback can be checked there with `FIXED_OTP` logins).

### Read-back BEFORE
```sql
SELECT current_database();  -- must be gifsy_prod
SELECT audience, count(*) AS total,
       count(*) FILTER (WHERE "isPublished") AS published,
       count(*) FILTER (WHERE "videoKey" IS NOT NULL) AS with_video
FROM help_topics WHERE "clientId" = 'bajaj' AND "deletedAt" IS NULL GROUP BY audience ORDER BY audience;
```
Expected: no rows (nothing loaded yet).

### Backup
Not required (additive rows in one new table; every write audited as `AuditLog` `entityType 'HelpTopic'`; soft delete).
If the owner wants one anyway: the standard on-demand backup (see C step C2).

### Exact steps (owner, GIFSY_ADMIN, prod console — flag may stay OFF while authoring)
1. Clients → **Bajaj** → **Help & videos** link (next to the status pill) → `/gifsy/clients/bajaj/help-videos`.
   A loud "feature is OFF" banner is expected until part A step 4.
2. For each guide in `HELP-VIDEOS.md` §3: **New guide** → audience (SALES / PARTNER) → title (≤ 80) → description
   (≤ 200) → steps one per line (3–6, each ≤ 200) → save (always a draft).
3. For the 3 recorded videos: open the guide → upload the MP4 (sent in 8 MiB parts; wait for completion) → optional
   poster (PNG/JPG/WEBP ≤ 5 MB).
4. Reorder within each audience if wanted.
5. **Publish** each guide (needs 3–6 steps).
6. Then part A step 4 (`helpVideos` ON).

### Verify
1. Read-back SQL again: SALES total/published = the agreed count (9 if all), PARTNER = 5 if all; `with_video` = 3 (SALES).
2. Console preview: each video plays (preview token works with the flag OFF).
3. After `helpVideos` ON: rep + partner Profile → Help & videos → list matches; open a video guide → plays; steps shown.

### Rollback
Unpublish a guide (hidden from members at once) or delete it (soft delete: row kept for the audit trail, its video +
poster objects are deleted from the bucket). Or switch `helpVideos` off (all member endpoints 404).

### Risks
- Wording drift: §3 steps "follow the real screens as of `f5abb310`" — screens changed since (e.g. location guide,
  notification reminder). **UNVERIFIED — needs check:** re-read each step against the current prod screens.
- SALES guide 2 "Allow location" and 6 "Visibility capture" assume `requireLocation` ON — publish them only if A step 2
  is approved.
- Abandoned video uploads leave parts under `help-uploads/`; the 1-day lifecycle rule is in
  `terraform/gcs-memorystore.tf` but **NOT applied** — harmless cost item until the next terraform run.
- Videos are streamed through the API (60-min tokens, per-token limits) — a large rep audience opening videos at once
  adds API egress load (no transcoding).

---

## C. Bajaj prod wallet backfill → VERIFY → switch reversal engine LEGACY → V2

### What it does (plain words)
The Wallet Reversal Engine (V2) needs every Bajaj wallet's history numbered in order and each credit's "how much debt
did it repay" recorded. The **backfill** writes that bookkeeping only — movement sequence numbers, ledger links, credit
positions, historical reversal allocations, and `debtPoints` for the 8 negative wallets. **It never changes a balance,
a counter or a points lot** (guarded per wallet: any change rolls that wallet back and stops the run, exit 4).
**VERIFY** re-checks it read-only. The **switch to V2** then makes future Bajaj POINTS reversals follow the owner's
rules: a reversal fully undoes the credit; whatever the wallet no longer holds becomes debt repaid from future earnings
(nothing written off). Under LEGACY today, reversals floor at 0 and are refused on wallets carrying debt.

**⚠️ Dependency:** switch Bajaj to **V2 BEFORE any credit reversal on Bajaj prod** (RESUME §4 item 9). Also: **never
run a points compute for Bajaj imported months (Apr 2025 – Oct 2026).** Do NOT ship the post-backfill migration
(`platform/docs/plans/sql/wallet-reversal-post-backfill.DRAFT.sql`): Deoleo is not backfilled, so its preflight would
refuse (NULL `seq` rows) — out of scope here.

**Dry run on prod 2026-11-20 (the baseline to compare against):** 6,491 wallets · 2,281 planned (the rest have no
history = no-op) · 0 blocked · 0 anomalies · 8 debt wallets totalling −3,549 pts
(balances −840, −612, −520, −360, −360, −297, −280, −280).

### Prerequisites
1. Prod api image contains the backfill/verify code (WRE on prod since `4a48dc0d`): serving SHA check (A prereq 1) and
   the `gifsy-migrate` job image = the same SHA:
   `gcloud run jobs describe gifsy-migrate --region asia-south1 $OPS --format='value(spec.template.spec.template.spec.containers[0].image)'`
   (**UNVERIFIED — needs check:** exact `--format` path for jobs; any `describe` output showing the image tag is fine.)
   Also confirm the job carries no leftover env from the 2026-11-20 dry run (`EXPECTED_DB`, `TENANTS`, `BACKFILL_*`) —
   `gifsy-migrate` normally runs `npx prisma migrate deploy` on every prod deploy.
2. No in-flight Bajaj reversals and the engine flag is absent (= LEGACY):
   ```sql
   SELECT current_database();  -- must be gifsy_prod
   SELECT "awardType", status, count(*) FROM credit_reversals
   WHERE "clientId" = 'bajaj' AND status = 'PENDING_GIFSY' GROUP BY 1, 2;          -- expect 0 rows (else decide first)
   SELECT "settingKey", "settingValue", "updatedAt" FROM program_settings
   WHERE "clientId" = 'bajaj' AND "settingKey" IN ('reversalEngine', 'pointsReversalApprovalsPaused'); -- expect 0 rows
   ```
3. A quiet window (earn/redeem keep working during APPLY and are reconciled; only POINTS reversal create/approve are
   paused for the run — seconds for ~29k events / 2,281 wallets per design §9). Prefer no sales-file apply / credit
   batch confirm running at the same time.

### Steps (each numbered step = one owner go)
**C1. Fresh DRY RUN (read-only)** — re-plan right before APPLY; new wallets may have history since 2026-11-20.
```bash
gcloud run jobs execute gifsy-migrate --region asia-south1 $OPS --wait \
  --args=node,dist/wallet/backfill/backfill.main.js \
  --update-env-vars="EXPECTED_DB=gifsy_prod,TENANTS=bajaj"
```
(`gifsy-migrate`'s command is `npx`, so `--args=node,<file>` runs `npx node <file>` — same pattern as the 2026-11-19
trim recipe in RESUME §4 item 7. `--update-env-vars` on `execute` applies to that execution only.)
Read the log: planned / noop / BLOCKED counts, debt wallets `B → D (H)`, anomaly list. **Go/no-go:** 0 BLOCKING
anomalies, 0 blocked, 8 debt wallets = the 8 balances above (planned may be ≥ 2,281 if wallets gained history). Any
difference → stop and bring the anomaly list to the owner.

**C2. Backup** (instance-wide on-demand backup; note the id):
```bash
gcloud sql backups create --instance=gifsy-db $OPS --description="pre-WRE-backfill bajaj <date>"
gcloud sql backups list --instance=gifsy-db $OPS --limit=3   # record the new backup id + SUCCESSFUL
```

**C3. APPLY** (writes bookkeeping only; pauses Bajaj POINTS reversal approvals for its window and lifts the pause at the
end, also after a crash — do NOT set `KEEP_POINTS_REVERSALS_PAUSED`, because the V2 switch refuses while paused):
```bash
gcloud run jobs execute gifsy-migrate --region asia-south1 $OPS --wait \
  --args=node,dist/wallet/backfill/backfill.main.js \
  --update-env-vars="EXPECTED_DB=gifsy_prod,TENANTS=bajaj,BACKFILL_APPLY=true,BACKFILL_CONFIRM=APPLY gifsy_prod"
```
`BACKFILL_CONFIRM` must be exactly `APPLY gifsy_prod` (the runner refuses otherwise, exit 2). Exit codes: **0** ok
(BLOCKED wallets would be listed under ATTENTION, not a failure) · 2 guard refused · **3** wallets/payout plan changed
mid-run → re-run C3 · **4** V0 ALARM → stop, nothing more, investigate · 1 crash (check the pause is lifted — see Rollback).
**Save from the log:** the `V0 before` JSON objects (needed by C4), the ATTENTION block (send to owner), the final
`wallet-reversal backfill report` JSON line. Reading the log:
`gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="gifsy-migrate"' $OPS --freshness=1h --format='value(textPayload)'`
(**UNVERIFIED — needs check:** filter by execution name if several runs are in the window.)

**C4. VERIFY** (read-only):
```bash
gcloud run jobs execute gifsy-migrate --region asia-south1 $OPS --wait \
  --args=node,dist/wallet/backfill/verify.main.js \
  --update-env-vars='^@^EXPECTED_DB=gifsy_prod@TENANTS=bajaj@V0_BASELINE_JSON=[<the V0 before objects from C3>]@EXPECTED_NEGATIVE_BALANCES={"bajaj":[-840,-612,-520,-360,-360,-297,-280,-280]}'
```
(The JSON values contain commas, so the env list uses gcloud's alternate delimiter `^@^`. **UNVERIFIED — needs
check:** quoting on the owner's shell — Git Bash vs PowerShell; a safer alternative is `--env-vars-file` with a YAML file.)
Pass = **exit 0** (no FAIL). WARN lines (V9b payout planner, V10 blocked wallets) are printed and counted — read them.
V0 passes when identical to the baseline or "live activity since the APPLY baseline … — explained".

**C5. Read-back SQL** (independent of the job):
```sql
SELECT current_database();  -- must be gifsy_prod
SELECT count(*)                                                   AS wallets,
       count(*) FILTER (WHERE w."movementSeq" > 0)                AS sequenced,
       count(*) FILTER (WHERE w."backfillStatus" = 'DONE')        AS done,
       count(*) FILTER (WHERE w."backfillStatus" = 'BLOCKED')     AS blocked,
       count(*) FILTER (WHERE w."debtPoints" > 0)                 AS debt_wallets,
       coalesce(sum(w."debtPoints"), 0)                           AS debt_total,
       count(*) FILTER (WHERE w."redeemablePoints" < 0)           AS negative_wallets,
       coalesce(sum(w."redeemablePoints") FILTER (WHERE w."redeemablePoints" < 0), 0) AS negative_sum,
       count(*) FILTER (WHERE w."redeemablePoints" + w."debtPoints" < 0) AS holdings_below_zero
FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'bajaj';
-- Expected: wallets 6,491 (+ new outlets since) · sequenced ≈ done = 2,281 (or C1's planned figure) · blocked 0 ·
-- debt_wallets 8 · debt_total 3,549 · negative_wallets 8 · negative_sum −3,549 · holdings_below_zero 0.

-- Same test the V2 switch applies (must be 0, else the switch refuses):
SELECT count(*) FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'bajaj' AND w."movementSeq" = 0
  AND (w."redeemablePoints" <> 0 OR EXISTS (SELECT 1 FROM wallet_transactions t WHERE t."walletId" = w.id))
  AND NOT (w."backfillStatus" IS NOT DISTINCT FROM 'BLOCKED' AND w."backfillBlockedReason" IS NOT NULL);

-- Pause lifted (expect 0 rows, or settingValue paused=false):
SELECT "settingValue" FROM program_settings WHERE "clientId" = 'bajaj' AND "settingKey" = 'pointsReversalApprovalsPaused';

-- Deoleo untouched (expect 0):
SELECT count(*) FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'deoleo' AND (w."movementSeq" > 0 OR w."debtPoints" <> 0 OR w."backfillStatus" IS NOT NULL);
```

**C6. Switch Bajaj to V2** (owner, GIFSY_ADMIN). There is **no console button** for this — the only write path is
`POST /v1/admin/credits/reversal-engine/mode` (GIFSY_ADMIN + `credits:approve_reversal`; the generic settings upsert
refuses the key). The FE proxies `/api/*` → `/v1/*`, so from a logged-in prod console tab (browser DevTools console):
```js
await fetch('/api/admin/credits/reversal-engine/mode', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
  body: JSON.stringify({ mode: 'V2', clientId: 'bajaj', reason: 'WRE backfill <backup id> verified <date> — owner go' }),
}).then(r => r.json());
```
**UNVERIFIED — needs check:** that the console session authenticates this call this way (cookie vs bearer header), and
how Bajaj **staging** was switched to V2 — repeat that same method. `clientId` is required for an un-assumed Gifsy
session; if the session is assumed into Bajaj it must match. The endpoint waits for in-flight reversals, refuses V2 while
approvals are paused or while any wallet with history is un-sequenced and not listed BLOCKED (message names the count),
and writes an audit row. Expected response: `{ clientId: 'bajaj', mode: 'V2', previous: null, blockedWalletsListed: 0, note: null }`.

### Verify the switch
```sql
SELECT current_database();  -- must be gifsy_prod
SELECT "clientId", "settingValue", "updatedAt" FROM program_settings
WHERE "settingKey" = 'reversalEngine' ORDER BY 1;   -- expect exactly one row: bajaj = "V2" (Deoleo: no row = LEGACY)
```
Screens (owner, Bajaj admin login): Credits → Payout Status shows the reversal-engine attention banner (mounts only when
the mode is not LEGACY) with no blocked wallets / unmapped credits; "Wallets in debt" lists the 8 wallets, 3,549 pts
owed. Deoleo's credits screen: unchanged (no banner). Next Daily Ops Digest: "8 negative wallets (3,549 pts owed)".

### Rollback
- **Mode:** same endpoint with `{"mode":"LEGACY","clientId":"bajaj","reason":"…"}` — always allowed. Reversals already
  approved under V2 keep their recorded outcome (debt stays); PAYOUT reversals reserved under V2 still complete on the
  V2 path (dispatch is by allocation rows).
- **Backfill writes:** no undo needed for correctness — balances were never changed, and backfilled wallets keep working
  under LEGACY (movement path keeps them sequenced). A stuck pause after a crash: GIFSY lifts it on the credits screen
  ("Resume approvals") or `POST /v1/admin/credits/reversal-engine/pause {"paused":false,"clientId":"bajaj"}`.
- **Last resort — restore backup C2:** ⚠️ a Cloud SQL restore is **instance-wide** (`gifsy-db` also holds
  `gifsy_staging`) and loses every write since the backup on BOTH databases (Bajaj + Deoleo earn/redeem, KYC, sales).
  Only with an explicit owner decision.

### Risks + who is affected
- **Reps:** nothing visible.
- **Retailers / wholesalers (Bajaj):** nothing changes at backfill or switch time. **After V2, on a future reversal:** a
  reversal larger than what the wallet holds takes the wallet **below zero** (debt, repaid from future earnings); the
  retailer sees the negative balance with a plain-words note and a self-explaining passbook row (no ₹). Under LEGACY the
  same reversal would have stopped at 0. The 8 existing negative wallets become reversible (today refused).
- **Bajaj admins / Gifsy:** POINTS reversal create/approve refuse with "Points reversal approvals are paused — wallet
  maintenance in progress" during C3 only; reversal-engine banner appears after C6; liability figures exclude debt
  (already shipped behaviour).
- **Deoleo:** none (no backfill, stays LEGACY; the C5 Deoleo check proves it).
- Run risks: exit 3 under heavy live activity (re-run, idempotent); exit 4 = stop. `gifsy-migrate` task timeout:
  **UNVERIFIED — needs check** (the run is expected to take seconds–minutes; the dry run completed on 2026-11-20).
  Open engine items (design doc): D3 not built; WP8 shadow-diff report and the REPLAY tool not built — the switch goes
  straight LEGACY → V2 without a SHADOW period (consistent with "Bajaj → V2 first", design §9 rollout step 5).

---

## Decisions the owner must make
1. ~~A: switch `requireLocation` ON for Bajaj prod~~ — **DONE 2026-11-21** by the owner (Gifsy console → Clients →
   Bajaj → **Behaviour flags**, not "Feature Flags"); verified read-only on `gifsy_prod`. Server-side staging test the
   same day passed (see `LOCATION-GATE.md`); the real-phone test was not recorded before the switch.
2. ~~A: switch `wholesalerPayoutInclActivation` ON for Bajaj prod?~~ — **DONE 2026-11-21** (display-only "Incl.
   Activation" sub-line under Lifetime Payout for WHOLESALER outlets; no payout math change); verified read-only.
3. A/B: load which guides (all 14 from `HELP-VIDEOS.md` §3 or a subset), which 3 get the videos, and where the video
   files are; then switch `helpVideos` ON (after the content is published).
4. B: rehearse the guides on Bajaj staging first, or enter straight on prod?
5. C: go for C1 fresh dry run → C2 backup → C3 APPLY → C4/C5 verify → C6 V2 switch — one go per step, in a quiet window.
6. C: if C1 shows anything different from the 2026-11-20 baseline (blocked wallets, anomalies, other debt wallets) — stop,
   or proceed with BLOCKED wallets listed (they keep today's rules; reversals on them refused)?
7. C: who performs C6 and how (DevTools fetch from the console vs the method used on staging).
