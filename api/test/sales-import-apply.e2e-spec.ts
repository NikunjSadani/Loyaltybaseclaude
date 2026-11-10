/**
 * K-6 integration — SalesApplyService against a REAL Postgres (plan §11 K-6).
 *
 * Runs under `npm run test:e2e` ONLY when BOTH `DATABASE_URL` is set AND `SALES_IMPORT_E2E=1` (explicit opt-in: the
 * spec writes rows), and refuses to run if `current_database()` looks like staging/prod (they share an instance).
 * Every row it writes lives under a unique throw-away clientId and is deleted in afterAll.
 *
 * Asserts the §7.2 SQL on real jsonb: after apply, a MANUAL key on an existing row is untouched, the OWNED key holds the
 * new value, an in-roster outlet with no lines is 0, an off-roster row lost its owned key, and the existing row's
 * batchId is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SalesApplyService } from '../src/sales-import/apply/sales-apply.service';
import { SalesKpiDefService } from '../src/sales-import/kpi/sales-kpi-def.service';
import { definitionsHash, stableStringify } from '../src/sales-import/kpi/sales-kpi.helper';
import { mappingFingerprint } from '../src/sales-import/ingest/mapping-fingerprint';
import type { SalesColumnMapping } from '../src/sales-import/sales-import.contract';
import { currentMonthKey } from '../src/targets/targets.helpers';

const enabled = !!process.env.DATABASE_URL && process.env.SALES_IMPORT_E2E === '1';
const d = enabled ? describe : describe.skip;

d('SalesApplyService × real Postgres (K-6)', () => {
  let prisma: PrismaService; // constructed in beforeAll, so skip mode never builds a client
  const clientId = `e2e-si-${randomUUID().slice(0, 8)}`;
  const month = currentMonthKey(); // the current month is always OPEN (date-relative)
  let typeId = '';
  let actorId = '';
  let manualBatchId = '';
  const MAPPING: SalesColumnMapping = {
    headerRow: 'auto', outletCode: 'CODE', invoiceDate: 'DATE', amount: 'AMT', quantity: null,
    dimensions: [{ key: 'dimA', label: 'A', header: 'A' }], dateOrder: 'DMY',
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (/prod|staging/i.test(db)) throw new Error(`Refusing to run against ${db}`);
    const actor = await prisma.user.findFirst({ select: { id: true } });
    if (!actor) throw new Error('Need at least one user row (AuditLog.actorId FK).');
    actorId = actor.id;
    const type = await prisma.outletType.create({ data: { code: `E2E_${clientId}`, name: 'E2E' } });
    typeId = type.id;
    for (const code of ['A1', 'A2', 'A3']) {
      await prisma.outlet.create({ data: { clientId, outletTypeId: typeId, outletCode: code, name: code, city: 'X', state: 'Y' } });
    }
    const manual = await prisma.salesUploadBatch.create({ data: { clientId, uploadedById: actorId, month, status: 'COMPLETED' } });
    manualBatchId = manual.id;
    await prisma.outletSalesRecord.createMany({
      data: [
        { clientId, outletCode: 'A1', outletName: 'A1', month, kpiValues: { MANUAL_K: 5, OWNED_K: 1 }, batchId: manualBatchId },
        { clientId, outletCode: 'GONE', outletName: 'Gone', month, kpiValues: { MANUAL_K: 9, OWNED_K: 7 }, batchId: manualBatchId },
      ],
    });
    await prisma.salesImportProfile.create({ data: { clientId, columnMapping: MAPPING as never, updatedById: actorId } });
    await prisma.salesKpiDefinition.create({
      data: { clientId, kpiCode: 'OWNED_K', measure: 'AMOUNT', filter: {}, updatedById: actorId },
    });
    await prisma.salesImport.create({
      data: {
        id: `${clientId}-imp`, clientId, uploadedById: actorId, originalFilename: 'f.csv', fileKind: 'CSV', sizeBytes: 1n,
        partCount: 1, gcsPrefix: 'x/', status: 'READY', processingVersion: 1, mappingFingerprint: mappingFingerprint(MAPPING),
        monthSummaries: [{ month, firstDate: `${month}-01`, lastDate: `${month}-01`, lines: 2, matchedOutlets: 2, unmatchedCustomers: 0,
          matchedAmountRupees: 0, matchedQuantity: 0, unmatchedAmountRupees: 0, unmatchedQuantity: 0 }],
      },
    });
    const dims = { dimA: 'X' };
    await prisma.salesImportAggregate.createMany({
      data: [
        { importId: `${clientId}-imp`, month, outletCode: 'A1', dims, dimKey: stableStringify(dims), amountPaise: 12345n, qtyPico: 0n, lines: 1 },
        { importId: `${clientId}-imp`, month, outletCode: 'A2', dims, dimKey: stableStringify(dims), amountPaise: -500n, qtyPico: 0n, lines: 1 },
        // M6: a customer not on the roster is aggregated too; apply must ignore it
        { importId: `${clientId}-imp`, month, outletCode: 'ZZ9', dims, dimKey: stableStringify(dims), amountPaise: 999n, qtyPico: 0n, lines: 1 },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.auditLog.deleteMany({ where: { entityType: 'SALES_MONTH', entityId: `${clientId}:${month}` } });
    await prisma.salesImportApply.deleteMany({ where: { clientId } });
    await prisma.salesImport.deleteMany({ where: { clientId } });
    await prisma.salesMonthStatus.deleteMany({ where: { clientId } });
    await prisma.salesKpiDefinition.deleteMany({ where: { clientId } });
    await prisma.salesImportProfile.deleteMany({ where: { clientId } });
    await prisma.salesUploadBatch.deleteMany({ where: { clientId } }); // cascades outlet_sales_records
    await prisma.outlet.deleteMany({ where: { clientId } });
    if (typeId) await prisma.outletType.delete({ where: { id: typeId } });
    await prisma.$disconnect();
  });

  it('merges owned keys only, zero-fills, strips off-roster, keeps existing batchId', async () => {
    const svc = new SalesApplyService(prisma as never, new SalesKpiDefService(prisma as never));
    const hash = definitionsHash([{ kpiCode: 'OWNED_K', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [] }]);
    const res = await svc.apply(
      { sub: actorId, role: 'CLIENT_ADMIN', clientId, phone: '', name: 'E2E' },
      `${clientId}-imp`,
      { months: [month], expectedDefinitionsHash: hash, processingVersion: 1, acknowledgePartialMonths: [month] },
    );
    expect(res.results[0]).toEqual(expect.objectContaining({ ok: true, outletsWritten: 3, outletsZeroFilled: 1 }));

    const rows = await prisma.outletSalesRecord.findMany({ where: { clientId, month } });
    const by = Object.fromEntries(rows.map((r) => [r.outletCode, r]));
    expect(by.A1.kpiValues).toEqual({ MANUAL_K: 5, OWNED_K: 123.45 });
    expect(by.A1.batchId).toBe(manualBatchId);
    expect(by.A2.kpiValues).toEqual({ OWNED_K: -5 });
    expect(by.A3.kpiValues).toEqual({ OWNED_K: 0 });
    expect(by.GONE.kpiValues).toEqual({ MANUAL_K: 9 });

    // idempotent re-apply
    const again = await svc.apply(
      { sub: actorId, role: 'CLIENT_ADMIN', clientId, phone: '', name: 'E2E' },
      `${clientId}-imp`,
      { months: [month], expectedDefinitionsHash: hash, processingVersion: 1, acknowledgePartialMonths: [month] },
    );
    expect(again.results[0].ok).toBe(true);
    const rows2 = await prisma.outletSalesRecord.findMany({ where: { clientId, month }, orderBy: { outletCode: 'asc' } });
    expect(rows2.map((r) => r.kpiValues)).toEqual(['A1', 'A2', 'A3', 'GONE'].map((c) => by[c].kpiValues));
  });
});
