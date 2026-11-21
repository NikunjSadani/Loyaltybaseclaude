import { Readable } from 'node:stream';
// Unit tests for SchemeReportService (Wave-0 scheme reports/export, D26/D30).
// Covers: report aggregation (counts, coverage %, breakdowns; standalone bucket),
// the tenant read-only row list (no raw media), the pure export row builder
// (uniform columns + media→REAL Excel hyperlink, bugs 1/3), an END-TO-END xlsx
// round-trip proving cellSafe + signed-in "Open photo" viewer links (scheme-media-link.ts,
// 2026-11-21), and the LEGACY public tokenized media-view endpoint's security contract.
// Run: npx jest src/schemes/scheme-report.service.spec.ts

import * as XLSX from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, StreamableFile } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { buildXlsx, isHyperlinkCell, HyperlinkCell } from '../common/xlsx';
import { FormField } from './enrollment-form.helper';
import { SCHEME_LINK_LIMIT } from './scheme-media-link';
import {
  SchemeReportService,
  buildEnrollmentExportRows,
  renderExportValue,
  resolveOutletName,
  ExportRosterRow,
  MEDIA_FIELD_TYPES,
} from './scheme-report.service';

const field = (over: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({
  label: over.id,
  required: false,
  order: 0,
  ...over,
});

async function streamToBuffer(file: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    file
      .getStream()
      .on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return Buffer.concat(chunks);
}

/** Read a worksheet cell by header text + 0-based data-row index (so we can inspect `.l`). */
function cellByHeader(ws: XLSX.WorkSheet, header: string, dataRow: number): XLSX.CellObject | undefined {
  if (!ws['!ref']) return undefined;
  const range = XLSX.utils.decode_range(ws['!ref']);
  let col = -1;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = ws[XLSX.utils.encode_cell({ r: 0, c })] as XLSX.CellObject | undefined;
    if (h && String(h.v) === header) {
      col = c;
      break;
    }
  }
  if (col < 0) return undefined;
  return ws[XLSX.utils.encode_cell({ r: dataRow + 1, c: col })] as XLSX.CellObject | undefined;
}

describe('renderExportValue (pure)', () => {
  // The third arg renders one media KEY as a cell (the export binds the per-sheet link writer).
  const link = (k: string): HyperlinkCell => ({ __hyperlink: true, text: 'L', target: `/link/${k}` });

  it('renders a media field as a REAL hyperlink cell (not the raw key)', () => {
    const cam = renderExportValue(field({ id: 'p', type: 'CAMERA' }), 'gcs/key.jpg', link);
    expect(cam).toEqual({ __hyperlink: true, text: 'L', target: '/link/gcs/key.jpg' });
    const doc = renderExportValue(field({ id: 'd', type: 'DOCUMENT' }), 'gcs/doc.pdf', link);
    expect(doc).toEqual({ __hyperlink: true, text: 'L', target: '/link/gcs/doc.pdf' });
  });

  it('links a scheme-media key stored under a NON-media type (legacy UPI_QR_SCAN image, TEXT, {key,geo}, array)', () => {
    const k = 'scheme-media/deoleo/2026-09/0b7c-qr.jpg';
    expect(renderExportValue(field({ id: 'u', type: 'UPI_QR_SCAN' }), k, link)).toEqual(link(k));
    expect(renderExportValue(field({ id: 't', type: 'TEXT' }), ` ${k} `, link)).toEqual(link(k));
    expect(renderExportValue(field({ id: 't', type: 'TEXT' }), { key: k, geo: { lat: 1, lng: 2 } }, link)).toEqual(link(k));
    expect(renderExportValue(field({ id: 'm', type: 'MULTI_SELECT' }), [k], link)).toEqual(link(k));
    expect(renderExportValue(field({ id: 'm', type: 'MULTI_SELECT' }), [k, 'A'], link)).toBe('(file), A');
  });

  it('treats SIGNATURE (a net-new media type) as media', () => {
    expect(MEDIA_FIELD_TYPES.has('SIGNATURE')).toBe(true);
  });

  it('does NOT treat UPI_QR_SCAN as media — it exports as the plain VPA text (not a hyperlink)', () => {
    expect(MEDIA_FIELD_TYPES.has('UPI_QR_SCAN')).toBe(false);
    const cell = renderExportValue(field({ id: 'u', type: 'UPI_QR_SCAN' }), '9876543210@paytm', link);
    expect(cell).toBe('9876543210@paytm');
  });

  it('renders a GPS_POINT as "lat, lng (±acc)"', () => {
    expect(
      renderExportValue(field({ id: 'g', type: 'GPS_POINT' }), { lat: 12.9, lng: 77.5, accuracy: 8 }, link),
    ).toBe('12.9, 77.5 (±8)');
  });

  it('joins arrays (multi-select) and JSON-stringifies plain objects', () => {
    expect(renderExportValue(field({ id: 'm', type: 'DROPDOWN' }), ['A', 'B'], link)).toBe('A, B');
    expect(renderExportValue(field({ id: 'o', type: 'TEXT' }), { a: 1 }, link)).toBe('{"a":1}');
  });

  it('renders empty/null as blank (media key absent → no link)', () => {
    expect(renderExportValue(field({ id: 't', type: 'TEXT' }), '', link)).toBe('');
    expect(renderExportValue(field({ id: 't', type: 'TEXT' }), null, link)).toBe('');
    expect(renderExportValue(field({ id: 'p', type: 'CAMERA' }), '', link)).toBe('');
  });
});

