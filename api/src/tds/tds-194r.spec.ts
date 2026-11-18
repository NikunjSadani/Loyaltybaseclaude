/**
 * 194R — owner decisions 2026-11-18 (D2–D6, D9, D10 + Q1–Q6). One in-memory dataset drives BOTH the
 * 194R report (TdsService.compute194R) and the payout engine (CreditsService.buildPayoutTdsPlan), so
 * the parity test proves they share ONE definition of "what counts" and "how much is due".
 * Dates are computed relative to "now" (never a hardcoded future date).
 */
import { TdsService } from './tds.service';
import { CreditsService } from '../credits/credits.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY, financialYear, type ResolvedTdsStatutory } from './tds.helpers';
import { liability194R } from './tds-194r.shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { TdsStatutoryConfigService } from './tds-statutory.config.service';
import type { TenantSettingsService } from '../tenant/tenant-settings.service';

const CLIENT = 'bajaj';
const NOW = new Date();
const FY = financialYear(NOW);
/** A date `days` into the current FY (always inside it, independent of today). */
const inFy = (days: number) => new Date(FY.start.getTime() + days * 86_400_000);

type Entry = {
  id: string; clientId: string; status: string; paidAt: Date | null; downloadedAt?: Date | null;
  outletId: string; amountPaise: bigint; fieldId: string; tdsSection: string | null; sourceKind?: string | null;
};
type Data = {
  entries: Entry[];
  outlets: Array<{ outletCode: string; clientId: string; partnerId: string | null }>;
  partners: Array<{ id: string; clientId: string; panNumber: string | null; isParent?: boolean }>;
  redemptions: Array<{ clientId: string; partnerId: string; valuePaise: bigint; redemptionMode: string; deliveredAt: Date }>;
  offPlatform: Array<{ clientId: string; panNumber: string; outletCode: string | null; amountPaise: bigint; entryDate: Date }>;
  deposits: Array<{ clientId: string; panNumber: string; outletCode: string | null; amountPaise: bigint; forPeriod: string; depositDate: Date; uploadBatchId: string | null }>;
  ledger: Array<{ clientId: string; panNumber: string; section: string; fyLabel: string; tdsDeductedThisPaise: bigint }>;
  countFrom: string | null;
};
const empty = (): Data => ({ entries: [], outlets: [], partners: [], redemptions: [], offPlatform: [], deposits: [], ledger: [], countFrom: null });

const inRange = (d: Date | null | undefined, r?: { gte?: Date; lt?: Date }) =>
  !r || (!!d && (!r.gte || d >= r.gte) && (!r.lt || d < r.lt));
const inList = <T>(v: T, f?: { in?: T[] }) => !f?.in || f.in.includes(v);
const ciIn = (v: string | null, f?: { in?: string[] }) => !f?.in || (!!v && f.in.map((x) => x.toUpperCase()).includes(v.toUpperCase()));
const ciEq = (v: string | null, f?: { equals?: string }) => !f?.equals || (!!v && v.toUpperCase() === f.equals.toUpperCase());

