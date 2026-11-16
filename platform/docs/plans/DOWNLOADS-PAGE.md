# Downloads page (background exports) — design

> **Status: ✅ LIVE on prod + staging since 2026-11-15 (`2eb8271d`).** Migration `20261116120000_export_requests`
> applied on both; worker jobs `gifsy-exports` (prod) / `gifsy-exports-staging` deployed by the workflows, which also
> grant `roles/run.jobsExecutor` to `gifsy-api-sa` (owner-approved IAM change, shipped with the release). The optional
> drain Scheduler (Runbook below) is NOT created by the workflows (none is recorded as created) — the Downloads list
> self-heals without it.

Owner-approved 2026-11-13. ⚠️ PLATFORM-WIDE (shared code; every tenant incl. Deoleo). Part of the memory-safety plan
(decisions log, 2026-11-13 "API memory + memory-safety plan").

## Why
Two heap-out-of-memory crashes on 2026-11-13 (prod Outlet Master download; staging upload overlapping a Sales Import
recalculate). ~30 downloads build the whole workbook in the API's memory (`common/xlsx.ts` `buildXlsx`, ≈ 4 copies of
the data). The API is shared by every user on an instance (concurrency 80) — one heavy download can take all of them
down. Static audit: `scratchpad/memory-audit.md` (session 2026-11-13).

## Owner model (plain words)
Heavy files are prepared in the back room and appear on a **Downloads** page a few minutes later (usually 1–5 min),
like a bank statement download. Small downloads stay instant.

