// Unit tests for NotificationTemplatesController — delegation, the { config, contracts } response
// shape, and the owner-only @Roles('GIFSY_ADMIN') metadata on both routes.
// Run: npx jest src/notification-templates/notification-templates.controller.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { NotificationTemplatesController } from './notification-templates.controller';
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
    // KYC_SUBMITTED + PAYOUT_CREDITED pass includeFreeChannels:false → no IN_APP/PUSH.
    expect(res.contracts.KYC_SUBMITTED.freeChannels).toBe(false);
    expect(res.contracts.PAYOUT_CREDITED.freeChannels).toBe(false);
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
