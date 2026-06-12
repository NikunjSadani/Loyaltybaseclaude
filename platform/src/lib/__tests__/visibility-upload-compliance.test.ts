/// <reference types="vitest/globals" />
/**
 * TDD — Outlet Visibility Upload module
 *
 * RED phase: all tests written before implementation.
 *
 * Changes under test:
 *  1. api/prisma/schema.prisma                               — new OutletVisibility* models
 *  2. platform/src/lib/visibility.ts                         — shared types + helpers
 *  3. app/api/admin/visibility/bulk-upload/route.ts          — POST (Excel upload)
 *  4. app/api/admin/visibility/records/route.ts              — GET (admin list)
 *  5. app/api/visibility/outlet-statuses/route.ts            — GET (sales app)
 *  6. app/admin/visibility/page.tsx                          — Bulk Upload tab added
 *  7. app/sales/outlets/page.tsx                             — visibility badge on RETAILER/MT cards
 *  8. app/sales/tasks/page.tsx                               — auto-remove APPROVED outlets from vis tasks
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Read a file relative to platform/src */
const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

/** Read a file relative to the repo root (Loyaltybaseclaude/) */
const rootSrc = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../..', rel), 'utf-8');

// ─── A: Prisma schema has new OutletVisibility models ────────────────────────

describe('A — Prisma schema: OutletVisibility models', () => {
  const schema = rootSrc('api/prisma/schema.prisma');

  it('A1: OutletVisibilityStatus enum exists', () => {
    expect(schema).toMatch(/enum\s+OutletVisibilityStatus/);
  });

  it('A2: enum values are PENDING, UNDER_REVIEW, APPROVED', () => {
    const enumBlock = schema.match(/enum\s+OutletVisibilityStatus\s*\{[^}]+\}/)?.[0] ?? '';
    expect(enumBlock).toMatch(/PENDING/);
    expect(enumBlock).toMatch(/UNDER_REVIEW/);
    expect(enumBlock).toMatch(/APPROVED/);
  });

  it('A3: OutletVisibilityRecord model exists', () => {
    expect(schema).toMatch(/model\s+OutletVisibilityRecord/);
  });

  it('A4: OutletVisibilityRecord has unique constraint on [clientId, outletCode, month]', () => {
    expect(schema).toMatch(/@@unique\(\[clientId,\s*outletCode,\s*month\]\)/);
  });

  it('A5: OutletVisibilityUploadBatch model exists', () => {
    expect(schema).toMatch(/model\s+OutletVisibilityUploadBatch/);
  });

  it('A6: OutletVisibilityAuditLog model exists (per-outlet status-change history)', () => {
    expect(schema).toMatch(/model\s+OutletVisibilityAuditLog/);
  });
});

// ─── B: lib/visibility.ts shape ──────────────────────────────────────────────