describe('resolveOutletName (bug 1)', () => {
  const base: ExportRosterRow = {
    outletRef: 'r', outletName: '', matchedOutletName: null, matchedOutletId: null,
    zone: null, programName: null, programCategory: null, outletType: null,
    taggedEmployeeCode: null, prefillValues: null, enrollmentId: null, enrollment: null,
  };

  it('prefers a non-empty uploaded outletName', () => {
    expect(resolveOutletName({ ...base, outletName: 'Uploaded' })).toEqual({ name: 'Uploaded', consumedKey: null });
  });

  it('falls back to the matched loyalty outlet name', () => {
    expect(resolveOutletName({ ...base, matchedOutletName: 'Real' })).toEqual({ name: 'Real', consumedKey: null });
  });

  it('falls back to a name-alias prefill header (case-insensitive) for a standalone row', () => {
    expect(
      resolveOutletName({ ...base, prefillValues: { 'Shop Name': 'Corner Store', Beat: 'North' } }),
    ).toEqual({ name: 'Corner Store', consumedKey: 'Shop Name' });
    expect(
      resolveOutletName({ ...base, prefillValues: { 'Party Name': 'x' } }),
    ).toEqual({ name: 'x', consumedKey: 'Party Name' });
  });

  it('returns blank when nothing supplies a name', () => {
    expect(resolveOutletName({ ...base, prefillValues: { Beat: 'North' } })).toEqual({ name: '', consumedKey: null });
  });
});

