// Unit tests for the offer-tile controllers — role/permission metadata + delegation.
// Run: npx jest src/offers/offers.controller.spec.ts --no-coverage

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { OffersAdminController, PartnerOffersController } from './offers.controller';
import { OffersAdminService } from './offers-admin.service';
import { OffersPartnerService } from './offers-partner.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateOfferTileDto } from './dto/offers.dto';

const admin: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };
const partner: JwtPayload = { sub: 'p1', role: 'SSS', clientId: 'bajaj', phone: '', name: '' };

describe('Offer tile controllers', () => {
  let adminCtl: OffersAdminController;
  let partnerCtl: PartnerOffersController;
  const adminSvc = {
    list: jest.fn(), segmentOptions: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn(), copyMonth: jest.fn(),
  };
  const partnerSvc = { listForPartner: jest.fn() };
  const reflector = new Reflector();

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OffersAdminController, PartnerOffersController],
      providers: [
        { provide: OffersAdminService, useValue: adminSvc },
        { provide: OffersPartnerService, useValue: partnerSvc },
      ],
    }).compile();
    adminCtl = module.get(OffersAdminController);
    partnerCtl = module.get(PartnerOffersController);
  });

  it('class-level roles: admin = GIFSY_ADMIN+CLIENT_ADMIN; partner = SSS/WHOLESALER/SUB_STOCKIST', () => {
    expect(reflector.get(ROLES_KEY, OffersAdminController)).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN']);
    expect(reflector.get(ROLES_KEY, PartnerOffersController)).toEqual(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
  });

  it('permissions: reads engagement:read, writes engagement:manage_banners', () => {
    const p = OffersAdminController.prototype;
    expect(reflector.get(PERMISSION_KEY, p.list)).toBe('engagement:read');
    expect(reflector.get(PERMISSION_KEY, p.options)).toBe('engagement:read');
    expect(reflector.get(PERMISSION_KEY, p.create)).toBe('engagement:manage_banners');
    expect(reflector.get(PERMISSION_KEY, p.update)).toBe('engagement:manage_banners');
    expect(reflector.get(PERMISSION_KEY, p.remove)).toBe('engagement:manage_banners');
    expect(reflector.get(PERMISSION_KEY, p.copy)).toBe('engagement:manage_banners');
    expect(reflector.get(PERMISSION_KEY, PartnerOffersController.prototype.list)).toBe('engagement:read');
  });

  it('static routes are declared before :id routes', () => {
    const names = Object.getOwnPropertyNames(OffersAdminController.prototype);
    expect(names.indexOf('options')).toBeLessThan(names.indexOf('update'));
    expect(names.indexOf('copy')).toBeLessThan(names.indexOf('update'));
  });

  it('admin handlers delegate with (user, …)', async () => {
    await adminCtl.list(admin, { month: '2026-11' });
    expect(adminSvc.list).toHaveBeenCalledWith(admin, '2026-11');
    await adminCtl.options(admin);
    expect(adminSvc.segmentOptions).toHaveBeenCalledWith(admin);
    const dto = { label: 'x' } as CreateOfferTileDto;
    await adminCtl.create(admin, dto);
    expect(adminSvc.create).toHaveBeenCalledWith(admin, dto);
    await adminCtl.update(admin, 't1', { isActive: false });
    expect(adminSvc.update).toHaveBeenCalledWith(admin, 't1', { isActive: false });
    await adminCtl.remove(admin, 't1');
    expect(adminSvc.remove).toHaveBeenCalledWith(admin, 't1');
    await adminCtl.copy(admin, { fromMonth: '2026-10', toMonth: '2026-11' });
    expect(adminSvc.copyMonth).toHaveBeenCalledWith(admin, { fromMonth: '2026-10', toMonth: '2026-11' });
  });

  it('partner handler forwards the x-active-partner-id header value', async () => {
    await partnerCtl.list(partner, 'sib1');
    expect(partnerSvc.listForPartner).toHaveBeenCalledWith(partner, 'sib1');
  });
});
