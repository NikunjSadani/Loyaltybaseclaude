/**
 * Unit tests for P6.5b TDS upload + liability tracker.
 * Tests: off-platform upload (preview vs apply), blank-PAN rejected,
 * amount→paise, uploadBatchId stamped; deposit upload 194R vs 194C;
 * liability read (including negative over-deposit outstanding).
 *
 * Run: npx jest src/tds/tds.upload.spec.ts
 */

import * as XLSX from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { TdsService } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseOffPlatformUpload,
  parseDepositUpload,
  buildOffPlatformTemplate,
  buildDepositTemplate,
} from './tds.helpers';

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

const mockPrisma = {
  creditPayoutEntry: { findMany: jest.fn() },
  creditField: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
  tdsOffPlatformEntry: { findMany: jest.fn(), createMany: jest.fn() },
  tdsDeposit: { findMany: jest.fn(), createMany: jest.fn() },
  tdsDeductionEntry: { findMany: jest.fn() },
  tdsRecoveryEntry: { findMany: jest.fn() },
};

// ─── Xlsx builder helper for tests ───────────────────────────────────────────

/**
 * Build a minimal xlsx ArrayBuffer from a 2D array (header + data rows).
 * Simulates the file an admin would upload.
 */
function buildXlsxBuffer(rows: (string | number | null)[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  // Convert Node Buffer to ArrayBuffer
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Wrap an ArrayBuffer as Express.Multer.File (only .buffer is used in service). */
function multerFile(ab: ArrayBuffer): Express.Multer.File {
  const buf = Buffer.from(ab);
  return {
    buffer: buf,
    fieldname: 'file',
    originalname: 'test.xlsx',
    encoding: '7bit',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buf.length,
  } as Express.Multer.File;
}

const CLIENT_ID = 'deoleo';
const USER_ID = 'user-abc';
const FY = '2025-26';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TDS helpers — parseOffPlatformUpload', () => {
  // Valid row: Date, PAN, Outlet Code, Amount (₹)
  const validHeader = ['Date', 'PAN', 'Outlet Code', 'Amount (₹)'];

  it('returns empty result for header-only file (no data rows)', () => {
    const ab = buildXlsxBuffer([validHeader]);
    const { result, rows } = parseOffPlatformUpload(ab);
    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('parses a valid row: date → Date, PAN uppercase, amount → paise', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'abcde1234f', 'OUT001', 500], // ₹500 = 50000 paise
    ]);
    const { result, rows } = parseOffPlatformUpload(ab);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.panNumber).toBe('ABCDE1234F'); // uppercased
    expect(row.outletCode).toBe('OUT001');
    expect(row.amountPaise).toBe(50000n); // ₹500 × 100
    expect(row.entryDate).toBeInstanceOf(Date);
  });

  it('rejects a row with blank PAN', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', '', 'OUT001', 500],
    ]);
    const { result, rows } = parseOffPlatformUpload(ab);

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(rows).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/PAN is required/i);
  });

  it('rejects a row with zero amount', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', '', 0],
    ]);
    const { result, rows } = parseOffPlatformUpload(ab);
    expect(result.failed).toBe(1);
    expect(rows).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/Amount must be a positive number/i);
  });

  it('rejects a row with negative amount', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', '', -100],
    ]);
    const { result } = parseOffPlatformUpload(ab);
    expect(result.failed).toBe(1);
  });

  it('accepts outlet code as optional (null when blank)', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'XYZPQ5678G', '', 1000],
    ]);
    const { rows } = parseOffPlatformUpload(ab);
    expect(rows[0].outletCode).toBeNull();
  });

  it('rejects a row with missing/unparseable date', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['not-a-date', 'ABCDE1234F', '', 500],
    ]);
    const { result } = parseOffPlatformUpload(ab);
    expect(result.failed).toBe(1);
    expect(result.errors[0].message).toMatch(/invalid or missing date/i);
  });

  it('skips entirely blank rows without counting them as failures', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', '', 500],
      ['', '', '', ''], // blank row
      ['2025-09-01', 'XYZPQ5678G', '', 1500],
    ]);
    const { result, rows } = parseOffPlatformUpload(ab);
    expect(rows).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('converts ₹100.50 correctly to 10050 paise', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', '', 100.5],
    ]);
    const { rows } = parseOffPlatformUpload(ab);
    expect(rows[0].amountPaise).toBe(10050n);
  });

  it('trims and uppercases PAN', () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', '  abcde1234f  ', '', 500],
    ]);
    const { rows } = parseOffPlatformUpload(ab);
    expect(rows[0].panNumber).toBe('ABCDE1234F');
  });
});