describe('buildEnrollmentExportRows (pure)', () => {
  const fields: FormField[] = [
    field({ id: 'f_name', type: 'TEXT', label: 'Owner', order: 1 }),
    field({ id: 'f_photo', type: 'CAMERA', label: 'Photo', order: 2 }),
  ];
  // mediaCell(key) → the cell for one stored media key.
  const link = (k: string): HyperlinkCell => ({ __hyperlink: true, text: 'Open photo', target: `/media/${k}` });

  // Roster-row factory — an enrolled row auto-gets a stable enrollmentId (media minting
  // needs it) unless one is supplied.
  const row = (over: Partial<ExportRosterRow>): ExportRosterRow => {
    const r: ExportRosterRow = {
      outletRef: 'r', outletName: 'r', matchedOutletName: null, matchedOutletId: null,
      zone: null, programName: null, programCategory: null, outletType: null,
      taggedEmployeeCode: null, prefillValues: null, enrollmentId: null, enrollment: null, ...over,
    };
    if (r.enrollment && r.enrollmentId == null) r.enrollmentId = `enr_${r.outletRef}`;
    return r;
  };
  const enrolled = (over: Partial<NonNullable<ExportRosterRow['enrollment']>> = {}) => ({
    status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'),
    rejectionReason: null, submittedByName: 'Rep', submittedByPhone: '9990000001',
    submittedByEmployeeCode: null, formValues: {}, ...over,
  });

  it('gives EVERY row an identical key set even when the first row has no enrollment', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'X2', outletName: 'Standalone' }),
      row({
        outletRef: 'X1', outletName: 'Shop One', matchedOutletId: 'o1', zone: 'W', programName: 'P',
        programCategory: 'C', outletType: 'Retail', taggedEmployeeCode: 'E1',
        enrollment: enrolled({ formValues: { f_name: 'Ravi', f_photo: 'gcs/p.jpg' } }),
      }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(Object.keys(rows[0])).toEqual(Object.keys(rows[1]));
    expect(rows[0]).toMatchObject({ Matched: 'No', Status: 'NOT_ENROLLED', Owner: '', Photo: '' });
    expect(rows[1]).toMatchObject({ Matched: 'Yes', Status: 'SUBMITTED', Owner: 'Ravi' });
    // Photo is a real hyperlink cell built from the stored key.
    expect(rows[1]['Photo']).toEqual({ __hyperlink: true, text: 'Open photo', target: '/media/gcs/p.jpg' });
  });

  it('de-collides duplicate field labels', () => {
    const dup = [field({ id: 'a', type: 'TEXT', label: 'Qty' }), field({ id: 'b', type: 'TEXT', label: 'Qty' })];
    const { rows } = buildEnrollmentExportRows([row({})], dup, link);
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['Qty', 'Qty (2)']));
  });

  it('emits the UNION of uploaded audience-Excel columns, filling blanks per row', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', prefillValues: { Slab: 'Gold', Target: '100' } }),
      row({ outletRef: 'B', prefillValues: { Slab: 'Silver', Region: 'West' } }),
    ];
    const { rows, columns } = buildEnrollmentExportRows(roster, fields, link);
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['Slab', 'Target', 'Region']));
    expect(Object.keys(rows[1])).toEqual(expect.arrayContaining(['Slab', 'Target', 'Region']));
    expect(rows[0]).toMatchObject({ Slab: 'Gold', Target: '100', Region: '' });
    expect(rows[1]).toMatchObject({ Slab: 'Silver', Target: '', Region: 'West' });
    expect(columns).toEqual(expect.arrayContaining([{ name: 'Slab', source: 'Audience Excel upload' }]));
  });

  it('de-collides an Excel header that clashes with a base column (does not drop or overwrite it)', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', prefillValues: { Status: 'FROM_EXCEL' }, enrollment: enrolled({ status: 'REJECTED' }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Status']).toBe('REJECTED');
    expect(rows[0]['Status (Excel)']).toBe('FROM_EXCEL');
  });

  it('de-collides an Excel header that clashes with a built-in column case-INSENSITIVELY', () => {
    // An uploaded column differing only in case from a built-in ("status" vs "Status")
    // must be de-collided to "… (Excel)", not appear as a confusing second bare column.
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', prefillValues: { status: 'FROM_EXCEL' }, enrollment: enrolled({ status: 'REJECTED' }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Status']).toBe('REJECTED');          // built-in preserved
    expect(rows[0]['status (Excel)']).toBe('FROM_EXCEL'); // lowercase Excel col de-collided
    expect(rows[0]['status']).toBeUndefined();            // NOT a bare lowercase duplicate
  });

  it('de-collides an uploaded "Enrollment Status" (semantic synonym of the live Status) → "(Excel)"', () => {
    // Client complaint 2026-09-17: a roster upload carried its OWN frozen "Enrollment Status"
    // column that contradicts the live built-in "Status" (e.g. Status=SUBMITTED but the sheet
    // said NOT_ENROLLED). It matches no reserved header by text, so it used to surface as a
    // confusing second bare column. It must now be de-collided to "Enrollment Status (Excel)".
    const roster: ExportRosterRow[] = [
      row({
        outletRef: 'A',
        prefillValues: { 'Enrollment Status': 'NOT_ENROLLED' },
        enrollment: enrolled({ status: 'SUBMITTED' }),
      }),
    ];
    const { rows, columns } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Status']).toBe('SUBMITTED');                       // live built-in preserved
    expect(rows[0]['Enrollment Status (Excel)']).toBe('NOT_ENROLLED'); // upload de-collided, data kept
    expect(rows[0]['Enrollment Status']).toBeUndefined();             // NO confusing bare duplicate
    expect(columns).toEqual(
      expect.arrayContaining([{ name: 'Enrollment Status (Excel)', source: 'Audience Excel upload' }]),
    );
  });

  it('keeps BOTH columns when an upload has "Enrollment Status" AND a literal "Enrollment Status (Excel)"', () => {
    // Hardening (audit 2026-09-17): the synonym de-collide turns "Enrollment Status" into
    // "Enrollment Status (Excel)"; if the sheet ALSO literally has that header, the two must
    // NOT collapse onto one row key (silent data loss). The second is suffixed with a counter.
    const roster: ExportRosterRow[] = [
      row({
        outletRef: 'A',
        prefillValues: { 'Enrollment Status': 'SYNONYM_VAL', 'Enrollment Status (Excel)': 'LITERAL_VAL' },
      }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Enrollment Status (Excel)']).toBe('SYNONYM_VAL');     // synonym-suffixed, first
    expect(rows[0]['Enrollment Status (Excel) (2)']).toBe('LITERAL_VAL'); // literal, counter-suffixed
    expect(rows[0]['Enrollment Status']).toBeUndefined();                 // no confusing bare status
  });

  it('de-collides the per-photo geo companion from a form field with the same label', () => {
    // A media field "Photo" that carries geo produces a "Photo (Geo)" companion column. A
    // separate text field literally labelled "Photo (Geo)" must NOT clobber it — the field
    // keeps "Photo (Geo)", the geo companion yields to "Photo (Geo) (2)". Both values kept.
    const mediaAndClash: FormField[] = [
      field({ id: 'f_photo', type: 'CAMERA', label: 'Photo', order: 1 }),
      field({ id: 'f_clash', type: 'TEXT', label: 'Photo (Geo)', order: 2 }),
    ];
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', enrollment: enrolled({ formValues: {
        f_photo: { key: 'gcs/p.jpg', geo: { lat: 12.9, lng: 77.6, accuracy: 8 } },
        f_clash: 'typed text',
      } }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, mediaAndClash, link);
    expect(rows[0]['Photo (Geo)']).toBe('typed text');       // the text field keeps the name
    expect(rows[0]['Photo (Geo) (2)']).toBe('12.9, 77.6 (±8m)'); // geo companion de-collided, value kept
  });

  it('de-collides a FORM FIELD label that clashes with a built-in column (does not clobber Outlet Name)', () => {
    // A form field literally labelled "Outlet Name" must NOT overwrite the built-in
    // Outlet Name column. The original bug: form-field cells are written AFTER the
    // built-in cells under the same row object, so an "Outlet Name" field clobbered the
    // real name with its (empty, on un-enrolled rows) captured value → blank report.
    const collidingFields: FormField[] = [field({ id: 'f_on', type: 'TEXT', label: 'Outlet Name', order: 1 })];
    const roster: ExportRosterRow[] = [
      // Enrolled: the field HAS a captured value → the two columns are distinct.
      row({ outletRef: 'A', outletName: 'Ambey Stores', enrollment: enrolled({ formValues: { f_on: 'Typed Name' } }) }),
      // Un-enrolled: the field is EMPTY — this is the row the bug blanked.
      row({ outletRef: 'B', outletName: 'Baquai' }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, collidingFields, link);
    // Built-in Outlet Name preserved (NOT clobbered) on BOTH rows.
    expect(rows[0]['Outlet Name']).toBe('Ambey Stores');
    expect(rows[1]['Outlet Name']).toBe('Baquai');
    // The form field is still surfaced, under a de-collided "(Form)" header.
    expect(rows[0]['Outlet Name (Form)']).toBe('Typed Name');
    expect(rows[1]['Outlet Name (Form)']).toBe('');
  });

  it('de-collides a form-field label that matches a built-in column case-INSENSITIVELY', () => {
    // Parity with the Excel side: a field "status" (lowercase) must be de-collided to
    // "status (Form)", not sit beside the built-in "Status" as a confusing near-duplicate.
    const f: FormField[] = [field({ id: 'f_s', type: 'TEXT', label: 'status', order: 1 })];
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', enrollment: enrolled({ status: 'SUBMITTED', formValues: { f_s: 'typed' } }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, f, link);
    expect(rows[0]['Status']).toBe('SUBMITTED');    // built-in preserved
    expect(rows[0]['status (Form)']).toBe('typed'); // field de-collided
    expect(rows[0]['status']).toBeUndefined();      // no bare lowercase near-duplicate
  });

  it('falls back Outlet Name to the matched outlet name when the uploaded name is blank', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', outletName: '', matchedOutletName: 'Real Loyalty Outlet', matchedOutletId: 'o1' }),
      row({ outletRef: 'B', outletName: 'Uploaded Name', matchedOutletName: 'Ignored' }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Outlet Name']).toBe('Real Loyalty Outlet');
    expect(rows[1]['Outlet Name']).toBe('Uploaded Name');
  });

  // ── Bug 1: standalone row whose name lives in a non-standard prefill header ──
  it('shows the Outlet Name from a "Shop Name" prefill column for a standalone row, without duplicating it', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', outletName: '', matchedOutletName: null, matchedOutletId: null, prefillValues: { 'Shop Name': 'Corner Store', Beat: 'North' } }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Outlet Name']).toBe('Corner Store');
    // The consumed name column is NOT re-emitted as its own Excel column…
    expect(Object.keys(rows[0])).not.toContain('Shop Name');
    // …but a genuinely-unrelated prefill column (Beat) still appears.
    expect(rows[0]['Beat']).toBe('North');
  });

  // ── Bug 3: a field pinned from a prefill header → ONE merged column ──────────
  it('merges a field.prefillKey with its uploaded header into ONE column (no "(Excel)" duplicate)', () => {
    const beat = field({ id: 'f_beat', type: 'TEXT', label: 'Beat', prefillKey: 'Beat', order: 1 });
    const roster: ExportRosterRow[] = [
      // un-enrolled: captured empty → falls back to the uploaded prefill value.
      row({ outletRef: 'A', prefillValues: { Beat: 'North', Region: 'West' } }),
      // enrolled: captured value wins over the prefill.
      row({ outletRef: 'B', prefillValues: { Beat: 'South' }, enrollment: enrolled({ formValues: { f_beat: 'CapturedBeat' } }) }),
    ];
    const { rows, columns } = buildEnrollmentExportRows(roster, [beat], link);
    // Exactly ONE Beat column, no "(Excel)" duplicate.
    expect(Object.keys(rows[0])).toContain('Beat');
    expect(Object.keys(rows[0])).not.toContain('Beat (Excel)');
    // (a)/(b) un-enrolled shows the prefill value.
    expect(rows[0]['Beat']).toBe('North');
    // (c) enrolled shows the captured value.
    expect(rows[1]['Beat']).toBe('CapturedBeat');
    // (d) a genuinely-unrelated prefill header still appears as its own column.
    expect(rows[0]['Region']).toBe('West');
    expect(columns.filter((c) => c.name === 'Beat')).toHaveLength(1);
    expect(columns.some((c) => c.name === 'Beat (Excel)')).toBe(false);
  });

  it('an uploaded Excel cell holding a scheme-media key is linked, never written as text', () => {
    const k = 'scheme-media/deoleo/2026-09/x-board.jpg';
    const { rows } = buildEnrollmentExportRows([row({ prefillValues: { 'Board Photo': k } })], fields, link);
    expect(rows[0]['Board Photo']).toEqual(link(k));
  });

  it('lists every column with its source in the legend, in column order', () => {
    const { columns } = buildEnrollmentExportRows([row({ prefillValues: { Slab: 'Gold' } })], fields, link);
    const names = columns.map((c) => c.name);
    expect(names).toEqual([
      'Outlet Ref', 'Outlet Name', 'Matched', 'Tagged Employee', 'Submitted By (Employee)',
      'Slab',
      'Zone', 'Program', 'Sub-Program', 'Outlet Type',
      'Status', 'Version', 'Enrolled At', 'Submitted By', 'Submitted By Phone', 'Rejection Reason',
      'Owner', 'Photo',
    ]);
    expect(columns.find((c) => c.name === 'Owner')?.source).toBe('Captured on the enrollment form');
    expect(columns.find((c) => c.name === 'Photo')?.source).toContain('"Open photo" / "Open file" link (sign-in needed');
    expect(columns.find((c) => c.name === 'Zone')?.source).toBe('Matched loyalty outlet master');
  });
});

