/**
 * Unit tests for TdsController tenant scoping (194R reads).
 *
 * The cross-tenant rule: a 194R read is tenant data. CLIENT_ADMIN — and an ASSUMED
 * GIFSY operator (working inside a tenant) — are pinned to their own (assumed) clientId;
 * only an un-assumed GIFSY may cross-scope via ?clientId=. (194C stays platform-wide +
 * GIFSY-only by design and is not exercised here.)
 *
 * Run: npx jest src/tds/tds.controller.spec.ts
 */
import { ForbiddenException } from '@nestjs/common';
import { TdsController } from './tds.controller';
import { TdsService } from './tds.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const summary194R = {
  fyLabel: '2025-26',
  clientId: 'deoleo',
  totalBasePaise: 0n,
  totalLiabilityPaise: 0n,
  totalDepositedPaise: 0n,
  totalOutstandingPaise: 0n,
  rowCount: 0,
};

const svc = {
  compute194R: jest.fn().mockResolvedValue([]),
  summary194R: jest.fn().mockResolvedValue(summary194R),
  export194R: jest.fn().mockResolvedValue({ buffer: Buffer.from(''), filename: 'tds-194r.xlsx' }),
  compute194C: jest.fn().mockResolvedValue([]),
  summary194C: jest.fn().mockResolvedValue({ fyLabel: '2025-26', totalBasePaise: 0n, totalLiabilityPaise: 0n, totalLiabilityNoThresholdPaise: 0n, totalDepositedPaise: 0n, totalOutstandingPaise: 0n, totalWithheldPaise: 0n, totalRecoveredPaise: 0n, rowCount: 0 }),
  export194C: jest.fn().mockResolvedValue({ buffer: Buffer.from(''), filename: 'tds-194c.xlsx' }),
  getLiability: jest.fn().mockResolvedValue({ rows: [], totals: {} }),
};

const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'Op' };
const CLIENT: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '8', name: 'CA' };
const ASSUMED: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9', name: 'Op', assumed: true };

describe('TdsController — 194R tenant scoping', () => {
  let controller: TdsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TdsController(svc as unknown as TdsService);
  });

  describe('get194R', () => {
    it('CLIENT_ADMIN is pinned to their own tenant (ignores ?clientId=)', async () => {
      await controller.get194R(CLIENT, '2025-26', 'other-tenant');
      expect(svc.compute194R).toHaveBeenCalledWith('deoleo', '2025-26');
      expect(svc.summary194R).toHaveBeenCalledWith('deoleo', '2025-26');
    });

    it('an ASSUMED GIFSY operator is pinned to the assumed tenant (ignores ?clientId=)', async () => {
      await controller.get194R(ASSUMED, '2025-26', 'other-tenant');
      expect(svc.compute194R).toHaveBeenCalledWith('deoleo', '2025-26');
    });

    it('an un-assumed GIFSY may cross-scope via ?clientId=', async () => {
      await controller.get194R(GIFSY, '2025-26', 'deoleo');
      expect(svc.compute194R).toHaveBeenCalledWith('deoleo', '2025-26');
    });

    it('an un-assumed GIFSY with no ?clientId= falls back to its own JWT clientId', async () => {
      await controller.get194R(GIFSY, '2025-26', undefined);
      expect(svc.compute194R).toHaveBeenCalledWith('gifsy', '2025-26');
    });
  });

  describe('export194R', () => {
    it('an ASSUMED GIFSY operator export is pinned to the assumed tenant (ignores ?clientId=)', async () => {
      await controller.export194R(ASSUMED, '2025-26', 'other-tenant');
      expect(svc.export194R).toHaveBeenCalledWith('deoleo', '2025-26');
    });

    it('an un-assumed GIFSY export may cross-scope via ?clientId=', async () => {
      await controller.export194R(GIFSY, '2025-26', 'deoleo');
      expect(svc.export194R).toHaveBeenCalledWith('deoleo', '2025-26');
    });
  });

  // 194C is TGSL's platform-wide obligation — un-assumed GIFSY only (owner decision: hide when assumed).
  describe('194C is un-assumed-GIFSY-only', () => {
    it('get194C: un-assumed GIFSY OK, assumed operator → 403', async () => {
      await controller.get194C(GIFSY, '2025-26');
      expect(svc.compute194C).toHaveBeenCalledWith('2025-26');
      await expect(controller.get194C(ASSUMED, '2025-26')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('export194C: assumed operator → 403', async () => {
      await expect(controller.export194C(ASSUMED, '2025-26')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getLiability 194C: un-assumed GIFSY OK, assumed → 403; 194R stays clientId-scoped when assumed', async () => {
      await controller.getLiability(GIFSY, { section: '194C', fy: '2025-26' } as never);
      expect(svc.getLiability).toHaveBeenCalledWith('194C', '2025-26', 'gifsy');
      await expect(controller.getLiability(ASSUMED, { section: '194C', fy: '2025-26' } as never)).rejects.toBeInstanceOf(ForbiddenException);
      await controller.getLiability(ASSUMED, { section: '194R', fy: '2025-26' } as never);
      expect(svc.getLiability).toHaveBeenCalledWith('194R', '2025-26', 'deoleo'); // 194R scoped to assumed tenant
    });
  });
});
