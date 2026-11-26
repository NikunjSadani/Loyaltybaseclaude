/**
 * Sales Import — the SHARED API CONTRACT (frontend mirror).
 *
 * Source: platform/docs/plans/SALES-IMPORT-PIPELINE-PLAN.md §5 (+ §6.2a for the KPI tester). The
 * backend original is api/src/sales-import/sales-import.contract.ts — keep the two files IDENTICAL in shape
 * (they live in separate packages, so nothing is imported across). Deviations from the plan text are
 * listed in the plan's "Phase-0 deviations" note (§10a).
 *
 * Conventions:
 *   - Every money/quantity number crossing the wire is a plain JS number in RUPEES / CASES
 *     (2 dp / 3 dp). BigInt paise / pico-cases (×1e12) stay inside the backend (DB + accumulators).
 *   - Dates are ISO strings; months are 'YYYY-MM' (IST calendar month).
 *   - All routes live under backend `/v1` (FE calls `/api/...`), envelope = ApiResponse<T>.
 */

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Browser upload part size (D-2 A). The last part may be shorter. */
export const SALES_IMPORT_PART_SIZE = 4 * 1024 * 1024; // 4194304
/** Hard ceiling on a declared upload size. */
export const SALES_IMPORT_MAX_FILE_BYTES = 600 * 1024 * 1024;
/** Multer per-part limit (a part + multipart slack). */
export const SALES_IMPORT_PART_LIMIT_BYTES = SALES_IMPORT_PART_SIZE + 64 * 1024;
export const SALES_IMPORT_ALLOWED_EXTENSIONS = ['.xlsx', '.csv'] as const;
/** SalesUploadBatch.status written by an apply (the column is a free String). */
export const SALES_IMPORT_BATCH_STATUS = 'SALES_IMPORT';
/** Max dimensions in a column mapping. */
export const SALES_IMPORT_MAX_DIMENSIONS = 6;
/** Dimension key shape (used as a JSON key in filters and aggregates). */
export const SALES_IMPORT_DIM_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,23}$/;
/** Max entries per anyOf / noneOf list (§6.2a). */
export const SALES_KPI_MAX_FILTER_ENTRIES = 200;
/** Caps for the worker's frozen side outputs. */
export const SALES_IMPORT_MAX_ERROR_SAMPLES = 200;
export const SALES_IMPORT_MAX_DIMENSION_VALUES = 200;
export const SALES_IMPORT_MAX_DIMENSION_COMBOS = 2000;
/** A PROCESSING import whose heartbeat is older than this is reclaimable (§7.1.1). */
export const SALES_IMPORT_STALE_HEARTBEAT_MINUTES = 10;
/** attempts > this → FAILED (§7.1.1). */
export const SALES_IMPORT_MAX_ATTEMPTS = 3;
/** Max UPLOADING imports per tenant at once (POST uploads → 409 beyond it). */
export const SALES_IMPORT_MAX_INFLIGHT_UPLOADS = 3;
/**
 * Retention (api/src/sales-import/retention-window.ts reads these; the switch SALES_RETENTION_V2 picks the regime and is
 * OFF by default, so a deploy changes no retention):
 * Raw parts, unmatched.csv, aggregates and sample rows are purged this long after an import finishes — switch OFF.
 */
export const SALES_IMPORT_RETENTION_DAYS = 30;
/** The same with SALES_RETENTION_V2=on (owner 2026-11-18), and what the one-off trim applies explicitly. */
export const SALES_IMPORT_RETENTION_DAYS_V2 = 7;
/** SalesMonthHistory (+ its product-list summary and set headers) is kept this long — switch OFF. */
export const SALES_MONTH_HISTORY_RETENTION_YEARS = 10;
/**
 * The new month window (owner 2026-11-18): the current IST month + the 3 before it. Month history follows it with
 * SALES_RETENTION_V2=on (and the one-off trim applies it explicitly); the day-level data (OutletSalesDay + SalesDaySet)
 * ALWAYS follows it. Default of the API setting SALES_HISTORY_RETENTION_MONTHS.
 */
export const SALES_MONTH_HISTORY_RETENTION_MONTHS = 4;
/** An UPLOADING import older than this is abandoned: CANCELLED + purged. */
export const SALES_IMPORT_ABANDONED_UPLOAD_HOURS = 24;
/** Header detection reads at most this many columns per row (wider rows are truncated). */
export const SALES_IMPORT_MAX_COLUMNS = 300;
/** detectedHeaders = the header row + at most this many sample rows, each cell ≤ SALES_IMPORT_SAMPLE_CELL_CHARS. */
export const SALES_IMPORT_SAMPLE_ROWS = 3;
export const SALES_IMPORT_SAMPLE_CELL_CHARS = 50;
/** A file with more distinct customer codes than this fails with a readable message. */
export const SALES_IMPORT_MAX_DISTINCT_CODES = 600_000; // memory budget: plan §7.1 step 11
/** A dimension value longer than this is skipped at ingest (row counted as skipped) so stored keys stay bounded. */
export const SALES_IMPORT_MAX_DIM_VALUE_CHARS = 200;
/** QUANTITY KPI values (and every cases number on the wire) are rounded to this many decimals. */
export const SALES_KPI_QUANTITY_DECIMALS = 3;

// ─── Status / enums ─────────────────────────────────────────────────────────────

