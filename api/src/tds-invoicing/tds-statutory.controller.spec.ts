/**
 * Unit tests for TdsStatutoryController — platform-level, FY-effective statutory TDS config.
 * Covers: GET readable by CLIENT_ADMIN (+ GIFSY_ADMIN); PUT is GIFSY_ADMIN-only (RolesGuard denies
 * CLIENT_ADMIN and GIFSY_STAFF) AND un-assumed-only (an assumed GIFSY_ADMIN gets 403 in-handler);
 * PUT persists via AdminCoreService.upsertSetting under the 'gifsy' scope + invalidates + returns
 * getAll(); PUT strict-validates the entries.
 * Run: npx jest src/tds-invoicing/tds-statutory.controller.spec.ts
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TdsStatutoryController } from './tds-statutory.controller';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TdsStatutoryConfigService } from '../tds/tds-statutory.config.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { SetTdsStatutoryDto } from './dto/tds-statutory.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const adminCore = { upsertSetting: jest.fn().mockResolvedValue({}) };
const statutory = { getAll: jest.fn(), invalidate: jest.fn() };

const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'Op' };
const CLIENT: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '8', name: 'CA' };
const STAFF: JwtPayload = { sub: 'st', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '7', name: 'St' } as JwtPayload;
// An ASSUMED GIFSY operator is pinned to the assumed tenant — not platform-wide.
const ASSUMED: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9', name: 'Op', assumed: true };

const validEntry = {
  effectiveFromFy: '2026-27',
  r194rWithPanPct: 10,
  r194rNoPanPct: 20,
  c194cIndividualPct: 1,
  c194cOtherPct: 2,
  c194cNoPanPct: 20,
  thr194cSingleRupees: 30000,
  thr194cFyRupees: 100000,
  thr194rFyRupees: 20000,
};

describe('TdsStatutoryController', () => {
  let controller: TdsStatutoryController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TdsStatutoryController(
      adminCore as unknown as AdminCoreService,
      statutory as unknown as TdsStatutoryConfigService,
    );
    statutory.getAll.mockResolvedValue({ entries: [], defaults: {}, currentFyLabel: '2026-27', resolvedForCurrentFy: {} });
  });

  describe('GET', () => {
    it('is declared for CLIENT_ADMIN + GIFSY_ADMIN', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, TdsStatutoryController.prototype.get);
      expect(roles).toEqual(['CLIENT_ADMIN', 'GIFSY_ADMIN']);
    });

    it('CLIENT_ADMIN can read (RolesGuard admits)', () => {
      const guard = new RolesGuard(new Reflector());
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: CLIENT }) }),
        getHandler: () => TdsStatutoryController.prototype.get,
        getClass: () => TdsStatutoryController,
      } as never;
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('returns getAll()', async () => {
      const res = await controller.get();
      expect(statutory.getAll).toHaveBeenCalledTimes(1);
      expect(res.currentFyLabel).toBe('2026-27');
    });
  });

  describe('PUT — RBAC', () => {
    it('is declared GIFSY_ADMIN-only', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, TdsStatutoryController.prototype.put);
      expect(roles).toEqual(['GIFSY_ADMIN']);
    });

    it('RolesGuard denies a CLIENT_ADMIN', () => {
      const guard = new RolesGuard(new Reflector());
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: CLIENT }) }),
        getHandler: () => TdsStatutoryController.prototype.put,
        getClass: () => TdsStatutoryController,
      } as never;
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('RolesGuard denies a GIFSY_STAFF (no @RequirePermission to defer to → allow-list 403)', () => {
      const guard = new RolesGuard(new Reflector());
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: STAFF }) }),
        getHandler: () => TdsStatutoryController.prototype.put,
        getClass: () => TdsStatutoryController,
      } as never;
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('an ASSUMED GIFSY_ADMIN gets 403 in-handler (un-assumed platform context required)', async () => {
      await expect(
        controller.put(ASSUMED, { entries: [validEntry] } as unknown as SetTdsStatutoryDto),
      ).rejects.toThrow(ForbiddenException);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
    });
  });

  describe('PUT — persist', () => {
    it('validates + writes tdsStatutory under the gifsy scope, invalidates, returns getAll()', async () => {
      const dto = { entries: [validEntry] } as unknown as SetTdsStatutoryDto;
      const res = await controller.put(GIFSY, dto);

      expect(adminCore.upsertSetting).toHaveBeenCalledTimes(1);
      const [payload, settingDto] = adminCore.upsertSetting.mock.calls[0];
      expect(payload.clientId).toBe('gifsy'); // platform scope
      expect(payload.sub).toBe('op'); // operator identity preserved for the audit
      expect(settingDto.key).toBe('tdsStatutory');
      expect(settingDto.value).toEqual({ entries: [validEntry] });
      expect(statutory.invalidate).toHaveBeenCalledTimes(1);
      expect(res.currentFyLabel).toBe('2026-27');
    });

    it('rejects a malformed entry BEFORE writing (strict validation)', async () => {
      const bad = { entries: [{ ...validEntry, r194rWithPanPct: 200 }] } as unknown as SetTdsStatutoryDto;
      await expect(controller.put(GIFSY, bad)).rejects.toThrow(BadRequestException);
      expect(adminCore.upsertSetting).not.toHaveBeenCalled();
      expect(statutory.invalidate).not.toHaveBeenCalled();
    });
  });
});
