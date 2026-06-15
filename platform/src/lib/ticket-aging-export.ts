/**
 * Ticket Aging Export
 *
 * Pure, deterministic functions for the R2 Ticket Aging report.
 * Generates open/unresolved ticket rows aged into buckets with SLA flags.
 *
 * Spec: docs/plans/REPORTING-REVAMP.md § R2
 */

import * as XLSX from 'xlsx';
import type { TicketAgingRow, TicketAgingSummary } from '@/types';

// ─── Buckets ──────────────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  '0-1 days',
  '2-3 days',
  '4-7 days',
  '8-14 days',
  '15-30 days',
  '30+ days',
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

// ─── Pure calculation helpers ─────────────────────────────────────────────────

/**
 * Returns the age in whole days between `createdAt` and `asOf`.
 * Clamped to 0 — never negative (future-dated createdAt returns 0).
 */
export function ageInDays(
  createdAt: Date | string,
  asOf:      Date | string,
): number {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const as      = asOf      instanceof Date ? asOf      : new Date(asOf);
  const diff    = Math.floor((as.getTime() - created.getTime()) / 86_400_000);
  return Math.max(0, diff);
}

/**
 * Maps an age-in-days to its display bucket string.
 *
 * Boundaries (inclusive):
 *   0–1   → '0-1 days'
 *   2–3   → '2-3 days'
 *   4–7   → '4-7 days'
 *   8–14  → '8-14 days'
 *   15–30 → '15-30 days'
 *   31+   → '30+ days'
 */
export function agingBucket(ageDays: number): AgingBucket {
  if (ageDays <= 1)  return '0-1 days';
  if (ageDays <= 3)  return '2-3 days';
  if (ageDays <= 7)  return '4-7 days';
  if (ageDays <= 14) return '8-14 days';
  if (ageDays <= 30) return '15-30 days';
  return '30+ days';
}

/**
 * Returns hours (1-decimal precision) between `createdAt` and `firstResponseAt`,
 * or `null` if `firstResponseAt` is null/undefined (ticket not yet responded to).
 */
export function firstResponseHours(
  firstResponseAt: Date | string | null | undefined,
  createdAt:       Date | string,
): number | null {
  if (firstResponseAt == null) return null;
  const resp    = firstResponseAt instanceof Date ? firstResponseAt : new Date(firstResponseAt);
  const created = createdAt        instanceof Date ? createdAt        : new Date(createdAt);
  const hrs     = (resp.getTime() - created.getTime()) / 3_600_000;
  // Clamp to >= 0 — a firstResponseAt before createdAt is a data anomaly, not a negative SLA.
  return Math.max(0, Math.round(hrs * 10) / 10);
}

// ─── Row builder ──────────────────────────────────────────────────────────────

/** Minimal ticket shape expected by buildTicketAgingRow. */
export interface TicketInput {
  ticketNumber:    string;
  subject:         string;
  category:        string;
  priority:        string;
  status:          string;
  createdByName:   string;
  assignedToName?: string;
  createdAt:       Date | string;
  updatedAt:       Date | string;
  firstResponseAt?: Date | string | null;
  slaBreached:     boolean;
}

/**
 * Maps a raw ticket + `asOf` to a `TicketAgingRow`.
 * Pure — no side-effects, deterministic given the same inputs.
 */
export function buildTicketAgingRow(
  t:    TicketInput,
  asOf: Date | string,
): TicketAgingRow {
  const days   = ageInDays(t.createdAt, asOf);
  const bucket = agingBucket(days);
  const frhrs  = firstResponseHours(t.firstResponseAt, t.createdAt);

  const toISO = (d: Date | string): string =>
    (d instanceof Date ? d : new Date(d)).toISOString();

  return {
    ticketNumber:       t.ticketNumber,
    subject:            t.subject,
    category:           t.category,
    priority:           t.priority,
    status:             t.status,
    createdByName:      t.createdByName,
    assignedToName:     t.assignedToName,
    createdAt:          toISO(t.createdAt),
    ageDays:            days,
    agingBucket:        bucket,
    firstResponseHours: frhrs,
    slaBreached:        t.slaBreached,
    lastUpdatedAt:      toISO(t.updatedAt),
  };
}

// ─── Summarizer ───────────────────────────────────────────────────────────────

/**
 * Summarises an array of `TicketAgingRow`s into totals and per-bucket counts.
 * All six bucket keys are always present in `byBucket` (0 when empty).
 */