describe('TDS helpers — parseDepositUpload', () => {
  const depositHeader = ['Date', 'Outlet Code', 'PAN', 'Amount (₹)'];

  it('parses a valid deposit row', () => {
    const ab = buildXlsxBuffer([
      depositHeader,
      ['2025-09-10', 'OUT002', 'PQRST9876H', 2500], // ₹2500 = 250000 paise
    ]);
    const { result, rows } = parseDepositUpload(ab);
    expect(result.succeeded).toBe(1);
    expect(rows[0].panNumber).toBe('PQRST9876H');
    expect(rows[0].amountPaise).toBe(250000n);
    expect(rows[0].outletCode).toBe('OUT002');
  });

  it('rejects blank PAN in deposit', () => {
    const ab = buildXlsxBuffer([
      depositHeader,
      ['2025-09-10', 'OUT002', '', 2500],
    ]);
    const { result } = parseDepositUpload(ab);
    expect(result.failed).toBe(1);
    expect(result.errors[0].message).toMatch(/PAN is required/i);
  });
});

describe('TDS helpers — template builders', () => {
  it('buildOffPlatformTemplate returns a non-empty Buffer', () => {
    const buf = buildOffPlatformTemplate();
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
    // Verify it is a valid xlsx
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toHaveLength(1);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as string[][];
    expect(data[0]).toContain('Date');
    expect(data[0]).toContain('PAN');
    expect(data[0]).toContain('Amount (₹)');
  });

  it('buildDepositTemplate returns a valid xlsx with the right headers', () => {
    const buf = buildDepositTemplate();
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as string[][];
    expect(data[0]).toContain('Date');
    expect(data[0]).toContain('PAN');
    expect(data[0]).toContain('Outlet Code');
    expect(data[0]).toContain('Amount (₹)');
  });
});

// ─── TdsService upload + liability tests (with mock Prisma) ──────────────────