export const SALES_IMPORT_STATUSES = [
  'UPLOADING', 'QUEUED', 'PROCESSING', 'NEEDS_MAPPING', 'READY', 'FAILED', 'CANCELLED',
] as const;
export type SalesImportStatus = (typeof SALES_IMPORT_STATUSES)[number];

export type SalesImportFileKind = 'XLSX' | 'CSV';
export type SalesMonthState = 'OPEN' | 'CLOSED';

// ─── Column mapping (SalesImportProfile.columnMapping) ──────────────────────────

export interface SalesDimensionMapping {
  key: string;    // SALES_IMPORT_DIM_KEY_PATTERN; unique within the mapping
  label: string;  // display label ("Brand")
  header: string; // header text in the file (matched after normalizeHeader)
}

export interface SalesColumnMapping {
  sheetName?: string | null;   // xlsx only; null → first sheet
  headerRow: 'auto' | number;  // 'auto' = first row in rows 1..10 containing ALL mapped headers; number = 1-based
  outletCode: string;          // header text (matched after normalizeHeader)
  outletName?: string | null;
  invoiceDate: string;
  amount?: string | null;      // at least one of amount/quantity
  quantity?: string | null;
  dimensions: SalesDimensionMapping[]; // ≤ SALES_IMPORT_MAX_DIMENSIONS
  dateOrder: 'DMY' | 'MDY' | 'YMD';    // for TEXT dates only (real date cells are unambiguous)
  /**
   * Decimal separator of TEXT amount/quantity cells (numeric xlsx cells are unaffected). Absent = 'auto':
   * ',' when the CSV delimiter is ';' (European export: "1.234,56"), else '.'. With ',', '.' and spaces are
   * thousands separators.
   */
  decimalSeparator?: 'auto' | '.' | ',';
}

// ─── KPI definitions (SalesKpiDefinition) ───────────────────────────────────────

/**
 * AMOUNT = Σ ₹ (net amount) · QUANTITY = Σ cases · PRODUCT_COUNT ("LINES", owner 2026-11-13) = number of DISTINCT
 * products (combination of the dimension columns) the outlet bought in the month whose NET amount is > 0 (an integer).
 */
export type SalesKpiMeasure = 'AMOUNT' | 'QUANTITY' | 'PRODUCT_COUNT';
/** Every listed dim must equal (normalized). Keys ⊆ the profile's dimension keys. */
export type DimMatch = Record<string, string>;
/** `{}` = all lines. A line is IN iff (anyOf empty OR it matches ≥1 anyOf entry) AND it matches no noneOf entry. */
export interface SalesKpiFilter {
  anyOf?: DimMatch[];
  noneOf?: DimMatch[];
}

export interface SalesKpiDefinitionDto {
  id?: string;
  kpiCode: string;
  measure: SalesKpiMeasure;
  filter: SalesKpiFilter;
  /** Absent = 'FILTER'. TARGET_NAMES -> `filter` must be {} (see SalesKpiProductSource). */
  productSource?: SalesKpiProductSource;
  /**
   * FOCUS-NAMES-FROM-KPI (2026-11-25): only with TARGET_NAMES — read the per-outlet focus names written for THIS other
   * KPI code (an enabled TARGET_NAMES definition that does not borrow itself), so e.g. FB1 CASES (QUANTITY) counts
   * exactly the products of FOCUS BRAND (AMOUNT). Absent / null = the definition's own kpiCode (original behaviour).
   */
  focusNamesFromKpi?: string | null;
  outletTypes: string[];
  programs: string[];
  enabled: boolean;
  order: number;
}

/** PATCH admin/sales-import/kpis/:id body. */
export type SalesKpiDefinitionPatch = Partial<Omit<SalesKpiDefinitionDto, 'id'>>;

/** GET admin/sales-import/kpis response. */
export interface SalesKpiDefinitionList {
  definitions: SalesKpiDefinitionDto[];
  definitionsHash: string;
}

/** POST admin/sales-import/kpis/test body (§6.2a). `importId: 'latest'` = latest READY import. */
export interface SalesKpiTestRequest {
  importId: string;
  definition: SalesKpiDefinitionDto;
}

/** POST admin/sales-import/kpis/test response (§6.2a). Indexes point into the request's anyOf/noneOf. */
export interface SalesKpiTestResult {
  /** `totalProducts` (Σ per-outlet product counts) is present only when the draft's measure is PRODUCT_COUNT. */
  months: Array<{ month: string; totalAmountRupees: number; totalQuantity: number; totalProducts?: number; outletsNonZero: number }>;
  unmatchedEntries: { anyOf: number[]; noneOf: number[] };
  redundantEntries: { anyOf: number[] };
  matchedLines: number;
  /**
   * Roster-only imports (2026-11-23): outlets on the roster NOW that were not on it when the tested import was processed —
   * any sales they have in that file are not in these totals. Absent for legacy imports.
   */
  outletsNotIncluded?: number;
}

/**
 * GET admin/sales-import/segment-options: the tenant's DISTINCT outlet-type codes (+ display name), programme names and
 * sub-programme names (Outlet.programCategory) among non-deleted outlets, all sorted. Feeds the KPI editor's
 * outlet-type / programme scope multi-selects (sub-programmes: APPLIES-TO scope hints).
 */
export interface SalesSegmentOptions {
  outletTypes: Array<{ code: string; name: string }>;
  programs: string[];
  subPrograms: string[];
}

