import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SalesProfileService, validateColumnMapping } from './sales-profile.service';
import { SalesKpiDefService } from './sales-kpi-def.service';
import { stableStringify } from './sales-kpi.helper';

const user: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'A' };
const MAPPING = {
  headerRow: 'auto' as const,
  outletCode: 'CUSTOMER CODE',
  invoiceDate: 'INVOICE DATE',
  amount: 'NET AMT',
  quantity: 'QTY',
  dimensions: [
    { key: 'dimA', label: 'A', header: 'CODE' },
    { key: 'dimB', label: 'B', header: 'SKU' },
  ],
  dateOrder: 'DMY' as const,
};

function txDb(extra: Record<string, unknown> = {}) {
  const db: Record<string, any> = {
    salesImportProfile: { findUnique: jest.fn(async () => ({ columnMapping: MAPPING })), upsert: jest.fn(async () => ({})) },
    salesKpiDefinition: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'd1', clientId: 't1', kpiCode: 'K', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0, ...data })),
    },
    kpiDef: {
      findFirst: jest.fn(async ({ where }: { where: { code: string } }) => (where.code.startsWith('K') ? { code: where.code } : null)),
      // L4: KpiDef.outletType lookups (default: every KPI is shared)
      findMany: jest.fn(async (): Promise<Array<{ code: string; outletType: string | null }>> => []),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    outlet: { findMany: jest.fn(async () => []) },
    salesImport: { findFirst: jest.fn(async () => null) },
    salesImportAggregate: { findMany: jest.fn(async () => []) },
    ...extra,
  };
  db.$queryRaw = jest.fn(async () => []); // FOCUS-NAMES-FROM-KPI row locks
  db.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(db));
  return db;
}

// ─── K-1 profile ─────────────────────────────────────────────────────────────

describe('validateColumnMapping (K-1)', () => {
  it('accepts the generic mapping and normalises blanks to null', () => {
    const m = validateColumnMapping({ ...MAPPING, outletName: '  ', sheetName: '' });
    expect(m.outletName).toBeNull();
    expect(m.sheetName).toBeNull();
    expect(m.headerRow).toBe('auto');
  });
  it.each([
    ['missing outlet code', { ...MAPPING, outletCode: '' }, /outlet code column is required/],
    ['missing date', { ...MAPPING, invoiceDate: undefined }, /invoice date column is required/],
    ['no amount and no quantity', { ...MAPPING, amount: null, quantity: '' }, /at least one of the amount or quantity/],
    ['bad dim key', { ...MAPPING, dimensions: [{ key: 'Brand', label: 'B', header: 'X' }] }, /must start with a lower-case/],
    ['duplicate dim key', { ...MAPPING, dimensions: [{ key: 'dimA', label: 'A', header: 'X' }, { key: 'dimA', label: 'B', header: 'Y' }] }, /used twice/],
    ['> 6 dims', { ...MAPPING, dimensions: Array.from({ length: 7 }, (_, i) => ({ key: `d${i}`, label: 'L', header: `H${i}` })) }, /At most 6/],
    ['header reused after normalisation', { ...MAPPING, amount: ' code ' }, /mapped to more than one field/],
    ['bad headerRow', { ...MAPPING, headerRow: 0 }, /headerRow/],
    ['bad dateOrder', { ...MAPPING, dateOrder: 'XYZ' }, /dateOrder/],
    ['dim without header', { ...MAPPING, dimensions: [{ key: 'dimA', label: 'A', header: '' }] }, /header is required/],
  ])('%s → 400', (_n, input, re) => {
    expect(() => validateColumnMapping(input)).toThrow(BadRequestException);
    expect(() => validateColumnMapping(input)).toThrow(re);
  });
  it('"CODE" and "CUSTOMER CODE" are different columns', () => expect(() => validateColumnMapping(MAPPING)).not.toThrow());
});

