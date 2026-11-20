// Authz-gate tests for ReportsController. The role gate lives on the controller
// (@Roles metadata consumed by the global RolesGuard), so it is invisible to a
// service unit test — we assert the SetMetadata payload directly.
// Run: npx jest src/reports/reports.controller.spec.ts

import { ReportsController } from './reports.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { ReportFormat } from './dto/reports.dto';

const rolesOf = (handler: (...args: never[]) => unknown): string[] =>
  (Reflect.getMetadata(ROLES_KEY, handler) as string[]) ?? [];

describe('ReportsController @Roles gates', () => {
  it('kyc-status is callable by CLIENT_ADMIN (bug fix) alongside the operator roles', () => {
    const roles = rolesOf(ReportsController.prototype.kycStatus);
    expect(roles).toEqual(expect.arrayContaining(['GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN']));
  });

  it('session-report remains callable by CLIENT_ADMIN', () => {
    const roles = rolesOf(ReportsController.prototype.sessionReport);
    expect(roles).toContain('CLIENT_ADMIN');
  });

  it.each([
    ['tds', ReportsController.prototype.tds],
    ['payoutLiability', ReportsController.prototype.payoutLiability],
    ['visibilityStatus', ReportsController.prototype.visibilityStatus],
    ['schemePerformance', ReportsController.prototype.schemePerformance],
  ])('%s stays operator-scoped (no CLIENT_ADMIN)', (_name, handler) => {
    const roles = rolesOf(handler as (...args: never[]) => unknown);
    expect(roles).toEqual(['GIFSY_ADMIN', 'MIS_USER']);
  });
});

describe('ReportsController — usage report', () => {
  it('has EXACTLY the Session Report access (roles + reports:read)', () => {
    expect(rolesOf(ReportsController.prototype.usage)).toEqual(rolesOf(ReportsController.prototype.sessionReport));
    expect(Reflect.getMetadata(PERMISSION_KEY, ReportsController.prototype.usage)).toBe('reports:read');
    expect(Reflect.getMetadata(PERMISSION_KEY, ReportsController.prototype.sessionReport)).toBe('reports:read');
  });

  it('JSON → ReportsService.usageReport; xlsx → the usage-report export kind (filters passed through)', async () => {
    const reports = { usageReport: jest.fn().mockResolvedValue({ kind: 'json', data: { rows: [] } }) };
    const exportsSvc = { respond: jest.fn().mockResolvedValue('FILE') };
    const ctl = new ReportsController(reports as any, exportsSvc as any);
    const user = { sub: 'u', role: 'CLIENT_ADMIN', clientId: 'bajaj' } as any;
    const res = {} as any;

    await expect(ctl.usage(user, { from: '2026-11-01' } as any, res)).resolves.toEqual({ rows: [] });
    expect(reports.usageReport).toHaveBeenCalledWith(user, { from: '2026-11-01' });

    const q = { format: ReportFormat.XLSX, role: 'SSS' } as any;
    await expect(ctl.usage(user, q, res)).resolves.toBe('FILE');
    expect(exportsSvc.respond).toHaveBeenCalledWith(res, user, 'usage-report', q);
  });
});

describe('ReportsController — location report (LOCATION-GATE.md)', () => {
  it('the report AND its /enabled probe have EXACTLY the Usage report access (incl. MIS_USER)', () => {
    const usage = rolesOf(ReportsController.prototype.usage);
    expect(rolesOf(ReportsController.prototype.locationCompliance)).toEqual(usage);
    expect(rolesOf(ReportsController.prototype.locationComplianceEnabled)).toEqual(usage);
    expect(usage).toContain('MIS_USER');
    expect(Reflect.getMetadata(PERMISSION_KEY, ReportsController.prototype.locationComplianceEnabled)).toBe('reports:read');
  });
});

describe('ReportsController — redemption report', () => {
  it('summary + export: GIFSY_ADMIN + CLIENT_ADMIN with reports:read, no MIS_USER (payments-report precedent)', () => {
    for (const h of [ReportsController.prototype.redemptions, ReportsController.prototype.redemptionsExport]) {
      expect(rolesOf(h as (...args: never[]) => unknown)).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, h)).toBe('reports:read');
    }
  });

  it('export → the redemption-report kind with the default IST-month range filled in (stored explicitly)', async () => {
    const exportsSvc = { respond: jest.fn().mockResolvedValue('FILE') };
    const ctl = new ReportsController({} as any, exportsSvc as any);
    const user = { sub: 'u', role: 'CLIENT_ADMIN', clientId: 'bajaj' } as any;
    const res = {} as any;
    await expect(ctl.redemptionsExport(user, { status: 'DELIVERED' } as any, res)).resolves.toBe('FILE');
    const sent = exportsSvc.respond.mock.calls[0][3];
    expect(exportsSvc.respond.mock.calls[0][2]).toBe('redemption-report');
    expect(sent).toMatchObject({ status: 'DELIVERED', from: expect.stringMatching(/^\d{4}-\d{2}-01$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('an un-assumed Gifsy owner without ?clientId= gets a 400 (one client at a time)', async () => {
    const ctl = new ReportsController({} as any, { respond: jest.fn() } as any);
    const owner = { sub: 'o', role: 'GIFSY_ADMIN', clientId: 'gifsy' } as any;
    await expect(ctl.redemptionsExport(owner, {} as any, {} as any)).rejects.toThrow(/Choose a client/);
  });
});
