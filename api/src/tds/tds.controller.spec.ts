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
});