// ─── Imports ────────────────────────────────────────────────────────────────────

/**
 * Import lifecycle routes (all return SalesImportSummary):
 *   POST   :id/reprocess  READY | NEEDS_MAPPING | FAILED | stalled PROCESSING → QUEUED. 409 once applied / purged /
 *                         while an apply is running.
 *   POST   :id/cancel     QUEUED | stalled PROCESSING → CANCELLED (the worker notices and stops). 409 otherwise.
 *   POST   :id/reprocess-as-new  (canReprocessAsNew) → the NEW import's summary (QUEUED; same file, new id,
 *                         `reprocessedFromId` = this import). 409 when not applied / mapping unchanged / purged.
 *   DELETE :id            never-applied import → CANCELLED + files/aggregates purged. 409 once applied / live PROCESSING.
 * POST uploads → 409 when SALES_IMPORT_MAX_INFLIGHT_UPLOADS imports are already UPLOADING.
 */

/** POST admin/sales-import/uploads body. */
export interface CreateSalesImportUploadRequest {
  filename: string;  // must end .xlsx / .csv
  sizeBytes: number; // 1 .. SALES_IMPORT_MAX_FILE_BYTES
}
/** POST admin/sales-import/uploads response. */
export interface CreateSalesImportUploadResult {
  importId: string;
  partSize: number; // SALES_IMPORT_PART_SIZE
  partCount: number;
}
/** POST admin/sales-import/:id/parts/:n response. */
export interface SalesImportPartResult {
  partsReceived: number;
}

export interface SalesImportSummary {
  id: string;
  status: SalesImportStatus;
  originalFilename: string;
  fileKind: SalesImportFileKind;
  sizeBytes: number;
  partCount: number;
  partsReceived: number;
  bytesRead: number;
  rowsRead: number;
  rowsSkipped: number;
  progressPct: number | null;        // bytesRead / sizeBytes while PROCESSING
  duplicateOfId: string | null;
  error: string | null;
  /**
   * [headerRow, ...≤ SALES_IMPORT_SAMPLE_ROWS sample rows] (≤ SALES_IMPORT_MAX_COLUMNS cells, each
   * ≤ SALES_IMPORT_SAMPLE_CELL_CHARS chars). For NEEDS_MAPPING the header row is the best guess. Only
   * GET :id fills it (the LIST always returns null); the sample rows are returned only to callers holding
   * targets:upload (others get just [headerRow]); null once the import is purged.
   */
  detectedHeaders: string[][] | null;
  createdAt: string;
  finishedAt: string | null;
  uploadedBy: string;                 // display name
  /** Server time the import last entered QUEUED (complete / reprocess); null before. For "waiting > 2 min". */
  queuedAt: string | null;
  heartbeatAt: string | null;
  /** Set on an import created by POST :id/reprocess-as-new: the applied import whose stored file it re-reads. */
  reprocessedFromId: string | null;
  /** PROCESSING with a heartbeat older than SALES_IMPORT_STALE_HEARTBEAT_MINUTES (worker died): can be cancelled/reprocessed. */
  stalled: boolean;
  /** At least one month was applied from this import: it can no longer be reprocessed, cancelled or deleted. */
  applied: boolean;
  /** Raw file + aggregates purged (retention); preview/apply/reprocess/unmatched.csv are no longer possible. */
  purgedAt: string | null;
  canReprocess: boolean; // READY / NEEDS_MAPPING / FAILED, or stalled PROCESSING; never applied; not purged
  /**
   * An APPLIED import whose column mapping has changed since it was processed (so it can no longer be applied and
   * cannot be reprocessed in place): POST :id/reprocess-as-new creates a NEW import from the same stored file and
   * queues it; this import stays as the record of what was written. Never true once purged.
   */
  canReprocessAsNew: boolean;
  canCancel: boolean;    // QUEUED, or stalled PROCESSING (POST :id/cancel); never for an applied import
  canDelete: boolean;    // never applied and not live PROCESSING (DELETE = cancel + purge files/aggregates)
}

/** GET admin/sales-import list response. */
export interface SalesImportList {
  items: SalesImportSummary[];
  nextCursor: string | null;
}

export interface SalesImportErrorSample {
  row: number;            // 1-based sheet row number
  column: string | null;  // mapped header (or null for a whole-row issue)
  reason: string;
}

export interface MonthSummary { // computed by the worker, frozen on the import
  month: string;
  firstDate: string; // YYYY-MM-DD
  lastDate: string;  // YYYY-MM-DD
  lines: number;
  matchedOutlets: number;
  unmatchedCustomers: number;
  matchedAmountRupees: number;
  matchedQuantity: number;
  unmatchedAmountRupees: number;
  unmatchedQuantity: number;
}

/** GET admin/sales-import/:id response. */
export interface SalesImportDetail extends SalesImportSummary {
  monthSummaries: MonthSummary[] | null;
  errorSamples: SalesImportErrorSample[] | null;
}

