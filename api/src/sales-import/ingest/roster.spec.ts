import { loadRoster, normalizedRosterIndex, rosterOutletWhere } from './roster';
import { rosterIndexOf } from '../kpi/sales-import-data';

/** M6: the worker (loadRoster) and preview/apply (rosterIndexOf) map a file code to an outlet with the SAME index. */
describe('roster index (single source)', () => {
  it('maps normalized file codes to stored codes; first stored code wins on a collision', () => {
    const idx = normalizedRosterIndex(['00123', ' 77 ', '77', 'A-1']);
    expect(idx.get('00123')).toBe('00123'); // leading zeros are data (R-6)
    expect(idx.get('77')).toBe(' 77 '); // ' 77 ' sorts before '77'
    expect(idx.get('A-1')).toBe('A-1');
    expect(idx.has('123')).toBe(false);
  });

  it('worker and preview/apply build identical indexes from the same roster', async () => {
    const codes = ['9', '10', ' 10', '0010'];
    const prisma = { outlet: { findMany: jest.fn(async () => codes.map((outletCode) => ({ outletCode }))) } };
    const worker = await loadRoster(prisma as never, 't1');
    expect(prisma.outlet.findMany).toHaveBeenCalledWith({ where: rosterOutletWhere('t1'), select: { outletCode: true } });
    const meta = new Map(codes.map((c) => [c, { name: c, outletType: null, program: null }]));
    expect([...rosterIndexOf(meta).entries()]).toEqual([...worker.byNormalizedCode.entries()]);
  });
});
