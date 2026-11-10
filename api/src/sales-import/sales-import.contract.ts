/**
 * Sales Import — the SHARED API CONTRACT (backend side).
 *
 * Source: platform/docs/plans/SALES-IMPORT-PIPELINE-PLAN.md §5 (+ §6.2a for the KPI tester). The
 * frontend mirror is platform/src/lib/sales-import/types.ts — keep the two files IDENTICAL in shape
 * (they live in separate packages, so nothing is imported across). Deviations from the plan text are
 * listed in the plan's "Phase-0 deviations" note (§10a).
 *
 * Conventions:
 *   - Every money/quantity number crossing the wire is a plain JS number in RUPEES / CASES
 *     (2 dp / up to 6 dp). BigInt paise / micro-units stay inside the backend (DB + accumulators).
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
}

// ─── KPI definitions (SalesKpiDefinition) ───────────────────────────────────────

export type SalesKpiMeasure = 'AMOUNT' | 'QUANTITY';
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
  months: Array<{ month: string; totalAmountRupees: number; totalQuantity: number; outletsNonZero: number }>;
  unmatchedEntries: { anyOf: number[]; noneOf: number[] };
  redundantEntries: { anyOf: number[] };
  matchedLines: number;
}

/**
 * GET admin/sales-import/segment-options: the tenant's DISTINCT outlet-type codes (+ display name) and programme names
 * among non-deleted outlets, both sorted. Feeds the KPI editor's outlet-type / programme scope multi-selects.
 */
export interface SalesSegmentOptions {
  outletTypes: Array<{ code: string; name: string }>;
  programs: string[];
}

// ─── Imports ────────────────────────────────────────────────────────────────────

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
  detectedHeaders: string[][] | null; // NEEDS_MAPPING only
  createdAt: string;
  finishedAt: string | null;
  uploadedBy: string;                 // display name
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

// ─── Preview / apply ────────────────────────────────────────────────────────────

export type SalesMonthWarning =
  | 'STARTS_AFTER_FIRST'
  | 'ENDS_BEFORE_MONTH_END'
  | 'OLDER_THAN_LAST_APPLIED'
  | 'REPLACES_MANUAL_VALUES'
  | 'NEGATIVE_VALUES'
  | 'ROSTER_CHANGED';

export interface MonthPreviewKpi {
  kpiCode: string;
  label: string;
  measure: SalesKpiMeasure;
  newTotal: number;
  currentTotal: number;
  delta: number;
  outletsNonZero: number;
  outletsNegative: number;
}

export interface MonthPreview extends MonthSummary { // live, per GET
  monthState: SalesMonthState;
  canApply: boolean;
  blockedReason?: string;
  warnings: SalesMonthWarning[];
  zeroFillOutlets: number; // programme outlets with no lines → 0
  kpis: MonthPreviewKpi[];
  lastApplied: { importId: string; at: string; byName: string } | null;
}

export interface SalesImportPreview {
  importId: string;
  definitionsHash: string;
  rosterHashMatches: boolean;
  months: MonthPreview[];
}

export interface ApplyRequest {
  months: string[];                          // each must be OPEN + present in the file
  expectedDefinitionsHash: string;           // TOCTOU guard (409 on mismatch)
  acknowledgePartialMonths?: string[];       // required for months with STARTS_AFTER_FIRST/ENDS_BEFORE_MONTH_END
  acknowledgeOlderThanLastApplied?: boolean; // required if any month has OLDER_THAN_LAST_APPLIED
}
export interface ApplyMonthResult {
  month: string;
  ok: boolean;
  applyId?: string;
  outletsWritten?: number;
  outletsZeroFilled?: number;
  error?: string;
}
export interface ApplyResult {
  results: ApplyMonthResult[];
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