describe('SalesProfileService (K-1)', () => {
  it('put upserts by clientId and writes an audit row in the same transaction', async () => {
    const db = txDb();
    db.salesImportProfile.findUnique.mockResolvedValue(null);
    await new SalesProfileService(db as never).put(user, MAPPING);
    expect(db.salesImportProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 't1' } }));
    expect(db.auditLog.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ action: 'CREATE', entityType: 'SALES_IMPORT_PROFILE', entityId: 't1', actorId: 'u1', metadata: { clientId: 't1' } }),
    );
  });
  it('cannot remove a dimension an enabled KPI uses', async () => {
    const db = txDb();
    db.salesKpiDefinition.findMany.mockResolvedValue([{ kpiCode: 'K1', filter: { anyOf: [{ dimB: '500' }] } }]);
    await expect(new SalesProfileService(db as never).put(user, { ...MAPPING, dimensions: [MAPPING.dimensions[0]] })).rejects.toThrow(/K1 \(dimB\)/);
    expect(db.salesImportProfile.upsert).not.toHaveBeenCalled();
  });
  describe('audit follow-up: product columns are frozen while a Lines (PRODUCT_COUNT) or "from the target file" KPI is enabled', () => {
    function guarded(users: Array<{ kpiCode: string }>) {
      const db = txDb();
      db.salesKpiDefinition.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        where.OR ? users : []);
      db.kpiDef.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
        select.label ? [{ code: 'LINES', label: 'Lines' }, { code: 'FB1', label: 'Focus Brand 1' }] : []);
      return db;
    }
    const [A, B] = MAPPING.dimensions;
    it.each([
      ['adding a column', [A, B, { key: 'dimC', label: 'C', header: 'PACK' }]],
      ['removing a column', [A]],
      ['reordering', [B, A]],
      ['changing a key', [A, { ...B, key: 'dimZ' }]],
      ['changing a heading', [A, { ...B, header: 'SKU GROUP' }]],
    ])('%s → 400 naming the KPIs; nothing saved', async (_n, dimensions) => {
      const db = guarded([{ kpiCode: 'FB1' }, { kpiCode: 'LINES' }]);
      await expect(new SalesProfileService(db as never).put(user, { ...MAPPING, dimensions })).rejects.toThrow(
        "Product columns can't be changed while 'Focus Brand 1' (FB1), 'Lines' (LINES) use them",
      );
      expect(db.salesImportProfile.upsert).not.toHaveBeenCalled();
      const q = db.salesKpiDefinition.findMany.mock.calls.find((c: Array<{ where: Record<string, unknown> }>) => c[0].where.OR)![0];
      expect(q.where).toEqual({ clientId: 't1', enabled: true, OR: [{ measure: 'PRODUCT_COUNT' }, { productSource: 'TARGET_NAMES' }] });
    });
    it('a label-only (or heading case/space) change is allowed', async () => {
      const db = guarded([{ kpiCode: 'LINES' }]);
      await new SalesProfileService(db as never).put(user, { ...MAPPING, dimensions: [{ ...A, label: 'Brand' }, { ...B, header: ' sku ' }] });
      expect(db.salesImportProfile.upsert).toHaveBeenCalled();
    });
    it('no such KPI enabled → product columns may change', async () => {
      const db = guarded([]);
      await new SalesProfileService(db as never).put(user, { ...MAPPING, dimensions: [A] });
      expect(db.salesImportProfile.upsert).toHaveBeenCalled();
    });
  });

  it('get returns null when unset', async () => {
    const db = txDb();
    db.salesImportProfile.findUnique.mockResolvedValue(null);
    await expect(new SalesProfileService(db as never).get('t1')).resolves.toBeNull();
  });
});

// ─── K-2 definitions ─────────────────────────────────────────────────────────

