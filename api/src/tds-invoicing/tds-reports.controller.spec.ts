/**
 * Unit tests for TdsReportsController — scoping + RBAC (§5/§6).
 * Covers: CLIENT_ADMIN is pinned to their own clientId (any ?clientId= ignored → cannot read
 * cross-tenant); GIFSY_ADMIN passes ?clientId= through; and the unregistered/RCM report is
 * GIFSY_ADMIN-only (a CLIENT_ADMIN is denied by RolesGuard against the method @Roles metadata).
 * Run: npx jest src/tds-invoicing/tds-reports.controller.spec.ts
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TdsReportsController } from './tds-reports.controller';
import { TdsReportsService } from './tds-reports.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const svc = {
  payoutReport: jest.fn().mockResolvedValue({ rows: [] }),
  unregisteredReport: jest.fn().mockResolvedValue({ rows: [] }),
  recoveryReport: jest.fn().mockResolvedValue({ rows: [] }),
};

const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'Op' };
const CLIENT: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '8', name: 'CA' };

function ctxForHandler(user: JwtPayload, handler: unknown, cls: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as never;
}

describe('TdsReportsController', () => {
  let controller: TdsReportsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TdsReportsController(svc as unknown as TdsReportsService);
  });

  describe('scoping — CLIENT_ADMIN pinned to own tenant', () => {
    it('payouts: CLIENT_ADMIN clientId always their own, even if ?clientId= names another tenant', async () => {
      await controller.payouts(CLIENT, { clientId: 'other-tenant', period: '2026-06' });
      expect(svc.payoutReport).toHaveBeenCalledWith({ clientId: 'deoleo', period: '2026-06' });
    });

    it('recovery: CLIENT_ADMIN sees only their own recovery liability', async () => {
      await controller.recovery(CLIENT, { clientId: 'other-tenant', fy: '2026-27' });
      expect(svc.recoveryReport).toHaveBeenCalledWith({ clientId: 'deoleo', fy: '2026-27' });
    });

    it('payouts: GIFSY_ADMIN may scope to any tenant via ?clientId=', async () => {
      await controller.payouts(GIFSY, { clientId: 'deoleo' });
      expect(svc.payoutReport).toHaveBeenCalledWith({ clientId: 'deoleo', period: undefined });
    });

    it('payouts: GIFSY_ADMIN with no ?clientId= is platform-wide (undefined scope)', async () => {
      await controller.payouts(GIFSY, {});
      expect(svc.payoutReport).toHaveBeenCalledWith({ clientId: undefined, period: undefined });
    });
  });

  describe('RBAC — unregistered/RCM report is GIFSY-only', () => {
    it('the unregistered handler carries GIFSY_ADMIN-only @Roles metadata', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, TdsReportsController.prototype.unregistered);
      expect(roles).toEqual(['GIFSY_ADMIN']);
    });

    it('RolesGuard denies a CLIENT_ADMIN on the unregistered handler', () => {
      const guard = new RolesGuard(new Reflector());
      const ctx = ctxForHandler(
        CLIENT,
        TdsReportsController.prototype.unregistered,
        TdsReportsController,
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('the payouts handler is open to CLIENT_ADMIN + GIFSY_ADMIN', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, TdsReportsController.prototype.payouts);
      expect(roles).toEqual(['CLIENT_ADMIN', 'GIFSY_ADMIN']);
    });
  });
});
