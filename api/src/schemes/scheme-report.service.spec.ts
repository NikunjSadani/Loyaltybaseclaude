// Unit tests for SchemeReportService (Wave-0 scheme reports/export, D26/D30).
// Covers: report aggregation (counts, coverage %, breakdowns; standalone bucket),
// the tenant read-only row list (no raw media), the pure export row builder
// (uniform columns + media→REAL Excel hyperlink, bugs 1/3), an END-TO-END xlsx
// round-trip proving cellSafe + tokenized-media-hyperlink minting (bug 2), and the
// PUBLIC tokenized media-view endpoint's security contract.
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
  // mintLink now takes (submissionId, fieldId); renderExportValue's third arg is the
  // media-only (key)=>url closure the builder binds per row+field.
  const link = (k: string) => `/link/${k}`;

  it('renders a media field as a REAL hyperlink cell (not the raw key)', () => {
    const cam = renderExportValue(field({ id: 'p', type: 'CAMERA' }), 'gcs/key.jpg', link);
    expect(cam).toEqual({ __hyperlink: true, text: 'View image', target: '/link/gcs/key.jpg' });
    const doc = renderExportValue(field({ id: 'd', type: 'DOCUMENT' }), 'gcs/doc.pdf', link);
    expect(doc).toEqual({ __hyperlink: true, text: 'View image', target: '/link/gcs/doc.pdf' });
  });

  it('treats SIGNATURE (a net-new media type) as media', () => {
    expect(MEDIA_FIELD_TYPES.has('SIGNATURE')).toBe(true);
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
  // mintLink(submissionId, fieldId) → the media URL.
  const link = (sub: string, fid: string) => `/media/${sub}/${fid}`;

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
    // Photo is a real hyperlink cell whose target uses the row's enrollment id + field id.
    expect(rows[1]['Photo']).toEqual({ __hyperlink: true, text: 'View image', target: '/media/enr_X1/f_photo' });
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

  it('renders a media field as an ABSOLUTE hyperlink when the mintLink resolves a host', () => {
    const absLink = (sub: string, fid: string) =>
      `https://deoleo.example.com/v1/schemes/media/view?token=tok_${sub}_${fid}`;
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', enrollment: enrolled({ formValues: { f_photo: 'gcs/p.jpg' } }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, absLink);
    expect(rows[0]['Photo']).toEqual({
      __hyperlink: true,
      text: 'View image',
      target: 'https://deoleo.example.com/v1/schemes/media/view?token=tok_enr_A_f_photo',
    });
  });

  it('lists every column with its source in the legend, in column order', () => {
    const { columns } = buildEnrollmentExportRows([row({ prefillValues: { Slab: 'Gold' } })], fields, link);
    const names = columns.map((c) => c.name);
    expect(names).toEqual([
      'Outlet Ref', 'Outlet Name', 'Matched', 'Tagged Employee', 'Submitted By (Employee)',
      'Slab',
      'Zone', 'Program', 'Program Category', 'Outlet Type',
      'Status', 'Version', 'Enrolled At', 'Submitted By', 'Submitted By Phone', 'Rejection Reason',
      'Owner', 'Photo',
    ]);
    expect(columns.find((c) => c.name === 'Owner')?.source).toBe('Captured on the enrollment form');
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
};
const mockJwt = { sign: jest.fn(() => 'TESTTOKEN'), verify: jest.fn() };
const mockConfig = { get: jest.fn(() => 'test-secret') };
const mockStorage = { downloadBytes: jest.fn() };

describe('SchemeReportService', () => {
  let service: SchemeReportService;

  const asTenant = (clientId: string, sub = 'admin1') =>
    ({ sub, clientId, role: 'CLIENT_ADMIN' } as any);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockJwt.sign.mockReturnValue('TESTTOKEN');
    mockConfig.get.mockReturnValue('test-secret');
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
    it('mints a tokenized media hyperlink and cellSafe-escapes a formula-injection value', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        {
          outletRef: 'A1', outletName: 'Shop', matchedOutletId: 'o1',
          prefillValues: { Tier: 'Gold' },
          taggedSalesUser: { employeeCode: 'E1' },
          matchedOutlet: { name: 'Shop', zone: 'W', programName: 'P', programCategory: 'C', outletType: { name: 'Retail' } },
          enrollment: {
            id: 'enr1', status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
            deletedAt: null, submittedBy: { name: 'Rep', phone: '9990000001', salesUser: null },
            formValues: { f_note: '=SUM(A1)', f_photo: 'gcs/shop.jpg' },
          },
        },
      ]);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue({
        formSchema: {
          fields: [
            { id: 'f_note', type: 'TEXT', label: 'Note', order: 1 },
            { id: 'f_photo', type: 'CAMERA', label: 'Photo', order: 2 },
          ],
        },
      });

      const file = await service.exportEnrollments(asTenant('deoleo'), 's1');
      expect(file).toBeInstanceOf(StreamableFile);

      const buf = await streamToBuffer(file);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets['Enrollments'];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);

      // Media cell displays "View image" and carries a real hyperlink to the PUBLIC
      // tokenized backend route (path-relative form — no host threaded in).
      const photoCell = cellByHeader(ws, 'Photo', 0);
      expect(photoCell?.v).toBe('View image');
      expect(photoCell?.l?.Target).toBe('/v1/schemes/media/view?token=TESTTOKEN');
      // The token is minted with the enrollment id, tenant, field id, and type gate.
      expect(mockJwt.sign).toHaveBeenCalledWith(
        { sub: 'enr1', clientId: 'deoleo', fieldId: 'f_photo', typ: 'schememedia' },
        expect.objectContaining({ expiresIn: '30d' }),
      );
      // cellSafe escaped the formula so Excel treats it as text (leading apostrophe).
      expect(rows[0]['Note']).toBe("'=SUM(A1)");
      expect(rows[0]['Tagged Employee']).toBe('E1');

      const legend = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Columns']);
      expect(legend.find((c) => c.Column === 'Photo')?.Source).toBe('Captured on the enrollment form');
      expect(legend.find((c) => c.Column === 'Tier')?.Source).toBe('Audience Excel upload');
      expect(rows[0]['Tier']).toBe('Gold');
    });

    it('makes media links ABSOLUTE against the resolved host', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        {
          outletRef: 'A1', outletName: 'Shop', matchedOutletId: 'o1', prefillValues: null,
          taggedSalesUser: { employeeCode: 'E1' },
          matchedOutlet: { name: 'Shop', zone: 'W', programName: 'P', programCategory: 'C', outletType: { name: 'Retail' } },
          enrollment: {
            id: 'enr1', status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
            deletedAt: null, submittedBy: { name: 'Rep', phone: '9990000001', salesUser: null },
            formValues: { f_photo: 'gcs/shop.jpg' },
          },
        },
      ]);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue({
        formSchema: { fields: [{ id: 'f_photo', type: 'CAMERA', label: 'Photo', order: 1 }] },
      });

      const file = await service.exportEnrollments(asTenant('deoleo'), 's1', 'deoleo.gifsy.in');
      const wb = XLSX.read(await streamToBuffer(file), { type: 'buffer' });
      const ws = wb.Sheets['Enrollments'];
      const photoCell = cellByHeader(ws, 'Photo', 0);
      expect(photoCell?.l?.Target).toBe('https://deoleo.gifsy.in/v1/schemes/media/view?token=TESTTOKEN');
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
      mockStorage.downloadBytes.mockResolvedValue({ bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' });

      const res = await service.viewMediaByToken('tok');
      expect(res).toEqual({ bytes: expect.any(Buffer), contentType: 'image/jpeg', inline: true });
      // Verify pins HS256; the object key is resolved server-side (never from the token).
      expect(mockJwt.verify).toHaveBeenCalledWith('tok', expect.objectContaining({ algorithms: ['HS256'] }));
      expect(mockStorage.downloadBytes).toHaveBeenCalledWith('scheme-media/deoleo/shop.jpg');
    });

    it('serves an unsafe mime as an octet-stream attachment (never inline)', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(liveEnrollment);
      mockStorage.downloadBytes.mockResolvedValue({ bytes: Buffer.from('x'), contentType: 'text/html' });

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
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s a soft-deleted enrollment', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ ...liveEnrollment, deletedAt: new Date() });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s when the roster row was REMOVED (schemeOutlet soft-deleted → media fails closed)', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({
        ...liveEnrollment,
        schemeOutlet: { deletedAt: new Date() },
      });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s a cross-tenant token (enrollment tenant ≠ token clientId)', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ ...liveEnrollment, scheme: { clientId: 'other' } });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s when the resolved key is not this tenant\'s scheme-media object', async () => {
      mockJwt.verify.mockReturnValue(goodPayload);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({
        ...liveEnrollment,
        formValues: { f_photo: 'scheme-media/other/steal.jpg' },
      });
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s when the field id holds no object key', async () => {
      mockJwt.verify.mockReturnValue({ ...goodPayload, fieldId: 'f_missing' });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(liveEnrollment);
      await expect(service.viewMediaByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });
  });
});