describe('TdsService — uploadOffPlatform', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(TdsService);

    // Safe defaults
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.tdsDeposit.createMany.mockResolvedValue({ count: 1 });
  });

  const validHeader = ['Date', 'PAN', 'Outlet Code', 'Amount (₹)'];

  it('preview (apply=false) does NOT call createMany', async () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', 'OUT001', 500],
    ]);
    const result = await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab), false);

    expect(result.succeeded).toBe(1);
    expect(mockPrisma.tdsOffPlatformEntry.createMany).not.toHaveBeenCalled();
  });

  it('apply=true calls createMany and stamps uploadBatchId on all rows', async () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', 'OUT001', 500],
      ['2025-09-01', 'XYZPQ5678G', '', 1000],
    ]);
    const result = await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab), true);

    expect(result.succeeded).toBe(2);
    expect(mockPrisma.tdsOffPlatformEntry.createMany).toHaveBeenCalledTimes(1);

    const callArg = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[0][0];
    const data: any[] = callArg.data;

    // All rows get the SAME uploadBatchId
    const batchIds = data.map((r: any) => r.uploadBatchId);
    expect(new Set(batchIds).size).toBe(1); // one unique batchId
    expect(batchIds[0]).toMatch(/^OP-/);

    // Section always SEC_194R
    data.forEach((r: any) => expect(r.section).toBe('SEC_194R'));

    // clientId propagated
    data.forEach((r: any) => expect(r.clientId).toBe(CLIENT_ID));

    // Amount→paise
    expect(data[0].amountPaise).toBe(50000n);  // ₹500
    expect(data[1].amountPaise).toBe(100000n); // ₹1000
  });

  it('apply=true with blank PAN row: failed row not included in createMany', async () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', '', 'OUT001', 500],   // blank PAN → rejected
      ['2025-09-01', 'ABCDE1234F', '', 500], // valid
    ]);
    const result = await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab), true);

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.errors[0].message).toMatch(/PAN is required/i);

    const callArg = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[0][0];
    expect(callArg.data).toHaveLength(1); // only the valid row
  });

  it('apply=true with zero rows (all invalid) does NOT call createMany', async () => {
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', '', 'OUT001', 500], // blank PAN
    ]);
    await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab), true);
    expect(mockPrisma.tdsOffPlatformEntry.createMany).not.toHaveBeenCalled();
  });

  it('DIFFERENT files produce distinct (deterministic) uploadBatchIds', async () => {
    const ab1 = buildXlsxBuffer([validHeader, ['2025-08-15', 'ABCDE1234F', '', 500]]);
    const ab2 = buildXlsxBuffer([validHeader, ['2025-09-01', 'ABCDE1234F', '', 1000]]);

    await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab1), true);
    await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab2), true);

    const batchId1 = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[0][0].data[0].uploadBatchId;
    const batchId2 = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[1][0].data[0].uploadBatchId;

    expect(batchId1).not.toBe(batchId2);
  });

  it('uploadBatchId is a deterministic sha256 (same content → same id) across two calls', async () => {
    const make = () => buildXlsxBuffer([validHeader, ['2025-08-15', 'ABCDE1234F', 'OUT001', 500]]);

    await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(make()), true);
    await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(make()), true);

    const batchId1 = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[0][0].data[0].uploadBatchId;
    const batchId2 = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[1][0].data[0].uploadBatchId;

    expect(batchId1).toBe(batchId2);
    expect(batchId1).toMatch(/^OP-[0-9a-f]{64}$/);
  });

  it('re-uploading the SAME file: all rows reported as duplicate-skipped, 0 new inserts', async () => {
    const make = () =>
      buildXlsxBuffer([
        validHeader,
        ['2025-08-15', 'ABCDE1234F', 'OUT001', 500],
        ['2025-09-01', 'XYZPQ5678G', '', 1000],
      ]);

    // First upload: nothing present yet → both rows insert.
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValueOnce([]);
    const first = await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(make()), true);
    expect(first.succeeded).toBe(2);
    expect(first.skipped).toBe(0);

    const firstInsert = mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[0][0].data;
    expect(firstInsert).toHaveLength(2);
    const batchId = firstInsert[0].uploadBatchId;

    // Second upload of the IDENTICAL file → simulate that both rows now exist
    // for that (clientId, section, uploadBatchId).
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValueOnce([
      { panNumber: 'ABCDE1234F', entryDate: firstInsert[0].entryDate, amountPaise: 50000n, outletCode: 'OUT001' },
      { panNumber: 'XYZPQ5678G', entryDate: firstInsert[1].entryDate, amountPaise: 100000n, outletCode: null },
    ]);
    mockPrisma.tdsOffPlatformEntry.createMany.mockClear();

    const second = await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(make()), true);

    // Same deterministic batch id was used to look up existing rows.
    expect(mockPrisma.tdsOffPlatformEntry.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ uploadBatchId: batchId }) }),
    );
    // Both rows skipped, none inserted.
    expect(second.skipped).toBe(2);
    expect(second.succeeded).toBe(0);
    expect(second.errors.some((e) => /duplicate entry/i.test(e.message))).toBe(true);
    expect(mockPrisma.tdsOffPlatformEntry.createMany).not.toHaveBeenCalled();
  });

  it('a DIFFERENT file with the same PAN/date/amount still inserts (genuine repeat preserved)', async () => {
    // Earlier file's row exists, but under a DIFFERENT batch id. The new file
    // hashes differently, so the existing-row lookup (scoped to the new batch id)
    // returns nothing → the row inserts.
    const ab = buildXlsxBuffer([
      validHeader,
      ['2025-08-15', 'ABCDE1234F', 'OUT001', 500],
      ['2025-10-10', 'NEWPAN1234Z', '', 750], // extra row → different file hash
    ]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]); // new batch id → none present

    const res = await service.uploadOffPlatform(CLIENT_ID, USER_ID, multerFile(ab), true);

    expect(res.succeeded).toBe(2);
    expect(res.skipped).toBe(0);
    expect(mockPrisma.tdsOffPlatformEntry.createMany.mock.calls[0][0].data).toHaveLength(2);
  });
});

