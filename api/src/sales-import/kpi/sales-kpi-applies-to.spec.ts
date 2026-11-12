/**
 * APPLIES-TO §5 (platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md) — Sales Import:
 *   • definitionsHash is UNCHANGED for existing data (literal hashes pinned from the pre-change code at 7b3bb712);
 *   • the KPI's own scope (outletTypes / programs / subPrograms) INTERSECTS the definition scope; disjoint → nothing;
 *   • sub-program facet (Outlet.programCategory) flows through loadRosterMeta → outletInScope → computeMonthRows.
 */
import {
  OutletKpiAccumulator,
  computeOutletKpis,
  definitionsHash,
  effectiveDefScope,
  outletInScope,
  type KpiAgg,
  type KpiDefLite,
} from './sales-kpi.helper';
import { kpiScopesOf, toLite } from './sales-kpi-def.service';
import { loadRosterMeta } from './sales-import-data';
import { computeMonthRows } from '../apply/month-compute';

const agg = (dims: Record<string, string>, amountPaise: bigint): KpiAgg => ({ dims, amountPaise, qtyPico: 0n, lines: 1 });

// Fixture identical to the capture run against the PRE-change definitionsHash.
const BASE: KpiDefLite = { kpiCode: 'VOL', measure: 'QUANTITY', filter: { anyOf: [{ brand: 'X' }] }, outletTypes: [], programs: [] };
const AMT: KpiDefLite = { kpiCode: 'AMT', measure: 'AMOUNT', filter: {}, outletTypes: ['WHOLESALER', 'RETAILER'], programs: ['Gold'] };
const H_UNSCOPED = '8488b7a5eaa1e6edefb0976c209f6ab901f3d002115856a318274942826af20e';
const H_LEGACY_SSS = '676ee18af1c6a034efa99030f1123c1997e7ae3478dc2f9b0725bab248879fe4';

describe('definitionsHash stability (pinned literal hashes)', () => {
  it('unscoped KPIs hash exactly as before (legacy field absent, null, or empty kpiScope)', () => {
    expect(definitionsHash([BASE, AMT])).toBe(H_UNSCOPED);
    expect(definitionsHash([{ ...BASE, kpiOutletType: null, kpiScope: { outletTypes: [], programs: [], subPrograms: [] } }, AMT])).toBe(H_UNSCOPED);
  });

  it('a legacy single-type KPI hashes exactly as before — via kpiOutletType OR the backfilled kpiScope', () => {
    expect(definitionsHash([{ ...BASE, kpiOutletType: 'SSS' }, AMT])).toBe(H_LEGACY_SSS);
    expect(definitionsHash([{ ...BASE, kpiOutletType: ' sss ' }, { ...AMT, kpiOutletType: null }])).toBe(H_LEGACY_SSS);
    // post-migration row: outletType 'SSS' + outletTypes ['SSS']
    expect(definitionsHash([{ ...BASE, kpiOutletType: 'SSS', kpiScope: { outletTypes: ['SSS'], programs: [], subPrograms: [] } }, AMT])).toBe(H_LEGACY_SSS);
    // via the service mapper too
    const row = { kpiCode: 'VOL', measure: 'QUANTITY', filter: BASE.filter, outletTypes: [], programs: [] } as never;
    expect(definitionsHash([toLite(row, { outletType: 'SSS', outletTypes: ['SSS'], programs: [], subPrograms: [] }), AMT])).toBe(H_LEGACY_SSS);
    expect(definitionsHash([toLite(row, null), AMT])).toBe(H_UNSCOPED);
  });

  it('a new multi-facet scope changes the hash, ci / order-insensitively', () => {
    const scoped = (s: KpiDefLite['kpiScope']) => definitionsHash([{ ...BASE, kpiScope: s }, AMT]);
    const h = scoped({ outletTypes: ['SSS'], programs: ['Gold'], subPrograms: [] });
    expect(h).not.toBe(H_UNSCOPED);
    expect(h).not.toBe(H_LEGACY_SSS);
    expect(scoped({ outletTypes: ['sss'], programs: ['GOLD'], subPrograms: [] })).toBe(h);
    expect(scoped({ outletTypes: ['SSS', 'WHOLESALER'] })).toBe(scoped({ outletTypes: ['wholesaler', 'sss'] }));
    expect(scoped({ subPrograms: ['Tier A'] })).not.toBe(H_UNSCOPED);
  });
});

