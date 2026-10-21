// Unit tests for PointsEngineSettingsController — focus on the SET guard that lets an operator write the
// per-tenant Points Engine flags EITHER un-assumed (any tenant via dto.clientId) OR while assumed INTO the
// target tenant (dto.clientId === the assumed tenant), while still blocking a cross-tenant write from inside
// a different brand. Run: npx jest --no-coverage src/points-engine/points-engine-settings.controller.spec.ts

import { ForbiddenException } from '@nestjs/common';
import { PointsEngineSettingsController } from './points-engine-settings.controller';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockAdminCore = { upsertSetting: jest.fn() };
const mockTenantSettings = { getEffectiveSettings: jest.fn() };

/** An un-assumed GIFSY owner (platform-wide). */
const unassumedOwner: JwtPayload = { sub: 'u_owner', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '1', name: 'Owner' };
/** A GIFSY owner ASSUMED into Bajaj ("working in the brand"): clientId pinned, assumed flag set. */
const assumedIntoBajaj: JwtPayload = { sub: 'u_owner', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '1', name: 'Owner', assumed: true } as JwtPayload;

describe('PointsEngineSettingsController.set (per-tenant flag write guard)', () => {
  let controller: PointsEngineSettingsController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminCore.upsertSetting.mockResolvedValue({});
    controller = new PointsEngineSettingsController(
      mockAdminCore as unknown as AdminCoreService,
      mockTenantSettings as unknown as TenantSettingsService,
    );
  });

  it('UN-ASSUMED owner may target any tenant via dto.clientId', async () => {
    const res = await controller.set(unassumedOwner, { clientId: 'bajaj', enabled: true, directCreditEnabled: false });
    expect(res).toEqual({ clientId: 'bajaj', enabled: true, directCreditEnabled: false });
    expect(mockAdminCore.upsertSetting).toHaveBeenCalledTimes(1);
    const [callUser, dto, opts] = mockAdminCore.upsertSetting.mock.calls[0];
    expect(callUser.clientId).toBe('bajaj'); // write targets the TARGET tenant
    expect(dto).toMatchObject({ key: 'pointsEngine', value: { enabled: true, directCreditEnabled: false } });
    expect(opts).toEqual({ allowPlatformOnlyKey: true });
  });

  it('ASSUMED owner may enable the brand they are working in (dto.clientId === assumed tenant)', async () => {
    const res = await controller.set(assumedIntoBajaj, { clientId: 'bajaj', enabled: true, directCreditEnabled: false });
    expect(res).toMatchObject({ clientId: 'bajaj', enabled: true });
    expect(mockAdminCore.upsertSetting).toHaveBeenCalledTimes(1);
    expect(mockAdminCore.upsertSetting.mock.calls[0][0].clientId).toBe('bajaj');
  });

  it('ASSUMED owner may NOT edit a DIFFERENT tenant from inside a brand (cross-tenant block)', async () => {
    await expect(
      controller.set(assumedIntoBajaj, { clientId: 'deoleo', enabled: true, directCreditEnabled: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
  });
});