// ── Bug 2: buildXlsx emits a real hyperlink cell (`.l.Target`) ────────────────
describe('buildXlsx hyperlink cells (bug 2)', () => {
  it('writes a HyperlinkCell as a SheetJS cell with .l.Target set + cellSafe display text', () => {
    const link: HyperlinkCell = { __hyperlink: true, text: 'View image', target: 'https://h/v1/schemes/media/view?token=T' };
    expect(isHyperlinkCell(link)).toBe(true);
    const buf = buildXlsx([{ name: 'S', rows: [{ Name: 'Shop', Photo: link }] }]);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets['S'];
    const cell = cellByHeader(ws, 'Photo', 0);
    expect(cell?.v).toBe('View image');
    expect(cell?.l?.Target).toBe('https://h/v1/schemes/media/view?token=T');
  });
});

const mockPrisma = {
  scheme: { findFirst: jest.fn() },
  schemeOutlet: { findMany: jest.fn() },
  schemeEnrollment: { findMany: jest.fn(), findUnique: jest.fn() },
  schemeEnrollmentForm: { findUnique: jest.fn() },
  outlet: { count: jest.fn() },
  clientDomain: { findMany: jest.fn() },
  // Per-tenant outlet-type display names (loadOutletTypeDisplayNames). Defaults to [] in
  // beforeEach ⇒ empty display map ⇒ reports fall back to outletType.name (Deoleo parity).
  outletTypeClientConfig: { findMany: jest.fn() },
};
const mockJwt = { sign: jest.fn(() => 'TESTTOKEN'), verify: jest.fn() };
const mockConfig = { get: jest.fn(() => 'test-secret') };
const mockStorage = { openBoundedObject: jest.fn() };

