/**
 * scheme-roster.helper.ts — pure, unit-testable helpers for the Wave-0 scheme
 * data-collection ADMIN authoring paths. No Prisma / NestJS imports, so these can
 * be tested directly without bootstrapping the DI container.
 *
 * Three concerns:
 *   (a) buildOutletWhereFromFilter — Mode-A audience filter → Prisma Outlet `where`
 *       (D17: outletType / programName / programCategory / zone / state, inclusions
 *       only; kycApprovedOnly → isActive:true per trap #1).
 *   (b) parseRosterUploadBuffer   — Mode-B Excel → normalized roster rows (fixed
 *       columns: outlet id, outlet name, tagged-employee code; everything else is a
 *       per-outlet prefill variable).
 *   (c) matchRosterRows           — match outletRef → tenant Outlet by outletCode
 *       and tagged-employee code → SalesUser by employeeCode; dedup on outletRef.
 *
 * See docs/plans/SCHEME-DATA-COLLECTION-DESIGN.md §12 / §13.
 */

import * as XLSX from 'xlsx';
import type { Prisma } from '@prisma/client';

// ── (a) Mode-A filter → Prisma Outlet where ──────────────────────────────────

/** The Mode-A audience filter shape (mirrors SetAudienceDto.filter / §13.2). */
export interface AudienceFilter {
  outletTypeIds?: string[];
  programNames?: string[];
  programCategories?: string[];
  zones?: string[];
  states?: string[];
  kycApprovedOnly: boolean;
}

/** Drops null/undefined/blank entries and de-dups; returns undefined if empty. */
function cleanList(vals: string[] | undefined): string[] | undefined {
  if (!vals || vals.length === 0) return undefined;
  const out = Array.from(
    new Set(vals.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())),
  );
  return out.length > 0 ? out : undefined;
}

/**
 * Build a tenant-scoped Prisma `where` for the Outlet master from a Mode-A filter.
 *
 * Contract:
 *   • Always tenant-scoped (clientId) and non-deleted (deletedAt: null).
 *   • Each filter facet is an INCLUSION (`in`); an empty/absent facet adds no clause
 *     (D17a — inclusions only, no exclusions).
 *   • kycApprovedOnly → isActive:true (trap #1: an outlet is only "live/KYC-approved"
 *     when active; the filter narrows to active outlets rather than joining KYC rows).
 */
export function buildOutletWhereFromFilter(
  clientId: string,
  filter: AudienceFilter | undefined,
): Prisma.OutletWhereInput {
  const where: Prisma.OutletWhereInput = { clientId, deletedAt: null };
  if (!filter) return where;

  const outletTypeIds = cleanList(filter.outletTypeIds);
  if (outletTypeIds) where.outletTypeId = { in: outletTypeIds };

  const programNames = cleanList(filter.programNames);
  if (programNames) where.programName = { in: programNames };

  const programCategories = cleanList(filter.programCategories);
  if (programCategories) where.programCategory = { in: programCategories };

  const zones = cleanList(filter.zones);
  if (zones) where.zone = { in: zones };

  const states = cleanList(filter.states);
  if (states) where.state = { in: states };

  if (filter.kycApprovedOnly) where.isActive = true;

  return where;
}

// ── (b) Mode-B Excel parse ───────────────────────────────────────────────────

/** Header-name overrides for the three fixed columns (optional). */
export interface RosterColumnOverrides {
  idColumn?: string;
  nameColumn?: string;
  taggedEmployeeColumn?: string;
}

/** Default accepted header spellings for each fixed column (case-insensitive). */
const DEFAULT_ID_HEADERS = ['outlet id', 'outlet code', 'outletcode', 'outlet_id', 'id'];
const DEFAULT_NAME_HEADERS = ['outlet name', 'outletname', 'name'];
const DEFAULT_TAGGED_HEADERS = [
  'tagged employee',
  'tagged employee code',
  'employee code',
  'employeecode',
  'tagged emp',
  'emp code',
];