/** Frozen on the import (SalesImport.dimensionValues); per dim key, top SALES_IMPORT_MAX_DIMENSION_VALUES by |₹|. */
export type SalesDimensionValues = Record<string, Array<{ value: string; lines: number; amountRupees: number }>>;
/** Frozen on the import (SalesImport.dimensionCombos); every distinct full combo, ≤ SALES_IMPORT_MAX_DIMENSION_COMBOS by |₹|. */
export interface SalesDimensionCombo {
  dims: DimMatch;
  lines: number;
  amountRupees: number;
  quantity: number;
}
/** GET admin/sales-import/:id/combos (`:id` may be `latest`). */
export interface SalesImportCombos {
  importId: string;
  dimensionValues: SalesDimensionValues;
  dimensionCombos: SalesDimensionCombo[];
}
/** Most months "last N stored months" may cover in GET admin/sales-import/history-combos. */
export const SALES_HISTORY_COMBOS_MAX_MONTHS = 12;
/**
 * GET admin/sales-import/history-combos (targets:read) — the KPI product picker's "Stored month(s)" source.
 * Query: `month=YYYY-MM` (one stored month) OR `lastMonths=N` (the N most recent months WITH stored history,
 * 1..SALES_HISTORY_COMBOS_MAX_MONTHS; the default is 1). Never both.
 * Combos / values are aggregated in SQL from SalesMonthHistory (the final applied lines of each month, programme
 * outlets only — since 2026-11-18), in the same shape as SalesImportCombos and capped the same way (top SALES_IMPORT_MAX_DIMENSION_COMBOS combos
 * and SALES_IMPORT_MAX_DIMENSION_VALUES values per key, by |₹|). A combo's `dims` carry the keys its month's lines were
 * read with (SalesMonthHistorySet.dimensionKeys). 404 when `month` has no stored history; a tenant with no history at
 * all gets `months: []` and empty lists.
 */
export interface SalesHistoryCombos {
  /** The stored months these combos cover, ascending. */
  months: string[];
  /** Every month with stored history for this tenant, newest first (for the month picker). */
  availableMonths: string[];
  /** Product-column keys the covered months' lines were read with (union, sorted). */
  dimensionKeys: string[];
  /** The covered months were read with DIFFERENT product columns (combos from them may pin different keys). */
  dimensionKeysDiffer: boolean;
  dimensionValues: SalesDimensionValues;
  dimensionCombos: SalesDimensionCombo[];
  /** Distinct combos in the covered months; more than dimensionCombos.length = the list is capped. */
  totalCombos: number;
  /**
   * Covered months whose product list cannot be shown: their stored product list is missing or out of date (only if an
   * older revision applied the month while this feature was being deployed) and their stored lines are too many to read
   * directly. They contribute NO combos. The FE says: "The product list for <month> isn't available — open Months and
   * choose 'Rebuild product list' (it doesn't change any figures)." (POST admin/sales-months/:month/rebuild-product-list).
   * Empty when every covered month is included.
   */
  unavailableMonths: string[];
}

// ─── Preview / apply ────────────────────────────────────────────────────────────

/**
 * OLDER_THAN_LAST_APPLIED = this file's latest invoice date in the month (MonthPreview.lastDate) is EARLIER than
 * the latest invoice date of the import last applied to the month (MonthPreview.lastApplied.lastInvoiceDate).
 * (ROSTER_CHANGED was removed: apply maps the file's customer codes to the roster CURRENT at apply time.)
 * MAPPING_CHANGED (recalculate preview only): the column mapping changed since this month's stored lines were applied;
 * every dimension the current KPIs use still exists in them, so recalculating is possible but reads the lines as they
 * were parsed then. (A KPI using a dimension the stored lines lack BLOCKS the recalculation instead.)
 */
export type SalesMonthWarning =
  | 'STARTS_AFTER_FIRST'
  | 'ENDS_BEFORE_MONTH_END'
  | 'OLDER_THAN_LAST_APPLIED'
  | 'REPLACES_MANUAL_VALUES'
  | 'NEGATIVE_VALUES'
  | 'MAPPING_CHANGED';

export interface MonthPreviewKpi {
  kpiCode: string;
  label: string;
  measure: SalesKpiMeasure;
  newTotal: number;
  currentTotal: number;
  delta: number;
  outletsNonZero: number;
  outletsNegative: number;
  /** FOCUS-NAMES-FROM-KPI: the KPI is NOT calculated this month (see MonthReconciliation.notCalculated) — `newTotal` is not a 0. */
  notCalculated?: true;
}

/**
 * Live, per GET. The matched/unmatched figures inherited from MonthSummary (matchedOutlets, matchedAmountRupees,
 * matchedQuantity, unmatchedCustomers, unmatchedAmountRupees, unmatchedQuantity) are RECOMPUTED against the roster
 * current at preview time (apply uses the roster current at apply time). firstDate/lastDate/lines are the file's.
 * Roster-only imports: an outlet added after processing stays in the unmatched figures (its sales are not applied).
 */
export interface MonthPreview extends MonthSummary {
  monthState: SalesMonthState;
  canApply: boolean;
  blockedReason?: string;
  warnings: SalesMonthWarning[];
  zeroFillOutlets: number; // programme outlets with no lines → 0
  kpis: MonthPreviewKpi[];
  /** lastInvoiceDate = that import's latest invoice date in this month (compare with this file's lastDate). */
  lastApplied: { importId: string; at: string; byName: string; lastInvoiceDate: string | null } | null;
  /** Targets, focus products, blockers and gaps for this month: the one place to check before applying. */
  reconciliation: MonthReconciliation;
  /** An Apply / Recalculate of this month queued or running now (by anyone): the month cannot be applied until it ends. */
  activeJob: SalesMonthActiveJob | null;
  /** The month's latest finished Apply / Recalculate (any import), or null. */
  lastJob: SalesMonthLastJob | null;
}