/** A where-aware fake of exactly the Prisma reads the shared 194R path + report make. */
function fakeDb(d: Data) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    creditField: { findMany: async () => [{ id: 'f-vis' }] },
    programSetting: { findUnique: async () => (d.countFrom ? { settingValue: { countFrom: d.countFrom } } : null) },
    creditPayoutEntry: {
      findMany: async ({ where: w }: any) =>
        d.entries.filter((e) => {
          if (w.clientId && e.clientId !== w.clientId) return false;
          if (w.status && e.status !== w.status) return false;
          if (w.paidAt && !inRange(e.paidAt, w.paidAt)) return false;
          if (w.download && !inRange(e.downloadedAt, w.download.downloadedAt)) return false;
          if (w.fieldId && e.fieldId !== w.fieldId) return false;
          if (w.batch?.sourceKind === 'VENDOR_IMPORT' && e.sourceKind !== 'VENDOR_IMPORT') return false;
          if (w.batch?.OR && e.sourceKind === 'VENDOR_IMPORT') return false;
          return inList(e.outletId, w.outletId);
        }),
    },
    outlet: {
      findMany: async ({ where: w }: any) =>
        d.outlets.filter(
          (o) =>
            (!w.clientId || o.clientId === w.clientId) &&
            inList(o.outletCode, w.outletCode) &&
            inList(o.partnerId, w.partnerId) &&
            (!w.OR || w.OR.some((c: any) => ciEq(o.outletCode, c.outletCode))),
        ),
    },
    channelPartner: {
      findMany: async ({ where: w }: any) =>
        d.partners.filter(
          (p) =>
            !p.isParent &&
            (!w.clientId || p.clientId === w.clientId) &&
            inList(p.id, w.id) &&
            (!w.OR || w.OR.some((c: any) => ciEq(p.panNumber, c.panNumber))),
        ),
    },
    redemptionOrder: {
      findMany: async ({ where: w }: any) =>
        d.redemptions
          .filter((r) => r.clientId === w.partner.clientId && inRange(r.deliveredAt, w.deliveredAt) && inList(r.partnerId, w.partnerId))
          .map((r) => ({
            valuePaise: r.valuePaise,
            redemptionMode: r.redemptionMode,
            partner: { id: r.partnerId, panNumber: d.partners.find((p) => p.id === r.partnerId)?.panNumber ?? null },
          })),
    },
    tdsOffPlatformEntry: {
      findMany: async ({ where: w }: any) =>
        d.offPlatform.filter(
          (o) =>
            o.clientId === w.clientId &&
            inRange(o.entryDate, w.entryDate) &&
            (!w.OR || ciIn(o.panNumber, w.OR[0].panNumber) || ciIn(o.outletCode, w.OR[1].outletCode)),
        ),
    },
    tdsDeposit: {
      findMany: async ({ where: w }: any) =>
        d.deposits.filter((x) => (w.clientId === undefined || x.clientId === w.clientId) && x.forPeriod >= w.OR[0].forPeriod.gte && x.forPeriod <= w.OR[0].forPeriod.lte),
    },
    tdsDeductionEntry: {
      findMany: async ({ where: w }: any) =>
        d.ledger.filter(
          (l) =>
            (!w.clientId || l.clientId === w.clientId) &&
            (!w.section || l.section === w.section) &&
            (!w.fyLabel || l.fyLabel === w.fyLabel) &&
            ciIn(l.panNumber, w.panNumber),
        ),
    },
  } as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function services(d: Data, methodology: 'DEDUCT' | 'GROSS_UP', cfg: ResolvedTdsStatutory = DEFAULT_RESOLVED_TDS_STATUTORY) {
  const db = fakeDb(d);
  const statutory = { getForFy: jest.fn().mockResolvedValue(cfg) } as unknown as TdsStatutoryConfigService;
  const tenantSettings = { resolveTdsPolicy: jest.fn().mockResolvedValue({ section: 'SEC_194R', methodology }) } as unknown as TenantSettingsService;
  const tds = new TdsService(db as PrismaService, statutory, tenantSettings);
  const noop = {} as never;
  const credits = new CreditsService(db as PrismaService, noop, noop, noop, tenantSettings, noop, statutory);
  return { db, tds, credits };
}

const pan = (id: string, p: string | null, clientId = CLIENT) => ({ id, clientId, panNumber: p });
const paidVis = (id: string, amountPaise: bigint, outletId = 'O1', clientId = CLIENT): Entry => ({
  id, clientId, status: 'PAID', paidAt: inFy(30), outletId, amountPaise, fieldId: 'f-vis', tdsSection: 'SEC_194R',
});
const paidInc = (id: string, amountPaise: bigint, outletId = 'O1', paidAt = inFy(40)): Entry => ({
  id, clientId: CLIENT, status: 'PAID', paidAt, outletId, amountPaise, fieldId: 'f-inc', tdsSection: 'SEC_194R',
});

