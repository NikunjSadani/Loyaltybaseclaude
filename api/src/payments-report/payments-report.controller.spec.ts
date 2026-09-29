/**
 * Unit tests for PaymentsReportController — scoping + RBAC.
 * Covers: CLIENT_ADMIN is pinned to their own clientId (any ?clientId= ignored → cannot read
 * cross-tenant); an ASSUMED GIFSY operator is pinned to the assumed tenant; an un-assumed
 * GIFSY_ADMIN passes ?clientId= through (or is platform-wide when omitted); and both handlers carry
 * the GIFSY_ADMIN + CLIENT_ADMIN @Roles + reports:read @RequirePermission gate.
 * Run: npx jest src/payments-report/payments-report.controller.spec.ts
 */
import { PaymentsReportController } from './payments-report.controller';
import { PaymentsReportService } from './payments-report.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const svc = {
  paymentReport: jest.fn().mockResolvedValue({ rows: [] }),
  paymentReportXlsx: jest.fn().mockResolvedValue({ buffer: Buffer.from(''), filename: 'x.xlsx' }),
};

const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'Op' };
const CLIENT: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '8', name: 'CA' };
const ASSUMED: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9', name: 'Op', assumed: true };

function fakeRes() {
  return { setHeader: jest.fn() } as never;
}

describe('PaymentsReportController', () => {
  let controller: PaymentsReportController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PaymentsReportController(svc as unknown as PaymentsReportService);
  });

  describe('scoping', () => {
    it('CLIENT_ADMIN clientId is always their own, even if ?clientId= names another tenant', async () => {
      await controller.paymentsReport(CLIENT, { clientId: 'other-tenant', from: '2026-06-01', to: '2026-06-30', status: 'PAID' as never });
      expect(svc.paymentReport).toHaveBeenCalledWith({ clientId: 'deoleo', from: '2026-06-01', to: '2026-06-30', status: 'PAID' });
    });

    it('an ASSUMED GIFSY operator is pinned to the assumed tenant (?clientId= ignored)', async () => {
      await controller.paymentsReport(ASSUMED, { clientId: 'other-tenant' });
      expect(svc.paymentReport).toHaveBeenCalledWith({ clientId: 'deoleo', from: undefined, to: undefined, status: undefined });
    });

    it('un-assumed GIFSY_ADMIN may scope to any tenant via ?clientId=', async () => {
      await controller.paymentsReport(GIFSY, { clientId: 'deoleo' });
      expect(svc.paymentReport).toHaveBeenCalledWith({ clientId: 'deoleo', from: undefined, to: undefined, status: undefined });
    });

    it('un-assumed GIFSY_ADMIN with no ?clientId= is platform-wide (undefined scope)', async () => {
      await controller.paymentsReport(GIFSY, {});
      expect(svc.paymentReport).toHaveBeenCalledWith({ clientId: undefined, from: undefined, to: undefined, status: undefined });
    });

    it('export resolves scope identically and sets the attachment header', async () => {
      await controller.paymentsReportExport(CLIENT, { clientId: 'other-tenant' }, fakeRes());
      expect(svc.paymentReportXlsx).toHaveBeenCalledWith({ clientId: 'deoleo', from: undefined, to: undefined, status: undefined });
    });
  });

  describe('RBAC metadata', () => {
    it('both handlers are open to GIFSY_ADMIN + CLIENT_ADMIN and require reports:read', () => {
      for (const handler of [
        PaymentsReportController.prototype.paymentsReport,
        PaymentsReportController.prototype.paymentsReportExport,
      ]) {
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN']);
        expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe('reports:read');
      }
    });
  });
});