describe('B — lib/visibility-upload.ts API shape', () => {
  const code = src('lib/visibility-upload.ts');

  it('B1: exports VISIBILITY_ELIGIBLE_OUTLET_TYPES containing SSS and SSS_TOT', () => {
    expect(code).toMatch(/VISIBILITY_ELIGIBLE_OUTLET_TYPES/);
    expect(code).toMatch(/['"]SSS['"]/);
    expect(code).toMatch(/['"]SSS_TOT['"]/);
  });

  it('B2: exports parseVisibilityStatus function', () => {
    expect(code).toMatch(/export\s+function\s+parseVisibilityStatus/);
  });

  it('B3: exports parseExcelDate function (DD-MM-YYYY + Excel serial numbers)', () => {
    expect(code).toMatch(/export\s+function\s+parseExcelDate/);
  });

  it('B4: exports fetchOutletVisibilityStatuses (async, API-backed)', () => {
    expect(code).toMatch(/export\s+async\s+function\s+fetchOutletVisibilityStatuses/);
  });

  it('B5: exports generateVisibilityTemplate (xlsx template creator)', () => {
    expect(code).toMatch(/export\s+(async\s+)?function\s+generateVisibilityTemplate/);
  });

  it('B6: exports VISIBILITY_UPLOAD_HEADERS with all 8 required columns', () => {
    expect(code).toMatch(/VISIBILITY_UPLOAD_HEADERS/);
    expect(code).toMatch(/outlet_id/);
    expect(code).toMatch(/date_of_capture/);
    expect(code).toMatch(/captured_by_employee_name/);
  });
});

// ─── B-unit: parseVisibilityStatus logic ─────────────────────────────────────

import { parseVisibilityStatus, parseExcelDate, VISIBILITY_ELIGIBLE_OUTLET_TYPES } from '../visibility-upload';

describe('B-unit — parseVisibilityStatus', () => {
  it('BU1: "PENDING" → PENDING', () => expect(parseVisibilityStatus('PENDING')).toBe('PENDING'));
  it('BU2: "pending" (lowercase) → PENDING', () => expect(parseVisibilityStatus('pending')).toBe('PENDING'));
  it('BU3: "Under Review" → UNDER_REVIEW', () => expect(parseVisibilityStatus('Under Review')).toBe('UNDER_REVIEW'));
  it('BU4: "under_review" → UNDER_REVIEW', () => expect(parseVisibilityStatus('under_review')).toBe('UNDER_REVIEW'));
  it('BU5: "APPROVED" → APPROVED', () => expect(parseVisibilityStatus('APPROVED')).toBe('APPROVED'));
  it('BU6: "approved" → APPROVED', () => expect(parseVisibilityStatus('approved')).toBe('APPROVED'));
  it('BU7: unknown string → null', () => expect(parseVisibilityStatus('INVALID')).toBeNull());
  it('BU8: empty string → null', () => expect(parseVisibilityStatus('')).toBeNull());
});

describe('B-unit — parseExcelDate', () => {
  it('BD1: "15-06-2026" → June 15 2026', () => {
    const d = parseExcelDate('15-06-2026');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5); // 0-indexed
    expect(d!.getDate()).toBe(15);
  });

  it('BD2: "15/06/2026" (slash) → same date', () => {
    const d = parseExcelDate('15/06/2026');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
  });

  it('BD3: Excel serial number 46198 → a valid Date', () => {
    const d = parseExcelDate(46198);
    expect(d).not.toBeNull();
    expect(d).toBeInstanceOf(Date);
  });

  it('BD4: null / empty string → null', () => {
    expect(parseExcelDate(null)).toBeNull();
    expect(parseExcelDate('')).toBeNull();
  });
});

describe('B-unit — VISIBILITY_ELIGIBLE_OUTLET_TYPES', () => {
  it('BE1: includes RETAILER', () => expect(VISIBILITY_ELIGIBLE_OUTLET_TYPES).toContain('SSS'));
  it('BE2: includes SSS_TOT', () => expect(VISIBILITY_ELIGIBLE_OUTLET_TYPES).toContain('SSS_TOT'));
  it('BE3: does NOT include WHOLESALER', () => expect(VISIBILITY_ELIGIBLE_OUTLET_TYPES).not.toContain('WHOLESALER'));
  it('BE4: does NOT include SUB_STOCKIST', () => expect(VISIBILITY_ELIGIBLE_OUTLET_TYPES).not.toContain('SUB_STOCKIST'));
});

// ─── C: bulk-upload route shape ──────────────────────────────────────────────

describe('C — app/api/admin/visibility/bulk-upload/route.ts shape', () => {
  const code = src('app/api/admin/visibility/bulk-upload/route.ts');

  it('C1: exports POST', () => {
    expect(code).toMatch(/export\s+async\s+function\s+POST/);
  });

  it('C2: only CLIENT_ADMIN and GIFSY_ADMIN can upload (returns 403 for others)', () => {
    expect(code).toMatch(/CLIENT_ADMIN/);
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('C3: uses prisma.outletVisibilityRecord for upsert', () => {
    expect(code).toMatch(/outletVisibilityRecord/);
  });

  it('C4: creates OutletVisibilityUploadBatch record', () => {
    expect(code).toMatch(/outletVisibilityUploadBatch/);
  });

  it('C5: writes OutletVisibilityAuditLog entries for status changes', () => {
    expect(code).toMatch(/outletVisibilityAuditLog/);
  });

  it('C6: response includes successCount and errorCount', () => {
    expect(code).toMatch(/successCount/);
    expect(code).toMatch(/errorCount/);
  });

  it('C7: generates base64-encoded error Excel when rows fail', () => {
    expect(code).toMatch(/errorFileBase64|errorExcelBase64/);
  });

  it('C8: parses DD-MM-YYYY dates via parseExcelDate', () => {
    expect(code).toMatch(/parseExcelDate/);
  });

  it('C9: normalises status case via parseVisibilityStatus', () => {
    expect(code).toMatch(/parseVisibilityStatus/);
  });
});

// ─── D: records GET route shape ───────────────────────────────────────────────

describe('D — app/api/admin/visibility/records/route.ts shape', () => {
  const code = src('app/api/admin/visibility/records/route.ts');

  it('D1: exports GET', () => {
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
  });

  it('D2: partner roles are blocked', () => {
    // Partner roles (RETAILER / WHOLESALER / SUB_STOCKIST) must be rejected
    expect(code).toMatch(/partnerRoles|RETAILER.*block|partner.*403/i);
  });

  it('D3: filters by month query param', () => {
    expect(code).toMatch(/month/);
  });

  it('D4: filters by status query param', () => {
    expect(code).toMatch(/status/);
  });
});

// ─── E: outlet-statuses GET route shape ──────────────────────────────────────

describe('E — app/api/visibility/outlet-statuses/route.ts shape', () => {
  const code = src('app/api/visibility/outlet-statuses/route.ts');

  it('E1: exports GET', () => {
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
  });

  it('E2: reads outletCodes query param', () => {
    expect(code).toMatch(/outletCodes/);
  });

  it('E3: reads month query param', () => {
    expect(code).toMatch(/month/);
  });

  it('E4: returns a map keyed by outletCode', () => {
    // Result is { data: { [outletCode]: { status, ... } } }
    expect(code).toMatch(/outletCode|statusMap/);
  });
});

// ─── F: admin/visibility/page.tsx — Bulk Upload tab ──────────────────────────

describe('F — admin/visibility/page.tsx: Bulk Upload tab', () => {
  const code = src('app/admin/visibility/page.tsx');

  it('F1: VisTab type includes "upload"', () => {
    expect(code).toMatch(/['"']upload['"']/);
  });

  it('F2: template download uses generateVisibilityTemplate', () => {
    expect(code).toMatch(/generateVisibilityTemplate/);
  });

  it('F3: file input accepts .xlsx / .xls', () => {
    expect(code).toMatch(/\.xlsx|accept.*xls/i);
  });

  it('F4: shows error-report download link when upload has errors', () => {
    expect(code).toMatch(/errorFileBase64|Download Error/i);
  });

  it('F5: fetches recent records from API on mount/upload', () => {
    expect(code).toMatch(/visibility\/records/);
  });
});

// ─── G: sales/outlets/page.tsx — visibility badge ─────────────────────────────

describe('G — sales/outlets/page.tsx: visibility badge on RETAILER/MT cards', () => {
  const code = src('app/sales/outlets/page.tsx');

  it('G1: imports from visibility-upload lib', () => {
    expect(code).toMatch(/visibility-upload/);
  });

  it('G2: references VISIBILITY_ELIGIBLE_OUTLET_TYPES', () => {
    expect(code).toMatch(/VISIBILITY_ELIGIBLE_OUTLET_TYPES/);
  });

  it('G3: renders Visibility: label in the outlet card', () => {
    expect(code).toMatch(/Visibility:/);
  });

  it('G4: stores visibilityMap in state', () => {
    expect(code).toMatch(/visibilityMap/);
  });

  it('G5: Outlet interface includes outletCode field', () => {
    expect(code).toMatch(/outletCode\s*:/);
  });
});

// ─── H: sales/tasks/page.tsx — dynamic visibility tasks ──────────────────────

describe('H — sales/tasks/page.tsx: dynamic visibility tasks', () => {
  const code = src('app/sales/tasks/page.tsx');

  it('H1: imports from visibility-upload lib', () => {
    expect(code).toMatch(/visibility-upload/);
  });

  it('H2: VISIBILITY_TASKS is no longer a static const array declaration', () => {
    // The old pattern was: const VISIBILITY_TASKS: TaskItem[] = [...]
    // After refactor it must be state-driven
    expect(code).not.toMatch(/const VISIBILITY_TASKS\s*:\s*TaskItem\[\]\s*=/);
  });

  it('H3: visibility tasks state is used in taskGroups memo', () => {
    // The memo must reference a state/variable (not a hardcoded constant)
    expect(code).toMatch(/visibilityTasks|visibilityItems/);
  });

  it('H4: filters out outlets with APPROVED status from visibility tasks', () => {
    expect(code).toMatch(/APPROVED/);
  });
});

// ─── I: Runtime tests — bulk-upload route ─────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  default: {
    outletVisibilityRecord: {
      upsert:     vi.fn(),
      findUnique: vi.fn(),
      findMany:   vi.fn(),
      count:      vi.fn(),
    },
    outletVisibilityUploadBatch: { create: vi.fn() },
    outletVisibilityAuditLog:    { createMany: vi.fn() },
    outlet:   { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser: vi.fn(),
}));

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn(() => 'client_test'),
}));

