/**
 * 194R — owner decisions 2026-11-18 (D2–D6, D9, D10 + Q1–Q6). One in-memory dataset drives BOTH the
 * 194R report (TdsService.compute194R) and the payout engine (CreditsService.buildPayoutTdsPlan), so
 * the parity test proves they share ONE definition of "what counts" and "how much is due".
 * Dates are computed relative to "now" (never a hardcoded future date).
 */
import { TdsService } from './tds.service';
import { CreditsService } from '../credits/credits.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY, financialYear, type ResolvedTdsStatutory } from './tds.helpers';
import { liability194R, normalisePan, payeeKeyFor } from './tds-194r.shared';
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
  /** Payee SNAPSHOT at payment time (owner rule 2026-11-18). */
  payeePan?: string | null;
};
const ciContains = (v: string | null, f?: { contains?: string }) =>
  !f?.contains || (!!v && v.toUpperCase().includes(f.contains.toUpperCase()));
type Data = {
  entries: Entry[];
  outlets: Array<{ outletCode: string; clientId: string; partnerId: string | null }>;
  partners: Array<{ id: string; clientId: string; panNumber: string | null; isParent?: boolean }>;
  redemptions: Array<{ clientId: string; partnerId: string; valuePaise: bigint; redemptionMode: string; deliveredAt: Date; payeePan?: string | null }>;
  offPlatform: Array<{ clientId: string; panNumber: string; outletCode: string | null; amountPaise: bigint; entryDate: Date; resolvedKey?: string | null }>;
  deposits: Array<{ clientId: string; panNumber: string; outletCode: string | null; amountPaise: bigint; forPeriod: string; depositDate: Date; uploadBatchId: string | null; resolvedKey?: string | null }>;
  ledger: Array<{ clientId: string; panNumber: string; section: string; fyLabel: string; tdsDeductedThisPaise: bigint; outletCode?: string | null; carryForwardPaise?: bigint; createdAt?: Date }>;
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
    // A-L1: SELECT … FROM channel_partners WHERE "clientId" = $1 AND upper(btrim("panNumber")) = ANY($2)
    $queryRaw: async (q: { values: [string, string[]] }) =>
      d.partners
        .filter((p) => p.clientId === q.values[0] && !!p.panNumber && q.values[1].includes(normalisePan(p.panNumber)))
        .map((p) => ({ id: p.id, panNumber: p.panNumber })),
    programSetting: { findUnique: async () => (d.countFrom ? { settingValue: { countFrom: d.countFrom } } : null) },
    creditPayoutEntry: {
      findMany: async ({ where: w }: any) =>
        d.entries.filter((e) => {
          if (w.clientId && e.clientId !== w.clientId) return false;
          if (typeof w.status === 'string' && e.status !== w.status) return false;
          if (w.status?.in && !w.status.in.includes(e.status)) return false;
          if (w.downloadId === null && e.downloadedAt) return false; // "no bank file"
          if (w.download && !e.downloadedAt) return false;
          if (w.paidAt && !inRange(e.paidAt, w.paidAt)) return false;
          if (w.download && !inRange(e.downloadedAt, w.download.downloadedAt)) return false;
          if (w.fieldId && e.fieldId !== w.fieldId) return false;
          if (w.batch?.sourceKind === 'VENDOR_IMPORT' && e.sourceKind !== 'VENDOR_IMPORT') return false;
          if (w.batch?.OR && e.sourceKind === 'VENDOR_IMPORT') return false;
          if (w.OR) {
            return w.OR.some((c: any) =>
              c.payeePan?.in ? !!e.payeePan && c.payeePan.in.includes(e.payeePan) : !e.payeePan && inList(e.outletId, c.outletId),
            );
          }
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
            (w.isParent === undefined || !!p.isParent === w.isParent) &&
            (!w.clientId || p.clientId === w.clientId) &&
            inList(p.id, w.id) &&
            (!w.OR || w.OR.some((c: any) => ciEq(p.panNumber, c.panNumber) && ciContains(p.panNumber, c.panNumber))),
        ),
    },
    redemptionOrder: {
      findMany: async ({ where: w }: any) =>
        d.redemptions
          .filter(
            (r) =>
              r.clientId === w.partner.clientId &&
              inRange(r.deliveredAt, w.deliveredAt) &&
              (!w.OR ||
                w.OR.some((c: any) => (c.payeePan?.in ? !!r.payeePan && c.payeePan.in.includes(r.payeePan) : !r.payeePan && inList(r.partnerId, c.partnerId)))),
          )
          .map((r) => ({
            valuePaise: r.valuePaise,
            redemptionMode: r.redemptionMode,
            payeePan: r.payeePan ?? null,
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
            ciIn(l.panNumber, w.panNumber) &&
            (!w.OR || w.OR.some((c: any) => (c.panNumber ? ciIn(l.panNumber, c.panNumber) : inList(l.outletCode ?? null, c.outletCode)))),
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

describe('owner FY rule: a payout belongs to the FY its BANK FILE was made', () => {
  // The 30-March-file / 2-April-paid case, in the FY before the current one (computed from now).
  const prev = financialYear(new Date(FY.start.getTime() - 86_400_000));
  const fileDate = new Date(prev.endExclusive.getTime() - 2 * 86_400_000); // 30 Mar (IST-ish)
  const paidDate = new Date(prev.endExclusive.getTime() + 1 * 86_400_000); // 2 Apr
  const data = () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [{ ...paidVis('v1', 2500000n), paidAt: paidDate, downloadedAt: fileDate }];
    // Its withholding was booked in the file's FY.
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', section: 'SEC_194R', fyLabel: prev.fyLabel, tdsDeductedThisPaise: 250000n }];
    return d;
  };

  it('report: counted ONLY in the bank-file FY (paid in April does not move it)', async () => {
    const before = await services(data(), 'DEDUCT').tds.compute194R(CLIENT, prev.fyLabel, null);
    const after = await services(data(), 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(before[0]).toMatchObject({ baseFyTotalPaise: 2500000n, deductLiabilityPaise: 250000n, deductedPaise: 250000n });
    expect(after.find((r) => r.panNumber === 'ABCDE1234F' && r.baseFyTotalPaise > 0n)).toBeUndefined();
  });

  it('engine: a new run in April does not re-count the March file nor withhold it again', async () => {
    const d = data();
    const { credits } = services(d, 'DEDUCT');
    const plan = await (credits as unknown as {
      buildPayoutTdsPlan: (db: unknown, p: unknown) => Promise<{ deductionLedger: Array<{ cumulativeBasePaise: bigint; tdsDeductedThisPaise: bigint }> }>;
    }).buildPayoutTdsPlan(fakeDb(d), {
      clientId: CLIENT,
      period: '2026-05',
      engineEntries: [{ id: 'run1', outletId: 'O1', amountPaise: 1000000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' }],
      outletTaxMap: new Map([['O1', { partnerId: 'p1', panNumber: 'ABCDE1234F', entityType: 'INDIVIDUAL' }]]),
      runAt: NOW,
      currentMethodology: 'DEDUCT',
      importedCountFrom: null,
    });
    // This FY: only this run's ₹10,000 → below ₹20,000 → nothing withheld (the March file stays in its own FY).
    expect(plan.deductionLedger).toHaveLength(0);
  });
});

describe('owner rule 2026-11-18: TDS is keyed by PAN — a PAN change SPLITS the year at the change', () => {
  const engine = async (d: Data, entries: Array<{ id: string; outletId: string; amountPaise: bigint }>, payee: { partnerId: string; panNumber: string | null }) => {
    const { credits } = services(d, 'DEDUCT');
    return (credits as unknown as {
      buildPayoutTdsPlan: (db: unknown, p: unknown) => Promise<{ deductionLedger: Array<{ panNumber: string; cumulativeBasePaise: bigint; tdsDueCumulativePaise: bigint; tdsDeductedPriorPaise: bigint; tdsDeductedThisPaise: bigint }> }>;
    }).buildPayoutTdsPlan(fakeDb(d), {
      clientId: CLIENT,
      period: '2026-05',
      engineEntries: entries.map((e) => ({ ...e, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' })),
      outletTaxMap: new Map(entries.map((e) => [e.outletId, { ...payee, entityType: 'INDIVIDUAL' }])),
      runAt: NOW,
      currentMethodology: 'DEDUCT',
      importedCountFrom: null,
    });
  };

  it('PAN corrected mid-year: the OLD PAN keeps its ₹30k base + ₹3k deducted; the NEW PAN starts from 0 (₹5k → nothing due)', async () => {
    const d = empty();
    d.partners = [pan('p1', 'NEWPN1234N')]; // the partner's PAN today
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [{ ...paidVis('v1', 3000000n), payeePan: 'OLDPN1234O' }]; // paid under the OLD PAN
    d.ledger = [{ clientId: CLIENT, panNumber: 'OLDPN1234O', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 300000n }];

    const plan = await engine(d, [{ id: 'run1', outletId: 'O1', amountPaise: 500000n }], { partnerId: 'p1', panNumber: 'NEWPN1234N' });
    expect(plan.deductionLedger).toHaveLength(0); // NEW PAN: ₹5,000 only → below ₹20,000

    const after = { ...d, entries: [...d.entries, { id: 'run1', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'O1', amountPaise: 500000n, fieldId: 'f-vis', tdsSection: 'SEC_194R', payeePan: 'NEWPN1234N' }] };
    const rows = await services(after, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    const by = Object.fromEntries(rows.map((r) => [r.panNumber, r]));
    expect(Object.keys(by).sort()).toEqual(['NEWPN1234N', 'OLDPN1234O']); // the report shows BOTH PAN rows
    expect(by['OLDPN1234O']).toMatchObject({ baseFyTotalPaise: 3000000n, deductLiabilityPaise: 300000n, deductedPaise: 300000n, excessDeductedPaise: 0n });
    expect(by['NEWPN1234N']).toMatchObject({ baseFyTotalPaise: 500000n, liabilityPaise: 0n, deductedPaise: 0n });
  });

  it('no PAN, then a PAN is added: earlier payouts stay on the no-PAN owner key (20%); later ones go to the PAN', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')]; // PAN added later
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [{ ...paidVis('v1', 2500000n), payeePan: '__NO_PAN__:p1' }];
    d.ledger = [{ clientId: CLIENT, panNumber: '__NO_PAN__:p1', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 500000n }];
    const plan = await engine(d, [{ id: 'run1', outletId: 'O1', amountPaise: 1000000n }], { partnerId: 'p1', panNumber: 'ABCDE1234F' });
    expect(plan.deductionLedger).toHaveLength(0); // the PAN starts from 0: ₹10,000

    const after = { ...d, entries: [...d.entries, { id: 'run1', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'O1', amountPaise: 1000000n, fieldId: 'f-vis', tdsSection: 'SEC_194R', payeePan: 'ABCDE1234F' }] };
    const rows = await services(after, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    const by = Object.fromEntries(rows.map((r) => [r.panNumber, r]));
    expect(by['__NO_PAN__:p1']).toMatchObject({ ratePct: 20, baseFyTotalPaise: 2500000n, deductLiabilityPaise: 500000n, deductedPaise: 500000n });
    expect(by['ABCDE1234F']).toMatchObject({ ratePct: 10, baseFyTotalPaise: 1000000n, liabilityPaise: 0n });
  });

  it('parity after a PAN change: the NEW PAN crossing on its own payments — engine due == report deducted part', async () => {
    const d = empty();
    d.partners = [pan('p1', 'NEWPN1234N')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [
      { ...paidVis('v1', 3000000n), payeePan: 'OLDPN1234O' },
      { ...paidVis('v2', 1500000n), id: 'v2', payeePan: 'NEWPN1234N' },
    ];
    const plan = await engine(d, [{ id: 'run1', outletId: 'O1', amountPaise: 1000000n }], { partnerId: 'p1', panNumber: 'NEWPN1234N' });
    expect(plan.deductionLedger[0]).toMatchObject({ panNumber: 'NEWPN1234N', cumulativeBasePaise: 2500000n, tdsDueCumulativePaise: 250000n });
    const after = { ...d, entries: [...d.entries, { id: 'run1', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'O1', amountPaise: 1000000n, fieldId: 'f-vis', tdsSection: 'SEC_194R', payeePan: 'NEWPN1234N' }] };
    const rows = await services(after, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows.find((r) => r.panNumber === 'NEWPN1234N')!.deductLiabilityPaise).toBe(plan.deductionLedger[0].tdsDueCumulativePaise);
  });

  it('a redemption delivered under the OLD PAN stays with the old PAN', async () => {
    const d = empty();
    d.partners = [pan('p1', 'NEWPN1234N')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.redemptions = [{ clientId: CLIENT, partnerId: 'p1', valuePaise: 2500000n, redemptionMode: 'UPI', deliveredAt: inFy(10), payeePan: 'OLDPN1234O' }];
    const rows = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows.map((r) => r.panNumber)).toEqual(['OLDPN1234O']);
  });
});

describe('B-L8: ONE scope rule — padded / lower-case PAN on file + a PARENT partner sharing the PAN', () => {
  it('engine and report both count the parent’s redemption and the padded-PAN partner (parity)', async () => {
    const d = empty();
    d.partners = [
      { id: 'p1', clientId: CLIENT, panNumber: ' abcde1234f ' }, // stored padded + lower-case
      { id: 'pp', clientId: CLIENT, panNumber: 'ABCDE1234F', isParent: true }, // the group parent
    ];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidVis('v1', 1000000n)];
    d.redemptions = [{ clientId: CLIENT, partnerId: 'pp', valuePaise: 800000n, redemptionMode: 'UPI', deliveredAt: inFy(15) }];
    const { credits } = services(d, 'DEDUCT');
    const plan = await (credits as unknown as {
      buildPayoutTdsPlan: (db: unknown, p: unknown) => Promise<{ deductionLedger: Array<{ tdsDueCumulativePaise: bigint }> }>;
    }).buildPayoutTdsPlan(fakeDb(d), {
      clientId: CLIENT,
      period: '2026-05',
      engineEntries: [{ id: 'run1', outletId: 'O1', amountPaise: 500000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' }],
      outletTaxMap: new Map([['O1', { partnerId: 'p1', panNumber: ' abcde1234f ', entityType: 'INDIVIDUAL' }]]),
      runAt: NOW,
      currentMethodology: 'DEDUCT',
      importedCountFrom: null,
    });
    // ₹10,000 + ₹5,000 visibility + the parent's ₹8,000 UPI redemption = ₹23,000 > ₹20,000 → due 10% × ₹15,000.
    expect(plan.deductionLedger[0].tdsDueCumulativePaise).toBe(150000n);
    const after = { ...d, entries: [...d.entries, { id: 'run1', clientId: CLIENT, status: 'PROCESSING', paidAt: null, downloadedAt: NOW, outletId: 'O1', amountPaise: 500000n, fieldId: 'f-vis', tdsSection: 'SEC_194R' }] };
    const [row] = await services(after, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({ panNumber: 'ABCDE1234F', baseFyTotalPaise: 2300000n, deductLiabilityPaise: 150000n });
  });
});

describe('report — audit items B-M2 / B-M3 / B-L7 / A-M5', () => {
  const base = () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    return d;
  };

  it('B-M2: withholding with NO base and NO deposit this FY still gets its own row (base 0, deducted shown, note) and counts in the rows', async () => {
    const d = base();
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 120000n }];
    const rows = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ panNumber: 'ABCDE1234F', baseFyTotalPaise: 0n, liabilityPaise: 0n, deductedPaise: 120000n });
    expect(rows[0].note).toMatch(/withheld .* but no benefit is counted/i);
  });

  it('B-M3: a legacy 194R DEDUCT ledger row booked under ANOTHER FY label (old period anchor) is not counted in this FY (current behaviour; prod has none)', async () => {
    const d = base();
    const prev = financialYear(new Date(FY.start.getTime() - 86_400_000));
    d.entries = [paidVis('v1', 2500000n)];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: prev.fyLabel, tdsDeductedThisPaise: 250000n }];
    const [row] = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({ deductLiabilityPaise: 250000n, deductedPaise: 0n });
  });

  it('B-L7: a portal deposit stored with a DEP-<uuid> batch id (Jun-2026 uploads) is NOT labelled imported', async () => {
    const { isImportedDepositBatch } = await import('./tds.service');
    expect(isImportedDepositBatch('DEP-0b7a3c1e-4f2d-4c8b-9a6e-1d2f3a4b5c6d')).toBe(false);
    expect(isImportedDepositBatch('OP-0b7a3c1e-4f2d-4c8b-9a6e-1d2f3a4b5c6d')).toBe(false);
    expect(isImportedDepositBatch('DEP-' + 'a'.repeat(64))).toBe(false);
    expect(isImportedDepositBatch('bajaj-vendor-tds-fy2627-2026-11-13')).toBe(true);
    expect(isImportedDepositBatch(null)).toBe(false);
  });

  it('A-M5: DEDUCT → GROSS_UP switch: ₹40,000 visibility, ₹3,000 withheld AND deposited → liability ₹4,444 (gross-up) → outstanding ₹1,444', async () => {
    const d = base();
    d.entries = [paidVis('v1', 4000000n)];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 300000n }];
    d.deposits = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 300000n, forPeriod: `${FY.fyLabel.slice(0, 4)}-06`, depositDate: inFy(70), uploadBatchId: 'DEP-' + 'c'.repeat(64) }];
    const [row] = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({ methodology: 'GROSS_UP', liabilityPaise: 444400n, deductedPaise: 300000n, depositedPaise: 300000n, outstandingPaise: 144400n });
  });
});

describe('over-withholding — ONLY FLAGGED (owner 2026-11-18): excess column + note, dropped carry-forward, summary total', () => {
  const base = () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    return d;
  };

  it('no-PAN 20% withheld, then the PAN is added: NOT excess — the 20% stays with the no-PAN key (the year splits at the PAN change)', async () => {
    const d = base();
    d.entries = [{ ...paidVis('v1', 3000000n), payeePan: '__NO_PAN__:p1' }];
    d.ledger = [{ clientId: CLIENT, panNumber: '__NO_PAN__:p1', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 600000n }];
    const rows = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows.map((r) => r.panNumber)).toEqual(['__NO_PAN__:p1']);
    expect(rows[0]).toMatchObject({ deductLiabilityPaise: 600000n, deductedPaise: 600000n, excessDeductedPaise: 0n });
  });

  it('B-M1: excess = deducted − the WHOLE-YEAR liability — a DEDUCT → GROSS_UP switch is NOT excess while deducted ≤ liability', async () => {
    const d = base();
    d.entries = [paidVis('v1', 3000000n)];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 300000n }];
    const [row] = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    // GROSS_UP whole-year liability ₹3,333 ≥ ₹3,000 deducted → no excess.
    expect(row).toMatchObject({ liabilityPaise: 333300n, deductedPaise: 300000n, excessDeductedPaise: 0n });
  });

  it('B-M1: excess when deducted > the whole-year liability (the year later drops to ₹20,000 or less after TDS was taken)', async () => {
    const d = base();
    d.entries = [paidVis('v1', 1500000n)]; // ₹3,000 was taken while the year was over ₹20,000; it is now ₹15,000
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 300000n }];
    const [row] = await services(d, 'DEDUCT').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row).toMatchObject({ liabilityPaise: 0n, deductedPaise: 300000n, excessDeductedPaise: 300000n });
    expect(row.note).toContain('TDS taken in excess: ₹3,000.00');
    expect(row.note).toMatch(/no automatic refund/i);
  });

  it('A-L3: the carry-forward is read from the LATEST ledger group (createdAt, then id) — earlier groups never leak in', async () => {
    const d = base();
    d.entries = [paidVis('v1', 10500000n)];
    const t1 = inFy(40);
    const t0 = inFy(10);
    d.ledger = [
      // latest group (one download, same instant): only its LAST row carries the residual
      // stored out of order on purpose: the engine must sort, not trust the read order
      { clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 250000n, carryForwardPaise: 550000n, createdAt: t1, id: 'b2' } as never,
      { clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 250000n, carryForwardPaise: 0n, createdAt: t1, id: 'b1' } as never,
      // an older group's carry-forward (superseded)
      { clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 0n, carryForwardPaise: 999900n, createdAt: t0, id: 'a1' } as never,
    ];
    const [row] = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row.carryForwardDroppedPaise).toBe(550000n);
  });

  it('a carry-forward that is no longer due is shown as DROPPED (not silently)', async () => {
    const d = base();
    d.entries = [paidVis('v1', 10500000n)];
    d.ledger = [
      { clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 500000n, carryForwardPaise: 550000n, createdAt: inFy(40) },
    ];
    // Client moved to GROSS_UP → nothing more will be withheld → the ₹5,500 still "to withhold" is dropped.
    const [row] = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(row.carryForwardDroppedPaise).toBe(550000n);
    expect(row.note).toContain('carry-forward of ₹5,500.00 is no longer due');
  });

  it('L4: the liability tracker carries the note, deducted so far and the excess (rows + totals)', async () => {
    const d = base();
    d.entries = [paidVis('v1', 1500000n)];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 300000n }];
    const { tds } = services(d, 'GROSS_UP');
    jest.spyOn(tds, 'importedPayoutsCountFrom').mockResolvedValue(null);
    const res = await tds.getLiability('194R', FY.fyLabel, CLIENT);
    expect(res.rows[0]).toMatchObject({ deductedPaise: '300000', excessDeductedPaise: '300000' });
    expect(res.rows[0].note).toContain('TDS taken in excess');
    expect(res.totals).toMatchObject({ excessDeductedPaise: '300000' });
  });

  it('the summary carries the total excess (and the count of retailers with excess)', async () => {
    const d = base();
    d.entries = [paidVis('v1', 1500000n)];
    d.ledger = [{ clientId: CLIENT, panNumber: 'ABCDE1234F', outletCode: 'O1', section: 'SEC_194R', fyLabel: FY.fyLabel, tdsDeductedThisPaise: 300000n }];
    const { tds } = services(d, 'GROSS_UP');
    jest.spyOn(tds, 'importedPayoutsCountFrom').mockResolvedValue(null);
    const rep = await tds.report194R(CLIENT, FY.fyLabel);
    expect(rep.summary).toMatchObject({ totalExcessDeductedPaise: 300000n, excessRetailerCount: 1 });
  });
});