describe('TdsService — uploadDeposit', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(TdsService);

    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.createMany.mockResolvedValue({ count: 1 });
  });

  const depositHeader = ['Date', 'Outlet Code', 'PAN', 'Amount (₹)'];

  it('194R deposit: depositorType=CLIENT, clientId set', async () => {
    const ab = buildXlsxBuffer([
      depositHeader,
      ['2025-09-15', 'OUT001', 'ABCDE1234F', 3000],
    ]);
    const result = await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(ab), true);

    expect(result.succeeded).toBe(1);
    const callArg = mockPrisma.tdsDeposit.createMany.mock.calls[0][0];
    const row: any = callArg.data[0];

    expect(row.section).toBe('SEC_194R');
    expect(row.depositorType).toBe('CLIENT');
    expect(row.clientId).toBe(CLIENT_ID);
    expect(row.amountPaise).toBe(300000n); // ₹3000 × 100
    expect(row.uploadBatchId).toMatch(/^DEP-/);
  });

  it('194C deposit: depositorType=GIFSY, clientId=null', async () => {
    const ab = buildXlsxBuffer([
      depositHeader,
      ['2025-09-15', '', 'PQRST9876H', 5000],
    ]);
    const result = await service.uploadDeposit('194C', null, USER_ID, multerFile(ab), true);

    expect(result.succeeded).toBe(1);
    const callArg = mockPrisma.tdsDeposit.createMany.mock.calls[0][0];
    const row: any = callArg.data[0];

    expect(row.section).toBe('SEC_194C');
    expect(row.depositorType).toBe('GIFSY');
    expect(row.clientId).toBeUndefined(); // null → undefined (Prisma omit)
    expect(row.amountPaise).toBe(500000n); // ₹5000 × 100
  });

  it('194R deposit preview (apply=false): does NOT call createMany', async () => {
    const ab = buildXlsxBuffer([
      depositHeader,
      ['2025-09-15', '', 'ABCDE1234F', 3000],
    ]);
    const result = await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(ab), false);
    expect(result.succeeded).toBe(1);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
  });

  it('194C deposit: blank PAN rejected', async () => {
    const ab = buildXlsxBuffer([
      depositHeader,
      ['2025-09-15', '', '', 5000],
    ]);
    const result = await service.uploadDeposit('194C', null, USER_ID, multerFile(ab), true);
    expect(result.failed).toBe(1);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
  });

  it('deposit uploadBatchId differs for DIFFERENT files, matches for IDENTICAL files', async () => {
    const ab1 = buildXlsxBuffer([depositHeader, ['2025-09-15', '', 'ABCDE1234F', 1000]]);
    const ab2 = buildXlsxBuffer([depositHeader, ['2025-10-01', '', 'ABCDE1234F', 2000]]);
    const ab1again = buildXlsxBuffer([depositHeader, ['2025-09-15', '', 'ABCDE1234F', 1000]]);

    await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(ab1), true);
    await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(ab2), true);
    await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(ab1again), true);

    const id1 = mockPrisma.tdsDeposit.createMany.mock.calls[0][0].data[0].uploadBatchId;
    const id2 = mockPrisma.tdsDeposit.createMany.mock.calls[1][0].data[0].uploadBatchId;
    const id3 = mockPrisma.tdsDeposit.createMany.mock.calls[2][0].data[0].uploadBatchId;
    expect(id1).not.toBe(id2);
    expect(id3).toBe(id1); // identical content → identical deterministic id
    expect(id1).toMatch(/^DEP-[0-9a-f]{64}$/);
  });

  it('re-uploading the SAME deposit file: all rows duplicate-skipped, 0 inserts', async () => {
    const make = () =>
      buildXlsxBuffer([depositHeader, ['2025-09-15', 'OUT002', 'ABCDE1234F', 1000]]);

    // First upload inserts.
    mockPrisma.tdsDeposit.findMany.mockResolvedValueOnce([]);
    const first = await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(make()), true);
    expect(first.succeeded).toBe(1);
    const inserted = mockPrisma.tdsDeposit.createMany.mock.calls[0][0].data[0];

    // Second upload of identical file → row already present under same batch id.
    mockPrisma.tdsDeposit.findMany.mockResolvedValueOnce([
      { panNumber: 'ABCDE1234F', depositDate: inserted.depositDate, amountPaise: 100000n, outletCode: 'OUT002' },
    ]);
    mockPrisma.tdsDeposit.createMany.mockClear();

    const second = await service.uploadDeposit('194R', CLIENT_ID, USER_ID, multerFile(make()), true);
    expect(second.skipped).toBe(1);
    expect(second.succeeded).toBe(0);
    expect(second.errors.some((e) => /duplicate entry/i.test(e.message))).toBe(true);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
  });
});