export function summarizeAging(rows: TicketAgingRow[]): TicketAgingSummary {
  const byBucket: Record<string, number> = {};
  for (const b of AGING_BUCKETS) byBucket[b] = 0;

  let slaBreachedCount = 0;

  for (const r of rows) {
    if (r.slaBreached) slaBreachedCount++;
    if (byBucket[r.agingBucket] !== undefined) {
      byBucket[r.agingBucket]++;
    }
  }

  return { total: rows.length, slaBreached: slaBreachedCount, byBucket };
}

// ─── Excel generator ──────────────────────────────────────────────────────────

/** Exact column count for the Ticket Aging report (13 flat columns). */
export const TICKET_AGING_COLUMN_COUNT = 13;

const COLUMN_HEADERS = [
  'Ticket #',
  'Subject',
  'Category',
  'Priority',
  'Status',
  'Created By',
  'Assigned To',
  'Created',
  'Age (days)',
  'Aging bucket',
  'First response (hrs)',
  'SLA breached',
  'Last updated',
] as const;

/** ISO datetime string → YYYY-MM-DD date portion. */
function isoToDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Generates an Excel workbook (13 flat columns) for the Ticket Aging report.
 *
 * Column rendering:
 *   firstResponseHours === null  → 'Pending'
 *   slaBreached                  → 'Yes' / 'No'
 *   dates (createdAt/lastUpdated) → 'YYYY-MM-DD'
 *
 * Returns a `Uint8Array` (same Buffer→Uint8Array wrap as R1).
 */