export interface SalesImportPreview {
  importId: string;
  definitionsHash: string;
  /** Send back as ApplyRequest.processingVersion; changes whenever the import is (re)processed. */
  processingVersion: number;
  /** The column mapping changed since this file was processed: every month is blocked until it is reprocessed. */
  mappingChanged: boolean;
  /**
   * Informational, LEGACY imports only (processed before roster-only aggregates, 2026-11-23): live roster outlets created
   * after this file was processed — they ARE included there. Always 0 for a roster-only import (see below).
   */
  rosterOutletsAddedSinceProcessing: number;
  /**
   * Roster-only imports (2026-11-23): outlets on the roster NOW that were NOT on it when this file was processed. The
   * file kept no product lines for them, so their sales in this file are NOT included (preview and apply give them 0).
   * The page must say so loudly; Reprocess (or the next file) includes them. 0 for legacy imports.
   */
  rosterOutletsNotIncluded: number;
  months: MonthPreview[];
}

export interface ApplyRequest {
  months: string[];                          // each must be OPEN + present in the file
  expectedDefinitionsHash: string;           // TOCTOU guard (409 on mismatch)
  /** SalesImportPreview.processingVersion the admin reviewed (409 when the import was reprocessed since). */
  processingVersion: number;
  acknowledgePartialMonths?: string[];       // required for months with STARTS_AFTER_FIRST/ENDS_BEFORE_MONTH_END
  acknowledgeOlderThanLastApplied?: boolean; // required if any month has OLDER_THAN_LAST_APPLIED (re-checked under the month lock)
  /** month -> MonthReconciliation.focusFingerprint reviewed; required for every month whose fingerprint is non-empty (409 on mismatch). */
  expectedFocusFingerprints?: Record<string, string>;
  /**
   * FOCUS-NAMES-FROM-KPI (owner 2026-11-25): months whose reconciliation lists `notCalculated` KPIs (no focus names in
   * the month's target file → those KPIs are left EMPTY). Required for every such month (400 / refused under the lock
   * otherwise); recorded on the month's apply audit row.
   */
  acknowledgeNotCalculatedMonths?: string[];
  /**
   * A random id the page makes per click (background jobs, 2026-11-18): resending the same request (no reply arrived)
   * returns the SAME job instead of queueing a second one. GET admin/sales-import/apply-jobs?requestId= finds it.
   */
  requestId?: string;
}
/**
 * Day-level data written with a month (OutletSalesDay / SalesDaySet; sales-day-level 2026-11-18). `written: false` =
 * the month's previous day data was REMOVED and the month has no day data now — `reason` says why (e.g. the file was
 * processed before day-level storage → reprocess it; the stored history has no day split). Never silent.
 */
export interface SalesDayDataResult {
  written: boolean;
  outlets: number;      // programme outlets with at least one day row
  rows: number;         // OutletSalesDay rows written
  lastDay: number | null; // SalesDaySet.lastDay (last invoice day in the applied file for the month)
  reason?: string;
}
export interface ApplyMonthResult {
  month: string;
  ok: boolean;
  applyId?: string;
  outletsWritten?: number;
  outletsZeroFilled?: number;
  error?: string;
  /** Present on ok:true (tenants with features.salesImport only). */
  dayData?: SalesDayDataResult;
  /**
   * APPLY of a roster-only import (ok:true): outlets on the roster at apply time that were NOT on it when the file was
   * processed — their sales in this file were NOT included (written as 0). Absent for legacy imports and recalculate.
   */
  outletsNotIncluded?: number;
}
export interface ApplyResult {
  results: ApplyMonthResult[];
}

// ─── Background apply / recalculate jobs (owner 2026-11-18) ────────────────────────
// Apply and Recalculate no longer run inside the HTTP request (files reach 300–350 MB; one month takes 30–90 s; the
// Cloudflare Worker cuts tenant-host requests at ~100 s). The POST checks what it can (every 4xx as before), records a
// job and returns 202; the sales-import worker (Cloud Run Job gifsy-sales-import, full CPU) runs it one month per
// transaction, marking the month DONE inside that same transaction. At most ONE active (QUEUED / RUNNING) job per
// tenant × month (DB partial unique index): a second Apply / Recalculate for that month → 409.

export type SalesApplyJobKind = 'APPLY' | 'RECALC';
export type SalesApplyJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

/** A queued / running job is reclaimed by another worker run when its heartbeat is older than this. */
export const SALES_APPLY_STALE_HEARTBEAT_MINUTES = 10;
/** A job claimed this many times without finishing → its remaining months FAILED. */
export const SALES_APPLY_MAX_ATTEMPTS = 3;