describe('SalesKpiDefService (K-2)', () => {
  const dto = (over: Record<string, unknown> = {}) => ({
    kpiCode: 'K_SET', measure: 'AMOUNT', filter: { anyOf: [{ dimA: ' p ' }] }, outletTypes: [' wholesaler'], programs: [], enabled: true, order: 0, ...over,
  }) as never;

  it('create: validates against an ENABLED KpiDef of THIS tenant, normalises the filter, audits', async () => {
    const db = txDb();
    const out = await new SalesKpiDefService(db as never).create(user, dto());
    expect(db.kpiDef.findFirst).toHaveBeenCalledWith({
      where: { clientId: 't1', code: 'K_SET', enabled: true },
      select: { code: true, hasNameOverride: true, nameOverrideLabel: true },
    });
    expect(db.salesKpiDefinition.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ clientId: 't1', kpiCode: 'K_SET', filter: { anyOf: [{ dimA: 'P' }] }, outletTypes: ['WHOLESALER'] }),
    );
    expect(out.kpiCode).toBe('K_SET');
    expect(db.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ action: 'CREATE', entityType: 'SALES_KPI_DEFINITION' }));
  });

  it.each([
    ['not an enabled KpiDef', { kpiCode: 'NOPE' }, /not an enabled KPI/],
    ['bad measure', { measure: 'CASES' }, /measure must be one of AMOUNT, QUANTITY, PRODUCT_COUNT/],
    ['garbage measure (lower-case)', { measure: 'product_count' }, /measure must be one of/],
    ['missing measure', { measure: undefined }, /measure must be one of/],
    ['filter on an unmapped dim', { filter: { anyOf: [{ brand: 'X' }] } }, /unknown dimension "brand"/],
    ['empty anyOf entry', { filter: { anyOf: [{}] } }, /empty/],
  ])('create: %s → 400', async (_n, over, re) => {
    await expect(new SalesKpiDefService(txDb() as never).create(user, dto(over))).rejects.toThrow(re);
  });

  it('create: no profile yet → 400; measure without its column → 400', async () => {
    const db = txDb();
    db.salesImportProfile.findUnique.mockResolvedValue(null);
    await expect(new SalesKpiDefService(db as never).create(user, dto())).rejects.toThrow(/column mapping/);
    const db2 = txDb();
    db2.salesImportProfile.findUnique.mockResolvedValue({ columnMapping: { ...MAPPING, quantity: null } });
    await expect(new SalesKpiDefService(db2 as never).create(user, dto({ measure: 'QUANTITY' }))).rejects.toThrow(/no quantity column/);
  });

  it('create: PRODUCT_COUNT is accepted and saved as-is', async () => {
    const db = txDb();
    const out = await new SalesKpiDefService(db as never).create(user, dto({ measure: 'PRODUCT_COUNT' }));
    expect(db.salesKpiDefinition.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ measure: 'PRODUCT_COUNT' }));
    expect(out.measure).toBe('PRODUCT_COUNT');
  });

  it('create: PRODUCT_COUNT needs the amount column (net basis) and at least one product column', async () => {
    const noAmt = txDb();
    noAmt.salesImportProfile.findUnique.mockResolvedValue({ columnMapping: { ...MAPPING, amount: null } });
    await expect(new SalesKpiDefService(noAmt as never).create(user, dto({ measure: 'PRODUCT_COUNT' }))).rejects.toThrow(/no amount column/);
    const noDims = txDb();
    noDims.salesImportProfile.findUnique.mockResolvedValue({ columnMapping: { ...MAPPING, dimensions: [] } });
    await expect(new SalesKpiDefService(noDims as never).create(user, dto({ measure: 'PRODUCT_COUNT', filter: {} }))).rejects.toThrow(/no product \(dimension\) columns/);
  });

  it('profile H2: the amount column used by an enabled PRODUCT_COUNT KPI cannot be removed or changed', async () => {
    const db = txDb();
    db.salesKpiDefinition.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.measure ? [{ kpiCode: 'K_LINES', measure: 'PRODUCT_COUNT' }] : []);
    await expect(new SalesProfileService(db as never).put(user, { ...MAPPING, amount: 'GROSS AMT' })).rejects.toThrow(/amount column is used by K_LINES/);
    await expect(new SalesProfileService(db as never).put(user, { ...MAPPING, amount: null })).rejects.toThrow(/amount column is used by K_LINES/);
    expect(db.salesImportProfile.upsert).not.toHaveBeenCalled();
  });

  it('create: 409 when the kpiCode is already owned by an ENABLED definition', async () => {
    const db = txDb();
    db.salesKpiDefinition.findUnique.mockResolvedValue({ id: 'd0', enabled: true });
    await expect(new SalesKpiDefService(db as never).create(user, dto())).rejects.toBeInstanceOf(ConflictException);
    expect(db.salesKpiDefinition.create).not.toHaveBeenCalled();
  });

  it('create: a DISABLED (released) definition is revived in place', async () => {
    const db = txDb();
    db.salesKpiDefinition.findUnique.mockResolvedValue({ id: 'd0', clientId: 't1', kpiCode: 'K_SET', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: false, order: 0 });
    await new SalesKpiDefService(db as never).create(user, dto());
    expect(db.salesKpiDefinition.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'd0' } }));
    expect(db.salesKpiDefinition.create).not.toHaveBeenCalled();
  });

  it('patch / delete: foreign or unknown id → 404; delete only disables + audits DELETE with old/new', async () => {
    const db = txDb();
    const svc = new SalesKpiDefService(db as never);
    await expect(svc.patch(user, 'x', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.disable(user, 'x')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.salesKpiDefinition.findFirst).toHaveBeenCalledWith({ where: { id: 'x', clientId: 't1' } });
    db.salesKpiDefinition.findFirst.mockResolvedValue({ id: 'd1', clientId: 't1', kpiCode: 'K1', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 });
    await svc.disable(user, 'd1');
    expect(db.salesKpiDefinition.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { enabled: false, updatedById: 'u1' } });
    const audit = db.auditLog.create.mock.calls.at(-1)[0].data;
    expect(audit.action).toBe('DELETE');
    expect(audit.oldValues.enabled).toBe(true);
    expect(audit.newValues.enabled).toBe(false);
  });

  it('patch: changing kpiCode onto another definition → 409', async () => {
    const db = txDb();
    db.salesKpiDefinition.findFirst.mockResolvedValue({ id: 'd1', clientId: 't1', kpiCode: 'K1', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 });
    db.salesKpiDefinition.findUnique.mockResolvedValue({ id: 'd2' });
    await expect(new SalesKpiDefService(db as never).patch(user, 'd1', { kpiCode: 'K2' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('list: definitionsHash covers enabled definitions only', async () => {
    const db = txDb();
    const row = { id: 'd1', clientId: 't1', kpiCode: 'K1', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 };
    db.salesKpiDefinition.findMany.mockResolvedValue([row]);
    const a = await new SalesKpiDefService(db as never).list('t1');
    db.salesKpiDefinition.findMany.mockResolvedValue([row, { ...row, id: 'd2', kpiCode: 'K2', enabled: false }]);
    const b = await new SalesKpiDefService(db as never).list('t1');
    expect(b.definitions).toHaveLength(2);
    expect(b.definitionsHash).toBe(a.definitionsHash);
    // L4: the KPI's own type tag is part of the hash (same as preview / apply compute it)
    db.kpiDef.findMany.mockResolvedValue([{ code: 'K1', outletType: 'RETAIL' }]);
    const c = await new SalesKpiDefService(db as never).list('t1');
    expect(c.definitionsHash).not.toBe(a.definitionsHash);
  });

  describe('test (draft-filter tester, §6.2a)', () => {
    const agg = (id: number, month: string, outletCode: string, dims: Record<string, string>, amountPaise: bigint, qtyMicro: bigint) =>
      ({ id: BigInt(id), month, outletCode, dims, dimKey: stableStringify(dims), amountPaise, qtyPico: qtyMicro * 1_000_000n, lines: 2 });
    function testDb() {
      const db = txDb();
      db.salesImport.findFirst.mockImplementation(async ({ where }: { where: { id?: string; clientId: string; status?: string } }) =>
        where.clientId === 't1' && (where.id === 'imp1' || where.status === 'READY') ? { id: 'imp1', status: 'READY' } : null);
      db.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'O1', programName: null, outletType: { code: 'WHOLESALER' } },
        { outletCode: 'O2', name: 'O2', programName: null, outletType: { code: 'RETAIL' } },
      ]);
      const rows = [
        agg(1, '2026-09', 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_000000n),
        agg(2, '2026-09', 'O2', { dimA: 'P', dimB: '200' }, 4000n, 500000n),
        agg(3, '2026-10', 'O1', { dimA: 'Q', dimB: '500' }, 7000n, 700000n),
        agg(4, '2026-10', 'X9', { dimA: 'P', dimB: '500' }, 99900n, 0n), // unmatched customer: never counted
      ];
      db.salesImportAggregate.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt: bigint } }; take: number }) =>
        rows.filter((r) => !where.id || r.id > where.id.gt).slice(0, take));
      return db;
    }

    it('returns per-month ₹ and cases totals, unmatched + redundant entries (indexes into the REQUEST)', async () => {
      const res = await new SalesKpiDefService(testDb() as never).test(user, {
        importId: 'latest',
        definition: { kpiCode: 'K', measure: 'AMOUNT', filter: { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P' }, { dimA: 'P', dimB: '150' }], noneOf: [{ dimB: '999' }] }, outletTypes: [], programs: [], enabled: true, order: 0 },
      });
      expect(res.months).toEqual([
        { month: '2026-09', totalAmountRupees: 140, totalQuantity: 1.5, outletsNonZero: 2 },
        // a month present in the file (roster lines) whose lines all miss the set → shown as 0, not dropped
        { month: '2026-10', totalAmountRupees: 0, totalQuantity: 0, outletsNonZero: 0 },
      ]);
      expect(res.unmatchedEntries).toEqual({ anyOf: [2], noneOf: [0] });
      expect(res.redundantEntries).toEqual({ anyOf: [0, 2] }); // both are covered by the whole-P entry
      expect(res.matchedLines).toBe(4);
    });

    it('roster-only import (2026-11-23): "matches no line of the file" also checks the frozen combos (products sold only to non-programme customers); totals unchanged', async () => {
      const db = testDb();
      db.salesImport.findFirst.mockImplementation(async ({ where }: { where: { id?: string; clientId: string; status?: string } }) =>
        where.clientId === 't1' && (where.id === 'imp1' || where.status === 'READY')
          ? {
              id: 'imp1', status: 'READY', processedRosterCodes: ['O1', 'O2'],
              dimensionCombos: [{ dims: { dimA: 'P', dimB: '150' }, lines: 1, amountRupees: 1, quantity: 0 }, { dims: { dimA: 'Z', dimB: '999' }, lines: 1, amountRupees: 1, quantity: 0 }],
            }
          : null);
      const res = await new SalesKpiDefService(db as never).test(user, {
        importId: 'latest',
        definition: { kpiCode: 'K', measure: 'AMOUNT', filter: { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P' }, { dimA: 'P', dimB: '150' }], noneOf: [{ dimB: '999' }] }, outletTypes: [], programs: [], enabled: true, order: 0 },
      });
      expect(res.unmatchedEntries).toEqual({ anyOf: [], noneOf: [] });
      expect(res.months[0]).toEqual({ month: '2026-09', totalAmountRupees: 140, totalQuantity: 1.5, outletsNonZero: 2 });
      expect(res.outletsNotIncluded).toBe(0); // O1, O2 were both on the processing-time roster
    });

    it('roster-only import (audit A L2): the tester reports outlets added since processing; a legacy import reports nothing', async () => {
      const db = testDb();
      db.salesImport.findFirst.mockImplementation(async ({ where }: { where: { id?: string; clientId: string; status?: string } }) =>
        where.clientId === 't1' && (where.id === 'imp1' || where.status === 'READY') ? { id: 'imp1', status: 'READY', processedRosterCodes: ['O1'], dimensionCombos: [] } : null);
      const def = { kpiCode: 'K', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 };
      expect((await new SalesKpiDefService(db as never).test(user, { importId: 'latest', definition: def } as never)).outletsNotIncluded).toBe(1);
      const legacy = await new SalesKpiDefService(testDb() as never).test(user, { importId: 'latest', definition: def } as never);
      expect(legacy).not.toHaveProperty('outletsNotIncluded');
    });

    it('PRODUCT_COUNT draft: adds totalProducts (Σ per-outlet counts) and judges "outlets > 0" on the count', async () => {
      const db = testDb();
      const rows = [
        agg(1, '2026-09', 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_000000n),
        agg(2, '2026-09', 'O1', { dimA: 'P', dimB: '500' }, -10000n, 0n), // fully returned → not counted
        agg(3, '2026-09', 'O1', { dimA: 'P', dimB: '200' }, 500n, 0n),
        agg(4, '2026-09', 'O2', { dimA: 'P', dimB: '200' }, 4000n, 500000n),
        agg(5, '2026-09', 'O2', { dimA: 'Q', dimB: '200' }, 4000n, 0n), // filtered out
      ];
      db.salesImportAggregate.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt: bigint } }; take: number }) =>
        rows.filter((r) => !where.id || r.id > where.id.gt).slice(0, take));
      const res = await new SalesKpiDefService(db as never).test(user, {
        importId: 'imp1',
        definition: { kpiCode: 'K', measure: 'PRODUCT_COUNT', filter: { anyOf: [{ dimA: 'P' }] }, outletTypes: [], programs: [], enabled: true, order: 0 },
      });
      expect(res.months).toEqual([{ month: '2026-09', totalAmountRupees: 45, totalQuantity: 1.5, totalProducts: 2, outletsNonZero: 2 }]);
    });

    it('outlet-type scope restricts the totals', async () => {
      const res = await new SalesKpiDefService(testDb() as never).test(user, {
        importId: 'imp1',
        definition: { kpiCode: 'K', measure: 'QUANTITY', filter: {}, outletTypes: ['WHOLESALER'], programs: [], enabled: true, order: 0 },
      });
      expect(res.months.map((m) => [m.month, m.totalQuantity])).toEqual([['2026-09', 1], ['2026-10', 0.7]]);
    });

    it('L4: the target KPI own type tag (KpiDef.outletType) also restricts the totals, intersected with outletTypes', async () => {
      const db = testDb();
      db.kpiDef.findMany.mockResolvedValue([{ code: 'K', outletType: 'RETAIL' }]);
      const d = { kpiCode: 'K', measure: 'AMOUNT' as const, filter: {}, outletTypes: [] as string[], programs: [], enabled: true, order: 0 };
      const res = await new SalesKpiDefService(db as never).test(user, { importId: 'imp1', definition: d });
      expect(res.months.map((m) => [m.month, m.totalAmountRupees])).toEqual([['2026-09', 40]]); // O2 (RETAIL) only
      // APPLIES-TO: the KPI's full scope (legacy outletType + outletTypes / programs / subPrograms) is read.
      expect(db.kpiDef.findMany).toHaveBeenCalledWith({
        where: { clientId: 't1', code: { in: ['K'] } },
        select: { code: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
      });
      const disjoint = await new SalesKpiDefService(db as never).test(user, { importId: 'imp1', definition: { ...d, outletTypes: ['WHOLESALER'] } });
      expect(disjoint.months).toEqual([]);
    });

    it('404 when the tenant has no READY import (latest) or the id is foreign', async () => {
      const db = txDb(); // findFirst → null
      const svc = new SalesKpiDefService(db as never);
      const def = { kpiCode: 'K', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 } as never;
      await expect(svc.test(user, { importId: 'latest', definition: def })).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.test(user, { importId: 'other-tenant-id', definition: def })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('blocking filter errors → 400', async () => {
      await expect(new SalesKpiDefService(testDb() as never).test(user, {
        importId: 'imp1',
        definition: { kpiCode: 'K', measure: 'AMOUNT', filter: { anyOf: [{ nope: 'X' }] }, outletTypes: [], programs: [], enabled: true, order: 0 },
      })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('segmentOptions: distinct via SQL GROUP BY (never fetches every outlet), tenant-scoped, sorted', async () => {
    const db = txDb();
    db.outlet.groupBy = jest
      .fn()
      .mockResolvedValueOnce([{ outletTypeId: 'ty1' }, { outletTypeId: 'ty2' }, { outletTypeId: null }])
      .mockResolvedValueOnce([{ programName: 'Gold ' }, { programName: 'Bronze' }, { programName: '' }])
      .mockResolvedValueOnce([{ programCategory: 'Tier B' }, { programCategory: ' Tier A' }, { programCategory: '' }]);
    db.outletType = { findMany: jest.fn(async () => [{ code: 'WHOLESALER', name: 'Wholesaler' }, { code: 'RETAIL', name: 'Retail' }]) };
    const r = await new SalesKpiDefService(db as never).segmentOptions('t1');
    // APPLIES-TO: + subPrograms (Outlet.programCategory), same GROUP BY / trim / sort rules.
    expect(r).toEqual({
      outletTypes: [{ code: 'RETAIL', name: 'Retail' }, { code: 'WHOLESALER', name: 'Wholesaler' }],
      programs: ['Bronze', 'Gold'],
      subPrograms: ['Tier A', 'Tier B'],
    });
    expect(db.outlet.groupBy.mock.calls.map((c: Array<{ by: string[] }>) => c[0].by)).toEqual([['outletTypeId'], ['programName'], ['programCategory']]);
    for (const c of db.outlet.groupBy.mock.calls) expect(c[0].where).toEqual(expect.objectContaining({ clientId: 't1', deletedAt: null }));
    expect(db.outletType.findMany).toHaveBeenCalledWith({ where: { id: { in: ['ty1', 'ty2'] } }, select: { code: true, name: true } });
    expect(db.outlet.findMany).not.toHaveBeenCalled();
  });
});

describe('audit fix round — profile / tester', () => {
  it('H2: PUT refuses removing or re-pointing the amount column while an enabled AMOUNT KPI uses it', async () => {
    const db = txDb();
    db.salesKpiDefinition.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.measure ? [{ kpiCode: 'K_RS', measure: 'AMOUNT' }] : []);
    const svc = new SalesProfileService(db as never);
    await expect(svc.put(user, { ...MAPPING, amount: 'GROSS AMT' })).rejects.toThrow(/amount column is used by K_RS and cannot be changed/);
    await expect(svc.put(user, { ...MAPPING, amount: null })).rejects.toThrow(/amount column is used by K_RS and cannot be removed/);
    expect(db.salesImportProfile.upsert).not.toHaveBeenCalled();
    // header case/space differences are the same column; the unused quantity column may change freely
    await expect(svc.put(user, { ...MAPPING, amount: ' net  amt ', quantity: 'CASES' })).resolves.toMatchObject({ amount: 'net  amt' });
  });

  it('L1: decimalSeparator is validated and defaults to auto', () => {
    expect(validateColumnMapping(MAPPING).decimalSeparator).toBe('auto');
    expect(validateColumnMapping({ ...MAPPING, decimalSeparator: ',' }).decimalSeparator).toBe(',');
    expect(() => validateColumnMapping({ ...MAPPING, decimalSeparator: ';' })).toThrow(/decimalSeparator/);
  });

  function testerDb(rows: Array<Record<string, unknown>>, outlets = [{ outletCode: '00012', name: 'A', programName: null, outletType: { code: 'R' } }]) {
    const db = txDb();
    db.salesImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'READY', purgedAt: null });
    db.outlet.findMany.mockResolvedValue(outlets);
    db.salesImportAggregate.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt: bigint } }; take: number }) =>
      rows.filter((r) => !where.id || (r.id as bigint) > where.id.gt).slice(0, take));
    return db;
  }
  const row = (id: number, code: string, dims: Record<string, string>, paise: bigint) =>
    ({ id: BigInt(id), month: '2026-09', outletCode: code, dims, dimKey: stableStringify(dims), amountPaise: paise, qtyPico: 0n, lines: 1 });
  const draft = (filter: Record<string, unknown>) =>
    ({ kpiCode: 'K', measure: 'AMOUNT', filter, outletTypes: [], programs: [], enabled: true, order: 0 }) as never;

  it("tester accepts an exact-blank value and maps file codes onto the CURRENT roster (M6)", async () => {
    const db = testerDb([row(1, '00012', { dimA: 'P', dimB: '' }, 500n), row(2, '00012', { dimA: 'P', dimB: '5' }, 900n), row(3, '99', { dimA: 'P', dimB: '' }, 7n)]);
    const r = await new SalesKpiDefService(db as never).test(user, { importId: 'imp1', definition: draft({ anyOf: [{ dimA: 'P', dimB: '' }] }) });
    expect(r.months).toEqual([{ month: '2026-09', totalAmountRupees: 5, totalQuantity: 0, outletsNonZero: 1 }]);
    expect(r.unmatchedEntries).toEqual({ anyOf: [], noneOf: [] });
  });

  it('M4: entry hits are evaluated once per distinct combo, and a file with too many combos is refused', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, '00012', { dimA: 'P', dimB: '' }, 1n));
    const db = testerDb(rows);
    const helper = jest.requireActual('./sales-kpi.helper') as typeof import('./sales-kpi.helper');
    const spy = jest.spyOn(helper, 'entryMatches');
    await new SalesKpiDefService(db as never).test(user, { importId: 'imp1', definition: draft({ anyOf: [{ dimA: 'Q' }, { dimA: 'R' }] }) });
    // 1 distinct combo × 2 entries for the hit scan (+ the match-vector evaluation of that one combo)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
    spy.mockRestore();

    const { KPI_TEST_MAX_COMBOS } = jest.requireActual('./sales-kpi-def.service') as typeof import('./sales-kpi-def.service');
    const many = Array.from({ length: KPI_TEST_MAX_COMBOS + 1 }, (_, i) => row(i + 1, '00012', { dimA: `V${i}` }, 1n));
    await expect(new SalesKpiDefService(testerDb(many) as never).test(user, { importId: 'imp1', definition: draft({}) }))
      .rejects.toThrow(/too many to test/);
  });
});