export function generateTicketAgingExcel(rows: TicketAgingRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  const headerRow: string[] = [...COLUMN_HEADERS];

  const dataRows: (string | number)[][] = rows.map(r => [
    r.ticketNumber,
    r.subject,
    r.category,
    r.priority,
    r.status,
    r.createdByName,
    r.assignedToName ?? '',
    isoToDate(r.createdAt),
    r.ageDays,
    r.agingBucket,
    r.firstResponseHours === null ? 'Pending' : r.firstResponseHours,
    r.slaBreached ? 'Yes' : 'No',
    isoToDate(r.lastUpdatedAt),
  ]);

  const wsData = [headerRow, ...dataRows];
  const ws     = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths — based on header label lengths (same approach as R1).
  ws['!cols'] = headerRow.map(label => ({ wch: Math.max(label.length + 2, 14) }));

  XLSX.utils.book_append_sheet(wb, ws, 'Ticket Aging');

  // type:'buffer' returns a Node.js Buffer; wrap in Uint8Array so instanceof
  // checks pass across jsdom/Vitest realms (mirrors R1).
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Demo data ────────────────────────────────────────────────────────────────

/**
 * ~10 deterministic demo tickets spread across every aging bucket.
 *
 * Offset days (from asOf) used: 0, 1, 3, 6, 10, 14, 20, 28, 40, 55.
 * This guarantees coverage of all 6 buckets:
 *   0-1 days   → offsets 0, 1
 *   2-3 days   → offset  3
 *   4-7 days   → offset  6
 *   8-14 days  → offsets 10, 14
 *   15-30 days → offsets 20, 28
 *   30+ days   → offsets 40, 55
 *
 * Values are purely a function of fixed constants + asOf; no randomness.
 * Calling twice with the same `asOf` produces deep-equal output.
 */
export function demoTicketAgingRows(asOf: Date): TicketAgingRow[] {
  // Each entry: [offsetDays, ticketNum, subject, category, priority, status,
  //              createdBy, assignedTo, firstResponseOffsetHours (null=no response), slaBreached]
  type DemoEntry = {
    offsetDays:   number;
    ticketNumber: string;
    subject:      string;
    category:     string;
    priority:     string;
    status:       string;
    createdBy:    string;
    assignedTo:   string | undefined;
    firstRespHrs: number | null;  // hours after createdAt, or null
    slaBreached:  boolean;
  };

  const DEMOS: DemoEntry[] = [
    {
      offsetDays:   0,
      ticketNumber: 'TKT-2026-0001',
      subject:      'Unable to redeem points — catalogue shows error',
      category:     'REDEMPTION',
      priority:     'HIGH',
      status:       'OPEN',
      createdBy:    'Suresh Kumar',
      assignedTo:   'Priya Iyer',
      firstRespHrs: null,
      slaBreached:  false,
    },
    {
      offsetDays:   1,
      ticketNumber: 'TKT-2026-0002',
      subject:      'KYC documents rejected without reason',
      category:     'KYC',
      priority:     'MEDIUM',
      status:       'IN_PROGRESS',
      createdBy:    'Ramesh Patel',
      assignedTo:   'Support Desk',
      firstRespHrs: 3.5,
      slaBreached:  false,
    },
    {
      offsetDays:   3,
      ticketNumber: 'TKT-2026-0003',
      subject:      'Points not credited after scheme upload',
      category:     'POINTS',
      priority:     'HIGH',
      status:       'OPEN',
      createdBy:    'Anjali Mehta',
      assignedTo:   'Priya Iyer',
      firstRespHrs: null,
      slaBreached:  false,
    },
    {
      offsetDays:   6,
      ticketNumber: 'TKT-2026-0004',
      subject:      'Payout not received after 10 business days',
      category:     'PAYOUT',
      priority:     'CRITICAL',
      status:       'ESCALATED',
      createdBy:    'Vijay Sharma',
      assignedTo:   'Priya Iyer',
      firstRespHrs: 1.0,
      slaBreached:  true,
    },
    {
      offsetDays:   10,
      ticketNumber: 'TKT-2026-0005',
      subject:      'OTP not received on registered mobile',
      category:     'ACCOUNT',
      priority:     'MEDIUM',
      status:       'PENDING_USER',
      createdBy:    'Kavitha Nair',
      assignedTo:   'Support Desk',
      firstRespHrs: 8.0,
      slaBreached:  false,
    },
    {
      offsetDays:   14,
      ticketNumber: 'TKT-2026-0006',
      subject:      'Scheme target showing incorrect achievement %',
      category:     'SCHEME',
      priority:     'HIGH',
      status:       'IN_PROGRESS',
      createdBy:    'Deepak Joshi',
      assignedTo:   undefined,
      firstRespHrs: 12.0,
      slaBreached:  true,
    },
    {
      offsetDays:   20,
      ticketNumber: 'TKT-2026-0007',
      subject:      'App login fails on Android 14',
      category:     'TECHNICAL',
      priority:     'MEDIUM',
      status:       'OPEN',
      createdBy:    'Meena Krishnamurthy',
      assignedTo:   'Support Desk',
      firstRespHrs: 24.0,
      slaBreached:  true,
    },
    {
      offsetDays:   28,
      ticketNumber: 'TKT-2026-0008',
      subject:      'Distributor mapping incorrect in reports',
      category:     'OTHER',
      priority:     'LOW',
      status:       'IN_PROGRESS',
      createdBy:    'Arjun Reddy',
      assignedTo:   'Priya Iyer',
      firstRespHrs: 48.0,
      slaBreached:  false,
    },
    {
      offsetDays:   40,
      ticketNumber: 'TKT-2026-0009',
      subject:      'Redemption order stuck in PROCESSING state',
      category:     'REDEMPTION',
      priority:     'CRITICAL',
      status:       'ESCALATED',
      createdBy:    'Sunita Verma',
      assignedTo:   'Priya Iyer',
      firstRespHrs: 2.5,
      slaBreached:  true,
    },
    {
      offsetDays:   55,
      ticketNumber: 'TKT-2026-0010',
      subject:      'Wallet balance mismatch after bulk upload',
      category:     'POINTS',
      priority:     'CRITICAL',
      status:       'ESCALATED',
      createdBy:    'Ravi Shankar',
      assignedTo:   'Support Desk',
      firstRespHrs: null,
      slaBreached:  true,
    },
  ];

  return DEMOS.map(d => {
    // createdAt = asOf − offsetDays (deterministic; no randomness)
    const createdAt = new Date(asOf.getTime() - d.offsetDays * 86_400_000);
    // updatedAt = createdAt + a fixed deterministic offset (hours)
    const updatedHrsOffset = (d.offsetDays % 5) + 1;
    const updatedAt  = new Date(createdAt.getTime() + updatedHrsOffset * 3_600_000);

    const firstResponseAt: Date | null = d.firstRespHrs !== null
      ? new Date(createdAt.getTime() + d.firstRespHrs * 3_600_000)
      : null;

    return buildTicketAgingRow(
      {
        ticketNumber:    d.ticketNumber,
        subject:         d.subject,
        category:        d.category,
        priority:        d.priority,
        status:          d.status,
        createdByName:   d.createdBy,
        assignedToName:  d.assignedTo,
        createdAt,
        updatedAt,
        firstResponseAt,
        slaBreached:     d.slaBreached,
      },
      asOf,
    );
  });
}