export interface SalesApplyJobMonthDto {
  month: string;
  status: SalesApplyJobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** DONE / FAILED: what happened (same shape as the old synchronous apply result). */
  result: ApplyMonthResult | null;
  /** The last retryable error of this month (a temporary DB problem); the job retried it. */
  lastError: string | null;
}
export interface SalesApplyJobDto {
  id: string;
  kind: SalesApplyJobKind;
  importId: string | null;
  requestId: string;
  /** QUEUED (waiting for the worker) → RUNNING → DONE (every month finished: applied or failed) / FAILED (refused whole). */
  status: SalesApplyJobStatus;
  requestedBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** A whole-job refusal found by the worker before any write (e.g. focus products changed since the preview). */
  error: string | null;
  /** Worker runs that took this job (a stop does not count). >0 while QUEUED = handed back, waiting to continue. */
  attempts: number;
  months: SalesApplyJobMonthDto[];
}
/** The active (QUEUED / RUNNING) job on a month, shown on the preview and the Months list. */
export interface SalesMonthActiveJob {
  jobId: string;
  kind: SalesApplyJobKind;
  status: 'QUEUED' | 'RUNNING';
  importId: string | null;
  requestedBy: string;
  createdAt: string;
}
/**
 * POST admin/sales-import/:id/apply and POST admin/sales-months/:month/recalculate → 202 with the job. `results` keeps
 * the old response shape for a page loaded before this release: one not-ok entry per month saying it runs in the
 * background (an old page then shows that text instead of crashing). New pages follow `job`.
 */
export interface ApplyEnqueued {
  job: SalesApplyJobDto;
  results: ApplyMonthResult[];
  /**
   * Recalculate only: the month result an OLD Months tab reads (`ok: false` + "being recalculated in the background —
   * refresh this page to follow it") instead of a false "recalculated" (audit B-H2).
   */
  month?: string;
  ok?: false;
  error?: string;
}
/**
 * The latest FINISHED Apply / Recalculate of a month (DONE or FAILED), shown when coming back to the page so a result
 * never disappears (audit B-H1).
 */
export interface SalesMonthLastJob {
  jobId: string;
  kind: SalesApplyJobKind;
  status: 'DONE' | 'FAILED';
  importId: string | null;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
  result: ApplyMonthResult | null;
}

// ─── Months ─────────────────────────────────────────────────────────────────────

export interface SalesMonthRow {
  month: string;
  state: SalesMonthState;
  implicit: boolean; // implicit = no override row
  closedAt: string | null;
  closedBy: string | null;
  lastAppliedAt: string | null;
  lastAppliedImportId: string | null;
  canClose: boolean;
  canReopen: boolean;
  /**
   * Points artefacts already produced for this month: credit batches (any status) for the period and points-compute
   * export / report downloads. Non-zero → reopening needs SalesMonthReopenRequest.acknowledgeDownstream.
   */
  downstream: { creditBatches: number; exports: number };
  /**
   * Stored month history (SalesMonthHistory): the FINAL applied file lines of this month (programme outlets only),
   * written by each apply and kept for the history window (10 years while SALES_RETENTION_V2 is off; the current month
   * + 3 before it with it on). `hasHistory` →
   * POST …/recalculate is possible. false for a month older than that window, even while the sweep is still deleting it.
   */
  hasHistory: boolean;
  historySourceImportId: string | null; // the import whose lines the history holds (the last applied one)
  historyAppliedAt: string | null;      // when those lines were applied (also the recalculate version token)
  /**
   * The month's stored product list (the KPI picker's "Stored month(s)" source, built from the stored lines at apply) is
   * up to date. False only when hasHistory and the list was built from an earlier apply or never built — then
   * POST admin/sales-months/:month/rebuild-product-list rebuilds it (it changes no figures). True without history.
   */
  productListCurrent: boolean;
  /**
   * FOCUS-FROM-TARGETS: targets for this month were uploaded after its last apply, so the applied achievements may be
   * out of date (e.g. focus KPIs computed before the focus names existed). The Months tab shows "Targets changed —
   * recalculate". false when never applied.
   */
  targetsChangedSinceApply: boolean;
  /** An Apply / Recalculate of this month queued or running now: Close / Reopen / Recalculate are refused (409) until it ends. */
  activeJob: SalesMonthActiveJob | null;
  /** The month's latest finished Apply / Recalculate, or null. */
  lastJob: SalesMonthLastJob | null;
}

/**
 * GET admin/sales-months/:month/recalculate/preview (targets:read): what "Recalculate from stored history" would write —
 * ALL importer-owned KPIs of the month recomputed from SalesMonthHistory with the CURRENT KPI definitions and the CURRENT
 * roster (customer codes → outlets). Same KPI shape as the import preview. 404 when the month has no history.
 */
export interface SalesMonthRecalcPreview {
  month: string;
  monthState: SalesMonthState;
  canApply: boolean;          // false for CLOSED / future months, no owned KPIs
  blockedReason?: string;
  definitionsHash: string;    // send back as SalesMonthRecalcRequest.expectedDefinitionsHash
  historySourceImportId: string;
  historyAppliedAt: string;   // send back as SalesMonthRecalcRequest.expectedHistoryAppliedAt
  matchedOutlets: number;     // history customer codes on the CURRENT roster
  unmatchedCustomers: number;
  matchedAmountRupees: number;
  matchedQuantity: number;
  unmatchedAmountRupees: number;
  unmatchedQuantity: number;
  zeroFillOutlets: number;    // in-scope roster outlets with no history lines → 0
  outletsAffected: number;    // OutletSalesRecord rows whose owned KPI values would change (incl. keys removed)
  warnings: SalesMonthWarning[]; // NEGATIVE_VALUES / REPLACES_MANUAL_VALUES
  kpis: MonthPreviewKpi[];
  reconciliation: MonthReconciliation;
  /**
   * Can the recalculation rebuild the month's day-level data? false when the stored lines have no day split (applied
   * before day-level storage): recalculating then REMOVES the month's day data — `reason` says so.
   */
  dayData?: { available: boolean; reason?: string };
}