describe('KPI tester totals = sum of per-outlet STORED values (audit L2)', () => {
  it('two outlets of 0.0005 cases → 0.002 (as stored), non-zero judged on the stored value', async () => {
    const db = txDb();
    db.salesImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'READY', purgedAt: null });
    db.outlet.findMany.mockResolvedValue([
      { outletCode: 'O1', name: 'O1', programName: null, outletType: { code: 'R' } },
      { outletCode: 'O2', name: 'O2', programName: null, outletType: { code: 'R' } },
      { outletCode: 'O3', name: 'O3', programName: null, outletType: { code: 'R' } },
    ]);
    const row = (id: number, code: string, qtyPico: bigint) =>
      ({ id: BigInt(id), month: '2026-09', outletCode: code, dims: {}, dimKey: '{}', amountPaise: 0n, qtyPico, lines: 1 });
    const rows = [row(1, 'O1', 500_000_000n), row(2, 'O2', 500_000_000n), row(3, 'O3', 400_000_000n)];
    db.salesImportAggregate.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt: bigint } }; take: number }) =>
      rows.filter((r) => !where.id || r.id > where.id.gt).slice(0, take));
    const r = await new SalesKpiDefService(db as never).test(user, {
      importId: 'imp1',
      definition: { kpiCode: 'K', measure: 'QUANTITY', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 } as never,
    });
    expect(r.months).toEqual([{ month: '2026-09', totalAmountRupees: 0, totalQuantity: 0.002, outletsNonZero: 2 }]);
  });
});