## Architecture
- **One implementation per report** — an `ExportKindDef` (`api/src/exports/export-kinds.ts`): `parseParams`,
  `isHeavy`, `describeParams`, `fileName`, `access` (same roles/permission as today's endpoint), and `run(ctx, params,
  out)` which pages the DB (≤ 2,000 rows, keyset) and writes rows to a streaming writer. Output identical to today's file.
- **Streaming writer** — `api/src/common/xlsx-stream.ts` (`createXlsxStreamWriter(dest)`): exceljs WorkbookWriter,
  rows committed as written, `cellSafe` on every string/header/hyperlink text, no shared strings/styles. Memory flat.
- **Two paths from the same report endpoint:**
  - light (`isHeavy` false) → stream instantly to the HTTP response (200, xlsx);
  - heavy → `ExportsService.request(user, kind, params)` → 202 `ExportQueuedResponse {exportRequestId, message}`.
- **Engine (lane A)** — `ExportRequest` table (QUEUED → RUNNING → READY / FAILED; READY files deleted after 7 days →
  EXPIRED; rows purged after 30 days); `POST/GET admin/exports`, `GET admin/exports/:id/download` (streamed from
  storage; requester only + the report's access re-checked); ≤ 3 active per user per tenant (409; an identical
  request already being prepared is returned instead of duplicated); worker = Cloud Run job `gifsy-exports(-staging)`
  (same image, 2 GiB, `--max-old-space-size=1700`), modelled on the Sales Import worker (claim `FOR UPDATE SKIP
  LOCKED`, heartbeat, stale recovery, SIGTERM), `EXPORTS_RUNNER=job|inline` (no runner → 503, never in-API building);
  self-heal kick from the list endpoint + optional scheduler drain (reuses the Sales Import drain secret).
- **Registry** — `api/src/exports/kinds/index.ts` concatenates `kinds/batch1.ts` (lane B) and `kinds/batch2.ts`
  (lane C); duplicate ids throw at start-up.
- **Screens (lane D)** — Downloads page (admin portal + Gifsy console), nav link, report buttons handle 200 (file) vs
  202 (show "We're preparing your file — it will appear under Downloads (usually 1–5 minutes)" + link), auto-refresh
  while QUEUED/RUNNING, bell "Your download is ready" if the notification helper allows.

## Reports moved (lanes B / C)
| Lane | Reports |
|---|---|
| B | Outlet Master (also fix its over-fetch: latest KYC only, no full status history, no 6-deep include), visibility capture export + visibility status report, KYC dumps/exports |
| C | Target-vs-Sales (> 3 months heavy), target/achievement exports + templates (> 3 months heavy), TDS-reports payouts export, payments report, delivery-status export, points-compute exports |

## Infra
`roles/run.jobsExecutor` for `gifsy-api-sa` on `gifsy-exports` (prod) / `gifsy-exports-staging` — granted by the deploy
workflows themselves (step "Allow the API to start the Downloads worker job", idempotent, right after the job deploy;
an IAM change — owner-approved, shipped 2026-11-15). Without it every heavy request FAILS at once with "Downloads
couldn't start on the server…" (never stuck); the API is unaffected. (Runbook below.)

## Engine reference (lane A)
Files (`api/src/exports/`): `exports.service.ts` (`respond` / `request` / list / get / download), `exports.controller.ts`
(`admin/exports`), `exports-drain.controller.ts` (`POST /v1/exports/drain`), `export-access.ts` (the RolesGuard +
PermissionGuard decision, programmatic — parity pinned by `export-access.spec.ts`), `exports-processor.service.ts`
(run one request → GCS; retention sweep), `exports-claim.ts`, `exports-runner.{config,service}.ts`,
`exports-engine.module.ts` (shared by API + job), `exports-worker.module.ts` + `worker.main.ts` (the job),
`worker-feature-modules.ts` (feature modules the job loads), `exports-engine.constants.ts`.

**Report endpoint pattern** (keep the endpoint's own `@Roles` / `@RequirePermission`; `respond` re-checks `def.access`):
```ts
@Get('outlet-master') @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') @RequirePermission('reports:export')
outletMaster(@CurrentUser() user: JwtPayload, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
  return this.exports.respond(res, user, 'outlet-master', q);
}
```
- light → 200 xlsx streamed straight to the response, inside an INSTANT-export slot (`instantExportLimiter`, 4 per
  instance, separate from the heavy-operation limiter so slow clients never block heavy routes; busy → 503 +
  Retry-After); a client abort destroys the data stream (a writer blocked on backpressure wakes up and stops); no
  progress for 2 min → aborted, slot freed. heavy → 202 `{ success, data: ExportQueuedResponse }` (an identical request
  already QUEUED/RUNNING → that request's id, message "This file is already being prepared…"). Errors: 400 params ·
  403 access · 409 three active · 503 not set up / busy / the worker couldn't be started (that request is FAILED).
- **Params are stored RAW.** `ExportRequest.params` = the caller's raw query/body + the server-set `requestOrigin`
  (JSON round-tripped). The API parses it once (validation + `isHeavy`), the worker parses the stored row once, the
  Downloads summary parses it once — `parseParams` is never run on its own output (strict DTOs refuse unknown fields).
  `kinds/round-trip.spec.ts` runs EVERY registered kind through store → reload → parse → READY; a new kind must add
  its cases there (the coverage test fails otherwise).
- `params.requestOrigin` is SERVER-set on every request; a client value is overwritten. `x-forwarded-host` is used only
  when it is the platform domain (`PLATFORM_DOMAIN`, `*.gifsy.in`) or a local dev host — otherwise the request's own
  `host`. Use it for links back to the API (Outlet Master document links).
- Worker context: `ctx.user` = the requester's snapshot (role, clientId, assumed, gifsyRoleId, vendorId), `ctx.now` =
  request time, `ctx.clientId` = tenant at request time ('gifsy' for an un-assumed owner — platform-wide reports keep
  using `tenantScope(ctx.user)`).
- A kind that resolves a service via `ctx.moduleRef` must have that service's module in `worker-feature-modules.ts`
  (`exports-engine.spec.ts` compiles the job's module, so a missing dependency fails a test, not a job run).

**Lifecycle.** QUEUED → (claim: `FOR UPDATE SKIP LOCKED`, random `claimToken`, `attempts+1`) RUNNING (heartbeat every
15 s; stale after 5 min → reclaimable) → READY (`exports/<clientId>/<id>/<claimToken>/<file>` — one object per attempt, so
a superseded worker only ever deletes its own object; `expiresAt` = +7 days) or FAILED (plain message; technical error
only in logs; > 3 attempts → FAILED; a failed storage upload stops the writer at once → FAILED promptly). SIGTERM → the
file is aborted and the request goes back to QUEUED (an early stop does not count an attempt).
**Stuck → FAILED, never "Waiting to start" forever:** the kick after a request fails (403 missing IAM grant, 404 job
missing, network) → that request is FAILED immediately ("Downloads couldn't start on the server. Please try again later
or contact Gifsy.", ERROR logged) and the caller gets 503; a self-heal kick from the list that fails → the caller's
waiting requests are FAILED the same way. A request QUEUED > 15 min doesn't count toward the 3-active cap.
**Retention sweep** — runs in the API too (Downloads list, ≤ once per 5 min per instance; drain endpoint on EVERY call,
also when work is waiting) besides every job drain: READY past `expiresAt` → file deleted, EXPIRED; QUEUED > 24 h →
FAILED ("couldn't be started"); EXPIRED/FAILED rows > 30 days deleted.
**Download / get: the REQUESTER only**, in the tenant it was requested in (anyone else → 404, never revealing it exists —
e.g. an un-assumed owner's all-tenant file is invisible to other 'gifsy' users), plus the kind's access re-checked now
(revoked → 403); 409 not ready, 410 expired; streamed from GCS (`openReadStream`), never buffered; a storage stream that
breaks mid-file destroys the response (the browser reports a failed download, never a truncated "complete" file).

**Runner.** `EXPORTS_RUNNER=job` + `EXPORTS_JOB` + `GCP_PROJECT` (staging/prod, set in the deploy workflows) → the API
calls `jobs/<EXPORTS_JOB>:run` after each request. `EXPORTS_RUNNER=inline` → in-process (LOCAL DEV / TESTS ONLY — it
builds the file inside the API). Unset → heavy requests answer 503 "Downloads aren't set up on this server yet"; light
requests still stream. Self-heal: `GET admin/exports` kicks the job (≤ once a minute per instance) when one of the
caller's requests waited > 2 min (QUEUED) or has a stale heartbeat.

## Runbook (owner)
**Job** — created by the deploy workflows (`Deploy Downloads worker job`), same image as the API, 2 GiB,
`--max-old-space-size=1700`, task timeout 1 h, 1 retry, VPC + Cloud SQL + `gifsy-api-sa`, secrets DATABASE_URL /
GCS_BUCKET / GCP_PROJECT_ID / JWT_SECRET (all existing — nothing added to the prod PREFLIGHT list).

**IAM — done by the deploy workflows** (an IAM change; owner-approved, live since 2026-11-15), in the step right after the
job deploy (idempotent; the deployer holds roles/run.admin; mirrors the grant on gifsy-sales-import):
```
gcloud run jobs add-iam-policy-binding gifsy-exports-staging --region=asia-south1 \
  --member=serviceAccount:gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com --role=roles/run.jobsExecutor --quiet