describe('194R shared definition — liability194R (pure)', () => {
  const cfg = DEFAULT_RESOLVED_TDS_STATUTORY;
  it('WORKED EXAMPLE: DEDUCT, PAN, visibility ₹15,000 + gift ₹8,000 → ₹1,500 deducted + ₹889 client-borne = ₹2,389', () => {
    const l = liability194R({ hasPan: true, visPaise: 1500000n, cashPaise: 0n, nonCashPaise: 800000n }, 'DEDUCT', cfg);
    expect(l).toMatchObject({ thresholdMet: true, ratePct: 10, deductPartPaise: 150000n, clientBornePartPaise: 88900n, liabilityPaise: 238900n });
  });
  it('GROSS_UP: the whole year is client-borne (10/90)', () => {
    const l = liability194R({ hasPan: true, visPaise: 1500000n, cashPaise: 0n, nonCashPaise: 800000n }, 'GROSS_UP', cfg);
    expect(l).toMatchObject({ deductPartPaise: 0n, clientBornePartPaise: 255600n, liabilityPaise: 255600n }); // 23000×10/90 = 2555.56 → ₹2,556
  });
  it('no PAN on DEDUCT (owner 2026-11-18): visibility ₹30,000 is WITHHELD at 20% = ₹6,000 (not client-borne)', () => {
    const l = liability194R({ hasPan: false, visPaise: 3000000n, cashPaise: 0n, nonCashPaise: 0n }, 'DEDUCT', cfg);
    expect(l).toMatchObject({ ratePct: 20, deductBasePaise: 3000000n, deductPartPaise: 600000n, clientBornePartPaise: 0n, liabilityPaise: 600000n });
  });
  it('no PAN on DEDUCT: gifts / incentives stay client-borne at 20/80 alongside the withheld visibility', () => {
    const l = liability194R({ hasPan: false, visPaise: 1500000n, cashPaise: 400000n, nonCashPaise: 400000n }, 'DEDUCT', cfg);
    expect(l).toMatchObject({ deductPartPaise: 300000n, clientBornePartPaise: 200000n }); // 20% × 15k; 8k × 20/80
  });
  it('no PAN on GROSS_UP: the whole year client-borne at 20/80', () => {
    const l = liability194R({ hasPan: false, visPaise: 3000000n, cashPaise: 0n, nonCashPaise: 0n }, 'GROSS_UP', cfg);
    expect(l).toMatchObject({ deductPartPaise: 0n, clientBornePartPaise: 750000n });
  });
  it('threshold is strictly greater than ₹20,000 (exactly ₹20,000 → nothing due)', () => {
    expect(liability194R({ hasPan: true, visPaise: 2000000n, cashPaise: 0n, nonCashPaise: 0n }, 'DEDUCT', cfg).liabilityPaise).toBe(0n);
  });
  it('D5: rates come from the statutory config, never a fixed fraction', () => {
    const custom = { ...cfg, r194rWithPan: { num: 5, den: 95 } };
    const l = liability194R({ hasPan: true, visPaise: 3000000n, cashPaise: 0n, nonCashPaise: 0n }, 'DEDUCT', custom);
    expect(l).toMatchObject({ ratePct: 5, deductPartPaise: 150000n });
  });
});

