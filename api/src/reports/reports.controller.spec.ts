// Authz-gate tests for ReportsController. The role gate lives on the controller
// (@Roles metadata consumed by the global RolesGuard), so it is invisible to a
// service unit test — we assert the SetMetadata payload directly.
// Run: npx jest src/reports/reports.controller.spec.ts

import { ReportsController } from './reports.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

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
