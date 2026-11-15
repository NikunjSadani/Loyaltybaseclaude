/**
 * Unit tests for TdsConfigController — Gifsy per-tenant TDS-policy config (Stream C).
 * Covers: GET scoping (CLIENT_ADMIN pinned to own tenant; GIFSY any via ?clientId=), SET
 * delegating to the EXISTING write path (AdminCoreService.upsertSetting with settingKey=tdsPolicy,
 * under the target tenant's scope), RBAC (SET is GIFSY-only), and DTO enum validate/reject.
 * Run: npx jest src/tds-invoicing/tds-config.controller.spec.ts
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TdsConfigController } from './tds-config.controller';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TdsService } from '../tds/tds.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { SetImportedPayoutsConfigDto, SetTdsConfigDto } from './dto/tds-config.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const adminCore = { upsertSetting: jest.fn().mockResolvedValue({}) };
const tenantSettings = { resolveTdsPolicy: jest.fn() };
const tds = { importedPayoutsSettingForEdit: jest.fn(), clientExists: jest.fn() };

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
      tds as unknown as TdsService,
    );
    tenantSettings.resolveTdsPolicy.mockResolvedValue({ section: 'SEC_194C', methodology: 'GROSS_UP' });
    tds.importedPayoutsSettingForEdit.mockResolvedValue({ countFrom: null, malformed: false });
    tds.clientExists.mockResolvedValue(true);
  });

  describe('imported-payouts — tenant existence + date bounds', () => {
    it('GET: unknown tenant → 404 (setting never read)', async () => {
      tds.clientExists.mockResolvedValue(false);
      await expect(controller.getImportedPayouts(GIFSY, { clientId: 'nope' })).rejects.toThrow(NotFoundException);
      expect(tds.importedPayoutsSettingForEdit).not.toHaveBeenCalled();
    });

    it('SET: unknown tenant → 404, nothing written', async () => {
      tds.clientExists.mockResolvedValue(false);
      await expect(
        controller.setImportedPayouts(GIFSY, { clientId: 'nope', countFrom: '2026-04-01' }),
      ).rejects.toThrow(NotFoundException);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('SET: a date before 2000-01-01 or after today + 1 year → 400, nothing written', async () => {
      const far = new Date();
      far.setUTCFullYear(far.getUTCFullYear() + 2);
      const farIso = far.toISOString().slice(0, 10);
      for (const bad of ['1999-12-31', farIso]) {
        await expect(
          controller.setImportedPayouts(GIFSY, { clientId: 'bajaj', countFrom: bad }),
        ).rejects.toThrow(BadRequestException);
      }
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('SET: 2000-01-01 and today are accepted', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await controller.setImportedPayouts(GIFSY, { clientId: 'bajaj', countFrom: '2000-01-01' });
      await controller.setImportedPayouts(GIFSY, { clientId: 'bajaj', countFrom: today });
      expect(adminCore.upsertSetting).toHaveBeenCalledTimes(2);
    });
  });

  describe('imported-payouts (count VENDOR_IMPORT payouts in the 194R report)', () => {
    it('GET: tenant admin pinned to own tenant; returns countFrom (null = OFF)', async () => {
      const res = await controller.getImportedPayouts(CLIENT, { clientId: 'other-tenant' });
      expect(tds.importedPayoutsSettingForEdit).toHaveBeenCalledWith('deoleo');
      expect(res).toEqual({ clientId: 'deoleo', countFrom: null, malformed: false });
    });

    it('GET: a malformed stored value comes back FLAGGED (not thrown) so the card can repair it', async () => {
      tds.importedPayoutsSettingForEdit.mockResolvedValue({ countFrom: null, malformed: true, raw: { countFrom: 'soon' } });
      const res = await controller.getImportedPayouts(GIFSY, { clientId: 'bajaj' });
      expect(res).toEqual({ clientId: 'bajaj', countFrom: null, malformed: true, raw: { countFrom: 'soon' } });
    });

    it('GET: an un-assumed GIFSY may read another tenant', async () => {
      tds.importedPayoutsSettingForEdit.mockResolvedValue({ countFrom: '2026-04-01', malformed: false });
      const res = await controller.getImportedPayouts(GIFSY, { clientId: 'bajaj' });
      expect(res).toEqual({ clientId: 'bajaj', countFrom: '2026-04-01', malformed: false });
    });

    it('SET: writes { countFrom } via upsertSetting(allowPlatformOnlyKey) under the target tenant', async () => {
      const res = await controller.setImportedPayouts(GIFSY, { clientId: 'bajaj', countFrom: '2026-04-01' });
      expect(adminCore.upsertSetting).toHaveBeenCalledTimes(1);
      const [payload, settingDto, opts] = adminCore.upsertSetting.mock.calls[0];
      expect(payload.clientId).toBe('bajaj');
      expect(payload.sub).toBe('op');
      expect(settingDto.key).toBe('tdsImportedPayouts');
      expect(settingDto.value).toEqual({ countFrom: '2026-04-01' });
      expect(opts).toEqual({ allowPlatformOnlyKey: true });
      expect(res).toEqual({ clientId: 'bajaj', countFrom: '2026-04-01' });
    });

    it('SET: null turns it OFF (stored as { countFrom: null })', async () => {
      await controller.setImportedPayouts(GIFSY, { clientId: 'bajaj', countFrom: null });
      expect(adminCore.upsertSetting.mock.calls[0][1].value).toEqual({ countFrom: null });
    });

    it('SET: an impossible calendar date → 400, nothing written', async () => {
      await expect(
        controller.setImportedPayouts(GIFSY, { clientId: 'bajaj', countFrom: '2026-02-30' }),
      ).rejects.toThrow(BadRequestException);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('SET: an ASSUMED operator cannot write a different tenant (403)', async () => {
      await expect(
        controller.setImportedPayouts(ASSUMED, { clientId: 'bajaj', countFrom: '2026-04-01' }),
      ).rejects.toThrow(ForbiddenException);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
      await controller.setImportedPayouts(ASSUMED, { clientId: 'deoleo', countFrom: '2026-04-01' });
      expect(adminCore.upsertSetting).toHaveBeenCalledTimes(1);
    });

    it('SET is GIFSY_ADMIN-only', () => {
      expect(Reflect.getMetadata(ROLES_KEY, TdsConfigController.prototype.setImportedPayouts)).toEqual(['GIFSY_ADMIN']);
    });

    it('DTO: accepts a YYYY-MM-DD string or null; rejects missing / wrong format', async () => {
      const ok1 = plainToInstance(SetImportedPayoutsConfigDto, { clientId: 'bajaj', countFrom: '2026-04-01' });
      const ok2 = plainToInstance(SetImportedPayoutsConfigDto, { clientId: 'bajaj', countFrom: null });
      expect(await validate(ok1)).toHaveLength(0);
      expect(await validate(ok2)).toHaveLength(0);
      for (const bad of [{ clientId: 'bajaj' }, { clientId: 'bajaj', countFrom: '01-04-2026' }, { clientId: 'bajaj', countFrom: 20260401 }]) {
        const errs = await validate(plainToInstance(SetImportedPayoutsConfigDto, bad));
        expect(errs.map((e) => e.property)).toContain('countFrom');
      }
    });
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

    // PROD BUG (owner, Bajaj): assumed operator's FE sent its HOME clientId 'gifsy' → the policy was
    // written for 'gifsy' while GET read 'bajaj'. An assumed operator is now pinned to the assumed tenant.
    const BAJAJ_ASSUMED: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '9', name: 'Op', assumed: true };
    const body194R = { section: 'SEC_194R' as SetTdsConfigDto['section'], methodology: 'GROSS_UP' as SetTdsConfigDto['methodology'] };

    it('ASSUMED into bajaj, body clientId "gifsy" (the old FE) → 403, nothing written', async () => {
      await expect(controller.set(BAJAJ_ASSUMED, { clientId: 'gifsy', ...body194R })).rejects.toThrow(ForbiddenException);
      await expect(controller.set(BAJAJ_ASSUMED, { clientId: 'gifsy', ...body194R })).rejects.toThrow(/working in "bajaj"/);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('ASSUMED into bajaj, no body clientId (or "bajaj") → writes bajaj', async () => {
      const r1 = await controller.set(BAJAJ_ASSUMED, body194R);
      const r2 = await controller.set(BAJAJ_ASSUMED, { clientId: 'bajaj', ...body194R });
      expect(adminCore.upsertSetting.mock.calls.map((c) => c[0].clientId)).toEqual(['bajaj', 'bajaj']);
      expect(r1).toEqual({ clientId: 'bajaj', section: 'SEC_194R', methodology: 'GROSS_UP' });
      expect(r2.clientId).toBe('bajaj');
    });

    it('un-assumed GIFSY: body clientId required (400) and must exist (404)', async () => {
      await expect(controller.set(GIFSY, body194R)).rejects.toThrow(BadRequestException);
      tds.clientExists.mockResolvedValue(false);
      await expect(controller.set(GIFSY, { clientId: 'nope', ...body194R })).rejects.toThrow(NotFoundException);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('imported-payouts PUT uses the same pinning: assumed + no clientId → assumed tenant; un-assumed + none → 400', async () => {
      const res = await controller.setImportedPayouts(BAJAJ_ASSUMED, { countFrom: null });
      expect(res).toEqual({ clientId: 'bajaj', countFrom: null });
      expect(adminCore.upsertSetting.mock.calls[0][0].clientId).toBe('bajaj');
      await expect(controller.setImportedPayouts(GIFSY, { countFrom: null })).rejects.toThrow(BadRequestException);
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