gcloud run jobs add-iam-policy-binding gifsy-exports --region=asia-south1 \
  --member=serviceAccount:gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com --role=roles/run.jobsExecutor --quiet
```
Without it the API's kick gets HTTP 403 (ERROR "Exports kick: jobs:run HTTP 403 — the Downloads worker could not be
started"): each heavy request is FAILED immediately with "Downloads couldn't start on the server. Please try again later
or contact Gifsy." (the user sees a 503 with that message); nothing else is affected.

**Scheduler (OPTIONAL — the Downloads list already self-heals):** a Cloud Scheduler job every 10 min →
`POST https://<api host>/v1/exports/drain` with header `x-drain-secret: <the SALES_IMPORT_DRAIN_SECRET value>`
(or set a dedicated `EXPORTS_DRAIN_SECRET` env — optional, never required). It recovers a request whose worker died
while nobody has the Downloads page open, and runs the retention sweep on every call (the sweep also runs at the end of
every job run and from the Downloads list).

**Verify after deploy:** request a heavy report → Downloads shows it QUEUED → RUNNING → READY within minutes →
download opens in Excel; `gcloud run jobs executions list --job=gifsy-exports(-staging)` shows a succeeded execution;
API memory flat during the build.

**Add a new kind:** implement `ExportKindDef` in a lane file (`kinds/batch1.ts` / `batch2.ts`, or a new list added to
`kinds/index.ts`), same `access` as the endpoint, `run` paged ≤ 2,000 rows; add any module its services need to
`worker-feature-modules.ts`; switch the endpoint to `exports.respond(...)`; add a row-parity spec vs the old file; add
its realistic raw params (incl. the screen's default) to `kinds/round-trip.spec.ts`. A route guard that records an
artefact on 2xx must skip 202 (queued) — the kind records it when the file is built (see `SalesMonthClosedGuard`).
Paged reads that must be consistent across pages (totals) read inside ONE REPEATABLE READ transaction (payments report).

## Build lanes (2026-11-13)
A engine · B reports batch 1 · C reports batch 2 · D screens — in parallel against this contract; lead integrates, runs
full gates, dual audit + UI/UX lane, staging verification (row-for-row file parity vs today's downloads; parallel heavy
downloads with flat API memory).