/** POST admin/sales-months/:month/recalculate body (targets:upload; month OPEN; 409 when either token is stale). */
export interface SalesMonthRecalcRequest {
  expectedDefinitionsHash: string;
  expectedHistoryAppliedAt: string;
  /** SalesMonthRecalcPreview.reconciliation.focusFingerprint (required when non-empty; 409 on mismatch). */
  expectedFocusFingerprint?: string;
  /** FOCUS-NAMES-FROM-KPI: required (true) when the preview's reconciliation lists `notCalculated` KPIs; recorded. */
  confirmNotCalculated?: boolean;
  /** As ApplyRequest.requestId: resending the same request returns the same job. */
  requestId?: string;
}
/** POST admin/sales-months/:month/recalculate response (recorded as a SalesImportApply with source HISTORY). */
export type SalesMonthRecalcResult = ApplyMonthResult;

/**
 * POST admin/sales-months/:month/rebuild-product-list (targets:upload; OPEN or CLOSED month — it changes no achievement,
 * KPI value or history line): rebuilds the month's stored product list from its stored lines under the month lock, and
 * returns the updated row (productListCurrent: true). 404 when the month has no stored history; 409 when the month is
 * busy (a file is being applied) for longer than the wait allows.
 */
export type SalesMonthRebuildProductListResult = SalesMonthRow;

/** POST admin/sales-months/:month/reopen body. Without the ack, reopen → 409 when `downstream` is non-zero. */
export interface SalesMonthReopenRequest {
  acknowledgeDownstream?: boolean;
}
/** POST admin/sales-months/:month/reopen response; `warnings` lists the downstream artefacts that may now diverge. */
export interface SalesMonthReopenResult extends SalesMonthRow {
  warnings: string[];
}

// ─── Drain (Cloud Scheduler fallback) ───────────────────────────────────────────

export interface SalesImportDrainResult {
  kicked: boolean;
}

// ─── Additive fields on EXISTING responses (only present for tenants with owned KPIs) ─

/** POST /v1/admin/achievements/upload gains this OPTIONAL field (absent when the tenant owns no KPIs). */
export interface AchievementUploadOwnershipExtension {
  skippedImporterOwnedKpis?: string[];
}

// ─── Focus products from the target file (FOCUS-FROM-TARGETS — owner-approved 2026-11-13) ─────────────────────
// Design: platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md. ONE place to enter focus products (the month's target
// file, the per-outlet name column of the KPI), ONE place to reconcile (the month preview = MonthReconciliation).

/**
 * Where a Sales Import KPI's products come from.
 *  - FILTER       = the definition's own `filter` (one product list for every outlet in scope) — the original behaviour.
 *  - TARGET_NAMES = per outlet, the product names written for this KPI in THAT MONTH's target file
 *                   (OutletTarget.targetValues.__names[kpiCode], e.g. "CNO & ADHO500"); `filter` must be {}.
 * Absent on a request = FILTER.
 */
export type SalesKpiProductSource = 'FILTER' | 'TARGET_NAMES';

/** How one written product name (a token between `&` / `,`) was read against the tenant's known products. */
export type FocusTokenStatus = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS';
export interface FocusTokenResolution {
  /** As written in the target file (trimmed), e.g. "ADHO500". */
  token: string;
  /** focusKey(token): UPPERCASE, all whitespace removed — the acceptance key. */
  key: string;
  status: FocusTokenStatus;
  /** MATCHED: e.g. {brand:'ADHO', skuGroup:'500'}, or {brand:'CNO'} = the whole brand. */
  product?: DimMatch;
  /** AMBIGUOUS: every product the token could mean. */
  candidates?: DimMatch[];
  /** UNMATCHED that an operator accepted as "not sold yet" for this month + KPI (counts as 0, no longer blocks). */
  accepted?: { byName: string; at: string };
}

/** One distinct focus name of a KPI in the month, across the outlets that carry it. */
export interface FocusNameSummary {
  /** The most common spelling as written. */
  name: string;
  /** Tokens' keys sorted and joined with '&' — identifies the name regardless of spelling/order. */
  key: string;
  outlets: number;
  /** Outlet type code → outlets ('' = outlet without a type). */
  outletsByType: Record<string, number>;
  tokens: FocusTokenResolution[];
  /** This month, over the outlets carrying the name, in the KPI's own measure (₹ / cases / products). */
  achieved: { total: number; outletsZero: number };
}

/**
 * FOCUS_SOURCE_MISSING (FOCUS-NAMES-FROM-KPI): a definition reads another KPI's names, but that KPI has no enabled
 * 'from the target file' definition — its outlets get no value until the source is fixed.
 * FOCUS_SCOPE_MISMATCH: that definition and its source apply to different outlets (no value until they match).
 * (A source with NO focus name at all in the month is not a blocker: see MonthReconciliation.notCalculated.)
 */
export type FocusBlockerCode = 'FOCUS_UNMATCHED' | 'FOCUS_AMBIGUOUS' | 'FOCUS_MISSING_NAME' | 'FOCUS_SOURCE_MISSING' | 'FOCUS_SCOPE_MISMATCH';
/** Anything here blocks applying the month (canApply false). */
export interface FocusBlocker {
  code: FocusBlockerCode;
  kpiCode: string;
  /** UNMATCHED / AMBIGUOUS: the token as written + its key. */
  token?: string;
  key?: string;
  outlets: number;
  /** ≤ 20 stored outlet codes. */
  sampleOutletCodes: string[];
  /** Plain English for the screen. */
  message: string;
}

