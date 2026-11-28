// Unit tests for NotificationTemplatesController — delegation, the { config, contracts } response
// shape, and the owner-only @Roles('GIFSY_ADMIN') metadata on both routes.
// Run: npx jest src/notification-templates/notification-templates.controller.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  GifsyClientNotificationTemplatesController,
  NotificationTemplatesController,
} from './notification-templates.controller';
import { RolesGuard } from '../common/guards/roles.guard';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { NotificationTemplatesService } from './notification-templates.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { EVENT_KEYS, VARIABLE_CONTRACTS } from './notification-templates.config';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const owner: JwtPayload = { sub: 'u1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '', assumed: true };

describe('NotificationTemplatesController', () => {
  let controller: NotificationTemplatesController;
  const svc = { getConfig: jest.fn(), saveConfig: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationTemplatesController],
      providers: [{ provide: NotificationTemplatesService, useValue: svc }],
    }).compile();
    controller = module.get(NotificationTemplatesController);
  });

  it('GET returns { config, contracts } with every EVENT_KEY contract present', async () => {
    const cfg = { masterSms: false, masterWhatsapp: false, events: {} } as never;
    svc.getConfig.mockResolvedValue(cfg);
    const res = await controller.get(owner);
    expect(svc.getConfig).toHaveBeenCalledWith('deoleo');
    expect(res.config).toBe(cfg);
    expect(res.contracts).toBe(VARIABLE_CONTRACTS);
    // contracts cover exactly the canonical event set
    expect(Object.keys(res.contracts).sort()).toEqual([...EVENT_KEYS].sort());
  });

  it('GET contracts carry freeChannels: false for paid-only events, true otherwise', async () => {
    svc.getConfig.mockResolvedValue({ masterSms: false, masterWhatsapp: false, events: {} } as never);
    const res = await controller.get(owner);
    // KYC_SUBMITTED passes includeFreeChannels:false → no IN_APP/PUSH. PAYOUT_CREDITED writes the bell + push since 2026-11-26.
    expect(res.contracts.KYC_SUBMITTED.freeChannels).toBe(false);
    expect(res.contracts.PAYOUT_CREDITED.freeChannels).toBe(true);
    // Every other event writes the free channels.
    expect(res.contracts.KYC_APPROVED.freeChannels).toBe(true);
    expect(res.contracts.POINTS_CREDITED.freeChannels).toBe(true);
    expect(res.contracts.REDEMPTION_CONFIRMED.freeChannels).toBe(true);
  });

  it('PUT delegates to saveConfig(user, dto) and returns { config, contracts }', async () => {
    const cfg = { masterSms: true, masterWhatsapp: true, events: {} } as never;
    svc.saveConfig.mockResolvedValue(cfg);
    const dto = { masterSms: true, masterWhatsapp: true } as never;
    const res = await controller.put(owner, dto);
    expect(svc.saveConfig).toHaveBeenCalledWith(owner, dto);
    expect(res.config).toBe(cfg);
    expect(res.contracts).toBe(VARIABLE_CONTRACTS);
  });

  it('both routes are gated @Roles(GIFSY_ADMIN)', () => {
    const reflector = new Reflector();
    const getRoles = reflector.get<string[]>(ROLES_KEY, NotificationTemplatesController.prototype.get);
    const putRoles = reflector.get<string[]>(ROLES_KEY, NotificationTemplatesController.prototype.put);
    expect(getRoles).toEqual(['GIFSY_ADMIN']);
    expect(putRoles).toEqual(['GIFSY_ADMIN']);
  });
});

// ── Client-targeted routes: /v1/gifsy/clients/:slug/notification-templates ──────────────────────
describe('GifsyClientNotificationTemplatesController', () => {
  let controller: GifsyClientNotificationTemplatesController;
  const svc = { getConfigForClient: jest.fn(), saveConfigForClient: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GifsyClientNotificationTemplatesController],
      providers: [{ provide: NotificationTemplatesService, useValue: svc }],
    }).compile();
    controller = module.get(GifsyClientNotificationTemplatesController);
  });

  it('is mounted at gifsy/clients/:slug/notification-templates', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GifsyClientNotificationTemplatesController)).toBe(
      'gifsy/clients/:slug/notification-templates',
    );
  });

  it('GET targets the PATH slug (not the assumed tenant) and returns { config, contracts }', async () => {
    const cfg = { masterSms: false, masterWhatsapp: true, events: {} } as never;
    svc.getConfigForClient.mockResolvedValue(cfg);
    // owner is assumed into deoleo, but views bajaj's page → bajaj is read.
    const res = await controller.get(owner, 'bajaj');
    expect(svc.getConfigForClient).toHaveBeenCalledWith(owner, 'bajaj');
    expect(res.config).toBe(cfg);
    expect(res.contracts).toBe(VARIABLE_CONTRACTS);
  });

  it('PUT delegates to saveConfigForClient(user, slug, dto)', async () => {
    const cfg = { masterSms: true, masterWhatsapp: true, events: {} } as never;
    svc.saveConfigForClient.mockResolvedValue(cfg);
    const dto = { masterSms: true, masterWhatsapp: true } as never;
    const res = await controller.put(owner, 'bajaj', dto);
    expect(svc.saveConfigForClient).toHaveBeenCalledWith(owner, 'bajaj', dto);
    expect(res).toEqual({ config: cfg, contracts: VARIABLE_CONTRACTS });
  });

  it('both routes are @Roles(GIFSY_ADMIN) with NO @RequirePermission (staff can never defer past it)', () => {
    const reflector = new Reflector();
    for (const h of [GifsyClientNotificationTemplatesController.prototype.get, GifsyClientNotificationTemplatesController.prototype.put]) {
      expect(reflector.get<string[]>(ROLES_KEY, h)).toEqual(['GIFSY_ADMIN']);
      expect(reflector.get(PERMISSION_KEY, h)).toBeUndefined();
    }
  });

  describe('real RolesGuard on the new routes', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (role: string, handler: (...a: never[]) => unknown) =>
      ({
        getHandler: () => handler,
        getClass: () => GifsyClientNotificationTemplatesController,
        switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'x', role, clientId: 'bajaj' } }) }),
      }) as unknown as ExecutionContext;

    it.each(['GIFSY_STAFF', 'CLIENT_ADMIN'])('%s gets 403 on GET and PUT (even for its own clientId)', (role) => {
      for (const h of [GifsyClientNotificationTemplatesController.prototype.get, GifsyClientNotificationTemplatesController.prototype.put]) {
        expect(() => guard.canActivate(ctx(role, h))).toThrow(ForbiddenException);
      }
    });

    it('GIFSY_ADMIN passes', () => {
      expect(guard.canActivate(ctx('GIFSY_ADMIN', GifsyClientNotificationTemplatesController.prototype.put))).toBe(true);
    });
  });
});