describe('A-M2: ONE PAN normaliser (JS == SQL) — every whitespace char removed, upper-cased', () => {
  it('normalisePan / payeeKeyFor', () => {
    expect(normalisePan('ABCDE1234F\r')).toBe('ABCDE1234F');
    expect(normalisePan(' abcde 1234f\u00a0\t\n')).toBe('ABCDE1234F');
    expect(payeeKeyFor('c1', 'O1', { id: 'p1', panNumber: 'abcde1234f\r' })).toBe('ABCDE1234F');
    expect(payeeKeyFor('c1', 'O1', { id: 'p1', panNumber: '  ' })).toBe('__NO_PAN__:p1');
    expect(payeeKeyFor('c1', 'O1', { id: 'p1', panNumber: '__NO_PAN__' })).toBe('__NO_PAN__:p1');
    expect(payeeKeyFor('c1', 'O1', null)).toBe('__NO_PAN__:outlet:c1:O1');
  });

  it('a partner PAN stored as "ABCDE1234F\\r" and a snapshot "ABCDE1234F" are the SAME retailer row', async () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F\r')];
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [paidVis('v1', 1500000n), { ...paidVis('v2', 1500000n), id: 'v2', payeePan: 'ABCDE1234F' }];
    const rows = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows.map((r) => r.panNumber)).toEqual(['ABCDE1234F']);
    expect(rows[0].baseFyTotalPaise).toBe(3000000n);
  });
});