/** One parsed roster row before DB matching. */
export interface RawRosterRow {
  /** 1-based row number in the sheet (2 = first data row; row 1 = header). */
  rowIndex: number;
  outletRef: string;
  outletName: string;
  /** Tagged-employee code (Mode B); null/'' → omitted. */
  taggedEmployeeCode: string | null;
  /** Every non-fixed column, keyed by its header text (blank cells omitted). */
  prefillValues: Record<string, string>;
}

/**
 * Parse a Mode-B roster .xlsx into normalized rows.
 *
 * Layout (single header row, unlike the 2-row target template):
 *   Row 1: column headers — "Outlet ID", "Outlet Name", "Tagged Employee",
 *          then any number of arbitrary prefill-variable columns.
 *   Row 2+: one data row per outlet.
 *
 * Rules:
 *   • The id column is REQUIRED; its absence throws (not the expected template).
 *   • A row with a blank outlet id is skipped (trailing/empty rows).
 *   • Blank cells are omitted from prefillValues (never stored as '').
 *   • Unknown/extra columns → prefillValues, keyed by the trimmed header text.
 *     A column whose header is blank is ignored.
 */
export function parseRosterUploadBuffer(
  buffer: Buffer | ArrayBuffer,
  overrides: RosterColumnOverrides = {},
): RawRosterRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new Error('Unrecognized file: no worksheet found');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(ws, {
    header: 1,
    defval: null,
  });

  if (aoa.length < 1) {
    throw new Error('Unrecognized file: the roster sheet has no header row');
  }

  const headers = (aoa[0] as (string | number | null)[]).map((c) => String(c ?? '').trim());
  const headersLower = headers.map((h) => h.toLowerCase());

  const idAccept = overrides.idColumn
    ? [overrides.idColumn.toLowerCase().trim()]
    : DEFAULT_ID_HEADERS;
  const nameAccept = overrides.nameColumn
    ? [overrides.nameColumn.toLowerCase().trim()]
    : DEFAULT_NAME_HEADERS;
  const taggedAccept = overrides.taggedEmployeeColumn
    ? [overrides.taggedEmployeeColumn.toLowerCase().trim()]
    : DEFAULT_TAGGED_HEADERS;

  const findCol = (accept: string[]): number =>
    headersLower.findIndex((h) => h !== '' && accept.includes(h));

  const idCol = findCol(idAccept);
  const nameCol = findCol(nameAccept);
  const taggedCol = findCol(taggedAccept);

  if (idCol === -1) {
    throw new Error(
      'Unrecognized roster template: missing the outlet id column (expected e.g. "Outlet ID")',
    );
  }

  // Columns that are NOT one of the three fixed ones become prefill variables,
  // keyed by their header text. A blank header column is skipped entirely.
  const fixedCols = new Set([idCol, nameCol, taggedCol].filter((c) => c !== -1));
  const prefillCols: { colIndex: number; key: string }[] = [];
  for (let ci = 0; ci < headers.length; ci++) {
    if (fixedCols.has(ci)) continue;
    if (headers[ci] === '') continue;
    prefillCols.push({ colIndex: ci, key: headers[ci] });
  }

  const rows: RawRosterRow[] = [];
  for (let ri = 1; ri < aoa.length; ri++) {
    const row = aoa[ri] as (string | number | null | undefined)[];
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === '')) {
      continue; // fully-blank row
    }

    const cell = (ci: number): string => (ci >= 0 && ci < row.length ? String(row[ci] ?? '').trim() : '');

    const outletRef = cell(idCol);
    if (!outletRef) continue; // no id → skip

    const outletName = cell(nameCol);
    const taggedRaw = cell(taggedCol);

    const prefillValues: Record<string, string> = {};
    for (const { colIndex, key } of prefillCols) {
      const v = cell(colIndex);
      if (v !== '') prefillValues[key] = v;
    }

    rows.push({
      rowIndex: ri + 1,
      outletRef,
      outletName,
      taggedEmployeeCode: taggedRaw !== '' ? taggedRaw : null,
      prefillValues,
    });
  }

  return rows;
}