describe('194R report (compute194R) on the shared definition', () => {
  it('WORKED EXAMPLE + D10 columns: DEDUCT client; deducted so far is SHOWN but not subtracted (Q3); outstanding = liability − deposited', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidVis('v1', 1500000n)];
    d.redemptions = [{ clientId: CLIENT, partnerId: 'p1', valuePaise: 800000n, redemptionMode: 'PHYSICAL_GIFT', deliveredAt: inFy(50) }];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 150000n }];
    d.deposits = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 100000n, forPeriod: `${FY.fyLabel.slice(0, 4)}-06`, depositDate: inFy(70), uploadBatchId: 'DEP-' + 'a'.repeat(64) }];
    const { tds } = services(d, 'DEDUCT');

    const [row] = await tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({
      panNumber: 'ABCDE1234F', methodology: 'DEDUCT', ratePct: 10,
      baseFyTotalPaise: 2300000n, cashBasePaise: 1500000n, nonCashBasePaise: 800000n,
      deductBasePaise: 1500000n, clientBorneBasePaise: 800000n,
      deductLiabilityPaise: 150000n, clientBorneLiabilityPaise: 88900n, liabilityPaise: 238900n,
      deductedPaise: 150000n, depositedPaise: 100000n,
      outstandingPaise: 138900n, // 238900 − 100000 (the ₹1,500 deducted is NOT subtracted)
      importedVendorDepositPaise: 0n,
    });
  });

  it('D4: a no-PAN OWNER with 2 outlets (₹15,000 + ₹15,000) is ONE retailer → ₹30,000 > ₹20,000 → 20/80 = ₹7,500', async () => {
    const d = empty();
    d.partners = [pan('p9', null)];
    d.outlets = [
      { outletCode: 'A1', clientId: CLIENT, partnerId: 'p9' },
      { outletCode: 'A2', clientId: CLIENT, partnerId: 'p9' },
    ];
    d.entries = [paidInc('i1', 1500000n, 'A1'), paidInc('i2', 1500000n, 'A2')];
    const { tds } = services(d, 'DEDUCT');

    const rows = await tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ panNumber: '__NO_PAN__:p9', baseFyTotalPaise: 3000000n, ratePct: 20, liabilityPaise: 750000n, deductLiabilityPaise: 0n });
  });

  it('no-PAN OWNER with 2 outlets, VISIBILITY on DEDUCT: ₹15,000 + ₹15,000 → 20% = ₹6,000 deducted part; "deducted so far" matched by the owner key', async () => {
    const d = empty();
    d.partners = [pan('p9', null)];
    d.outlets = [
      { outletCode: 'A1', clientId: CLIENT, partnerId: 'p9' },
      { outletCode: 'A2', clientId: CLIENT, partnerId: 'p9' },
    ];
    d.entries = [paidVis('v1', 1500000n, 'A1'), paidVis('v2', 1500000n, 'A2')];
    d.ledger = [{ clientId: CLIENT, panNumber: '__NO_PAN__:p9', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 600000n }];
    const rows = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      panNumber: '__NO_PAN__:p9', ratePct: 20, deductBasePaise: 3000000n, deductLiabilityPaise: 600000n,
      clientBorneLiabilityPaise: 0n, liabilityPaise: 600000n, deductedPaise: 600000n, outstandingPaise: 600000n,
    });
  });

  it('D4: an outlet with NO partner counts alone (per client + outlet)', async () => {
    const d = empty();
    d.outlets = [{ outletCode: 'Z1', clientId: CLIENT, partnerId: null }];
    d.entries = [paidInc('i1', 2100000n, 'Z1')];
    const { tds } = services(d, 'GROSS_UP');
    const rows = await tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows.map((r) => r.panNumber)).toEqual([`__NO_PAN__:outlet:${CLIENT}:Z1`]);
  });

  it('D6 METHOD SWITCH: the same year recomputes on the CURRENT method (GROSS_UP 10/90 on all vs DEDUCT 10% on the visibility)', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidVis('v1', 10000000n), paidVis('v2', 500000n)];
    const gu = (await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null))[0];
    const de = (await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null))[0];
    expect(gu).toMatchObject({ methodology: 'GROSS_UP', liabilityPaise: 1166700n }); // 105000×10/90 = 11666.67 → ₹11,667
    expect(de).toMatchObject({ methodology: 'DEDUCT', liabilityPaise: 1050000n }); // 10% × ₹1,05,000
  });

  it('cash vs non-cash split: incentive + UPI redemption = cash; gift card + off-platform = non-cash', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidInc('i1', 100000n)];
    d.redemptions = [
      { clientId: CLIENT, partnerId: 'p1', valuePaise: 500000n, redemptionMode: 'UPI', deliveredAt: inFy(10) },
      { clientId: CLIENT, partnerId: 'p1', valuePaise: 300000n, redemptionMode: 'GIFT_CARD', deliveredAt: inFy(11) },
    ];
    d.offPlatform = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 200000n, entryDate: inFy(12) }];
    const [row] = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({ cashBasePaise: 600000n, nonCashBasePaise: 500000n, deductBasePaise: 0n, clientBorneBasePaise: 1100000n });
  });

  it('D9: imported vendor payouts count only when paid ON/AFTER the client’s countFrom date', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    const imp = (id: string, days: number): Entry => ({ ...paidInc(id, 1000000n, 'O1', inFy(days)), fieldId: 'historical-incentive-payout', sourceKind: 'VENDOR_IMPORT' });
    d.entries = [imp('before', 10), imp('after', 100)];
    const countFrom = inFy(50).toISOString().slice(0, 10);
    const on = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, countFrom);
    const off = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(on[0].baseFyTotalPaise).toBe(1000000n); // only the payout after countFrom
    expect(off).toHaveLength(0); // OFF → imported history never counts
  });

  it('Q4: imported vendor TDS is a deposit (subtracted ONCE) and is labelled "of which imported"', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidInc('i1', 3000000n)];
    const fp = `${FY.fyLabel.slice(0, 4)}-05`;
    d.deposits = [
      { clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 100000n, forPeriod: fp, depositDate: inFy(40), uploadBatchId: 'bajaj-vendor-tds-fy2627-2026-11-13' },
      { clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 50000n, forPeriod: fp, depositDate: inFy(41), uploadBatchId: 'DEP-' + 'b'.repeat(64) },
    ];
    const [row] = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({ depositedPaise: 150000n, importedVendorDepositPaise: 100000n, liabilityPaise: 333300n, outstandingPaise: 183300n });
  });

  it('D2: another client’s payouts to the same PAN are never added', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F'), pan('px', 'ABCDE1234F', 'other')];
    d.outlets = [
      { outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' },
      { outletCode: 'OX', clientId: 'other', partnerId: 'px' },
    ];
    d.entries = [paidVis('v1', 1500000n), paidVis('x1', 1500000n, 'OX', 'other')];
    const rows = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ baseFyTotalPaise: 1500000n, liabilityPaise: 0n });
  });
});