export interface MonthFocusKpi {
  kpiCode: string;
  label: string;
  /** The KPI's measure, so the screen formats `achieved` in the right unit (₹ / cases / products). */
  measure: SalesKpiMeasure;
  names: FocusNameSummary[];
  /** In the KPI's scope, a numeric target for this KPI this month, but no name → FOCUS_MISSING_NAME. */
  missingName: { outlets: number; sampleOutletCodes: string[] };
}

export interface MonthTargetsSummary {
  /** Importer-owned KPIs only. */
  kpis: Array<{ kpiCode: string; label: string; outletsWithTarget: number; totalTarget: number; measure: SalesKpiMeasure }>;
  /** When the month's target rows were last written (MAX OutletTarget.updatedAt, ISO); null = no targets for the month. */
  targetUploadedAt: string | null;
  /**
   * The month's targets were uploaded AFTER the month was last applied (sales first, targets later is normal): the
   * applied achievements do not reflect them yet -> re-apply / Recalculate. false when never applied or no targets.
   */
  newerThanLastApply: boolean;
}

/** The single reconciliation view of a month (import preview AND recalculate preview). */
export interface MonthReconciliation {
  targets: MonthTargetsSummary;
  /** One entry per enabled TARGET_NAMES definition ([] when none). */
  focus: MonthFocusKpi[];
  /** Non-empty → canApply false. */
  blockers: FocusBlocker[];
  gaps: {
    /** Roster outlets with a numeric target for an owned KPI this month but no sales line. */
    targetNoSales: { outlets: number; sampleOutletCodes: string[] };
    /** Roster outlets with sales lines this month but no target row for the month. */
    salesNoTarget: { outlets: number; sampleOutletCodes: string[] };
  };
  /**
   * Fingerprint of everything the focus KPIs depend on for this month (per-outlet names, how each name resolved,
   * acceptances, missing names). '' when the tenant has no enabled TARGET_NAMES definition. Send it back on apply;
   * a changed target file / acceptance / product list since the preview → 409 "refresh the preview".
   */
  focusFingerprint: string;
  /**
   * FOCUS-NAMES-FROM-KPI (owner 2026-11-25): KPIs that read another KPI's focus names, which has NO focus name at all in
   * this month's target file. They are NOT calculated this month (left empty — no value, not 0); everything else is.
   * Applying needs `acknowledgeNotCalculatedMonths` / recalculating needs `confirmNotCalculated`. Absent when none.
   */
  notCalculated?: FocusNotCalculated[];
}

/** One KPI left empty for the month (see MonthReconciliation.notCalculated). */
export interface FocusNotCalculated {
  kpiCode: string;
  /** The KPI whose focus names it reads. */
  namesFromKpi: string;
  /** Red warning text, e.g. "No focus names in this month's target file — FB1 CASES not calculated". */
  message: string;
  /** Outlets that hold a value for this KPI in the month NOW — removed by the apply / recalculate (absent when 0). */
  existingOutlets?: number;
}

/** POST admin/sales-months/:month/focus-acceptances (targets:upload; month OPEN): accept an UNMATCHED token as "not sold yet". */
export interface FocusAcceptanceRequest {
  kpiCode: string;
  key: string;
}
/** POST admin/sales-months/:month/focus-acceptances/bulk: several names of ONE KPI, all or nothing. */
export interface FocusAcceptanceBulkRequest {
  kpiCode: string;
  keys: string[];
}
/** DELETE admin/sales-months/:month/focus-acceptances?kpiCode=&key= removes it. Both return the month's acceptances. */
export interface FocusAcceptanceList {
  month: string;
  acceptances: Array<{ kpiCode: string; key: string; byName: string; at: string }>;
}

/**
 * Early, NON-blocking check returned by the target upload (TargetsService upload response `focusCheck`), so a typo is
 * seen on the day targets are uploaded. The month preview re-checks and is the one that blocks.
 */
export interface TargetUploadFocusCheck {
  /** false = nothing to check against yet (no TARGET_NAMES definition, or no stored product list yet). */
  checked: boolean;
  reason?: string;
  /**
   * Why the check did not run (checked:false): NO_TARGET_NAMES_KPI = nothing to check (stay silent);
   * NO_PRODUCT_LIST = no stored product list yet; CHECK_FAILED = the check errored. The last two are shown to the
   * operator as a grey note so a skipped check is never silent.
   */
  reasonCode?: 'NO_TARGET_NAMES_KPI' | 'NO_PRODUCT_LIST' | 'CHECK_FAILED';
  months: Array<{ month: string; blockers: FocusBlocker[] }>;
}

/** A reconciliation with nothing in it (no targets, no focus KPIs, no blockers, no gaps). */
export const EMPTY_MONTH_RECONCILIATION: MonthReconciliation = {
  targets: { kpis: [], targetUploadedAt: null, newerThanLastApply: false },
  focus: [],
  blockers: [],
  gaps: { targetNoSales: { outlets: 0, sampleOutletCodes: [] }, salesNoTarget: { outlets: 0, sampleOutletCodes: [] } },
  focusFingerprint: '',
};
