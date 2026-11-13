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

## Build lanes (2026-11-13)
A engine · B reports batch 1 · C reports batch 2 · D screens — in parallel against this contract; lead integrates, runs
full gates, dual audit + UI/UX lane, staging verification (row-for-row file parity vs today's downloads; parallel heavy
downloads with flat API memory).