// ── (c) Match + dedup ────────────────────────────────────────────────────────

/** Minimal matched-outlet lookup shape (outletCode → its ids). */
export interface OutletMatch {
  id: string;
  partnerId: string | null;
}

/** A roster row resolved against the tenant master, ready to persist as SchemeOutlet. */
export interface MatchedRosterRow {
  outletRef: string;
  outletName: string;
  /** Set when outletRef matched a tenant outlet (linked); null = standalone (D4). */
  matchedOutletId: string | null;
  matchedPartnerId: string | null;
  /** Set when the tagged-employee code resolved to a tenant SalesUser. */
  taggedSalesUserId: string | null;
  /** null when the row carried no prefill variables (never store `{}`). */
  prefillValues: Record<string, string> | null;
}

export interface MatchRosterResult {
  rows: MatchedRosterRow[];
  /** outletRefs seen more than once (only the FIRST occurrence is kept — D8). */
  duplicateRefs: string[];
  /** matched (linked to a tenant outlet) row count. */
  matchedCount: number;
  /** standalone (unmatched) row count. */
  standaloneCount: number;
  /** tagged-employee codes that did not resolve to a SalesUser. */
  unmatchedEmployeeCodes: string[];
}

/**
 * Resolve parsed roster rows against the tenant master.
 *
 *   • outletRef → Outlet by outletCode (caller supplies a tenant-scoped map) sets
 *     matchedOutletId + matchedPartnerId; a miss → standalone data point (D4 — never
 *     creates an outlet).
 *   • taggedEmployeeCode → SalesUser by employeeCode (tenant-scoped map) sets
 *     taggedSalesUserId; a miss leaves it null (reach falls back to the outlet's
 *     global assignment).
 *   • Dedup on outletRef within the scheme (D8) — the FIRST occurrence wins; later
 *     duplicates are dropped and reported.
 *
 * Pure: the caller does the DB reads and passes the lookup maps in.
 */
export function matchRosterRows(
  rows: RawRosterRow[],
  outletsByCode: Map<string, OutletMatch>,
  salesUsersByCode: Map<string, string>,
): MatchRosterResult {
  const seen = new Set<string>();
  const duplicateRefs: string[] = [];
  const unmatchedEmployeeCodes = new Set<string>();
  const out: MatchedRosterRow[] = [];
  let matchedCount = 0;
  let standaloneCount = 0;

  for (const row of rows) {
    if (seen.has(row.outletRef)) {
      duplicateRefs.push(row.outletRef);
      continue;
    }
    seen.add(row.outletRef);

    const outlet = outletsByCode.get(row.outletRef);
    const matchedOutletId = outlet?.id ?? null;
    const matchedPartnerId = outlet?.partnerId ?? null;
    if (matchedOutletId) matchedCount++;
    else standaloneCount++;

    let taggedSalesUserId: string | null = null;
    if (row.taggedEmployeeCode) {
      const su = salesUsersByCode.get(row.taggedEmployeeCode);
      if (su) taggedSalesUserId = su;
      else unmatchedEmployeeCodes.add(row.taggedEmployeeCode);
    }

    const hasPrefill = Object.keys(row.prefillValues).length > 0;

    out.push({
      outletRef: row.outletRef,
      outletName: row.outletName,
      matchedOutletId,
      matchedPartnerId,
      taggedSalesUserId,
      prefillValues: hasPrefill ? row.prefillValues : null,
    });
  }

  return {
    rows: out,
    duplicateRefs,
    matchedCount,
    standaloneCount,
    unmatchedEmployeeCodes: Array.from(unmatchedEmployeeCodes),
  };
}