describe('TdsService — getLiability (liability tracker)', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(TdsService);

    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([]);
  });

  it('194R: returns per-PAN rows with paise as strings (BigInt serialized)', async () => {
    // Off-platform entry: ₹25,000 = 2,500,000 paise → above ₹20,000 threshold
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', amountPaise: 2_500_000n },
    ]);
    // No deposits
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);

    const res = await service.getLiability('194R', FY, CLIENT_ID);

    expect(res.section).toBe('194R');
    expect(res.fyLabel).toBe(FY);
    expect(res.rows).toHaveLength(1);

    const row = res.rows[0];
    expect(row.panNumber).toBe('ABCDE1234F');
    // liabilityPaise should be a string representation
    expect(typeof row.liabilityPaise).toBe('string');
    expect(typeof row.depositedPaise).toBe('string');
    expect(typeof row.outstandingPaise).toBe('string');

    // Liability > 0 (threshold crossed)
    expect(BigInt(row.liabilityPaise)).toBeGreaterThan(0n);
    // No deposits → outstanding = liability
    expect(row.outstandingPaise).toBe(row.liabilityPaise);
  });

  it('194R: outstanding is negative when over-deposited', async () => {
    // ₹21,000 liability
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', amountPaise: 2_100_000n },
    ]);
    // Over-deposit: ₹5,000 = 500,000 paise deposited (more than liability ≈ 233,300 paise)
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', amountPaise: 500_000n },
    ]);

    const res = await service.getLiability('194R', FY, CLIENT_ID);

    const row = res.rows[0];
    const outstanding = BigInt(row.outstandingPaise);
    // outstanding = liability (233300) - deposited (500000) = -266700 → negative
    expect(outstanding).toBeLessThan(0n);
    // Also check totals reflect negative
    expect(BigInt(res.totals.outstandingPaise)).toBeLessThan(0n);
  });

  it('194R: returns empty rows when no data', async () => {
    const res = await service.getLiability('194R', FY, CLIENT_ID);
    expect(res.rows).toHaveLength(0);
    expect(res.totals.liabilityPaise).toBe('0');
    expect(res.totals.depositedPaise).toBe('0');
    expect(res.totals.outstandingPaise).toBe('0');
  });

  it('194C: returns platform-wide rows', async () => {
    // Visibility field → 194C
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis-field', clientId: CLIENT_ID }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
      {
        amountPaise: 12_000_000n, // ₹1,20,000 — above FY threshold
        fieldId: 'vis-field',
        outletId: 'outlet1',
        clientId: CLIENT_ID,
        status: 'PAID',
        paidAt: new Date('2025-08-01'),
      },
    ]);
    mockPrisma.outlet.findMany.mockResolvedValue([
      { outletCode: 'outlet1', partnerId: 'cp1', clientId: CLIENT_ID },
    ]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { id: 'cp1', panNumber: 'COM001', entityType: 'COMPANY' },
    ]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);

    const res = await service.getLiability('194C', FY, CLIENT_ID);

    expect(res.section).toBe('194C');
    expect(res.rows).toHaveLength(1);
    expect(BigInt(res.rows[0].liabilityPaise)).toBeGreaterThan(0n);
  });

  it('194C: over-deposit negative outstanding passes through', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis-field', clientId: CLIENT_ID }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
      {
        amountPaise: 12_000_000n,
        fieldId: 'vis-field',
        outletId: 'outlet1',
        clientId: CLIENT_ID,
        status: 'PAID',
        paidAt: new Date('2025-08-01'),
      },
    ]);
    mockPrisma.outlet.findMany.mockResolvedValue([
      { outletCode: 'outlet1', partnerId: 'cp1', clientId: CLIENT_ID },
    ]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { id: 'cp1', panNumber: 'COM001', entityType: 'COMPANY' },
    ]);
    // Over-deposit: ₹10,000 deposited vs much smaller liability
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: 'COM001', amountPaise: 1_000_000n }, // ₹10,000
    ]);

    const res = await service.getLiability('194C', FY, CLIENT_ID);
    const outstanding = BigInt(res.rows[0].outstandingPaise);
    // liability ≈ 244,900 paise; deposited = 1,000,000 paise → negative
    expect(outstanding).toBeLessThan(0n);
    expect(BigInt(res.totals.outstandingPaise)).toBeLessThan(0n);
  });
});