describe('PARITY: engine and report give the same 194R TDS for the same data', () => {
  it('the engine’s whole-year due == the report’s deducted part, and deducted-so-far + this withholding == it', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidVis('v1', 1500000n), paidInc('i1', 400000n)];
    d.redemptions = [{ clientId: CLIENT, partnerId: 'p1', valuePaise: 800000n, redemptionMode: 'PHYSICAL_GIFT', deliveredAt: inFy(20) }];
    d.offPlatform = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 100000n, entryDate: inFy(21) }];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 50000n }];

    // ── Engine: this run pays ₹10,000 of visibility now (still PENDING in the DB). ──
    const { credits } = services(d, 'DEDUCT');
    const plan = await (credits as unknown as {
      buildPayoutTdsPlan: (db: unknown, p: unknown) => Promise<{ deductionLedger: Array<{ tdsDueCumulativePaise: bigint; tdsDeductedThisPaise: bigint }> }>;
    }).buildPayoutTdsPlan(fakeDb(d), {
      clientId: CLIENT,
      period: '2026-05',
      engineEntries: [{ id: 'run1', outletId: 'O1', amountPaise: 1000000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' }],
      outletTaxMap: new Map([['O1', { partnerId: 'p1', panNumber: 'ABCDE1234F', entityType: 'INDIVIDUAL' }]]),
      runAt: NOW,
      currentMethodology: 'DEDUCT',
      importedCountFrom: null,
    });
    const engineDue = plan.deductionLedger[0].tdsDueCumulativePaise;
    const withheldNow = plan.deductionLedger.reduce((s, r) => s + r.tdsDeductedThisPaise, 0n);

    // ── Report: the same state AFTER the run (the run's entry is now PROCESSING, dated by its bank file). ──
    const after = { ...d, entries: [...d.entries, { id: 'run1', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'O1', amountPaise: 1000000n, fieldId: 'f-vis', tdsSection: 'SEC_194R' }] };
    const [row] = await services(after, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);

    expect(engineDue).toBe(250000n); // 10% × (₹15,000 + ₹10,000) visibility; ₹27,000 total > ₹20,000
    expect(row.deductLiabilityPaise).toBe(engineDue);
    expect(row.deductedPaise + withheldNow).toBe(row.deductLiabilityPaise); // ₹500 earlier + ₹2,000 now
    expect(row.clientBorneLiabilityPaise).toBe(144400n); // (4,000 + 8,000 + 1,000) × 10/90 = 1444.44 → ₹1,444
  });
  it('no-PAN OWNER with 2 outlets on DEDUCT: engine withholding (20%) == the report’s deducted part', async () => {
    const d = empty();
    d.partners = [pan('p9', null)];
    d.outlets = [
      { outletCode: 'A1', clientId: CLIENT, partnerId: 'p9' },
      { outletCode: 'A2', clientId: CLIENT, partnerId: 'p9' },
    ];
    d.entries = [paidVis('v1', 1000000n, 'A1')];
    d.redemptions = [{ clientId: CLIENT, partnerId: 'p9', valuePaise: 400000n, redemptionMode: 'GIFT_CARD', deliveredAt: inFy(20) }];
    d.ledger = [{ clientId: CLIENT, panNumber: '__NO_PAN__:p9', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 100000n }];
    const { credits } = services(d, 'DEDUCT');
    const plan = await (credits as unknown as {
      buildPayoutTdsPlan: (db: unknown, p: unknown) => Promise<{ deductionLedger: Array<{ panNumber: string; tdsDueCumulativePaise: bigint; tdsDeductedThisPaise: bigint; carryForwardPaise: bigint }> }>;
    }).buildPayoutTdsPlan(fakeDb(d), {
      clientId: CLIENT,
      period: '2026-05',
      // This run pays BOTH outlets of the same owner — one retailer, one whole-year true-up.
      engineEntries: [
        { id: 'r1', outletId: 'A1', amountPaise: 1000000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' },
        { id: 'r2', outletId: 'A2', amountPaise: 1000000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' },
      ],
      outletTaxMap: new Map([
        ['A1', { partnerId: 'p9', panNumber: null, entityType: null }],
        ['A2', { partnerId: 'p9', panNumber: null, entityType: null }],
      ]),
      runAt: NOW,
      currentMethodology: 'DEDUCT',
      importedCountFrom: null,
    });
    expect(new Set(plan.deductionLedger.map((r) => r.panNumber))).toEqual(new Set(['__NO_PAN__:p9']));
    const engineDue = plan.deductionLedger[0].tdsDueCumulativePaise;
    const withheldNow = plan.deductionLedger.reduce((s, r) => s + r.tdsDeductedThisPaise, 0n);
    expect(engineDue).toBe(600000n); // 20% × (₹10,000 earlier + ₹20,000 now)
    expect(withheldNow).toBe(500000n); // minus ₹1,000 already deducted

    const after = {
      ...d,
      entries: [
        ...d.entries,
        { id: 'r1', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'A1', amountPaise: 1000000n, fieldId: 'f-vis', tdsSection: 'SEC_194R' },
        { id: 'r2', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'A2', amountPaise: 1000000n, fieldId: 'f-vis', tdsSection: 'SEC_194R' },
      ],
      ledger: [...d.ledger, { clientId: CLIENT, panNumber: '__NO_PAN__:p9', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: withheldNow }],
    };
    const [row] = await services(after, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row.panNumber).toBe('__NO_PAN__:p9');
    expect(row.deductLiabilityPaise).toBe(engineDue);
    expect(row.deductedPaise).toBe(row.deductLiabilityPaise); // fully withheld after this run
    expect(row.clientBorneLiabilityPaise).toBe(100000n); // gift ₹4,000 × 20/80
  });
});
