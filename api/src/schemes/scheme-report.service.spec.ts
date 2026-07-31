// Unit tests for SchemeReportService (Wave-0 scheme reports/export, D26/D30).
// Covers: report aggregation (counts, coverage %, breakdowns; standalone bucket),
// the tenant read-only row list (no raw media), the pure export row builder
// (uniform columns + media→auth-gated link), and an END-TO-END xlsx round-trip
// proving cellSafe (formula-injection escape) + media-link minting.
// Run: npx jest src/schemes/scheme-report.service.spec.ts

import * as XLSX from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, StreamableFile } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FormField } from './enrollment-form.helper';
import {
  SchemeReportService,
  buildEnrollmentExportRows,
  renderExportValue,
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

describe('renderExportValue (pure)', () => {
  const link = (k: string) => `/link/${k}`;

  it('renders a media field as an auth-gated link (not the raw key)', () => {
    expect(renderExportValue(field({ id: 'p', type: 'CAMERA' }), 'gcs/key.jpg', link)).toBe('/link/gcs/key.jpg');
    expect(renderExportValue(field({ id: 'd', type: 'DOCUMENT' }), 'gcs/doc.pdf', link)).toBe('/link/gcs/doc.pdf');
    expect(renderExportValue(field({ id: 'u', type: 'UPI_QR_SCAN' }), 'gcs/qr.png', link)).toBe('/link/gcs/qr.png');
  });

  it('treats SIGNATURE (a net-new media type) as media', () => {
    // SIGNATURE joins FORM_FIELD_TYPES via the sibling form-engine stream; the export
    // recognises it as media independently, so links work as soon as it lands.
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

  it('renders empty/null as blank', () => {
    expect(renderExportValue(field({ id: 't', type: 'TEXT' }), '', link)).toBe('');
    expect(renderExportValue(field({ id: 't', type: 'TEXT' }), null, link)).toBe('');
    expect(renderExportValue(field({ id: 'p', type: 'CAMERA' }), '', link)).toBe('');
  });
});

describe('buildEnrollmentExportRows (pure)', () => {
  const fields: FormField[] = [
    field({ id: 'f_name', type: 'TEXT', label: 'Owner', order: 1 }),
    field({ id: 'f_photo', type: 'CAMERA', label: 'Photo', order: 2 }),
  ];
  const link = (k: string) => `/media/${k}`;

  // Roster-row factory — fills the fixed base fields so tests only vary what matters.
  const row = (over: Partial<ExportRosterRow>): ExportRosterRow => ({
    outletRef: 'r', outletName: 'r', matchedOutletName: null, matchedOutletId: null,
    zone: null, programName: null, programCategory: null, outletType: null,
    taggedEmployeeCode: null, prefillValues: null, enrollment: null, ...over,
  });
  const enrolled = (over: Partial<NonNullable<ExportRosterRow['enrollment']>> = {}) => ({
    status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'),
    rejectionReason: null, submittedByName: 'Rep', submittedByPhone: '9990000001',
    submittedByEmployeeCode: null, formValues: {}, ...over,
  });

  it('gives EVERY row an identical key set even when the first row has no enrollment', () => {
    const roster: ExportRosterRow[] = [
      // first row deliberately un-enrolled — header is derived from row[0] by buildXlsx
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
    expect(rows[1]).toMatchObject({ Matched: 'Yes', Status: 'SUBMITTED', Owner: 'Ravi', Photo: '/media/gcs/p.jpg' });
  });

  it('de-collides duplicate field labels', () => {
    const dup = [field({ id: 'a', type: 'TEXT', label: 'Qty' }), field({ id: 'b', type: 'TEXT', label: 'Qty' })];
    const { rows } = buildEnrollmentExportRows([row({})], dup, link);
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['Qty', 'Qty (2)']));
  });

  it('emits the UNION of uploaded audience-Excel columns, filling blanks per row', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', prefillValues: { Slab: 'Gold', Target: '100' } }),
      row({ outletRef: 'B', prefillValues: { Slab: 'Silver', Region: 'West' } }), // no Target; adds Region
    ];
    const { rows, columns } = buildEnrollmentExportRows(roster, fields, link);
    // Union across rows: Slab, Target, Region all present on BOTH rows.
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['Slab', 'Target', 'Region']));
    expect(Object.keys(rows[1])).toEqual(expect.arrayContaining(['Slab', 'Target', 'Region']));
    expect(rows[0]).toMatchObject({ Slab: 'Gold', Target: '100', Region: '' }); // Region blank on row A
    expect(rows[1]).toMatchObject({ Slab: 'Silver', Target: '', Region: 'West' }); // Target blank on row B
    // Legend marks them as Excel-sourced.
    expect(columns).toEqual(expect.arrayContaining([{ name: 'Slab', source: 'Audience Excel upload' }]));
  });

  it('de-collides an Excel header that clashes with a base column (does not drop or overwrite it)', () => {
    // An uploaded column literally named "Status" must NOT clobber the enrollment Status base column.
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', prefillValues: { Status: 'FROM_EXCEL' }, enrollment: enrolled({ status: 'REJECTED' }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Status']).toBe('REJECTED'); // base column wins
    expect(rows[0]['Status (Excel)']).toBe('FROM_EXCEL'); // Excel value preserved, de-collided
  });

  it('falls back Outlet Name to the matched outlet name when the uploaded name is blank', () => {
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', outletName: '', matchedOutletName: 'Real Loyalty Outlet', matchedOutletId: 'o1' }),
      row({ outletRef: 'B', outletName: 'Uploaded Name', matchedOutletName: 'Ignored' }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, link);
    expect(rows[0]['Outlet Name']).toBe('Real Loyalty Outlet'); // fell back
    expect(rows[1]['Outlet Name']).toBe('Uploaded Name'); // uploaded wins when present
  });

  it('renders a media field as an ABSOLUTE link when the mintLink resolves a host', () => {
    const absLink = (k: string) => `https://deoleo.example.com/api/schemes/s1/enrollments/media?key=${encodeURIComponent(k)}`;
    const roster: ExportRosterRow[] = [
      row({ outletRef: 'A', enrollment: enrolled({ formValues: { f_photo: 'gcs/p.jpg' } }) }),
    ];
    const { rows } = buildEnrollmentExportRows(roster, fields, absLink);
    expect(rows[0]['Photo']).toBe('https://deoleo.example.com/api/schemes/s1/enrollments/media?key=gcs%2Fp.jpg');
  });

  it('lists every column with its source in the legend, in column order', () => {
    const { columns } = buildEnrollmentExportRows(
      [row({ prefillValues: { Slab: 'Gold' } })],
      fields,
      link,
    );
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

const mockPrisma = {
  scheme: { findFirst: jest.fn() },
  schemeOutlet: { findMany: jest.fn() },
  schemeEnrollment: { findMany: jest.fn() },
  schemeEnrollmentForm: { findUnique: jest.fn() },
  outlet: { count: jest.fn() },
};

describe('SchemeReportService', () => {
  let service: SchemeReportService;

  // A non-GIFSY tenant user → platformWide false → stays hard-pinned to `clientId`,
  // exercising the exact tenant-scoping the old `clientId` param did.
  const asTenant = (clientId: string, sub = 'admin1') =>
    ({ sub, clientId, role: 'CLIENT_ADMIN' } as any);

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemeReportService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(SchemeReportService);
  });

  describe('aggregation', () => {
    beforeEach(() => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', name: 'Scheme 1', status: 'ACTIVE', clientId: 'deoleo' });
      // 4 roster rows: 2 in zone W (1 enrolled), 1 zone E (rejected), 1 standalone (not enrolled).
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
      // Zone W: 2 roster / 1 enrolled; standalone bucket = 'Unspecified'.
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
      // No formValues / media leaked into the tenant row.
      expect(JSON.stringify(rep.rows)).not.toContain('formValues');
      const standalone = rep.rows.find((r) => r.outletRef === 'A4');
      expect(standalone).toMatchObject({ matched: false, status: 'NOT_ENROLLED' });
    });

    it('throws NotFound for a cross-tenant scheme', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.gifsyReport(asTenant('other', 'x'), 's1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── B-MED-2: coverage denominator for a live-rule filter scheme ─────────────
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
      // Only 2 lazy roster rows (both enrolled), but 10 outlets match the live filter.
      mockPrisma.schemeOutlet.findMany.mockResolvedValue(liveRuleRoster);
      mockPrisma.schemeEnrollment.findMany.mockResolvedValue([
        { schemeOutletId: 'r1', status: 'SUBMITTED' },
        { schemeOutletId: 'r2', status: 'SUBMITTED' },
      ]);
      mockPrisma.outlet.count.mockResolvedValue(10);

      const rep = await service.gifsyReport(asTenant('deoleo'), 's1');

      expect(mockPrisma.outlet.count).toHaveBeenCalledTimes(1);
      // filter passed through to the outlet-count query
      expect(mockPrisma.outlet.count.mock.calls[0][0].where).toMatchObject({
        clientId: 'deoleo', deletedAt: null, zone: { in: ['W'] },
      });
      // denominator = 10 eligible outlets → 2/10 = 20%, 8 not enrolled.
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
    it('mints an auth-gated media link and cellSafe-escapes a formula-injection value', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        {
          outletRef: 'A1', outletName: 'Shop', matchedOutletId: 'o1',
          prefillValues: { Tier: 'Gold' },
          taggedSalesUser: { employeeCode: 'E1' },
          matchedOutlet: { name: 'Shop', zone: 'W', programName: 'P', programCategory: 'C', outletType: { name: 'Retail' } },
          enrollment: {
            status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
            deletedAt: null, submittedBy: { name: 'Rep', phone: '9990000001', salesUser: null },
            // f_note carries a spreadsheet-injection payload; f_photo carries a media key.
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
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Enrollments']);

      // Media link points at the SESSION-gated scheme media-view route (NOT the raw
      // key, NOT a self-authenticating token) — identical to 1B's extractMedia path.
      // No host threaded in → proxy-RELATIVE form.
      expect(rows[0]['Photo']).toBe('/api/schemes/s1/enrollments/media?key=gcs%2Fshop.jpg');
      // cellSafe escaped the formula so Excel treats it as text (leading apostrophe).
      expect(rows[0]['Note']).toBe("'=SUM(A1)");
      expect(rows[0]['Tagged Employee']).toBe('E1');

      // A second "Columns" legend sheet documents every column's source.
      const legend = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Columns']);
      expect(legend.find((c) => c.Column === 'Photo')?.Source).toBe('Captured on the enrollment form');
      expect(legend.find((c) => c.Column === 'Tier')?.Source).toBe('Audience Excel upload');
      // Uploaded audience-Excel column surfaced under its original header.
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
            status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
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
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Enrollments']);
      expect(rows[0]['Photo']).toBe('https://deoleo.gifsy.in/api/schemes/s1/enrollments/media?key=gcs%2Fshop.jpg');
    });

    it('surfaces the submitting rep employee code + falls back Outlet Name; a soft-deleted enrollment leaks NOTHING', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        // Row 1: blank uploaded name → falls back to the matched outlet's real name; submitter is a SalesUser.
        {
          outletRef: 'A1', outletName: '', matchedOutletId: 'o1', prefillValues: { Tier: 'Gold' },
          taggedSalesUser: { employeeCode: 'E1' },
          matchedOutlet: { name: 'Real Outlet', zone: 'W', programName: 'P', programCategory: 'C', outletType: { name: 'Retail' } },
          enrollment: {
            status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
            deletedAt: null, submittedBy: { name: 'Rep', phone: '9990000001', salesUser: { employeeCode: 'EMP42' } },
            formValues: { f_secret: 'VISIBLE' },
          },
        },
        // Row 2: SOFT-DELETED enrollment — reads as NOT_ENROLLED; its captured value must never appear.
        {
          outletRef: 'A2', outletName: 'Shop Two', matchedOutletId: null, prefillValues: null,
          taggedSalesUser: null, matchedOutlet: null,
          enrollment: {
            status: 'SUBMITTED', currentVersion: 1, enrolledAt: new Date('2026-07-25T00:00:00Z'), rejectionReason: null,
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

      expect(rows[0]['Outlet Name']).toBe('Real Outlet'); // fell back to matched name
      expect(rows[0]['Submitted By (Employee)']).toBe('EMP42');
      expect(rows[0]['Secret']).toBe('VISIBLE');
      // Soft-deleted row: NOT_ENROLLED, no captured value anywhere in the workbook.
      expect(rows[1]).toMatchObject({ 'Outlet Ref': 'A2', Status: 'NOT_ENROLLED', Secret: '' });
      expect(buf.toString('latin1')).not.toContain('LEAKED_SECRET');
    });

    it('throws NotFound when the scheme has no roster', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SC1', clientId: 'deoleo' });
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([]);
      await expect(service.exportEnrollments(asTenant('deoleo'), 's1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