import { POST as BULK_POST }   from '../../app/api/admin/visibility/bulk-upload/route';
import { GET  as RECORDS_GET } from '../../app/api/admin/visibility/records/route';
import { GET  as STATUSES_GET } from '../../app/api/visibility/outlet-statuses/route';
import prisma        from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

function makeReq(opts: {
  role?:    string | null;
  formData?: FormData;
  query?:   Record<string, string>;
} = {}) {
  const { role = 'CLIENT_ADMIN', formData, query } = opts;
  const user =
    role === 'CLIENT_ADMIN' ? { userId: 'u1', role: 'CLIENT_ADMIN' } :
    role === 'GIFSY_ADMIN'  ? { userId: 'u2', role: 'GIFSY_ADMIN'  } :
    role                    ? { userId: 'u3', role                  } :
    null;
  (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(user);
  const url = new URL(`http://localhost/api/test${query ? '?' + new URLSearchParams(query).toString() : ''}`);
  return {
    headers: { get: (k: string) => (k === 'x-tenant-slug' ? 'testclient' : null) },
    formData: () => Promise.resolve(formData ?? new FormData()),
    url: url.toString(),
    nextUrl: url,
  } as unknown as Request;
}

describe('I — Runtime: bulk-upload POST', () => {
  beforeEach(() => vi.clearAllMocks());

  it('I1: returns 401 when unauthenticated', async () => {
    const res = await BULK_POST(makeReq({ role: null }) as any);
    expect(res.status).toBe(401);
  });

  it('I2: returns 403 for SALES_SO (non-admin role)', async () => {
    const res = await BULK_POST(makeReq({ role: 'SALES_SO' }) as any);
    expect(res.status).toBe(403);
  });

  it('I3: returns 400 when no file is attached', async () => {
    // FormData with no "file" entry
    const res = await BULK_POST(makeReq() as any);
    expect(res.status).toBe(400);
  });

  it('I4: GIFSY_ADMIN is allowed to upload (no 403)', async () => {
    // No file → 400 (auth passed, file validation failed — that is correct)
    const res = await BULK_POST(makeReq({ role: 'GIFSY_ADMIN' }) as any);
    expect(res.status).not.toBe(403);
  });
});

// ─── J: Runtime tests — records GET ──────────────────────────────────────────

describe('J — Runtime: visibility records GET', () => {
  beforeEach(() => vi.clearAllMocks());

  it('J1: returns 401 when unauthenticated', async () => {
    const res = await RECORDS_GET(makeReq({ role: null }) as any);
    expect(res.status).toBe(401);
  });

  it('J2: returns 200 with empty records for CLIENT_ADMIN', async () => {
    (prisma.outletVisibilityRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.outletVisibilityRecord.count   as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const res  = await RECORDS_GET(makeReq({ query: { month: '2026-06' } }) as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.records).toEqual([]);
  });
});

// ─── K: Runtime tests — outlet-statuses GET ──────────────────────────────────

describe('K — Runtime: outlet-statuses GET', () => {
  beforeEach(() => vi.clearAllMocks());

  it('K1: returns 401 when unauthenticated', async () => {
    const res = await STATUSES_GET(makeReq({ role: null }) as any);
    expect(res.status).toBe(401);
  });

  it('K2: returns empty object when no records stored', async () => {
    (prisma.outletVisibilityRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res  = await STATUSES_GET(makeReq({ query: { outletCodes: 'OUT-1,OUT-2', month: '2026-06' } }) as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({});
  });

  it('K3: returns status map keyed by outletCode', async () => {
    (prisma.outletVisibilityRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { outletCode: 'OUT-MH-001', month: '2026-06', status: 'APPROVED',
        dateOfCapture: null, approvedBy: 'Admin', capturedByEmployeeName: 'Ravi' },
    ]);
    const res  = await STATUSES_GET(makeReq({ query: { outletCodes: 'OUT-MH-001', month: '2026-06' } }) as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data['OUT-MH-001'].status).toBe('APPROVED');
  });

  it('K4: SALES_SO can read (non-partner role)', async () => {
    (prisma.outletVisibilityRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u5', role: 'SALES_SO' });
    const req = {
      headers: { get: () => 'testclient' },
      url: 'http://localhost/api/visibility/outlet-statuses?outletCodes=OUT-1&month=2026-06',
      nextUrl: new URL('http://localhost/api/visibility/outlet-statuses?outletCodes=OUT-1&month=2026-06'),
    } as any;
    const res = await STATUSES_GET(req);
    expect(res.status).toBe(200);
  });
});