// ─── FOCUS-FROM-TARGETS: productSource on save (design §9) ─────────────────────────────────────────────────────

describe('SalesKpiDefService — productSource (FOCUS-FROM-TARGETS)', () => {
  const named = (where: { code: string }) =>
    where.code.startsWith('K') ? { code: where.code, hasNameOverride: where.code !== 'K_NONAME', nameOverrideLabel: where.code === 'K_NONAME' ? null : 'Focus Brand 1' } : null;
  const dto = (over: Record<string, unknown> = {}) => ({
    kpiCode: 'K_FB', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0, ...over,
  });

  it('absent = FILTER (stored + returned); unknown value → 400', async () => {
    const db = txDb();
    db.kpiDef.findFirst.mockImplementation(async ({ where }: { where: { code: string } }) => named(where));
    const out = await new SalesKpiDefService(db as never).create(user, dto() as never);
    expect(db.salesKpiDefinition.create.mock.calls[0][0].data.productSource).toBe('FILTER');
    expect(out.productSource).toBe('FILTER');
    await expect(new SalesKpiDefService(db as never).create(user, dto({ productSource: 'NAMES' }) as never)).rejects.toThrow(/productSource must be one of FILTER, TARGET_NAMES/);
  });

  it('TARGET_NAMES: saved with filter {} when the KPI has a per-outlet name column', async () => {
    const db = txDb();
    db.kpiDef.findFirst.mockImplementation(async ({ where }: { where: { code: string } }) => named(where));
    const out = await new SalesKpiDefService(db as never).create(user, dto({ productSource: 'TARGET_NAMES', filter: { anyOf: [] } }) as never);
    expect(db.salesKpiDefinition.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ productSource: 'TARGET_NAMES', filter: {} }));
    expect(out).toEqual(expect.objectContaining({ productSource: 'TARGET_NAMES', filter: {} }));
  });

  it('TARGET_NAMES refuses a product list of its own, and a KPI without the per-outlet name column (design §9 message)', async () => {
    const db = txDb();
    db.kpiDef.findFirst.mockImplementation(async ({ where }: { where: { code: string } }) => named(where));
    const s = new SalesKpiDefService(db as never);
    await expect(s.create(user, dto({ productSource: 'TARGET_NAMES', filter: { anyOf: [{ dimA: 'P' }] } }) as never)).rejects.toThrow(/can't also have its own product list/);
    await expect(s.create(user, dto({ productSource: 'TARGET_NAMES', filter: { noneOf: [{ dimA: 'P' }] } }) as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.create(user, dto({ kpiCode: 'K_NONAME', productSource: 'TARGET_NAMES' }) as never)).rejects.toThrow(
      'Turn on the per-outlet name column for this KPI in KPI settings first, so the target file can carry the product names.',
    );
    expect(db.salesKpiDefinition.create).not.toHaveBeenCalled();
  });

  it('audit follow-up: TARGET_NAMES needs at least one product column (same rule as PRODUCT_COUNT)', async () => {
    const db = txDb();
    db.kpiDef.findFirst.mockImplementation(async ({ where }: { where: { code: string } }) => named(where));
    db.salesImportProfile.findUnique.mockResolvedValue({ columnMapping: { ...MAPPING, dimensions: [] } });
    await expect(new SalesKpiDefService(db as never).create(user, dto({ productSource: 'TARGET_NAMES' }) as never)).rejects.toThrow(
      /no product \(dimension\) columns, so a 'from the target file' KPI/,
    );
    expect(db.salesKpiDefinition.create).not.toHaveBeenCalled();
  });

  it('patch keeps the stored productSource unless changed; switching back to FILTER is allowed', async () => {
    const db = txDb();
    db.kpiDef.findFirst.mockImplementation(async ({ where }: { where: { code: string } }) => named(where));
    const stored = { id: 'd1', clientId: 't1', kpiCode: 'K_FB', measure: 'AMOUNT', filter: {}, productSource: 'TARGET_NAMES', outletTypes: [], programs: [], enabled: true, order: 0 };
    db.salesKpiDefinition.findFirst.mockResolvedValue(stored);
    const s = new SalesKpiDefService(db as never);
    await s.patch(user, 'd1', { order: 3 });
    expect(db.salesKpiDefinition.update.mock.calls[0][0].data.productSource).toBe('TARGET_NAMES');
    await s.patch(user, 'd1', { productSource: 'FILTER', filter: { anyOf: [{ dimA: 'P' }] } });
    expect(db.salesKpiDefinition.update.mock.calls[1][0].data).toEqual(expect.objectContaining({ productSource: 'FILTER', filter: { anyOf: [{ dimA: 'P' }] } }));
  });

  it('list returns productSource; the hash moves only for TARGET_NAMES (FILTER hashes unchanged)', async () => {
    const row = { id: 'd1', clientId: 't1', kpiCode: 'K1', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 };
    const db1 = txDb();
    db1.salesKpiDefinition.findMany.mockResolvedValue([row]);
    const db2 = txDb();
    db2.salesKpiDefinition.findMany.mockResolvedValue([{ ...row, productSource: 'FILTER' }]);
    const db3 = txDb();
    db3.salesKpiDefinition.findMany.mockResolvedValue([{ ...row, productSource: 'TARGET_NAMES' }]);
    const [l1, l2, l3] = await Promise.all([db1, db2, db3].map((d) => new SalesKpiDefService(d as never).list('t1')));
    expect(l2.definitionsHash).toBe(l1.definitionsHash);
    expect(l3.definitionsHash).not.toBe(l1.definitionsHash);
    expect(l1.definitions[0].productSource).toBe('FILTER');
    expect(l3.definitions[0].productSource).toBe('TARGET_NAMES');
    const en = await new SalesKpiDefService(db3 as never).enabled('t1');
    expect(en.defs[0].productSource).toBe('TARGET_NAMES');
    const en1 = await new SalesKpiDefService(db1 as never).enabled('t1');
    expect(en1.defs[0]).not.toHaveProperty('productSource');
  });

  it('the KPI tester refuses a TARGET_NAMES draft with a pointer to the month screen', async () => {
    const db = txDb();
    await expect(
      new SalesKpiDefService(db as never).test(user, { importId: 'latest', definition: dto({ productSource: 'TARGET_NAMES' }) as never }),
    ).rejects.toThrow(/on the month screen/);
    expect(db.salesImport.findFirst).not.toHaveBeenCalled();
  });
});
