/**
 * Unit tests for TdsConfigController — Gifsy per-tenant TDS-policy config (Stream C).
 * Covers: GET scoping (CLIENT_ADMIN pinned to own tenant; GIFSY any via ?clientId=), SET
 * delegating to the EXISTING write path (AdminCoreService.upsertSetting with settingKey=tdsPolicy,
 * under the target tenant's scope), RBAC (SET is GIFSY-only), and DTO enum validate/reject.
 * Run: npx jest src/tds-invoicing/tds-config.controller.spec.ts
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TdsConfigController } from './tds-config.controller';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { SetTdsConfigDto } from './dto/tds-config.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const adminCore = { upsertSetting: jest.fn().mockResolvedValue({}) };
const tenantSettings = { resolveTdsPolicy: jest.fn() };

const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'Op' };
const CLIENT: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '8', name: 'CA' };
// An ASSUMED GIFSY operator is pinned to the assumed tenant — ?clientId= is ignored.
const ASSUMED: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9', name: 'Op', assumed: true };

describe('TdsConfigController', () => {
  let controller: TdsConfigController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TdsConfigController(
      adminCore as unknown as AdminCoreService,
      tenantSettings as unknown as TenantSettingsService,
    );
    tenantSettings.resolveTdsPolicy.mockResolvedValue({ section: 'SEC_194C', methodology: 'GROSS_UP' });
  });

  describe('GET', () => {
    it('CLIENT_ADMIN reads only their own tenant (ignores ?clientId=)', async () => {
      const res = await controller.get(CLIENT, { clientId: 'other-tenant' });
      expect(tenantSettings.resolveTdsPolicy).toHaveBeenCalledWith('deoleo');
      expect(res).toEqual({ clientId: 'deoleo', section: 'SEC_194C', methodology: 'GROSS_UP' });
    });

    it('GIFSY_ADMIN may read any tenant via ?clientId=', async () => {
      await controller.get(GIFSY, { clientId: 'deoleo' });
      expect(tenantSettings.resolveTdsPolicy).toHaveBeenCalledWith('deoleo');
    });

    it('an ASSUMED GIFSY operator is pinned to the assumed tenant (ignores ?clientId=)', async () => {
      const res = await controller.get(ASSUMED, { clientId: 'other-tenant' });
      expect(tenantSettings.resolveTdsPolicy).toHaveBeenCalledWith('deoleo');
      expect(res).toEqual({ clientId: 'deoleo', section: 'SEC_194C', methodology: 'GROSS_UP' });
    });
  });

  describe('SET', () => {
    it('writes tdsPolicy via upsertSetting under the TARGET tenant scope, operator preserved', async () => {
      const dto: SetTdsConfigDto = {
        clientId: 'deoleo',
        section: 'SEC_194C' as SetTdsConfigDto['section'],
        methodology: 'DEDUCT' as SetTdsConfigDto['methodology'],
      };
      const res = await controller.set(GIFSY, dto);

      expect(adminCore.upsertSetting).toHaveBeenCalledTimes(1);
      const [payload, settingDto] = adminCore.upsertSetting.mock.calls[0];
      // Target-tenant scope, real operator identity preserved for the audit.
      expect(payload.clientId).toBe('deoleo');
      expect(payload.sub).toBe('op');
      expect(settingDto.key).toBe('tdsPolicy');
      expect(settingDto.value).toEqual({ section: 'SEC_194C', methodology: 'DEDUCT' });
      expect(res).toEqual({ clientId: 'deoleo', section: 'SEC_194C', methodology: 'DEDUCT' });
    });

    it('SET is GIFSY_ADMIN-only; RolesGuard denies a CLIENT_ADMIN', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, TdsConfigController.prototype.set);
      expect(roles).toEqual(['GIFSY_ADMIN']);

      const guard = new RolesGuard(new Reflector());
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: CLIENT }) }),
        getHandler: () => TdsConfigController.prototype.set,
        getClass: () => TdsConfigController,
      } as never;
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });

  describe('DTO validation', () => {
    it('accepts valid Prisma enum values', async () => {
      const dto = plainToInstance(SetTdsConfigDto, {
        clientId: 'deoleo',
        section: 'SEC_194R',
        methodology: 'GROSS_UP',
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects an invalid section / methodology / empty clientId', async () => {
      const dto = plainToInstance(SetTdsConfigDto, {
        clientId: '',
        section: 'SEC_999',
        methodology: 'MAYBE',
      });
      const errors = await validate(dto);
      const props = errors.map((e) => e.property).sort();
      expect(props).toEqual(['clientId', 'methodology', 'section']);
    });
  });
});