describe('SchemeReportService', () => {
  let service: SchemeReportService;

  const asTenant = (clientId: string, sub = 'admin1') =>
    ({ sub, clientId, role: 'CLIENT_ADMIN' } as any);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockJwt.sign.mockReturnValue('TESTTOKEN');
    mockConfig.get.mockReturnValue('test-secret');
    // Default: tenant has NO per-type displayName → empty map → outletType.name passes through.
    mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
    mockPrisma.clientDomain.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemeReportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    service = module.get(SchemeReportService);
  });

  describe('aggregation', () => {
    beforeEach(() => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', name: 'Scheme 1', status: 'ACTIVE', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { id: 'r1', outletRef: 'A1', outletName: 'A1', matchedOutletId: 'o1', matchedOutlet: { zone: 'W', programName: 'P', outletType: { name: 'Retail' } } },
        { id: 'r2', outletRef: 'A2', outletName: 'A2', matchedOutletId: 'o2', matchedOutlet: { zone: 'W', programName: 'P', outletType: { name: 'Retail' } } },
        { id: 'r3', outletRef: 'A3', outletName: 'A3', matchedOutletId: 'o3', matchedOutlet: { zone: 'E', programName: 'Q', outletType: { name: 'MT' } } },
        { id: 'r4', outletRef: 'A4', outletName: 'A4', matchedOutletId: null, matchedOutlet: null },
      ]);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([
        { schemeOutletId: 'r1', status: 'SUBMITTED' },
        { schemeOutletId: 'r3', status: 'REJECTED' },
      ]);
    });

    it('gifsyReport computes counts, coverage %, and breakdowns', async () => {
      const rep = await service.gifsyReport(asTenant('deoleo'), 's1');
      expect(rep.summary).toEqual({
        rosterCount: 4,
        enrolledCount: 2,
        submittedCount: 1,
        rejectedCount: 1,
        notEnrolledCount: 2,
        coveragePct: 50,
      });
      expect(rep.byStatus).toEqual({ SUBMITTED: 1, REJECTED: 1, NOT_ENROLLED: 2 });
      const w = rep.byZone.find((b) => b.key === 'W');
      expect(w).toEqual({ key: 'W', rosterCount: 2, enrolledCount: 1 });
      expect(rep.byZone.find((b) => b.key === 'Unspecified')).toEqual({ key: 'Unspecified', rosterCount: 1, enrolledCount: 0 });
    });

    it('breakdown + rows fall back to the roster’s OWN columns for a standalone (unmatched) row', async () => {
      // A matched row (uses the loyalty outlet) + a standalone row whose roster carries Zone /
      // Program Name / Outlet Type columns (as in the real SOND 26 "WS & Sub DB" scheme).
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { id: 'r1', outletRef: 'A1', outletName: 'A1', matchedOutletId: 'o1', prefillValues: null, matchedOutlet: { zone: 'W', programName: 'P', outletType: { id: 't', name: 'Retail' } } },
        { id: 'r2', outletRef: 'A2', outletName: 'A2', matchedOutletId: null, prefillValues: { City: 'Katihar', Zone: 'East', 'Program Name': 'SOND 26 WS and SubD', 'Outlet Type': 'SubD' }, matchedOutlet: null },
      ]);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([{ schemeOutletId: 'r2', status: 'SUBMITTED' }]);

      const rep = await service.gifsyReport(asTenant('deoleo'), 's1');
      // The standalone row is attributed to its OWN roster columns, NOT "Unspecified".
      expect(rep.byZone.find((b) => b.key === 'East')).toEqual({ key: 'East', rosterCount: 1, enrolledCount: 1 });
      expect(rep.byZone.find((b) => b.key === 'Unspecified')).toBeUndefined();
      expect(rep.byProgram.find((b) => b.key === 'SOND 26 WS and SubD')).toMatchObject({ rosterCount: 1 });
      expect(rep.byOutletType.find((b) => b.key === 'SubD')).toMatchObject({ rosterCount: 1 });
      // The matched row is unchanged (its loyalty-outlet value wins).
      expect(rep.byZone.find((b) => b.key === 'W')).toMatchObject({ rosterCount: 1 });

      // The on-screen tenant row list reflects the same fallback.
      const trep = await service.tenantReport(asTenant('deoleo'), 's1');
      expect(trep.rows.find((r) => r.outletRef === 'A2')).toMatchObject({ matched: false, zone: 'East', program: 'SOND 26 WS and SubD', outletType: 'SubD' });
    });

    it('tenantReport returns aggregates + a row list with NO raw media/formValues', async () => {
      const rep = await service.tenantReport(asTenant('deoleo'), 's1');
      expect(rep.summary.rosterCount).toBe(4);
      expect(rep.rows).toHaveLength(4);
      const r1 = rep.rows.find((r) => r.outletRef === 'A1');
      expect(r1).toEqual({ outletRef: 'A1', outletName: 'A1', matched: true, zone: 'W', program: 'P', outletType: 'Retail', status: 'SUBMITTED' });
      expect(JSON.stringify(rep.rows)).not.toContain('formValues');
      const standalone = rep.rows.find((r) => r.outletRef === 'A4');
      expect(standalone).toMatchObject({ matched: false, status: 'NOT_ENROLLED' });
    });

    it('throws NotFound for a cross-tenant scheme', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.gifsyReport(asTenant('other', 'x'), 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    // ── Per-tenant outlet-type display name (displayName ?? name) ──────────────
    it('renders the tenant displayName for a renamed outlet type (row + byOutletType breakdown)', async () => {
      // The scheme belongs to tenant "bajaj" — display names are scoped to the SCHEME's tenant.
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', name: 'Scheme 1', status: 'ACTIVE', clientId: 'bajaj' });
      // Roster carries outletType.id so the per-tenant config can key onto it.
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { id: 'r1', outletRef: 'A1', outletName: 'A1', matchedOutletId: 'o1', matchedOutlet: { zone: 'W', programName: 'P', outletType: { id: 'ot_sss', name: 'SSS' } } },
        { id: 'r2', outletRef: 'A2', outletName: 'A2', matchedOutletId: 'o2', matchedOutlet: { zone: 'W', programName: 'P', outletType: { id: 'ot_sss', name: 'SSS' } } },
      ]);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([{ schemeOutletId: 'r1', status: 'SUBMITTED' }]);
      // Tenant renamed OutletType ot_sss → "Retailer".
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot_sss', displayName: 'Retailer' },
      ]);

      const rep = await service.tenantReport(asTenant('bajaj'), 's1');
      expect(rep.rows.every((r) => r.outletType === 'Retailer')).toBe(true);
      expect(rep.byOutletType).toEqual([{ key: 'Retailer', rosterCount: 2, enrolledCount: 1 }]);
      // The config lookup is scoped to the scheme's tenant.
      expect(mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'bajaj' });
    });

    it('falls back to outletType.name when the tenant set no displayName (Deoleo parity)', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { id: 'r1', outletRef: 'A1', outletName: 'A1', matchedOutletId: 'o1', matchedOutlet: { zone: 'W', programName: 'P', outletType: { id: 'ot_sss', name: 'SSS' } } },
      ]);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([]);
      // Default empty config (beforeEach) ⇒ empty map ⇒ original name.
      const rep = await service.tenantReport(asTenant('deoleo'), 's1');
      expect(rep.rows[0].outletType).toBe('SSS');
      expect(rep.byOutletType).toEqual([{ key: 'SSS', rosterCount: 1, enrolledCount: 0 }]);
    });
  });

  describe('coverage denominator (B-MED-2)', () => {
    const liveRuleRoster = [
      { id: 'r1', outletRef: 'A1', outletName: 'A1', matchedOutletId: 'o1', matchedOutlet: { zone: 'W', programName: 'P', outletType: { name: 'Retail' } } },
      { id: 'r2', outletRef: 'A2', outletName: 'A2', matchedOutletId: 'o2', matchedOutlet: { zone: 'W', programName: 'P', outletType: { name: 'Retail' } } },
    ];

    it('measures coverage against filter-eligible outlets, NOT the lazy roster', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({
        id: 's1', code: 'SC1', name: 'Scheme 1', status: 'ACTIVE', clientId: 'deoleo',
        audienceConfig: { mode: 'FILTER', frozen: false, selfEnrollAllowed: true, filter: { zones: ['W'], kycApprovedOnly: false } },
      });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue(liveRuleRoster);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([
        { schemeOutletId: 'r1', status: 'SUBMITTED' },
        { schemeOutletId: 'r2', status: 'SUBMITTED' },
      ]);
      mockPrisma.outlet.count.mockResolvedValue(10);

      const rep = await service.gifsyReport(asTenant('deoleo'), 's1');

      expect(mockPrisma.outlet.count).toHaveBeenCalledTimes(1);
      expect(mockPrisma.outlet.count.mock.calls[0][0].where).toMatchObject({
        clientId: 'deoleo', deletedAt: null, zone: { in: ['W'] },
      });
      expect(rep.summary.coveragePct).toBe(20);
      expect(rep.summary.notEnrolledCount).toBe(8);
      expect(rep.coverageDenominator).toBe(10);
      expect(rep.audienceMode).toBe('FILTER');
      expect(rep.frozen).toBe(false);
    });

    it('uses the roster count for a FILTER-FROZEN scheme (fixed roster)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({
        id: 's1', code: 'SC1', name: 'Scheme 1', status: 'ACTIVE', clientId: 'deoleo',
        audienceConfig: { mode: 'FILTER', frozen: true, selfEnrollAllowed: false, filter: { zones: ['W'], kycApprovedOnly: false } },
      });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue(liveRuleRoster);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([{ schemeOutletId: 'r1', status: 'SUBMITTED' }]);

      const rep = await service.gifsyReport(asTenant('deoleo'), 's1');

      expect(mockPrisma.outlet.count).not.toHaveBeenCalled();
      expect(rep.coverageDenominator).toBe(2);
      expect(rep.summary.coveragePct).toBe(50);
      expect(rep.frozen).toBe(true);
    });
  });

  describe('exportEnrollments (end-to-end xlsx)', () => {
    const ORIG_LINK_ENV = process.env.TENANT_LINK_ENV;
    afterEach(() => {
      if (ORIG_LINK_ENV === undefined) delete process.env.TENANT_LINK_ENV;
      else process.env.TENANT_LINK_ENV = ORIG_LINK_ENV;
      SCHEME_LINK_LIMIT.perSheet = 60_000;
    });

    const KEY = 'scheme-media/deoleo/2026-09/0b7c-shop.jpg';
    const PDF = 'scheme-media/deoleo/2026-09/0b7c-gst.pdf';
    const LEGACY_UPI = 'scheme-media/deoleo/2026-09/0b7c-upi_qr.jpg';
    const rosterRow = (ref: string, formValues: Record<string, unknown>, prefillValues: Record<string, unknown> | null = { Tier: 'Gold' }) => ({
      outletRef: ref, outletName: 'Shop', matchedOutletId: 'o1',
      prefillValues,
      taggedSalesUser: { employeeCode: 'E1' },
      matchedOutlet: { name: 'Shop', zone: 'W', programName: 'P', programCategory: 'C', outletType: { name: 'Retail' } },
      enrollment: {
        id: `enr_${ref}`, status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
        deletedAt: null, submittedBy: { name: 'Rep', phone: '9990000001', salesUser: null },
        formValues,
      },
    });
    const FORM = {
      formSchema: {
        fields: [
          { id: 'f_note', type: 'TEXT', label: 'Note', order: 1 },
          { id: 'f_photo', type: 'CAMERA', label: 'Photo', order: 2 },
          { id: 'f_doc', type: 'DOCUMENT', label: 'GST certificate', order: 3 },
          { id: 'f_upi', type: 'UPI_QR_SCAN', label: 'UPI QR', order: 4 },
        ],
      },
    };

    /** Every cell value (display text) of every sheet — for the no-raw-key scan. */
    const allCellTexts = (wb: XLSX.WorkBook): string[] =>
      wb.SheetNames.flatMap((n) => {
        const ws = wb.Sheets[n];
        return Object.keys(ws).filter((a) => !a.startsWith('!')).map((a) => String((ws[a] as XLSX.CellObject).v ?? ''));
      });

    it('writes "Open photo" / "Open file" links to the signed-in viewer on the tenant portal host (prod), never a token, never a raw key', async () => {
      process.env.TENANT_LINK_ENV = 'production';
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        rosterRow('A1', { f_note: '=SUM(A1)', f_photo: { key: KEY, geo: { lat: 12.9, lng: 77.6, accuracy: 8 } }, f_doc: PDF, f_upi: LEGACY_UPI }),
        rosterRow('A2', { f_note: 'ok', f_upi: '9876543210@paytm' }, { Tier: 'Silver', 'Old Photo': KEY }),
      ]);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(FORM);
      mockPrisma.clientDomain.findMany.mockResolvedValue([{ domain: 'loyalty.deoleo.example', isPrimary: true }]);

      const file = await service.exportEnrollments(asTenant('deoleo'), 's1', 'http://localhost:3000');
      expect(file).toBeInstanceOf(StreamableFile);
      const buf = await streamToBuffer(file);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets['Enrollments'];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);

      // Domain lookup is pinned to the SCHEME's tenant.
      expect(mockPrisma.clientDomain.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'deoleo' } }));
      const enc = (k: string) => `https://loyalty.deoleo.example/schemes/photo?key=${encodeURIComponent(k)}`;
      const photo = cellByHeader(ws, 'Photo', 0);
      expect(photo?.v).toBe('Open photo');
      expect(photo?.l?.Target).toBe(enc(KEY));
      const doc = cellByHeader(ws, 'GST certificate', 0);
      expect(doc?.v).toBe('Open file');
      expect(doc?.l?.Target).toBe(enc(PDF));
      // Legacy UPI_QR_SCAN image key (pre 2026-09-14) → a link; a real VPA stays text.
      expect(cellByHeader(ws, 'UPI QR', 0)?.l?.Target).toBe(enc(LEGACY_UPI));
      expect(rows[1]['UPI QR']).toBe('9876543210@paytm');
      // An uploaded Excel column holding a key → a link too.
      expect(cellByHeader(ws, 'Old Photo', 1)?.l?.Target).toBe(enc(KEY));
      // No token is minted any more.
      expect(mockJwt.sign).not.toHaveBeenCalled();
      // cellSafe escaped the formula so Excel treats it as text (leading apostrophe).
      expect(rows[0]['Note']).toBe("'=SUM(A1)");
      expect(rows[0]['Tier']).toBe('Gold');

      // NO raw `scheme-media/` key in ANY cell of ANY sheet (the links' URL-encoded key lives only in .l.Target).
      const texts = allCellTexts(wb);
      expect(texts.filter((t) => t.includes('scheme-media/'))).toEqual([]);
      expect(buf.includes(Buffer.from('/v1/schemes/media/view'))).toBe(false);

      // About sheet: links need sign-in, name the host.
      const about = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['About']);
      const links = about.find((r) => r.Item === 'PHOTO / FILE LINKS')?.Details ?? '';
      expect(links).toContain('signed in');
      expect(links).toContain('loyalty.deoleo.example');
      expect(about.some((r) => r.Item === 'LINK LIMIT')).toBe(false);
    });

    it('staging links use the uat- host; no primary domain → <slug>.gifsy.in with a note on About', async () => {
      process.env.TENANT_LINK_ENV = 'staging';
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([rosterRow('A1', { f_photo: KEY })]);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(FORM);
      mockPrisma.clientDomain.findMany.mockResolvedValue([]);
      const wb = XLSX.read(await streamToBuffer(await service.exportEnrollments(asTenant('deoleo'), 's1')), { type: 'buffer' });
      expect(cellByHeader(wb.Sheets['Enrollments'], 'Photo', 0)?.l?.Target).toBe(
        `https://uat-deoleo.gifsy.in/schemes/photo?key=${encodeURIComponent(KEY)}`,
      );
      const about = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['About']);
      expect(about.find((r) => r.Item === 'Link address')?.Details).toContain('no primary domain');
    });

    it('past the per-sheet hyperlink cap the rest carry the viewer URL as text, and About says how many', async () => {
      process.env.TENANT_LINK_ENV = 'production';
      SCHEME_LINK_LIMIT.perSheet = 1;
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([rosterRow('A1', { f_photo: KEY, f_doc: PDF })]);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(FORM);
      const wb = XLSX.read(await streamToBuffer(await service.exportEnrollments(asTenant('deoleo'), 's1')), { type: 'buffer' });
      const ws = wb.Sheets['Enrollments'];
      expect(cellByHeader(ws, 'Photo', 0)?.l?.Target).toContain('/schemes/photo?key=');
      const second = cellByHeader(ws, 'GST certificate', 0);
      expect(second?.l).toBeUndefined();
      expect(String(second?.v)).toBe(`https://deoleo.gifsy.in/schemes/photo?key=${encodeURIComponent(PDF)}`);
      const about = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['About']);
      expect(about.find((r) => r.Item === 'LINK LIMIT')?.Details).toContain('remaining 1');
      expect(allCellTexts(wb).filter((t) => t.includes('scheme-media/'))).toEqual([]);
    });

    it('surfaces the submitting rep employee code + falls back Outlet Name; a soft-deleted enrollment leaks NOTHING', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        {
          outletRef: 'A1', outletName: '', matchedOutletId: 'o1', prefillValues: { Tier: 'Gold' },
          taggedSalesUser: { employeeCode: 'E1' },
          matchedOutlet: { name: 'Real Outlet', zone: 'W', programName: 'P', programCategory: 'C', outletType: { name: 'Retail' } },
          enrollment: {
            id: 'enr1', status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
            deletedAt: null, submittedBy: { name: 'Rep', phone: '9990000001', salesUser: { employeeCode: 'EMP42' } },
            formValues: { f_secret: 'VISIBLE' },
          },
        },
        {
          outletRef: 'A2', outletName: 'Shop Two', matchedOutletId: null, prefillValues: null,
          taggedSalesUser: null, matchedOutlet: null,
          enrollment: {
            id: 'enr2', status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
            deletedAt: new Date('2026-07-26T00:00:00Z'), submittedBy: { name: 'Rep', phone: '9990000001', salesUser: null },
            formValues: { f_secret: 'LEAKED_SECRET' },
          },
        },
      ]);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue({
        formSchema: { fields: [{ id: 'f_secret', type: 'TEXT', label: 'Secret', order: 1 }] },
      });

      const file = await service.exportEnrollments(asTenant('deoleo'), 's1');
      const buf = await streamToBuffer(file);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Enrollments']);

      expect(rows[0]['Outlet Name']).toBe('Real Outlet');
      expect(rows[0]['Submitted By (Employee)']).toBe('EMP42');
      expect(rows[0]['Secret']).toBe('VISIBLE');
      expect(rows[1]).toMatchObject({ 'Outlet Ref': 'A2', Status: 'NOT_ENROLLED', Secret: '' });
      expect(buf.toString('latin1')).not.toContain('LEAKED_SECRET');
    });

    it('throws NotFound when the scheme has no roster', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([]);
      await expect(service.exportEnrollments(asTenant('deoleo'), 's1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Bug 2: PUBLIC tokenized media-view endpoint security contract ────────────
  describe('viewMediaByToken (PUBLIC)', () => {
    const goodPayload = { sub: 'enr1', clientId: 'deoleo', fieldId: 'f_photo', typ: 'schememedia' };
    const liveEnrollment = {
      formValues: { f_photo: 'scheme-media/deoleo/shop.jpg' },
      deletedAt: null,
      scheme: { clientId: 'deoleo' },
    };

    it('streams the tenant-verified object inline for a valid token', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(liveEnrollment);
      mockStorage.openBoundedObject.mockResolvedValue({ stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff])]), size: (Buffer.from([0xff, 0xd8, 0xff])).length, contentType: 'image/jpeg' });

      const res = await service.viewMediaByToken('tok');
      expect(res).toEqual({ stream: expect.anything(), size: expect.any(Number), contentType: 'image/jpeg', inline: true });
      // Verify pins HS256; the object key is resolved server-side (never from the token).
      expect(mockJwt.verify).toHaveBeenCalledWith('tok', expect.objectContaining({ algorithms: ['HS256'] }));
      expect(mockStorage.openBoundedObject).toHaveBeenCalledWith('scheme-media/deoleo/shop.jpg');
    });

    it('serves an unsafe mime as an octet-stream attachment (never inline)', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(liveEnrollment);
      mockStorage.openBoundedObject.mockResolvedValue({ stream: Readable.from([Buffer.from('x')]), size: (Buffer.from('x')).length, contentType: 'text/html' });

      const res = await service.viewMediaByToken('tok');
      expect(res).toMatchObject({ contentType: 'application/octet-stream', inline: false });
    });

    it('404s a missing token', async () => {
      await expect(service.viewMediaByToken('')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.schemeEnrollment.findUnique).not.toHaveBeenCalled();
    });

    it('404s a bad/expired token (verify throws)', async () => {
      mockJwt.verify.mockImplementation(() => { throw new Error('bad sig'); });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a wrong token type (replay guard)', async () => {
      mockJwt.verify.mockReturnValue({ ...goodPayload, typ: 'docview' });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.schemeEnrollment.findUnique).not.toHaveBeenCalled();
    });

    it('404s when the enrollment is not found', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('404s a soft-deleted enrollment', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ ...liveEnrollment, deletedAt: new Date() });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('404s when the roster row was REMOVED (schemeOutlet soft-deleted → media fails closed)', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({
        ...liveEnrollment,
        schemeOutlet: { deletedAt: new Date() },
      });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('404s a cross-tenant token (enrollment tenant ≠ token clientId)', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ ...liveEnrollment, scheme: { clientId: 'other' } });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('404s when the resolved key is not this tenant\'s scheme-media object', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({
        ...liveEnrollment,
        formValues: { f_photo: 'scheme-media/other/steal.jpg' },
      });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('404s when the field id holds no object key', async () => {
      mockJwt.verify.mockReturnValue({ ...goodPayload, fieldId: 'f_missing' });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(liveEnrollment);
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });
  });
});
