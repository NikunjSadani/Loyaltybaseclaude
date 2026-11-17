/**
 * Downloads page (background exports) — the SHARED API CONTRACT (backend side).
 * Frontend mirror: platform/src/lib/exports/types.ts — keep the two files IDENTICAL in shape below the header.
 * Design: platform/docs/plans/DOWNLOADS-PAGE.md (owner-approved 2026-11-13, ⚠️ platform-wide).
 *
 * One report implementation (an ExportKindDef, api/src/exports/export-kinds.ts) serves BOTH paths:
 *  - light request  → the existing report endpoint streams the file instantly (200, an xlsx body);
 *  - heavy request  → the existing report endpoint answers 202 with ExportQueuedResponse; a background worker
 *                     (Cloud Run job, own memory) builds the file; it appears on the Downloads page.
 */

export const EXPORT_RETENTION_DAYS = 7;
/** QUEUED + RUNNING requests one user may have at once (409 beyond). */
export const EXPORT_MAX_ACTIVE_PER_USER = 3;

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';

/** One row on the Downloads page. Dates are ISO strings. */
export interface ExportRequestDto {
  id: string;
  kind: string;
  /** Report name for people, e.g. "Outlet master". */
  label: string;
  /** Plain-English summary of the filters, e.g. "Nov 2025 – Oct 2026 · all outlets". */
  paramsSummary: string;
  status: ExportStatus;
  fileName: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  /** FAILED: a plain-English reason. */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** READY files are deleted after this. */
  expiresAt: string | null;
}

/** POST admin/exports body (generic request; report endpoints may also queue on their own). */
export interface CreateExportRequest {
  kind: string;
  params: Record<string, unknown>;
}

/**
 * 202 body — returned by POST admin/exports AND by any report endpoint that decided the request is heavy.
 * The screens show `message` and link to the Downloads page.
 */
export interface ExportQueuedResponse {
  exportRequestId: string;
  message: string;
}

/** GET admin/exports?cursor= — the caller's own requests in their (assumed) tenant, newest first. */
export interface ExportList {
  items: ExportRequestDto[];
  nextCursor: string | null;
}