describe('A-H1: a no-PAN DEPOSIT / OFF-PLATFORM row keeps the retailer key AS OF its upload (the PAN split)', () => {
  const data = () => {
    const d = empty();
    d.partners = [pan('p1', 'ABCDE1234F')]; // the PAN was added AFTER these uploads
    d.outlets = [{ outletCode: 'O1', clientId: CLIENT, partnerId: 'p1' }];
    d.entries = [{ ...paidVis('v1', 3000000n), payeePan: '__NO_PAN__:p1' }];
    return d;
  };

  it('the auditor\'s ₹6,000 no-PAN deposit stays on the no-PAN row (not moved to the PAN)', async () => {
    const d = data();
    d.deposits = [{ clientId: CLIENT, panNumber: '__NO_PAN__', outletCode: 'O1', amountPaise: 600000n, forPeriod: `${FY.fyLabel.slice(0, 4)}-06`, depositDate: inFy(70), uploadBatchId: 'DEP-' + 'd'.repeat(64), resolvedKey: '__NO_PAN__:p1' }];
    const rows = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    const by = Object.fromEntries(rows.map((r) => [r.panNumber, r]));
    expect(by['__NO_PAN__:p1'].depositedPaise).toBe(600000n);
    expect(by['ABCDE1234F']).toBeUndefined();
  });

  it('the auditor\'s ₹10,000 no-PAN off-platform gift stays on the no-PAN row', async () => {
    const d = data();
    d.offPlatform = [{ clientId: CLIENT, panNumber: '__NO_PAN__', outletCode: 'O1', amountPaise: 1000000n, entryDate: inFy(20), resolvedKey: '__NO_PAN__:p1' }];
    const rows = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    const by = Object.fromEntries(rows.map((r) => [r.panNumber, r]));
    expect(by['__NO_PAN__:p1']).toMatchObject({ baseFyTotalPaise: 4000000n, nonCashBasePaise: 1000000n });
    expect(by['ABCDE1234F']).toBeUndefined();
  });

  it('a row without the snapshot (legacy) still resolves through its outlet to the CURRENT owner', async () => {
    const d = data();
    d.offPlatform = [{ clientId: CLIENT, panNumber: '__NO_PAN__', outletCode: 'O1', amountPaise: 1000000n, entryDate: inFy(20) }];
    const rows = await services(d, 'GROSS_UP').tds.compute194R(CLIENT, FY.fyLabel, null);
    expect(rows.find((r) => r.panNumber === 'ABCDE1234F')!.nonCashBasePaise).toBe(1000000n);
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
