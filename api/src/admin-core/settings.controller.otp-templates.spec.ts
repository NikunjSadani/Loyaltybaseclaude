// M1 (B11): the OTP-templates routes are GIFSY_ADMIN-ONLY. They must carry @Roles('GIFSY_ADMIN') and NO
// @RequirePermission — RolesGuard only admits GIFSY_STAFF past an owner-only @Roles when the route has a
// fine permission gate to defer to (roles.guard.spec E3), so no permission = staff can never reach them.
// Run: npx jest src/admin-core/settings.controller.otp-templates.spec.ts

import { Reflector } from '@nestjs/core';
import { AdminSettingsController } from './settings.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';

describe('AdminSettingsController — otp-templates routes', () => {
  const reflector = new Reflector();
  const proto = AdminSettingsController.prototype;

  it.each(['getOtpTemplates', 'saveOtpTemplates'] as const)('%s is GIFSY_ADMIN-only with no permission gate', (m) => {
    const handler = proto[m];
    expect(reflector.get(ROLES_KEY, handler)).toEqual(['GIFSY_ADMIN']);
    expect(reflector.get(PERMISSION_KEY, handler)).toBeUndefined();
  });

  it('delegates to the service with the caller + DTO', async () => {
    const svc = { getOtpTemplates: jest.fn().mockResolvedValue('g'), saveOtpTemplates: jest.fn().mockResolvedValue('s') };
    const ctl = new AdminSettingsController(svc as never);
    const user = { sub: 'a', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true } as never;
    expect(await ctl.getOtpTemplates(user)).toBe('g');
    const dto = { clientId: 'bajaj', changes: { login: '' } };
    expect(await ctl.saveOtpTemplates(user, dto)).toBe('s');
    expect(svc.saveOtpTemplates).toHaveBeenCalledWith(user, dto);
  });
});
