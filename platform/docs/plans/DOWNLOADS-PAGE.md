# Downloads page (background exports) — design

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
  storage; same access check as the report); ≤ 3 active per user (409); worker = Cloud Run job `gifsy-exports(-staging)`
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

## Infra (owner, once per environment, after the first deploy that creates the job)
Grant `roles/run.jobsExecutor` to `gifsy-api-sa` on `gifsy-exports` (prod) / `gifsy-exports-staging`. Without it requests
stay "Waiting to start"; the API is unaffected. (Lane A's runbook section has the exact command.)

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
- light → 200 xlsx streamed straight to the response, inside a heavy-operation slot (`common/heavy-op-limiter.ts`;
  busy → 503 + Retry-After); a client abort stops the run at its next row. heavy → 202 `{ success, data:
  ExportQueuedResponse }`. Errors: 400 params · 403 access · 409 three active · 503 not set up / busy.
- `params.requestOrigin` is SERVER-set on every request (x-forwarded-proto/host → host); a client value is overwritten.
  Use it for links back to the API (Outlet Master document links).
- Worker context: `ctx.user` = the requester's snapshot (role, clientId, assumed, gifsyRoleId, vendorId), `ctx.now` =
  request time, `ctx.clientId` = tenant at request time ('gifsy' for an un-assumed owner — platform-wide reports keep
  using `tenantScope(ctx.user)`).
- A kind that resolves a service via `ctx.moduleRef` must have that service's module in `worker-feature-modules.ts`
  (`exports-engine.spec.ts` compiles the job's module, so a missing dependency fails a test, not a job run).

**Lifecycle.** QUEUED → (claim: `FOR UPDATE SKIP LOCKED`, random `claimToken`, `attempts+1`) RUNNING (heartbeat every
15 s; stale after 5 min → reclaimable) → READY (`exports/<clientId>/<id>/<file>`, `expiresAt` = +7 days) or FAILED (plain
message; technical error only in logs; > 3 attempts → FAILED). SIGTERM → the file is aborted and the request goes back
to QUEUED (an early stop does not count an attempt). Retention sweep (every job drain + idle scheduler drain): READY past
`expiresAt` → file deleted, EXPIRED; QUEUED > 24 h → FAILED ("couldn't be started"); EXPIRED/FAILED rows > 30 days
deleted. Download: same tenant (else 404) + the kind's access re-checked now (owner or any same-tenant user with that
access); 409 not ready, 410 expired; streamed from GCS (`openReadStream`), never buffered.

**Runner.** `EXPORTS_RUNNER=job` + `EXPORTS_JOB` + `GCP_PROJECT` (staging/prod, set in the deploy workflows) → the API
calls `jobs/<EXPORTS_JOB>:run` after each request. `EXPORTS_RUNNER=inline` → in-process (LOCAL DEV / TESTS ONLY — it
builds the file inside the API). Unset → heavy requests answer 503 "Downloads aren't set up on this server yet"; light
requests still stream. Self-heal: `GET admin/exports` kicks the job (≤ once a minute per instance) when one of the
caller's requests waited > 2 min (QUEUED) or has a stale heartbeat.

## Runbook (owner)
**Job** — created by the deploy workflows (`Deploy Downloads worker job`), same image as the API, 2 GiB,
`--max-old-space-size=1700`, task timeout 1 h, 1 retry, VPC + Cloud SQL + `gifsy-api-sa`, secrets DATABASE_URL /
GCS_BUCKET / GCP_PROJECT_ID / JWT_SECRET (all existing — nothing added to the prod PREFLIGHT list).

**IAM (once per environment, after the first deploy creates the job):**
```
gcloud run jobs add-iam-policy-binding gifsy-exports-staging --region=asia-south1 \
  --member=serviceAccount:gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com --role=roles/run.jobsExecutor
gcloud run jobs add-iam-policy-binding gifsy-exports --region=asia-south1 \
  --member=serviceAccount:gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com --role=roles/run.jobsExecutor
```
Without it the API's kick gets HTTP 403 (logged "Exports kick: jobs:run HTTP 403"); requests stay "Waiting to start"
and fail after 24 h; nothing else is affected.

**Scheduler (OPTIONAL — the Downloads list already self-heals):** a Cloud Scheduler job every 10 min →
`POST https://<api host>/v1/exports/drain` with header `x-drain-secret: <the SALES_IMPORT_DRAIN_SECRET value>`
(or set a dedicated `EXPORTS_DRAIN_SECRET` env — optional, never required). It recovers a request whose worker died
while nobody has the Downloads page open, and runs the retention sweep when idle (otherwise the sweep runs at the end of
every job run).

**Verify after deploy:** request a heavy report → Downloads shows it QUEUED → RUNNING → READY within minutes →
download opens in Excel; `gcloud run jobs executions list --job=gifsy-exports(-staging)` shows a succeeded execution;
API memory flat during the build.

**Add a new kind:** implement `ExportKindDef` in a lane file (`kinds/batch1.ts` / `batch2.ts`, or a new list added to
`kinds/index.ts`), same `access` as the endpoint, `run` paged ≤ 2,000 rows; add any module its services need to
`worker-feature-modules.ts`; switch the endpoint to `exports.respond(...)`; add a row-parity spec vs the old file.

## Build lanes (2026-11-13)
A engine · B reports batch 1 · C reports batch 2 · D screens — in parallel against this contract; lead integrates, runs
full gates, dual audit + UI/UX lane, staging verification (row-for-row file parity vs today's downloads; parallel heavy
downloads with flat API memory).
