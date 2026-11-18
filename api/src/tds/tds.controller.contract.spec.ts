/**
 * Response-shape CONTRACT for GET /v1/admin/tds/194r and /194c.
 *
 * The admin TDS screen once read summary.baseFyTotalPaise / liabilityPaise while the API sends
 * totalBasePaise / totalLiabilityPaise — the summary cards were blank on prod and the screen tests
 * (hand-written mocks) still passed. The single source of the shape is now the JSON fixture the
 * screen tests build their mocks from; this spec asserts the controller emits EXACTLY those keys, so
 * a rename on either side fails a test.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { TdsController } from './tds.controller';
import type { TdsService } from './tds.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const contract = JSON.parse(
  readFileSync(join(__dirname, '../../../platform/src/app/admin/tds/__tests__/fixtures/tds-report-contract.json'), 'utf-8'),
) as { r194: Record<string, unknown> & { summary: object; rows: object[] }; r194c: Record<string, unknown> & { summary: object; rows: object[] } };

const keys = (o: object) => Object.keys(o).filter((k) => k !== '_comment').sort();

const row194R = {
  panNumber: 'ABCDE1234F', fyLabel: '2025-26', baseFyTotalPaise: 500000n, liabilityPaise: 50000n, depositedPaise: 30000n,
  outstandingPaise: 20000n, methodology: 'GROSS_UP', ratePct: 10, cashBasePaise: 500000n, nonCashBasePaise: 0n,
  deductBasePaise: 0n, clientBorneBasePaise: 500000n, deductLiabilityPaise: 0n, clientBorneLiabilityPaise: 50000n,
  deductedPaise: 0n, importedVendorDepositPaise: 0n, excessDeductedPaise: 0n, carryForwardDroppedPaise: 0n,
};
const row194C = {
  panNumber: 'GIFSY1234A', entityType: 'COMPANY', fyLabel: '2025-26', baseFyTotalPaise: 200000n, maxSinglePaise: 200000n,
  thresholdMet: true, liabilityPaise: 8000n, liabilityNoThresholdPaise: 12000n, depositedPaise: 7000n, outstandingPaise: 1000n,
  methodology: 'GROSS_UP', withheldPaise: 0n, recoveredPaise: 0n, recoveryByTenant: [],
};
const svc = {
  report194R: jest.fn().mockResolvedValue({
    rows: [row194R],
    summary: {
      fyLabel: '2025-26', clientId: 'deoleo', totalBasePaise: 5500000n, totalLiabilityPaise: 611100n, totalDepositedPaise: 600000n,
      totalOutstandingPaise: 11100n, rowCount: 2, totalExcessDeductedPaise: 0n, excessRetailerCount: 0,
    },
    importedPayoutsCountedFrom: null,
    importedPayoutsNote: null,
  }),
  compute194C: jest.fn().mockResolvedValue([row194C]),
  summary194C: jest.fn().mockResolvedValue({
    fyLabel: '2025-26', totalBasePaise: 200000n, totalLiabilityPaise: 8000n, totalLiabilityNoThresholdPaise: 12000n,
    totalDepositedPaise: 7000n, totalWithheldPaise: 0n, totalRecoveredPaise: 0n, totalOutstandingPaise: 1000n, rowCount: 1,
  }),
};
const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9', name: 'Op' };

describe('TDS report response contract (shared with the admin TDS screen tests)', () => {
  const controller = new TdsController(svc as unknown as TdsService);

  it('194R: top-level, summary and row keys are exactly the contract fixture’s', async () => {
    const res = await controller.get194R(GIFSY, '2025-26');
    expect(keys(res)).toEqual(keys(contract.r194));
    expect(keys(res.summary)).toEqual(keys(contract.r194.summary));
    expect(keys(res.rows[0])).toEqual(keys(contract.r194.rows[0]));
    // Money crosses the wire as strings (BigInt.toString()), as in the fixture.
    expect(res.summary.totalLiabilityPaise).toBe('611100');
  });

  it('194C: summary keys are exactly the contract fixture’s (row keys are a superset — the screen reads a subset)', async () => {
    const res = await controller.get194C({ ...GIFSY, clientId: 'gifsy' }, '2025-26');
    expect(keys(res)).toEqual(keys(contract.r194c));
    expect(keys(res.summary)).toEqual(keys(contract.r194c.summary));
    for (const k of keys(contract.r194c.rows[0])) expect(res.rows[0]).toHaveProperty(k);
  });
});