describe('KPI scope ∩ definition scope (intersectAppliesTo)', () => {
  const G = { outletType: 'RETAILER', program: 'gold', subProgram: 'Tier A' };
  it('KPI programs / subPrograms restrict the definition; blank outlet facet is out (D4)', () => {
    const d: KpiDefLite = { ...BASE, kpiScope: { programs: ['Gold'], subPrograms: ['tier a'] } };
    expect(outletInScope(d, G)).toBe(true);
    expect(outletInScope(d, { ...G, subProgram: 'Tier B' })).toBe(false);
    expect(outletInScope(d, { ...G, subProgram: null })).toBe(false);
    expect(outletInScope(d, { outletType: 'RETAILER', program: 'Gold' })).toBe(false); // subProgram absent = blank
  });

  it('definition outletTypes ∩ KPI outletTypes; disjoint → null scope → no outlet, values omitted', () => {
    const both: KpiDefLite = { ...AMT, kpiScope: { outletTypes: ['RETAILER', 'SSS'] } };
    expect(effectiveDefScope(both)).toEqual({ outletTypes: ['RETAILER'], programs: ['Gold'], subPrograms: [] });
    expect(outletInScope(both, G)).toBe(true);
    expect(outletInScope(both, { ...G, outletType: 'WHOLESALER' })).toBe(false);
    const disjoint: KpiDefLite = { ...AMT, kpiScope: { outletTypes: ['SSS'] } };
    expect(effectiveDefScope(disjoint)).toBeNull();
    expect(computeOutletKpis([agg({ brand: 'X' }, 500n)], [disjoint], G)).toEqual({});
    const programDisjoint: KpiDefLite = { ...AMT, kpiScope: { programs: ['Silver'] } };
    expect(outletInScope(programDisjoint, G)).toBe(false);
  });

  it('kpiScope arrays WIN over a stale legacy kpiOutletType', () => {
    const d: KpiDefLite = { ...BASE, kpiOutletType: 'SSS', kpiScope: { outletTypes: ['RETAILER', 'WHOLESALER'] } };
    expect(outletInScope(d, G)).toBe(true);
    expect(outletInScope(d, { ...G, outletType: 'SSS' })).toBe(false);
  });

  it('the accumulator applies the same scope', () => {
    const d: KpiDefLite = { kpiCode: 'K', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], kpiScope: { subPrograms: ['Tier A'] } };
    const acc = new OutletKpiAccumulator([d]);
    acc.add('O1', agg({}, 700n));
    expect(acc.valuesFor('O1', G)).toEqual({ K: 7 });
    expect(acc.valuesFor('O1', { ...G, subProgram: 'Tier B' })).toEqual({});
  });
});

describe('DB plumbing: kpiScopesOf / loadRosterMeta / computeMonthRows', () => {
  it('kpiScopesOf reads the full KPI scope, tenant-scoped', async () => {
    const db = { kpiDef: { findMany: jest.fn().mockResolvedValue([{ code: 'K', outletType: null, outletTypes: ['SSS', 'WS'], programs: [], subPrograms: ['A'] }]) } };
    const m = await kpiScopesOf(db as never, 't1', ['K']);
    expect(db.kpiDef.findMany).toHaveBeenCalledWith({
      where: { clientId: 't1', code: { in: ['K'] } },
      select: { code: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
    });
    expect(m.get('K')).toEqual({ outletType: null, outletTypes: ['SSS', 'WS'], programs: [], subPrograms: ['A'] });
    expect((await kpiScopesOf(db as never, 't1', [])).size).toBe(0);
  });

  it('loadRosterMeta carries Outlet.programCategory as subProgram; computeMonthRows scopes by it', async () => {
    const db = {
      outlet: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'i1', outletCode: 'O1', name: 'One', programName: 'Gold', programCategory: 'Tier A', outletType: { code: 'RETAILER' } },
          { id: 'i2', outletCode: 'O2', name: 'Two', programName: 'Gold', programCategory: null, outletType: { code: 'RETAILER' } },
        ]),
      },
    };
    const roster = await loadRosterMeta(db as never, 't1');
    expect(db.outlet.findMany.mock.calls[0][0].select).toEqual(expect.objectContaining({ programCategory: true }));
    expect(roster.get('O1')).toEqual({ id: 'i1', name: 'One', outletType: 'RETAILER', program: 'Gold', subProgram: 'Tier A' });
    const d: KpiDefLite = { kpiCode: 'K', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], kpiScope: { subPrograms: ['Tier A'] } };
    const rows = [{ id: 1n, month: '2025-05', outletCode: 'O1', dims: {}, dimKey: '{}', amountPaise: 1200n, qtyPico: 0n, lines: 1 },
      { id: 2n, month: '2025-05', outletCode: 'O2', dims: {}, dimKey: '{}', amountPaise: 900n, qtyPico: 0n, lines: 1 }];
    const comp = await computeMonthRows(async (onPage) => { await onPage(rows); }, [d], roster);
    expect(comp.rows.map((r) => [r.outletCode, r.values])).toEqual([['O1', { K: 12 }]]); // O2 (blank sub-program) untouched
  });
});
